/**
 * Anthropic Messages provider (`/v1/messages`, `stream: true`).
 *
 * Anthropic's wire format differs from OpenAI's in three ways that matter
 * here: the system prompt is a top-level field, tool results are `user`
 * content blocks rather than their own role, and streamed tool input arrives
 * as `input_json_delta` fragments that only become valid JSON at block stop.
 */
import type {
  ChatRequest,
  FinishReason,
  ModelContent,
  ModelInfo,
  ModelMessage,
  Provider,
  ProviderInfo,
  ToolSchema,
  Usage,
} from "../core/types.ts";
import type { Logger } from "../util/log.ts";
import { callId as newCallId } from "../util/ids.ts";
import { KortivError, ProviderError } from "../util/errors.ts";
import { asRecord, iterateSse, parseSseJson, readErrorBody } from "./sse.ts";
import { credentialHint, httpStatusError, networkError } from "./http.ts";
import {
  finalizeUsage,
  joinUrl,
  mapAnthropicStopReason,
  mergeHeaders,
  nonEmptyString,
  numberOr,
  parseToolArguments,
  throwIfAborted,
  toolParameters,
} from "./shared.ts";

export interface AnthropicProviderOptions {
  info: ProviderInfo;
  baseURL: string;
  apiKey?: string;
  headers?: Record<string, string>;
  fetchImpl?: typeof fetch;
  logger?: Logger;
  modelInfo?: (id: string) => ModelInfo | undefined;
  /** Pin the wire version; `2023-06-01` is the current stable surface. */
  version?: string;
}

const DEFAULT_VERSION = "2023-06-01";

interface AnthropicBlock {
  type: string;
  [key: string]: unknown;
}

function toAnthropicContent(content: ModelContent[]): AnthropicBlock[] {
  const blocks: AnthropicBlock[] = [];
  for (const part of content) {
    if (part.type === "text") {
      if (part.text) blocks.push({ type: "text", text: part.text });
      continue;
    }
    if (part.type === "image") {
      blocks.push({
        type: "image",
        source: { type: "base64", media_type: part.mime, data: part.data },
      });
      continue;
    }
    blocks.push({ type: "tool_use", id: part.callId, name: part.name, input: part.input ?? {} });
  }
  return blocks;
}

interface AnthropicMessage {
  role: "user" | "assistant";
  content: AnthropicBlock[];
}

function toAnthropicMessages(messages: ModelMessage[]): AnthropicMessage[] {
  const out: AnthropicMessage[] = [];

  for (const message of messages) {
    if (message.role === "tool") {
      const content: AnthropicBlock[] = message.results.map((result) => ({
        type: "tool_result",
        tool_use_id: result.callId,
        content: result.content || (result.isError ? "Error: tool call failed" : ""),
        is_error: result.isError,
      }));
      // Consecutive tool results collapse into one user turn.
      const previous = out[out.length - 1];
      if (previous?.role === "user" && previous.content.every((block) => block.type === "tool_result")) {
        previous.content.push(...content);
      } else {
        out.push({ role: "user", content });
      }
      continue;
    }

    const content = toAnthropicContent(message.content);
    if (content.length === 0) continue;
    const previous = out[out.length - 1];
    if (previous?.role === message.role) {
      previous.content.push(...content);
    } else {
      out.push({ role: message.role, content });
    }
  }

  return out;
}

function toAnthropicTools(tools: ToolSchema[]): Array<Record<string, unknown>> {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: toolParameters(tool),
  }));
}

function mapAnthropicUsage(raw: unknown, previous?: Usage): Usage | undefined {
  const record = asRecord(raw);
  if (!record) return undefined;
  return {
    input: numberOr(record["input_tokens"], previous?.input ?? 0),
    output: numberOr(record["output_tokens"], previous?.output ?? 0),
    reasoning: previous?.reasoning ?? 0,
    cacheRead: numberOr(record["cache_read_input_tokens"], previous?.cacheRead ?? 0),
    cacheWrite: numberOr(record["cache_creation_input_tokens"], previous?.cacheWrite ?? 0),
  };
}

const ANTHROPIC_MESSAGE_PATH = "/v1/messages";

function messageUrl(baseURL: string): string {
  const trimmed = baseURL.replace(/\/+$/, "");
  if (trimmed.endsWith(ANTHROPIC_MESSAGE_PATH)) return trimmed;
  if (trimmed.endsWith("/v1")) return `${trimmed}/messages`;
  return joinUrl(trimmed, ANTHROPIC_MESSAGE_PATH);
}

export function createAnthropicProvider(options: AnthropicProviderOptions): Provider {
  const { info, logger } = options;
  const fetchImpl = options.fetchImpl ?? fetch;
  const version = options.version ?? DEFAULT_VERSION;
  const authHint = credentialHint(info.id, info.env);

  return {
    info,
    async chat(request: ChatRequest): Promise<void> {
      throwIfAborted(request.signal);

      const body: Record<string, unknown> = {
        model: request.model.model,
        max_tokens: request.maxTokens ?? 8_192,
        messages: toAnthropicMessages(request.messages),
        stream: true,
      };
      if (request.system.trim()) body["system"] = request.system;
      if (request.temperature !== undefined) body["temperature"] = request.temperature;
      if (request.tools.length > 0) body["tools"] = toAnthropicTools(request.tools);

      let response: Response;
      try {
        response = await fetchImpl(messageUrl(options.baseURL), {
          method: "POST",
          signal: request.signal,
          headers: mergeHeaders(
            {
              "content-type": "application/json",
              accept: "text/event-stream",
              "anthropic-version": version,
            },
            options.apiKey ? { "x-api-key": options.apiKey } : undefined,
            options.headers,
          ),
          body: JSON.stringify(body),
        });
      } catch (error) {
        throw networkError(info.id, error, options.baseURL, request.signal);
      }

      if (!response.ok) {
        const detail = await readErrorBody(response);
        throw httpStatusError(info.id, response.status, detail, authHint);
      }
      if (!response.body) {
        throw new ProviderError(info.id, `${info.name} returned a response without a stream body.`, {
          hint: "Retry the request; if it persists, check the Anthropic status page.",
        });
      }

      try {
        await consume(response.body, request);
      } catch (error) {
        if (error instanceof KortivError) throw error;
        throw networkError(info.id, error, options.baseURL, request.signal);
      }
    },
  };

  async function consume(body: ReadableStream<Uint8Array>, request: ChatRequest): Promise<void> {
    interface ToolBlock {
      id: string;
      name: string;
      json: string;
      /** Set when the start event carried a complete input. */
      complete?: unknown;
    }

    const tools = new Map<number, ToolBlock>();
    const emitted = new Set<number>();
    let usage: Usage | undefined;
    let finishReason: FinishReason = "unknown";
    let sawFinish = false;

    const modelInfo = options.modelInfo?.(request.model.model);

    const flush = (index: number): void => {
      if (emitted.has(index)) return;
      const block = tools.get(index);
      if (!block || !block.name) return;
      emitted.add(index);
      const id = block.id.trim() || newCallId();
      const input = block.complete !== undefined ? block.complete : parseToolArguments(block.json, id);
      request.onEvent({ type: "tool-call", callId: id, name: block.name, input });
    };

    for await (const payload of iterateSse(body, request.signal)) {
      const event = asRecord(parseSseJson(payload, logger, info.id));
      if (!event) continue;
      const type = nonEmptyString(event["type"]);

      if (type === "error") {
        const error = asRecord(event["error"]);
        const message = nonEmptyString(error?.["message"]) ?? "the provider reported an error";
        throw new ProviderError(info.id, `${info.name} stream error: ${message}`, {
          hint: "Retry the request; if it persists, the request may exceed the model's context window.",
        });
      }

      if (type === "message_start") {
        const message = asRecord(event["message"]);
        usage = mapAnthropicUsage(message?.["usage"], usage);
        continue;
      }

      if (type === "content_block_start") {
        const block = asRecord(event["content_block"]);
        if (!block) continue;
        const blockType = nonEmptyString(block["type"]);
        if (blockType === "tool_use") {
          const index = numberOr(event["index"], tools.size);
          const input = asRecord(block["input"]);
          tools.set(index, {
            id: nonEmptyString(block["id"]) ?? "",
            name: nonEmptyString(block["name"]) ?? "",
            json: "",
            // A non-streaming tool_use arrives with its input already filled in;
            // a streamed one starts as `{}` and is built from input_json_delta.
            complete: input && Object.keys(input).length > 0 ? input : undefined,
          });
        } else if (blockType === "text") {
          const text = nonEmptyString(block["text"]);
          if (text) request.onEvent({ type: "text-delta", text });
        }
        continue;
      }

      if (type === "content_block_delta") {
        const delta = asRecord(event["delta"]);
        if (!delta) continue;
        const deltaType = nonEmptyString(delta["type"]);
        if (deltaType === "text_delta") {
          const text = nonEmptyString(delta["text"]);
          if (text) request.onEvent({ type: "text-delta", text });
        } else if (deltaType === "thinking_delta") {
          const text = nonEmptyString(delta["thinking"]);
          if (text) request.onEvent({ type: "reasoning-delta", text });
        } else if (deltaType === "input_json_delta") {
          const index = numberOr(event["index"], 0);
          const block = tools.get(index);
          if (block && typeof delta["partial_json"] === "string") {
            block.json += delta["partial_json"];
          }
        }
        continue;
      }

      if (type === "content_block_stop") {
        flush(numberOr(event["index"], 0));
        continue;
      }

      if (type === "message_delta") {
        const delta = asRecord(event["delta"]);
        const stop = nonEmptyString(delta?.["stop_reason"]);
        if (stop) {
          sawFinish = true;
          finishReason = mapAnthropicStopReason(stop);
        }
        const next = mapAnthropicUsage(event["usage"], usage);
        if (next) {
          usage = next;
          request.onEvent({ type: "usage", usage: finalizeUsage(usage, modelInfo) ?? usage });
        }
        continue;
      }

      if (type === "message_stop") {
        break;
      }
    }

    throwIfAborted(request.signal);
    for (const index of tools.keys()) flush(index);
    request.onEvent({
      type: "finish",
      reason: emitted.size > 0 ? "tool-calls" : sawFinish ? finishReason : "unknown",
    });
  }
}
