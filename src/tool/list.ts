import { join } from "node:path";
import type { ToolDef, ToolContext, ToolOutcome } from "../core/types.ts";
import { listDir } from "../util/fsx.ts";
import { displayPath, escapesViaSymlink, fail, gate, isAborted, abortedOutcome, isIgnoredName, resolveInCwd } from "./shared.ts";

const MAX_ENTRIES = 2000;

const PARAMETERS = {
  type: "object",
  properties: {
    path: {
      type: "string",
      description: "Directory to list, absolute or relative to the working directory. Defaults to the working directory.",
    },
    depth: {
      type: "integer",
      minimum: 1,
      maximum: 4,
      description:
        "How many directory levels to expand (default 1). Ignored directories such as node_modules are never expanded.",
    },
  },
  required: [],
  additionalProperties: false,
} as const;

export const listTool: ToolDef = {
  name: "list",
  description:
    "List a directory as a tree. Directory names end with `/`. Use this to orient yourself in an unfamiliar project, " +
    "then `glob` or `grep` to find specific files. Pass `depth` 2 or 3 to see nested structure in one call. " +
    "Noisy directories (node_modules, .git, dist, build, coverage, …) are not expanded. Read-only.",
  parameters: PARAMETERS,
  readOnly: true,
  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome> {
    const rawPath = input["path"];
    const rawDepth = input["depth"];
    const depth = rawDepth === undefined ? 1 : rawDepth;
    if (rawPath !== undefined && (typeof rawPath !== "string" || rawPath.trim() === "")) {
      return fail('Invalid input for "list": field "path" must be a non-empty string.');
    }
    if (typeof depth !== "number" || !Number.isInteger(depth) || depth < 1 || depth > 4) {
      return fail('Invalid input for "list": field "depth" must be an integer between 1 and 4.');
    }

    let abs: string;
    try {
      abs = resolveInCwd(ctx, rawPath ?? ".");
    } catch {
      return fail(`Refusing to list outside the working directory: ${rawPath ?? "."}`);
    }
    const rel = displayPath(ctx, abs);
    if (await escapesViaSymlink(ctx.cwd, abs)) {
      return fail(`Refusing to list ${rel}: it resolves outside the working directory through a symlink.`);
    }

    const denied = await gate(ctx, {
      tool: "list",
      title: `List ${rel}`,
      detail: abs,
      risk: "low",
    });
    if (denied) return denied;
    if (isAborted(ctx)) return abortedOutcome();

    const out: string[] = [];
    let entries = 0;
    let truncated = false;

    const walk = async (dir: string, level: number, indent: string): Promise<void> => {
      if (truncated || ctx.signal.aborted) return;
      let children;
      try {
        children = await listDir(dir);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        out.push(`${indent}(unreadable: ${message})`);
        return;
      }
      for (const child of children) {
        if (entries >= MAX_ENTRIES) {
          truncated = true;
          return;
        }
        entries += 1;
        out.push(`${indent}${child.name}${child.dir ? "/" : ""}`);
        if (child.dir && level < depth && !isIgnoredName(child.name)) {
          await walk(join(dir, child.name), level + 1, `${indent}  `);
        }
      }
    };

    await walk(abs, 1, "");

    if (out.length === 0) {
      return { title: rel, output: `${rel} is empty.`, metadata: { entries: 0, path: rel } };
    }
    let body = `${rel === abs ? abs : rel}/`;
    body += `\n${out.join("\n")}`;
    if (truncated) body += `\n\n(truncated at ${MAX_ENTRIES} entries)`;

    return {
      title: rel,
      output: body,
      metadata: { path: rel, entries, truncated },
    };
  },
};
