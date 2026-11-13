/**
 * Small helpers shared by every provider implementation.
 *
 * Providers talk to their vendors over global `fetch` — no SDKs — so the
 * plumbing here is deliberately protocol-neutral: URL joining, header merging,
 * abort checks, tolerant JSON, and cost derivation.
 */
import type { FinishReason, ModelCost, ModelInfo, ToolSchema, Usage } from "../core/types.ts";

/** Appends `suffix` to `base` without doubling slashes. */
export function joinUrl(base: string, suffix: string): string {
  const trimmed = base.replace(/\/+$/, "");
  if (suffix.startsWith("/")) return `${trimmed}${suffix}`;
  return `${trimmed}/${suffix}`;
}

/**
 * Header maps this layer builds itself. `HeadersInit` is not a global in this
 * project (@types/node only exports it from undici-types), so callers pass a
 * plain record or a `Headers` instance and we normalize before use.
 */
export type HeaderMap = Record<string, string> | Headers;

/** Case-insensitive header lookup; `Headers` is checked structurally. */
export function headerValue(headers: HeaderMap | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted && typeof value === "string") return value;
  }
  return undefined;
}

export function mergeHeaders(...sources: Array<HeaderMap | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const source of sources) {
    if (!source) continue;
    if (source instanceof Headers) {
      source.forEach((value, key) => {
        out[key] = value;
      });
      continue;
    }
    for (const [key, value] of Object.entries(source)) {
      if (typeof value === "string") out[key] = value;
    }
  }
  return out;
}

/**
 * Throws a DOMException named `AbortError` (matching what `fetch` raises) so
 * the agent runtime recognizes the turn as aborted rather than failed.
 */
export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new DOMException("This operation was aborted", "AbortError");
}

const JSON_FENCE = /^```(?:json)?\s*([\s\S]*?)\s*```$/i;

/** Last-resort recovery for fenced or embedded JSON, then the raw string. */
export function looseParseJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return {};
  const fenced = JSON_FENCE.exec(trimmed);
  if (fenced?.[1]) {
    const inner = tryJson(fenced[1]);
    if (inner !== undefined) return inner;
  }
  const start = trimmed.search(/[[{]/);
  if (start >= 0) {
    const embedded = tryJson(trimmed.slice(start));
    if (embedded !== undefined) return embedded;
  }
  return trimmed;
}

function tryJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Parses streamed tool-call arguments. Models routinely emit `""`, `"{}"` or
 * a half-closed object, and some emit their arguments under `inputs`, so this
 * never throws: the raw string is the fallback.
 */
export function parseToolArguments(raw: string, call: string): unknown {
  const text = (raw ?? "").trim();
  if (!text) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      const nested = record["inputs"];
      if (Object.keys(record).length === 1 && nested !== undefined) {
        return typeof nested === "string" ? looseParseJson(nested) : nested;
      }
    }
    return parsed;
  } catch {
    // fall through to the tolerant path
  }
  if (!text.endsWith("}")) {
    for (const repair of [`${text}}`, `${text}"}}`, `${text}"}`]) {
      const parsed = tryJson(repair);
      if (parsed !== undefined) return parsed;
    }
  }
  return looseParseJson(text);
}

/** `{ input: 0.27, ... }` + token counts -> USD estimate. */
export function estimateCost(cost: ModelCost | undefined, usage: Usage): number {
  if (!cost) return 0;
  const per = (tokens: number, rate: number | undefined) => ((rate ?? 0) * tokens) / 1_000_000;
  const cacheRead = usage.cacheRead ?? 0;
  const cacheWrite = usage.cacheWrite ?? 0;
  // Prompt tokens that were served from cache must not be billed twice.
  const freshInput = Math.max(usage.input - cacheRead - cacheWrite, 0);
  return (
    per(freshInput, cost.input) +
    per(usage.output, cost.output) +
    per(cacheRead, cost.cacheRead ?? cost.input) +
    per(cacheWrite, cost.cacheWrite ?? cost.input)
  );
}

/** Fills in `cost` from the catalog when the provider reported raw tokens. */
export function finalizeUsage(usage: Usage | undefined, info: ModelInfo | undefined): Usage | undefined {
  if (!usage) return undefined;
  if (usage.cost !== undefined && usage.cost !== 0) return usage;
  return { ...usage, cost: estimateCost(info?.cost, usage) };
}

export function mapOpenAIFinishReason(reason: unknown): FinishReason {
  switch (typeof reason === "string" ? reason : "") {
    case "stop":
      return "stop";
    case "length":
      return "length";
    case "tool_calls":
    case "function_call":
      return "tool-calls";
    case "content_filter":
      return "content-filter";
    default:
      return "unknown";
  }
}

export function mapAnthropicStopReason(reason: unknown): FinishReason {
  switch (typeof reason === "string" ? reason : "") {
    case "end_turn":
    case "stop_sequence":
    case "pause_turn":
      return "stop";
    case "max_tokens":
      return "length";
    case "tool_use":
      return "tool-calls";
    case "refusal":
      return "content-filter";
    default:
      return "unknown";
  }
}

export function mapGeminiFinishReason(reason: unknown): FinishReason {
  switch (typeof reason === "string" ? reason.toUpperCase() : "") {
    case "STOP":
      return "stop";
    case "MAX_TOKENS":
      return "length";
    case "SAFETY":
    case "RECITATION":
    case "PROHIBITED_CONTENT":
    case "BLOCKLIST":
    case "SPII":
      return "content-filter";
    case "MALFORMED_FUNCTION_CALL":
      return "error";
    case "LANGUAGE":
    case "OTHER":
      return "stop";
    default:
      return "unknown";
  }
}

/** Anthropic's tool input schema is JSON Schema, so this is a plain copy. */
export function toolParameters(tool: ToolSchema): Record<string, unknown> {
  const parameters = tool.parameters;
  if (parameters && typeof parameters === "object" && !Array.isArray(parameters)) return parameters;
  return { type: "object", properties: {} };
}

export function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
