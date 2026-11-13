/**
 * SSE (server-sent events) reading over a `fetch` response body.
 *
 * The reader is incremental by contract: it slices the incoming byte stream
 * into `data:` events and never buffers the whole response. Node's own
 * `TextDecoder` handles multi-byte characters that straddle chunk boundaries,
 * so a token split mid-character is reassembled correctly.
 */
import type { Logger } from "../util/log.ts";

/** Reads `{"error":{"message":...}}` out of a failed response body. */
export async function readErrorBody(response: Response): Promise<string> {
  try {
    const text = await response.text();
    if (!text) return "";
    try {
      const parsed: unknown = JSON.parse(text);
      const message = pickMessage(parsed);
      if (message) return message;
    } catch {
      // Not JSON: fall back to the raw (truncated) body.
    }
    const trimmed = text.trim();
    return trimmed.length > 400 ? `${trimmed.slice(0, 400)}…` : trimmed;
  } catch {
    return "";
  }
}

function pickMessage(value: unknown, depth = 0): string | undefined {
  if (depth > 3 || value === null || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ["message", "detail", "error_description", "error"]) {
    const candidate = record[key];
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
    if (candidate && typeof candidate === "object") {
      const nested = pickMessage(candidate, depth + 1);
      if (nested) return nested;
    }
  }
  return undefined;
}

/**
 * Yields the payload of every `data:` event in an SSE body, in order.
 * Comment lines and non-`data` fields are ignored; `[DONE]` is passed through
 * so callers can decide what it means. A trailing event without its final
 * newline is still yielded.
 */
export async function* iterateSse(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<string, void, undefined> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const pending: string[] = [];
  let buffer = "";

  /** Slices every complete line out of `buffer`, queueing `data:` payloads. */
  const drain = (): void => {
    for (;;) {
      const boundary = buffer.indexOf("\n");
      if (boundary < 0) break;
      let line = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line === "" || line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon < 0 ? line : line.slice(0, colon);
      if (field !== "data") continue;
      let data = colon < 0 ? "" : line.slice(colon + 1);
      if (data.startsWith(" ")) data = data.slice(1);
      pending.push(data);
    }
  };

  try {
    for (;;) {
      if (signal?.aborted) throw new DOMException("This operation was aborted", "AbortError");
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.length === 0) continue;
      buffer += decoder.decode(value, { stream: true });
      drain();
      while (pending.length > 0) yield pending.shift() as string;
    }
    buffer += decoder.decode();
    drain();
    while (pending.length > 0) yield pending.shift() as string;
    const trailing = buffer.trim();
    if (trailing) {
      const colon = trailing.indexOf(":");
      const field = colon < 0 ? trailing : trailing.slice(0, colon);
      if (field === "data") {
        let data = colon < 0 ? "" : trailing.slice(colon + 1);
        if (data.startsWith(" ")) data = data.slice(1);
        yield data;
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // The stream may already be closed after an abort; that is fine.
    }
  }
}

/**
 * Parses one `data:` payload. Returns `undefined` for the `[DONE]` sentinel and
 * for anything that is not valid JSON.
 */
export function parseSseJson(payload: string, logger?: Logger, provider = "provider"): unknown {
  const text = payload.trim();
  if (!text || text === "[DONE]") return undefined;
  try {
    return JSON.parse(text);
  } catch (error) {
    logger?.debug(`${provider}: skipping unparsable SSE payload`, error);
    return undefined;
  }
}

/** Narrow helper: is this an object we can safely index? */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}
