import type { ToolDef, ToolContext, ToolOutcome } from "../core/types.ts";
import { readTextOrNull, writeTextAtomic } from "../util/fsx.ts";
import { displayPath, escapesViaSymlink, fail, gate, isAborted, abortedOutcome, lineChanges, previewLines, resolveInCwd } from "./shared.ts";

const PARAMETERS = {
  type: "object",
  properties: {
    filePath: {
      type: "string",
      description:
        "Path to the file to create or overwrite, absolute or relative to the working directory. Must stay inside the working directory.",
    },
    content: {
      type: "string",
      description: "Full contents of the file after this call. This replaces the file entirely, not a fragment.",
    },
  },
  required: ["filePath", "content"],
  additionalProperties: false,
} as const;

export const writeTool: ToolDef = {
  name: "write",
  description:
    "Create a new file or completely replace an existing one. " +
    "`content` is the ENTIRE new file: anything not included is lost, so prefer `edit` when changing part of a file. " +
    "Parent directories are created automatically. Refuses paths outside the working directory. " +
    "Requires permission, so expect to explain to the user why the write is needed. " +
    "Returns a short added/removed line summary rather than the whole content.",
  parameters: PARAMETERS,
  destructive: true,
  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome> {
    const rawPath = input["filePath"];
    const rawContent = input["content"];
    if (typeof rawPath !== "string" || rawPath.trim() === "") {
      return fail('Invalid input for "write": field "filePath" must be a non-empty string.');
    }
    if (typeof rawContent !== "string") {
      return fail('Invalid input for "write": field "content" must be a string.');
    }

    let abs: string;
    try {
      abs = resolveInCwd(ctx, rawPath);
    } catch {
      return fail(`Refusing to write outside the working directory: ${rawPath}`);
    }
    const rel = displayPath(ctx, abs);
    if (await escapesViaSymlink(ctx.cwd, abs)) {
      return fail(`Refusing to write ${rel}: it resolves outside the working directory through a symlink.`);
    }

    const previous = await readTextOrNull(abs);
    const created = previous === null;
    if (!created && previous === rawContent) {
      return { title: rel, output: `${rel} already has exactly this content; nothing to write.`, metadata: { unchanged: true } };
    }

    const denied = await gate(ctx, {
      tool: "write",
      title: created ? `Create ${rel}` : `Overwrite ${rel}`,
      detail: abs,
      risk: created ? "medium" : "high",
      preview: previewLines(rawContent),
    });
    if (denied) return denied;
    if (isAborted(ctx)) return abortedOutcome();

    try {
      await writeTextAtomic(abs, rawContent);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return fail(`Could not write ${rel}: ${message}`);
    }

    const stats = lineChanges(previous ?? "", rawContent);
    const lines = rawContent === "" ? 0 : rawContent.split("\n").length - (rawContent.endsWith("\n") ? 1 : 0);
    const summary = created
      ? `Created ${rel} (${lines} line${lines === 1 ? "" : "s"}, +${stats.added}).`
      : `Overwrote ${rel} (+${stats.added} -${stats.removed}).`;

    ctx.progress({ tool: "write", path: rel, created, added: stats.added, removed: stats.removed });
    return {
      title: rel,
      output: summary,
      metadata: {
        path: rel,
        created,
        bytes: Buffer.byteLength(rawContent, "utf8"),
        lines,
        added: stats.added,
        removed: stats.removed,
      },
    };
  },
};
