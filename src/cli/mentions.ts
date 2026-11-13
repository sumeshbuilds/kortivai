/**
 * `@path` mentions: resolves an explicit file reference in a prompt into
 * attached file content, the way opencode does. Pure discovery is separate from
 * I/O so the token rule can be tested without touching disk.
 */
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { isInside, toPosix } from "../util/paths.ts";

export interface MentionAttachment {
  path: string;
  content: string;
  bytes: number;
  truncated: boolean;
}

/** Largest single attached file, and the total budget across one message. */
const PER_FILE_LIMIT = 60_000;
const TOTAL_LIMIT = 160_000;

// A mention starts the prompt or follows whitespace/open punctuation. The
// word-character boundary is what keeps `me@example.com` from counting.
const MENTION = /(?:^|[\s([{},;:])@([^\s@]+)/g;

/** Extracts de-duplicated `@path` tokens from a prompt, in first-seen order. */
export function extractMentions(prompt: string): string[] {
  const found: string[] = [];
  for (const match of prompt.matchAll(MENTION)) {
    // Strip sentence punctuation the mention may have swallowed, e.g. the "?"
    // in "explain @src/a.ts?".
    const raw = (match[1] ?? "").replace(/[.,;:?!)\]}"']+$/, "");
    if (raw === "" || found.includes(raw)) continue;
    found.push(raw);
  }
  return found;
}

/**
 * Reads each mentioned file that exists inside `cwd`. Missing paths and
 * directories are skipped silently: a mention is a hint, never an error.
 */
export async function collectAttachments(
  prompt: string,
  cwd: string,
): Promise<MentionAttachment[]> {
  const attachments: MentionAttachment[] = [];
  let total = 0;

  for (const mention of extractMentions(prompt)) {
    if (!isInside(cwd, mention)) continue;
    const absolute = resolve(cwd, mention);
    try {
      const info = await stat(absolute);
      if (!info.isFile()) continue;
      const raw = await readFile(absolute, "utf8");
      const budget = Math.min(PER_FILE_LIMIT, TOTAL_LIMIT - total);
      if (budget <= 0) break;
      const content = raw.length > budget ? raw.slice(0, budget) : raw;
      total += content.length;
      attachments.push({
        path: toPosix(mention),
        content,
        bytes: info.size,
        truncated: content.length < raw.length,
      });
    } catch {
      // Not a readable file at that path: treat the mention as plain text.
    }
  }

  return attachments;
}

/** Renders attachments into the block appended to the user's message. */
export function renderAttachments(attachments: MentionAttachment[]): string {
  if (attachments.length === 0) return "";
  const blocks = attachments.map((attachment) => {
    const note = attachment.truncated ? ` (truncated to ${attachment.content.length} chars)` : "";
    return `<file path="${attachment.path}"${note}>\n${attachment.content}\n</file>`;
  });
  return `<attached-files>\n${blocks.join("\n")}\n</attached-files>`;
}

/** Rewrites a prompt into the text actually sent to the model. */
export function withAttachments(prompt: string, attachments: MentionAttachment[]): string {
  const rendered = renderAttachments(attachments);
  return rendered === "" ? prompt : `${prompt}\n\n${rendered}`;
}
