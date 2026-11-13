/**
 * OpenAI-compatible chat-completions provider.
 *
 * Speaks the `/chat/completions` wire format over global `fetch`, covering
 * DeepSeek, OpenRouter, Groq, Together, NVIDIA NIM, opencode zen, TokenHarbor,
 * Ollama and any custom base URL. Streaming is line-oriented: every `data:`
 * payload maps to a {@link StreamEvent} as soon as it arrives.
 */
import type {
  ChatRequest,
  ModelContent,
  ModelInfo,
  ModelMessage,
  ModelToolResult,
  Provider,
  ProviderInfo,
  ToolSchema,
  Usage,
} from "../core/types.ts";
import type { Logger } from "../util/log.ts";
import { callId as newCallId } from "../util/ids.ts";
import { ProviderError, KortivError } from "../util/errors.ts";
import { asRecord, iterateSse, parseSseJson, readErrorBody } from "./sse.ts";
import { credentialHint, httpStatusError, networkError } from "./http.ts";
import {
  finalizeUsage,
  joinUrl,
  mapOpenAIFinishReason,
  mergeHeaders,
  nonEmptyString,
  numberOr,
  parseToolArguments,
  throwIfAborted,
  toolParameters,
} from "./shared.ts";

export interface OpenAIProviderOptions {
  info: ProviderInfo;
  baseURL: string;
  /** Literal key from config, an env var, or the auth store. */
  apiKey?: string;
  headers?: Record<string, string>;
  fetchImpl?: typeof fetch;
  logger?: Logger;
  /** Look up the effective catalog entry (used to price usage). */
  modelInfo?: (id: string) => ModelInfo | undefined;
  /** Send `stream_options.include_usage`; the OpenAI-compatible default. */
  streamUsage?: boolean;
  /** Extra body fields a gateway requires (e.g. OpenRouter attribution). */
  extraBody?: Record<string, unknown>;
}

/* ------------------------------------------------------------------ *
 * Request mapping
 * ------------------------------------------------------------------ */

type OpenAIContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

type OpenAIMessage =
  | { role: "system"; content: string }
  | { role: "user" | "assistant"; content: string | OpenAIContentPart[] | null }
  | { role: "assistant"; content: string | OpenAIContentPart[] | null; tool_calls: OpenAIToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

interface OpenAIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface OpenAITool {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

function toContentParts(content: ModelContent[]): OpenAIContentPart[] {
  const parts: OpenAIContentPart[] = [];
  for (const part of content) {
    if (part.type === "text") {
      if (part.text) parts.push({ type: "text", text: part.text });
      continue;
    }
    if (part.type === "image") {
      parts.push({ type: "image_url", image_url: { url: `data:${part.mime};base64,${part.data}` } });
    }
    // `tool-call` entries are lifted into the assistant message's tool_calls.
  }
  return parts;
}

function toolCallsOf(content: ModelContent[]): OpenAIToolCall[] {
  const calls: OpenAIToolCall[] = [];
  for (const part of content) {
    if (part.type !== "tool-call") continue;
    calls.push({
      id: part.callId,
      type: "function",
      function: { name: part.name, arguments: stringifyInput(part.input) },
    });
  }
  return calls;
}

function stringifyInput(input: unknown): string {
  if (typeof input === "string") return input;
  try {
    const text = JSON.stringify(input ?? {});
    return text === undefined ? "{}" : text;
  } catch {
    return "{}";
  }
}

function toOpenAIMessages(system: string, messages: ModelMessage[]): OpenAIMessage[] {
  const out: OpenAIMessage[] = [];
  if (system.trim()) out.push({ role: "system", content: system });

  for (const message of messages) {
    if (message.role === "tool") {
      for (const result of message.results) {
        out.push({ role: "tool", tool_call_id: result.callId, content: toolResultContent(result) });
      }
      continue;
    }

    const calls = toolCallsOf(message.content);
    const parts = toContentParts(message.content);
    // A user turn must always carry content; an assistant turn may be tool calls only.
    const content: string | OpenAIContentPart[] | null =
      parts.length > 0 ? parts : calls.length > 0 ? null : "";
    if (calls.length > 0) {
      out.push({ role: message.role, content, tool_calls: calls });
      continue;
    }
    out.push({ role: message.role, content: content ?? "" });
  }
  return out;
}

function toolResultContent(result: ModelToolResult): string {
  const body = result.content ?? "";
  return result.isError ? (body ? `Error: ${body}` : "Error: tool call failed") : body;
}

function toOpenAITools(tools: ToolSchema[]): OpenAITool[] {
  return tools.map((tool) => ({
    type: "function" as const,
    function: { name: tool.name, description: tool.description, parameters: toolParameters(tool) },
  }));
}

/* ------------------------------------------------------------------ *
 * Stream mapping
 * ------------------------------------------------------------------ */

interface PendingToolCall {
  id: string;
  name: string;
  args: string;
}

interface DeltaResult {
  text: string;
  reasoning: string;
  toolCalls: Array<{ index: number; id?: string; name?: string; args?: string }>;
}

function readDelta(delta: Record<string, unknown>): DeltaResult {
  const content = delta["content"];
  const text = typeof content === "string" ? content : "";

  const reasoningRaw = delta["reasoning_content"] ?? delta["reasoning"];
  let reasoning = "";
  if (typeof reasoningRaw === "string") {
    reasoning = reasoningRaw;
  } else {
    const nested = asRecord(reasoningRaw)?.["content"];
    if (typeof nested === "string") reasoning = nested;
  }

  const toolCalls: DeltaResult["toolCalls"] = [];
  const rawCalls = delta["tool_calls"];
  if (Array.isArray(rawCalls)) {
    for (const [fallbackIndex, raw] of rawCalls.entries()) {
      const record = asRecord(raw);
      if (!record) continue;
      const fn = asRecord(record["function"]);
      toolCalls.push({
        index: numberOr(record["index"], fallbackIndex),
        id: nonEmptyString(record["id"]),
        name: nonEmptyString(fn?.["name"]),
        args: typeof fn?.["arguments"] === "string" ? fn["arguments"] : undefined,
      });
    }
  }
  return { text, reasoning, toolCalls };
}

function mapUsage(raw: unknown): Usage | undefined {
  const record = asRecord(raw);
  if (!record) return undefined;
  const promptDetails = asRecord(record["prompt_tokens_details"]);
  const completionDetails = asRecord(record["completion_tokens_details"]);
  const reasoning = promptDetails?.["reasoning_tokens"] ?? completionDetails?.["reasoning_tokens"];
  // OpenAI reports cached prompt tokens under prompt_tokens_details; DeepSeek
  // reports them as prompt_cache_hit_tokens on the usage object itself.
  const cacheRead = promptDetails?.["cached_tokens"] ?? record["prompt_cache_hit_tokens"];
  return {
    input: numberOr(record["prompt_tokens"], 0),
    output: numberOr(record["completion_tokens"], 0),
    reasoning: typeof reasoning === "number" ? reasoning : 0,
    cacheRead: numberOr(cacheRead, 0),
    cacheWrite: 0,
  };
}

/* ------------------------------------------------------------------ *
 * Provider
 * ------------------------------------------------------------------ */

export function createOpenAIProvider(options: OpenAIProviderOptions): Provider {
  const { info, logger } = options;
  const fetchImpl = options.fetchImpl ?? fetch;
  const authHint = info.keyless ? undefined : credentialHint(info.id, info.env);

  const catalog = (id: string): ModelInfo | undefined =>
    options.modelInfo?.(id) ?? info.models.find((entry) => entry.id === id);

  const completionUrl = (baseURL: string): string =>
    baseURL.endsWith("/chat/completions") ? baseURL : joinUrl(baseURL, "chat/completions");

  async function send(
    signal: AbortSignal,
    baseURL: string,
    payload: Record<string, unknown>,
  ): Promise<Response> {
    try {
      return await fetchImpl(completionUrl(baseURL), {
        method: "POST",
        signal,
        headers: mergeHeaders(
          { "content-type": "application/json", accept: "text/event-stream" },
          options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : undefined,
          options.headers,
        ),
        body: JSON.stringify(payload),
      });
    } catch (error) {
      throw networkError(info.id, error, baseURL, signal);
    }
  }

  async function consume(response: Response, request: ChatRequest, modelInfo: ModelInfo | undefined): Promise<void> {
    if (!response.ok) {
      const detail = await readErrorBody(response);
      throw httpStatusError(info.id, response.status, detail, authHint);
    }
    if (!response.body) {
      throw new ProviderError(info.id, `${info.name} returned a response without a stream body.`, {
        hint: "Retry the request; if it persists, point `baseURL` at a compatible OpenAI endpoint.",
      });
    }

    const pending = new Map<number, PendingToolCall>();
    const emitted = new Set<number>();
    let sawFinish = false;
    let finishReason: ReturnType<typeof mapOpenAIFinishReason> = "unknown";

    const flush = (index: number): void => {
      if (emitted.has(index)) return;
      const call = pending.get(index);
      if (!call || !call.name) return;
      emitted.add(index);
      const id = call.id.trim() || newCallId();
      request.onEvent({
        type: "tool-call",
        callId: id,
        name: call.name,
        input: parseToolArguments(call.args, id),
      });
    };

    for await (const payload of iterateSse(response.body, request.signal)) {
      if (payload.trim() === "[DONE]") break;
      const chunk = asRecord(parseSseJson(payload, logger, info.id));
      if (!chunk) continue;

      const error = asRecord(chunk["error"]);
      if (error) {
        const message = nonEmptyString(error["message"]) ?? "the provider reported an error";
        throw new ProviderError(info.id, `${info.name} stream error: ${message}`, {
          hint: "Retry the request; if it persists, the model may be unavailable on this account.",
        });
      }

      const choices = chunk["choices"];
      if (Array.isArray(choices)) {
        for (const rawChoice of choices) {
          const choice = asRecord(rawChoice);
          if (!choice) continue;

          const delta = asRecord(choice["delta"]);
          if (delta) {
            const { text, reasoning, toolCalls } = readDelta(delta);
            if (reasoning) request.onEvent({ type: "reasoning-delta", text: reasoning });
            if (text) request.onEvent({ type: "text-delta", text });

            for (const call of toolCalls) {
              const current = pending.get(call.index) ?? { id: "", name: "", args: "" };
              if (call.id) current.id = call.id;
              if (call.name) current.name = call.name;
              if (call.args) current.args += call.args;
              pending.set(call.index, current);
              // Do NOT flush on "name arrived, arguments still empty": the
              // OpenAI wire format sends the name first and streams arguments
              // in later chunks, so an early flush would emit `{}` and discard
              // the real arguments. Calls are flushed at finish_reason and at
              // end of stream, which also covers argument-less tools.
            }
          }

          if (typeof choice["finish_reason"] === "string") {
            sawFinish = true;
            finishReason = mapOpenAIFinishReason(choice["finish_reason"]);
            for (const index of pending.keys()) flush(index);
          }
        }
      }

      if (chunk["usage"] !== undefined && chunk["usage"] !== null) {
        const usage = mapUsage(chunk["usage"]);
        if (usage) request.onEvent({ type: "usage", usage: finalizeUsage(usage, modelInfo) ?? usage });
      }
    }

    throwIfAborted(request.signal);
    for (const index of pending.keys()) flush(index);
    request.onEvent({
      type: "finish",
      reason: emitted.size > 0 ? "tool-calls" : sawFinish ? finishReason : "stop",
    });
  }

  return {
    info,
    async chat(request: ChatRequest): Promise<void> {
      throwIfAborted(request.signal);

      const body: Record<string, unknown> = {
        model: request.model.model,
        messages: toOpenAIMessages(request.system, request.messages),
        stream: true,
      };
      if (request.temperature !== undefined) body["temperature"] = request.temperature;
      if (request.maxTokens !== undefined) body["max_tokens"] = request.maxTokens;
      if (request.tools.length > 0) {
        body["tools"] = toOpenAITools(request.tools);
        body["tool_choice"] = "auto";
      }
      if (options.streamUsage) body["stream_options"] = { include_usage: true };
      Object.assign(body, options.extraBody ?? {});

      const response = await send(request.signal, options.baseURL, body);
      try {
        await consume(response, request, catalog(request.model.model));
      } catch (error) {
        // AuthError and ProviderError are already user-facing; only raw
        // transport failures need wrapping. Aborts pass through untouched.
        if (error instanceof KortivError) throw error;
        throw networkError(info.id, error, options.baseURL, request.signal);
      }
    },
  };
}
