import { applyPatch, createTwoFilesPatch } from "diff";
import type { ToolDef, ToolContext, ToolOutcome } from "../core/types.ts";
import { readTextOrNull, writeTextAtomic } from "../util/fsx.ts";
import { displayPath, escapesViaSymlink, fail, gate, isAborted, abortedOutcome, lineChanges, resolveInCwd } from "./shared.ts";

const MAX_DIFF_CHARS = 40_000;

const PARAMETERS = {
  type: "object",
  properties: {
    patch: {
      type: "string",
      description:
        "A unified diff (`--- a/file`, `+++ b/file`, one or more `@@` hunks). Copy it verbatim, including context lines.",
    },
    filePath: {
      type: "string",
      description:
        "File to patch when the diff headers are missing or point at a different path. Normally omit this and let the `+++` header choose the file.",
    },
  },
  required: ["patch"],
  additionalProperties: false,
} as const;

function fileFromHeader(patch: string): string | undefined {
  for (const line of patch.split("\n")) {
    if (!line.startsWith("+++ ")) continue;
    let value = line.slice(4).trim();
    const tab = value.indexOf("\t");
    if (tab !== -1) value = value.slice(0, tab);
    if (value === "/dev/null") continue;
    if (value.startsWith("b/")) value = value.slice(2);
    else if (value.startsWith("a/")) value = value.slice(2);
    return value;
  }
  return undefined;
}

export const patchTool: ToolDef = {
  name: "patch",
  description:
    "Apply a unified diff to a file. Use this when you already have a patch (for example from `git diff` or a review " +
    "comment) and want it applied exactly. Prefer `edit` for ordinary code changes — `patch` fails if the context " +
    "lines do not match the file as-is. The target file is taken from the `+++` header unless `filePath` is given. " +
    "Refuses paths outside the working directory, requires permission, and returns the resulting diff.",
  parameters: PARAMETERS,
  destructive: true,
  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome> {
    const patch = input["patch"];
    const rawPath = input["filePath"];
    if (typeof patch !== "string" || patch.trim() === "") {
      return fail('Invalid input for "patch": field "patch" must be a non-empty unified diff string.');
    }
    if (rawPath !== undefined && (typeof rawPath !== "string" || rawPath.trim() === "")) {
      return fail('Invalid input for "patch": field "filePath" must be a non-empty string.');
    }
    if (!patch.includes("@@")) {
      return fail('Invalid input for "patch": the diff has no "@@" hunk header. Provide a unified diff.');
    }

    const target = (rawPath as string | undefined) ?? fileFromHeader(patch);
    if (!target) {
      return fail('Invalid input for "patch": no target file. Add a "+++ b/path" header or pass "filePath".');
    }

    let abs: string;
    try {
      abs = resolveInCwd(ctx, target);
    } catch {
      return fail(`Refusing to patch outside the working directory: ${target}`);
    }
    const rel = displayPath(ctx, abs);
    if (await escapesViaSymlink(ctx.cwd, abs)) {
      return fail(`Refusing to patch ${rel}: it resolves outside the working directory through a symlink.`);
    }

    const denied = await gate(ctx, {
      tool: "patch",
      title: `Patch ${rel}`,
      detail: abs,
      risk: "high",
      preview: patch.split("\n").slice(0, 12).join("\n"),
    });
    if (denied) return denied;
    if (isAborted(ctx)) return abortedOutcome();

    const original = (await readTextOrNull(abs)) ?? "";
    const patched = applyPatch(original, patch, { fuzzFactor: 0 });
    if (patched === false) {
      return fail(
        `The patch does not apply cleanly to ${rel}. Re-read the file and regenerate the diff so its context lines match.`,
        { path: rel },
      );
    }
    if (patched === original) {
      return { title: rel, output: `${rel} is unchanged after applying the patch.`, metadata: { unchanged: true } };
    }

    try {
      await writeTextAtomic(abs, patched);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return fail(`Could not write ${rel}: ${message}`);
    }

    const stats = lineChanges(original, patched);
    let diff = createTwoFilesPatch(rel, rel, original, patched, "", "", { context: 3 });
    if (diff.length > MAX_DIFF_CHARS) diff = `${diff.slice(0, MAX_DIFF_CHARS)}\n… (diff truncated)`;

    ctx.progress({ tool: "patch", path: rel, added: stats.added, removed: stats.removed });
    return {
      title: rel,
      output: diff.trimEnd(),
      metadata: { path: rel, added: stats.added, removed: stats.removed },
    };
  },
};

/** Exposed for the tests: the path a diff will be applied to. */
export function targetFromPatch(patch: string): string | undefined {
  return fileFromHeader(patch);
}
