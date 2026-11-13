import { promises as fs } from "node:fs";
import { createTwoFilesPatch } from "diff";
import type { ToolDef, ToolContext, ToolOutcome } from "../core/types.ts";
import { displayPath, escapesViaSymlink, fail, gate, isAborted, abortedOutcome, lineChanges, resolveInCwd } from "./shared.ts";

const MAX_DIFF_CHARS = 40_000;

interface EditSpec {
  oldString: string;
  newString: string;
  replaceAll: boolean;
}

const EDIT_ITEM_SCHEMA = {
  type: "object",
  properties: {
    oldString: {
      type: "string",
      description: "Exact text to replace. Include enough surrounding context to make it unique.",
    },
    newString: {
      type: "string",
      description: "Replacement text. Use an empty string to delete the matched text.",
    },
    replaceAll: {
      type: "boolean",
      description: "Replace every occurrence instead of failing when the text is ambiguous.",
    },
  },
  required: ["oldString", "newString"],
  additionalProperties: false,
} as const;

const PARAMETERS = {
  type: "object",
  properties: {
    filePath: {
      type: "string",
      description: "File to modify, absolute or relative to the working directory. Must stay inside it.",
    },
    oldString: {
      type: "string",
      description: "Exact text to replace. Include enough surrounding context to make it unique.",
    },
    newString: {
      type: "string",
      description: "Replacement text. Use an empty string to delete the matched text.",
    },
    replaceAll: {
      type: "boolean",
      description: "Replace every occurrence instead of failing when the text is ambiguous.",
    },
    edits: {
      type: "array",
      description:
        "Apply several replacements in one call, in array order. Provide this instead of oldString/newString.",
      items: EDIT_ITEM_SCHEMA,
    },
  },
  required: ["filePath"],
  anyOf: [{ required: ["oldString", "newString"] }, { required: ["edits"] }],
  additionalProperties: false,
} as const;

function parseEdits(input: Record<string, unknown>): { edits: EditSpec[] } | { error: string } {
  const rawEdits = input["edits"];
  if (rawEdits !== undefined) {
    if (input["oldString"] !== undefined || input["newString"] !== undefined) {
      return { error: 'Provide either "edits" or "oldString"/"newString", not both.' };
    }
    if (!Array.isArray(rawEdits) || rawEdits.length === 0) {
      return { error: 'Invalid input for "edit": field "edits" must be a non-empty array.' };
    }
    const edits: EditSpec[] = [];
    for (let index = 0; index < rawEdits.length; index += 1) {
      const entry: unknown = rawEdits[index];
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
        return { error: `Invalid input for "edit": edits[${index}] must be an object.` };
      }
      const record = entry as Record<string, unknown>;
      const oldString = record["oldString"];
      const newString = record["newString"];
      const replaceAll = record["replaceAll"];
      if (typeof oldString !== "string" || typeof newString !== "string") {
        return { error: `Invalid input for "edit": edits[${index}] requires string "oldString" and "newString".` };
      }
      if (replaceAll !== undefined && typeof replaceAll !== "boolean") {
        return { error: `Invalid input for "edit": edits[${index}].replaceAll must be a boolean.` };
      }
      edits.push({ oldString, newString, replaceAll: replaceAll === true });
    }
    return { edits };
  }

  const oldString = input["oldString"];
  const newString = input["newString"];
  const replaceAll = input["replaceAll"];
  if (typeof oldString !== "string" || typeof newString !== "string") {
    return { error: 'Invalid input for "edit": provide string "oldString" and "newString", or an "edits" array.' };
  }
  if (replaceAll !== undefined && typeof replaceAll !== "boolean") {
    return { error: 'Invalid input for "edit": field "replaceAll" must be a boolean.' };
  }
  return { edits: [{ oldString, newString, replaceAll: replaceAll === true }] };
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

interface AppliedEdit {
  content: string;
  strategy: "exact" | "crlf";
}

function applyEdit(content: string, spec: EditSpec, index: number): AppliedEdit {
  if (spec.oldString === "") {
    throw new Error(`edit[${index}]: "oldString" must not be empty.`);
  }
  if (spec.oldString === spec.newString) {
    throw new Error(`edit[${index}]: "oldString" and "newString" are identical; nothing to do.`);
  }

  let needle = spec.oldString;
  let replacement = spec.newString;
  let strategy: AppliedEdit["strategy"] = "exact";
  let occurrences = countOccurrences(content, needle);

  // A model sending LF matches against a CRLF file is the single most common
  // "not found" report; retry with the file's own line endings.
  if (occurrences === 0 && content.includes("\r\n") && !needle.includes("\r\n") && needle.includes("\n")) {
    needle = needle.replace(/\n/g, "\r\n");
    replacement = replacement.replace(/\n/g, "\r\n");
    occurrences = countOccurrences(content, needle);
    strategy = "crlf";
  }

  if (occurrences === 0) {
    throw new Error(
      `edit[${index}]: "oldString" was not found in the file. Read the file again and copy the text exactly, ` +
        "including indentation.",
    );
  }
  if (occurrences > 1 && !spec.replaceAll) {
    throw new Error(
      `edit[${index}]: "oldString" appears ${occurrences} times, so the edit is ambiguous. ` +
        "Add more surrounding context to make it unique, or set replaceAll: true to change every occurrence.",
    );
  }

  if (spec.replaceAll) return { content: content.split(needle).join(replacement), strategy };
  // A function replacement keeps `$&`/`$1` in newString literal.
  return { content: content.replace(needle, () => replacement), strategy };
}

export const editTool: ToolDef = {
  name: "edit",
  description:
    "Replace exact text in an existing file. This is the preferred way to change code: it preserves the rest of the file " +
    "and produces a unified diff of the change. `oldString` must match the file EXACTLY — read the file first and copy " +
    "whitespace verbatim. The call fails if the text is missing, and fails when it appears more than once unless " +
    "`replaceAll: true` is set or you add more context. Use `edits` to apply several independent replacements atomically. " +
    "Refuses paths outside the working directory and requires permission.",
  parameters: PARAMETERS,
  destructive: true,
  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome> {
    const rawPath = input["filePath"];
    if (typeof rawPath !== "string" || rawPath.trim() === "") {
      return fail('Invalid input for "edit": field "filePath" must be a non-empty string.');
    }
    const parsed = parseEdits(input);
    if ("error" in parsed) return fail(parsed.error);

    let abs: string;
    try {
      abs = resolveInCwd(ctx, rawPath);
    } catch {
      return fail(`Refusing to edit outside the working directory: ${rawPath}`);
    }
    const rel = displayPath(ctx, abs);
    if (await escapesViaSymlink(ctx.cwd, abs)) {
      return fail(`Refusing to edit ${rel}: it resolves outside the working directory through a symlink.`);
    }

    let original: string;
    try {
      original = await fs.readFile(abs, "utf8");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return fail(`Could not read ${rel} for editing: ${message}`);
    }

    let updated = original;
    try {
      for (let index = 0; index < parsed.edits.length; index += 1) {
        const spec = parsed.edits[index];
        if (!spec) continue;
        updated = applyEdit(updated, spec, index).content;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return fail(`${rel}: ${message}`, { path: rel });
    }

    if (updated === original) {
      return { title: rel, output: `${rel} is unchanged after applying the edit.`, metadata: { unchanged: true } };
    }

    const preview = parsed.edits
      .slice(0, 3)
      .map((spec) => `- ${spec.oldString.split("\n")[0]}\n+ ${spec.newString.split("\n")[0]}`)
      .join("\n");

    const denied = await gate(ctx, {
      tool: "edit",
      title: `Edit ${rel}`,
      detail: abs,
      risk: "medium",
      preview,
    });
    if (denied) return denied;
    if (isAborted(ctx)) return abortedOutcome();

    try {
      await fs.writeFile(abs, updated, "utf8");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return fail(`Could not write ${rel}: ${message}`);
    }

    const stats = lineChanges(original, updated);
    let diff = createTwoFilesPatch(rel, rel, original, updated, "", "", { context: 3 });
    if (diff.length > MAX_DIFF_CHARS) {
      diff = `${diff.slice(0, MAX_DIFF_CHARS)}\n… (diff truncated)`;
    }

    ctx.progress({ tool: "edit", path: rel, edits: parsed.edits.length, added: stats.added, removed: stats.removed });
    return {
      title: rel,
      output: diff.trimEnd(),
      metadata: { path: rel, edits: parsed.edits.length, added: stats.added, removed: stats.removed },
    };
  },
};
