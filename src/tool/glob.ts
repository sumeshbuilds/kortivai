import type { ToolDef, ToolContext, ToolOutcome } from "../core/types.ts";
import { matchGlob } from "../util/glob.ts";
import { isDirectory, relativeTo } from "../util/paths.ts";
import { displayPath, escapesViaSymlink, fail, gate, isAborted, abortedOutcome, resolveInCwd, walkFiles } from "./shared.ts";

const DEFAULT_MAX = 100;
const HARD_MAX = 2000;
/** Bound the traversal even when nothing matches, so a call cannot hang. */
const MAX_SCANNED_FILES = 50_000;

const PARAMETERS = {
  type: "object",
  properties: {
    pattern: {
      type: "string",
      description:
        'Glob to match against paths relative to the working directory, e.g. "src/**/*.ts" or "**/*.test.ts". ' +
        'A pattern without a "/" matches the file name anywhere, e.g. "*.json".',
    },
    path: {
      type: "string",
      description: "Directory to search under, relative to the working directory. Defaults to the working directory.",
    },
    maxResults: {
      type: "integer",
      minimum: 1,
      maximum: HARD_MAX,
      description: `Maximum number of paths to return (default ${DEFAULT_MAX}).`,
    },
  },
  required: ["pattern"],
  additionalProperties: false,
} as const;

export const globTool: ToolDef = {
  name: "glob",
  description:
    "Find files by path pattern, newest-agnostic and fast. Use it to discover which files exist before reading or " +
    "grepping them, e.g. pattern \"src/**/*.ts\". Directories such as node_modules, .git, dist and build are skipped. " +
    "Returns paths relative to the working directory, capped by `maxResults`. Read-only.",
  parameters: PARAMETERS,
  readOnly: true,
  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome> {
    const pattern = input["pattern"];
    const rawPath = input["path"];
    const rawMax = input["maxResults"];
    const maxResults = rawMax === undefined ? DEFAULT_MAX : rawMax;
    if (typeof pattern !== "string" || pattern.trim() === "") {
      return fail('Invalid input for "glob": field "pattern" must be a non-empty glob string.');
    }
    if (rawPath !== undefined && typeof rawPath !== "string") {
      return fail('Invalid input for "glob": field "path" must be a string.');
    }
    if (typeof maxResults !== "number" || !Number.isInteger(maxResults) || maxResults < 1 || maxResults > HARD_MAX) {
      return fail(`Invalid input for "glob": field "maxResults" must be an integer between 1 and ${HARD_MAX}.`);
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
      tool: "glob",
      title: `Find files matching ${pattern}`,
      detail: pattern,
      risk: "low",
    });
    if (denied) return denied;
    if (isAborted(ctx)) return abortedOutcome();

    const matches: string[] = [];
    let scanned = 0;
    let truncated = false;
    const normalized = pattern.replace(/\\/g, "/");

    for await (const file of walkFiles(root, { signal: ctx.signal, maxFiles: MAX_SCANNED_FILES })) {
      scanned += 1;
      const rel = relativeTo(ctx.cwd, file.abs).split("\\").join("/");
      if (matchGlob(normalized, rel)) {
        matches.push(rel);
        if (matches.length >= maxResults) {
          truncated = true;
          break;
        }
      }
    }

    if (ctx.signal.aborted) return abortedOutcome();
    matches.sort((a, b) => a.localeCompare(b));

    const rootLabel = displayPath(ctx, root) || ".";
    if (matches.length === 0) {
      return {
        title: pattern,
        output: `No files under ${rootLabel} match "${pattern}".`,
        metadata: { pattern, count: 0, scanned },
      };
    }

    const footer = truncated ? `\n\n(capped at ${maxResults} results)` : "";
    return {
      title: `${matches.length} file${matches.length === 1 ? "" : "s"} for ${pattern}`,
      output: `${matches.join("\n")}${footer}`,
      metadata: { pattern, count: matches.length, scanned, truncated },
    };
  },
};
