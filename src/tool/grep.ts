import { promises as fs } from "node:fs";
import type { ToolDef, ToolContext, ToolOutcome } from "../core/types.ts";
import { matchGlob } from "../util/glob.ts";
import { isDirectory, relativeTo } from "../util/paths.ts";
import { displayPath, escapesViaSymlink, fail, gate, isAborted, abortedOutcome, resolveInCwd, truncateLine, walkFiles } from "./shared.ts";

const DEFAULT_MAX = 100;
const HARD_MAX = 1000;
const MAX_SCANNED_FILES = 50_000;
/** Files larger than this are skipped: search is for source, not data dumps. */
const MAX_FILE_BYTES = 2 * 1024 * 1024;

const PARAMETERS = {
  type: "object",
  properties: {
    pattern: {
      type: "string",
      description:
        "JavaScript regular expression tested against each line, e.g. \"function\\\\s+\\\\w+\" or \"TODO|FIXME\". " +
        "Remember to escape regex metacharacters; this is not a literal string search.",
    },
    include: {
      type: "string",
      description: 'Optional glob limiting which files are searched, e.g. "*.ts" or "src/**".',
    },
    path: {
      type: "string",
      description: "Directory to search under, relative to the working directory. Defaults to the working directory.",
    },
    maxResults: {
      type: "integer",
      minimum: 1,
      maximum: HARD_MAX,
      description: `Maximum number of matching lines to return (default ${DEFAULT_MAX}).`,
    },
    ignoreCase: {
      type: "boolean",
      description: "Case-insensitive match. Defaults to false.",
    },
  },
  required: ["pattern"],
  additionalProperties: false,
} as const;

export const grepTool: ToolDef = {
  name: "grep",
  description:
    "Search file contents by regular expression and return `path:line:text` for every match, across the whole project. " +
    "Use it to locate a symbol, string or TODO before reading files; combine with `include` to narrow the search. " +
    "node_modules, .git, dist and other generated directories are skipped, as are binary and huge files. " +
    "Results are capped by `maxResults`. Read-only.",
  parameters: PARAMETERS,
  readOnly: true,
  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome> {
    const pattern = input["pattern"];
    const include = input["include"];
    const rawPath = input["path"];
    const rawMax = input["maxResults"];
    const ignoreCase = input["ignoreCase"];
    const maxResults = rawMax === undefined ? DEFAULT_MAX : rawMax;

    if (typeof pattern !== "string" || pattern === "") {
      return fail('Invalid input for "grep": field "pattern" must be a non-empty regular expression string.');
    }
    if (include !== undefined && typeof include !== "string") {
      return fail('Invalid input for "grep": field "include" must be a glob string.');
    }
    if (rawPath !== undefined && typeof rawPath !== "string") {
      return fail('Invalid input for "grep": field "path" must be a string.');
    }
    if (typeof maxResults !== "number" || !Number.isInteger(maxResults) || maxResults < 1 || maxResults > HARD_MAX) {
      return fail(`Invalid input for "grep": field "maxResults" must be an integer between 1 and ${HARD_MAX}.`);
    }
    if (ignoreCase !== undefined && typeof ignoreCase !== "boolean") {
      return fail('Invalid input for "grep": field "ignoreCase" must be a boolean.');
    }

    let regex: RegExp;
    try {
      regex = new RegExp(pattern, ignoreCase === true ? "i" : "");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return fail(`Invalid input for "grep": field "pattern" is not a valid regular expression (${message}).`);
    }

    let root: string;
    try {
      root = resolveInCwd(ctx, rawPath ?? ".");
    } catch {
      return fail(`Refusing to search outside the working directory: ${rawPath ?? "."}`);
    }
    if (!isDirectory(root)) {
      return fail(`Cannot search ${displayPath(ctx, root)}: not a directory.`);
    }
    if (await escapesViaSymlink(ctx.cwd, root)) {
      return fail(`Refusing to search ${displayPath(ctx, root)}: it resolves outside the working directory.`);
    }

    const denied = await gate(ctx, {
      tool: "grep",
      title: `Search for ${pattern}`,
      detail: pattern,
      risk: "low",
    });
    if (denied) return denied;
    if (isAborted(ctx)) return abortedOutcome();

    const { promises: fs } = await import("node:fs");
    const includeGlob = include?.replace(/\\/g, "/");
    const matches: string[] = [];
    let scanned = 0;
    let truncated = false;

    for await (const file of walkFiles(root, { signal: ctx.signal, maxFiles: MAX_SCANNED_FILES })) {
      if (ctx.signal.aborted) break;
      const rel = relativeTo(ctx.cwd, file.abs).split("\\").join("/");
      if (includeGlob && !matchGlob(includeGlob, rel)) continue;

      scanned += 1;
      let buffer;
      try {
        const stat = await fs.stat(file.abs);
        if (stat.size > MAX_FILE_BYTES) continue;
        buffer = await fs.readFile(file.abs);
      } catch {
        continue;
      }
      if (buffer.subarray(0, Math.min(buffer.length, 8192)).includes(0)) continue;

      const lines = buffer.toString("utf8").split("\n");
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        if (line === undefined) continue;
        if (regex.test(line)) {
          matches.push(`${rel}:${index + 1}:${truncateLine(line.trimEnd(), 500)}`);
          if (matches.length >= maxResults) {
            truncated = true;
            break;
          }
        }
      }
      if (truncated) break;
    }

    if (ctx.signal.aborted) return abortedOutcome();

    if (matches.length === 0) {
      return {
        title: pattern,
        output: `No matches for /${pattern}/ under ${displayPath(ctx, root) || "."}.`,
        metadata: { pattern, count: 0, scanned },
      };
    }

    const footer = truncated ? `\n\n(capped at ${maxResults} matches)` : "";
    return {
      title: `${matches.length} match${matches.length === 1 ? "" : "es"} for ${pattern}`,
      output: `${matches.join("\n")}${footer}`,
      metadata: { pattern, count: matches.length, scanned, truncated },
    };
  },
};
