/**
 * Google Gemini provider (`:streamGenerateContent?alt=sse`).
 *
 * Gemini's shape is the odd one out: messages are `contents` with `parts`,
 * the system prompt is a `systemInstruction`, tools are `functionDeclarations`,
 * and tool results come back as `functionResponse` parts inside a `user` turn.
 * Role names are `user` / `model`.
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
  mapGeminiFinishReason,
  mergeHeaders,
  nonEmptyString,
  numberOr,
  throwIfAborted,
  toolParameters,
} from "./shared.ts";

export interface GeminiProviderOptions {
  info: ProviderInfo;
  baseURL: string;
  apiKey?: string;
  headers?: Record<string, string>;
  fetchImpl?: typeof fetch;
  logger?: Logger;
  modelInfo?: (id: string) => ModelInfo | undefined;
}

interface GeminiPart {
  [key: string]: unknown;
}

interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

function toGeminiParts(content: ModelContent[]): GeminiPart[] {
  const parts: GeminiPart[] = [];
  for (const part of content) {
    if (part.type === "text") {
      if (part.text) parts.push({ text: part.text });
      continue;
    }
    if (part.type === "image") {
      parts.push({ inlineData: { mimeType: part.mime, data: part.data } });
      continue;
    }
    parts.push({ functionCall: { name: part.name, args: part.input ?? {} } });
  }
  return parts;
}

function toGeminiContents(messages: ModelMessage[]): GeminiContent[] {
  const out: GeminiContent[] = [];

  for (const message of messages) {
    if (message.role === "tool") {
      const parts: GeminiPart[] = message.results.map((result) => {
        const response: Record<string, unknown> = {
          name: result.name,
          // `response` must be an object; an error string is wrapped so Gemini
          // can still correlate it with the originating call.
          response: result.isError
            ? { error: result.content || "tool call failed" }
            : safeResponse(result.content),
        };
        return { functionResponse: response };
      });
      const previous = out[out.length - 1];
      if (previous?.role === "user" && previous.parts.every((part) => "functionResponse" in part)) {
        previous.parts.push(...parts);
      } else {
        out.push({ role: "user", parts });
      }
      continue;
    }

    const parts = toGeminiParts(message.content);
    if (parts.length === 0) continue;
    const role = message.role === "assistant" ? "model" : "user";
    const previous = out[out.length - 1];
    if (previous?.role === role) {
      previous.parts.push(...parts);
    } else {
      out.push({ role, parts });
    }
  }

  return out;
}

/** Gemini expects a JSON object as a function response payload. */
function safeResponse(content: string): Record<string, unknown> {
  const text = (content ?? "").trim();
  if (!text) return { output: "" };
  if (text.startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(text);
      const record = asRecord(parsed);
      if (record) return record;
    } catch {
      // Fall through and wrap the raw text.
    }
  }
  return { output: text };
}

function toGeminiTools(tools: ToolSchema[]): Array<Record<string, unknown>> {
  if (tools.length === 0) return [];
  return [
    {
      functionDeclarations: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: toolParameters(tool),
      })),
    },
  ];
}

function mapGeminiUsage(raw: unknown): Usage | undefined {
  const record = asRecord(raw);
  if (!record) return undefined;
  const input = numberOr(record["promptTokenCount"], 0);
  const candidates = numberOr(record["candidatesTokenCount"], 0);
  const thoughts = numberOr(record["thoughtsTokenCount"], 0);
  // `candidatesTokenCount` excludes thinking tokens; bill them into output.
  return {
    input,
    output: candidates + thoughts,
    reasoning: thoughts,
    cacheRead: numberOr(record["cachedContentTokenCount"], 0),
    cacheWrite: 0,
  };
}

function streamUrl(baseURL: string, model: string): string {
  const trimmed = baseURL.replace(/\/+$/, "");
  const root = trimmed.endsWith("/v1beta") ? trimmed : `${trimmed}/v1beta`;
  const id = model.startsWith("models/") ? model : `models/${model}`;
  return `${root}/${id}:streamGenerateContent?alt=sse`;
}

export function createGeminiProvider(options: GeminiProviderOptions): Provider {
  const { info, logger } = options;
  const fetchImpl = options.fetchImpl ?? fetch;
  const authHint = credentialHint(info.id, info.env);

  return {
    info,
    async chat(request: ChatRequest): Promise<void> {
      throwIfAborted(request.signal);

      const generationConfig: Record<string, unknown> = {};
      if (request.temperature !== undefined) generationConfig["temperature"] = request.temperature;
      if (request.maxTokens !== undefined) generationConfig["maxOutputTokens"] = request.maxTokens;

      const body: Record<string, unknown> = {
        contents: toGeminiContents(request.messages),
      };
      if (request.system.trim()) body["systemInstruction"] = { parts: [{ text: request.system }] };
      if (Object.keys(generationConfig).length > 0) body["generationConfig"] = generationConfig;
      const tools = toGeminiTools(request.tools);
      if (tools.length > 0) body["tools"] = tools;

      let response: Response;
      try {
        response = await fetchImpl(streamUrl(options.baseURL, request.model.model), {
          method: "POST",
          signal: request.signal,
          headers: mergeHeaders(
            { "content-type": "application/json", accept: "text/event-stream" },
            // Header auth keeps the key out of URLs, which end up in logs.
            options.apiKey ? { "x-goog-api-key": options.apiKey } : undefined,
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
          hint: "Retry the request; if it persists, check that the model id is valid.",
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
    const modelInfo = options.modelInfo?.(request.model.model);
    let finishReason: FinishReason = "unknown";
    let sawFinish = false;
    let toolCalls = 0;

    for await (const payload of iterateSse(body, request.signal)) {
      const chunk = asRecord(parseSseJson(payload, logger, info.id));
      if (!chunk) continue;

      const error = asRecord(chunk["error"]);
      if (error && !Array.isArray(chunk["candidates"])) {
        const message = nonEmptyString(error["message"]) ?? "the provider reported an error";
        throw new ProviderError(info.id, `${info.name} stream error: ${message}`, {
          hint: "Retry the request; if it persists, the prompt may have been blocked by safety filters.",
        });
      }

      const candidates = chunk["candidates"];
      if (Array.isArray(candidates)) {
        for (const rawCandidate of candidates) {
          const candidate = asRecord(rawCandidate);
          if (!candidate) continue;
          const content = asRecord(candidate["content"]);
          const parts = content?.["parts"];
          if (Array.isArray(parts)) {
            for (const rawPart of parts) {
              const part = asRecord(rawPart);
              if (!part) continue;

              const text = part["text"];
              if (typeof text === "string" && text) {
                const event = part["thought"] === true ? "reasoning-delta" : "text-delta";
                request.onEvent({ type: event, text });
                continue;
              }

              const call = asRecord(part["functionCall"]);
              if (call) {
                toolCalls += 1;
                request.onEvent({
                  type: "tool-call",
                  callId: newCallId(),
                  name: nonEmptyString(call["name"]) ?? "unknown",
                  input: call["args"] ?? {},
                });
              }
            }
          }

          const reason = nonEmptyString(candidate["finishReason"]);
          if (reason) {
            sawFinish = true;
            finishReason = mapGeminiFinishReason(reason);
          }
        }
      }

      if (chunk["usageMetadata"] !== undefined && chunk["usageMetadata"] !== null) {
        const usage = mapGeminiUsage(chunk["usageMetadata"]);
        if (usage) request.onEvent({ type: "usage", usage: finalizeUsage(usage, modelInfo) ?? usage });
      }
    }

    throwIfAborted(request.signal);
    request.onEvent({
      type: "finish",
      reason: toolCalls > 0 ? "tool-calls" : sawFinish ? finishReason : "unknown",
    });
  }
}
