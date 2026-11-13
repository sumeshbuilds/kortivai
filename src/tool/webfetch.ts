import type { ToolDef, ToolContext, ToolOutcome } from "../core/types.ts";
import { fail, gate, isAborted, abortedOutcome } from "./shared.ts";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
/** Hard cap on the response body we buffer, in bytes. */
const MAX_BYTES = 2_000_000;

const PARAMETERS = {
  type: "object",
  properties: {
    url: {
      type: "string",
      description: "Absolute http:// or https:// URL to fetch.",
    },
    format: {
      type: "string",
      enum: ["text", "html"],
      description:
        'Response format. "text" (default) strips HTML tags, scripts and styles into readable text; "html" returns the raw body.',
    },
    timeout: {
      type: "integer",
      minimum: 1000,
      maximum: MAX_TIMEOUT_MS,
      description: `Milliseconds before the request is aborted. Default ${DEFAULT_TIMEOUT_MS}, maximum ${MAX_TIMEOUT_MS}.`,
    },
  },
  required: ["url"],
  additionalProperties: false,
} as const;

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  copy: "©",
  reg: "®",
  trade: "™",
};

function decodeEntity(entity: string): string {
  if (entity.startsWith("#x") || entity.startsWith("#X")) {
    const code = Number.parseInt(entity.slice(2), 16);
    return Number.isFinite(code) ? String.fromCodePoint(code) : `&${entity};`;
  }
  if (entity.startsWith("#")) {
    const code = Number.parseInt(entity.slice(1), 10);
    return Number.isFinite(code) ? String.fromCodePoint(code) : `&${entity};`;
  }
  return NAMED_ENTITIES[entity.toLowerCase()] ?? `&${entity};`;
}

/**
 * Converts HTML into readable plain text. Deliberately regex-based: the tool
 * only needs enough structure (headings, paragraphs, list items) to be useful
 * to a model, and a full DOM parser would be a dependency.
 */
export function htmlToText(html: string): string {
  const text = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, "")
    .replace(/<style\b[\s\S]*?<\/style\s*>/gi, "")
    .replace(/<noscript\b[\s\S]*?<\/noscript\s*>/gi, "")
    .replace(/<(?:br|hr)\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|section|article|header|footer|main|nav|tr|li|blockquote|pre|h[1-6]|ul|ol|table)\s*>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<h([1-6])[^>]*>/gi, (_match, level: string) => `\n${"#".repeat(Number(level))} `)
    .replace(/<[^>]+>/g, "")
    .replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (_match, entity: string) => decodeEntity(entity));

  return text
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export const webfetchTool: ToolDef = {
  name: "webfetch",
  description:
    "Fetch a URL over HTTP(S) and return the response as text. Use it to read documentation, an issue thread or a raw " +
    "file you cannot reach locally. HTML is stripped to readable text (`format: \"text\"`, the default); pass " +
    '`format: "html"` for the raw body. Only http and https are allowed, the body is capped at 2MB and the request ' +
    "times out — if a page is too large or unreachable, say so instead of retrying blindly. Read-only.",
  parameters: PARAMETERS,
  readOnly: true,
  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome> {
    const url = input["url"];
    const format = input["format"];
    const rawTimeout = input["timeout"];
    if (typeof url !== "string" || url.trim() === "") {
      return fail('Invalid input for "webfetch": field "url" must be a non-empty string.');
    }
    if (format !== undefined && format !== "text" && format !== "html") {
      return fail('Invalid input for "webfetch": field "format" must be "text" or "html".');
    }
    const timeout = rawTimeout === undefined ? DEFAULT_TIMEOUT_MS : rawTimeout;
    if (typeof timeout !== "number" || !Number.isInteger(timeout) || timeout < 1000 || timeout > MAX_TIMEOUT_MS) {
      return fail(
        `Invalid input for "webfetch": field "timeout" must be an integer between 1000 and ${MAX_TIMEOUT_MS} milliseconds.`,
      );
    }

    let parsed: URL;
    try {
      parsed = new URL(url.trim());
    } catch {
      return fail(`Invalid input for "webfetch": "${url}" is not an absolute URL.`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return fail(`Refusing to fetch ${parsed.protocol} URL; only http and https are supported.`);
    }

    const denied = await gate(ctx, {
      tool: "webfetch",
      title: `Fetch ${parsed.href}`,
      detail: parsed.href,
      risk: "low",
    });
    if (denied) return denied;
    if (isAborted(ctx)) return abortedOutcome();

    try {
      const response = await fetch(parsed, {
        signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(timeout)]),
        redirect: "follow",
        headers: { "user-agent": "KortivAI/0.1 (+https://github.com/kortivai)" },
      });

      const contentType = response.headers.get("content-type") ?? "";
      const chunks: Buffer[] = [];
      let bytes = 0;
      let truncated = false;
      const reader = response.body?.getReader();
      if (reader) {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value) continue;
          bytes += value.byteLength;
          if (bytes > MAX_BYTES) {
            const keep = value.byteLength - (bytes - MAX_BYTES);
            if (keep > 0) chunks.push(Buffer.from(value.subarray(0, keep)));
            truncated = true;
            await reader.cancel();
            break;
          }
          chunks.push(Buffer.from(value));
        }
      }

      const rawBody = Buffer.concat(chunks).toString("utf8");
      const isHtml = /text\/html|application\/xhtml/i.test(contentType);
      const body = format === "html" || !isHtml ? rawBody : htmlToText(rawBody);

      const notes: string[] = [];
      if (truncated) notes.push(`[truncated at ${MAX_BYTES} bytes]`);
      if (response.status >= 400) notes.push(`[HTTP ${response.status} ${response.statusText}]`);

      const header = `# ${parsed.href}\n(content-type: ${contentType || "unknown"}, status: ${response.status})`;
      const output = `${header}\n\n${body.trim() === "" ? "(empty response body)" : body}${notes.length > 0 ? `\n${notes.join(" ")}` : ""}`;

      return {
        title: parsed.href,
        output,
        isError: response.status >= 400,
        metadata: {
          url: parsed.href,
          status: response.status,
          contentType,
          bytes,
          truncated,
          format: format ?? "text",
        },
      };
    } catch (error) {
      if (ctx.signal.aborted) return abortedOutcome();
      const name = error instanceof Error ? error.name : "";
      if (name === "TimeoutError") {
        return fail(`Timed out after ${timeout}ms fetching ${parsed.href}.`);
      }
      const message = error instanceof Error ? error.message : String(error);
      return fail(`Could not fetch ${parsed.href}: ${message}`);
    }
  },
};
