import { promises as fs } from "node:fs";
import type { ToolDef, ToolContext, ToolOutcome } from "../core/types.ts";
import { displayPath, escapesViaSymlink, fail, gate, isAborted, abortedOutcome, resolveInCwd, truncateLine } from "./shared.ts";

const DEFAULT_LIMIT = 2000;
const MAX_LIMIT = 20000;
/** Refuse to buffer absurd files; offset/limit would not make this cheap. */
const MAX_FILE_BYTES = 10 * 1024 * 1024;

const PARAMETERS = {
  type: "object",
  properties: {
    filePath: {
      type: "string",
      description:
        "Path to the file, absolute or relative to the working directory. Must stay inside the working directory.",
    },
    offset: {
      type: "integer",
      minimum: 1,
      description: "1-based line number to start reading from. Defaults to 1.",
    },
    limit: {
      type: "integer",
      minimum: 1,
      maximum: MAX_LIMIT,
      description: `Maximum number of lines to return (default ${DEFAULT_LIMIT}).`,
    },
  },
  required: ["filePath"],
  additionalProperties: false,
} as const;

export const readTool: ToolDef = {
  name: "read",
  description:
    "Read a text file from disk and return it with line numbers (`NNNN| text`). " +
    "Use this before editing a file so your replacement strings match the file exactly. " +
    "For large files, page through with `offset` and `limit` instead of reading everything at once; " +
    "the result reports the total line count. Binary files are rejected — use the shell for those. " +
    "This tool is read-only and never modifies anything.",
  parameters: PARAMETERS,
  readOnly: true,
  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome> {
    const rawPath = input["filePath"];
    if (typeof rawPath !== "string" || rawPath.trim() === "") {
      return fail('Invalid input for "read": field "filePath" must be a non-empty string.');
    }
    const offsetRaw = input["offset"];
    const limitRaw = input["limit"];
    const offset = offsetRaw === undefined ? 1 : offsetRaw;
    const limit = limitRaw === undefined ? DEFAULT_LIMIT : limitRaw;
    if (typeof offset !== "number" || !Number.isInteger(offset) || offset < 1) {
      return fail('Invalid input for "read": field "offset" must be a positive integer.');
    }
    if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
      return fail(`Invalid input for "read": field "limit" must be an integer between 1 and ${MAX_LIMIT}.`);
    }

    let abs: string;
    try {
      abs = resolveInCwd(ctx, rawPath);
    } catch (error) {
      return fail(`Refusing to read outside the working directory: ${rawPath}`);
    }
    const rel = displayPath(ctx, abs);
    if (await escapesViaSymlink(ctx.cwd, abs)) {
      return fail(`Refusing to read ${rel}: it resolves outside the working directory through a symlink.`);
    }

    const denied = await gate(ctx, {
      tool: "read",
      title: `Read ${rel}`,
      detail: abs,
      risk: "low",
    });
    if (denied) return denied;
    if (isAborted(ctx)) return abortedOutcome();

    try {
      const stat = await fs.stat(abs);
      if (stat.isDirectory()) {
        return fail(`${rel} is a directory; use the "list" tool to enumerate it.`);
      }
      if (!stat.isFile()) {
        return fail(`${rel} is not a regular file.`);
      }
      if (stat.size > MAX_FILE_BYTES) {
        return fail(
          `${rel} is ${Math.round(stat.size / (1024 * 1024))}MB, which is too large to read in one call. ` +
            `Use "grep" to locate the part you need, or "offset"/"limit" on a smaller file.`,
        );
      }

      const buffer = await fs.readFile(abs);
      if (buffer.subarray(0, Math.min(buffer.length, 8192)).includes(0)) {
        return fail(`${rel} looks like a binary file (contains NUL bytes) and cannot be read as text.`);
      }

      const lines = buffer.toString("utf8").split("\n");
      // A trailing newline produces a final empty element; do not count it.
      const total = lines.length > 0 && lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
      if (total === 0) {
        return { title: rel, output: `${rel} is empty.`, metadata: { lines: 0, bytes: buffer.length } };
      }
      if (offset > total) {
        return fail(
          `${rel} has only ${total} lines; offset ${offset} is past the end of the file.`,
          { lines: total },
        );
      }

      const end = Math.min(total, offset + limit - 1);
      const selected = lines.slice(offset - 1, end);
      const width = String(end).length;
      const body = selected
        .map((line, index) => `${String(offset + index).padStart(width, " ")}| ${truncateLine(line)}`)
        .join("\n");

      const truncated = end < total;
      const footer = truncated
        ? `\n\n(showing lines ${offset}-${end} of ${total}; call read again with offset ${end + 1} to continue)`
        : "";

      ctx.progress({ tool: "read", path: rel, lines: end - offset + 1 });
      return {
        title: rel,
        output: `${body}${footer}`,
        metadata: { lines: total, from: offset, to: end, truncated, bytes: buffer.length },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return fail(`Could not read ${rel}: ${message}`);
    }
  },
};
