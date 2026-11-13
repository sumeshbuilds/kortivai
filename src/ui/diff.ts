/**
 * Unified diff -> styled terminal string.
 *
 * Pure: the same string always renders the same output. Context lines stay
 * plain so added/removed lines carry the signal; hunk headers recede.
 */
import type { Theme } from "./theme.ts";

export interface DiffFileSummary {
  path: string;
  added: number;
  removed: number;
}

interface DiffFile {
  path: string;
  lines: string[];
}

const RE_GIT_HEADER = /^diff --git a\/(.+?) b\/(.+)$/;
const RE_FILE_HEADER = /^\+\+\+ (?:[ab]\/)?(.+)$/;

function parse(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  let current: DiffFile | null = null;
  const push = (line: string) => {
    current ??= { path: "", lines: [] };
    if (files[files.length - 1] !== current) files.push(current);
    current.lines.push(line);
  };

  for (const line of diff.split("\n")) {
    const gitHeader = RE_GIT_HEADER.exec(line);
    if (gitHeader) {
      current = { path: gitHeader[2]!, lines: [] };
      files.push(current);
      continue;
    }
    if (line.startsWith("--- ")) continue;
    const fileHeader = RE_FILE_HEADER.exec(line);
    if (fileHeader) {
      const path = fileHeader[1] === "/dev/null" ? "" : fileHeader[1]!;
      current ??= { path, lines: [] };
      if (files[files.length - 1] !== current) files.push(current);
      if (path) current.path = path;
      continue;
    }
    if (line === "" && current === null) continue;
    push(line);
  }
  return files;
}

export function parseDiffSummary(diff: string): DiffFileSummary[] {
  return parse(diff).map((file) => {
    let added = 0;
    let removed = 0;
    for (const line of file.lines) {
      if (line.startsWith("+++") || line.startsWith("---")) continue;
      if (line.startsWith("+")) added += 1;
      else if (line.startsWith("-")) removed += 1;
    }
    return { path: file.path, added, removed };
  });
}

/** Cheap sniff used by tool cards to choose the diff renderer. */
export function looksLikeDiff(text: string): boolean {
  return /^(diff --git |@@ -|--- |\+\+\+ |Index: )/m.test(text) && /^[+-]/m.test(text);
}

export function renderDiff(diff: string, theme: Theme): string {
  const files = parse(diff);
  const out: string[] = [];
  for (const file of files) {
    let added = 0;
    let removed = 0;
    for (const line of file.lines) {
      if (line.startsWith("+++") || line.startsWith("---")) continue;
      if (line.startsWith("+")) added += 1;
      else if (line.startsWith("-")) removed += 1;
    }
    const counts = [
      added ? theme.paint(`+${added}`, "added") : "",
      removed ? theme.paint(`-${removed}`, "removed") : "",
    ]
      .filter(Boolean)
      .join(" ");
    const title = theme.bold(file.path || "(diff)");
    out.push(`${theme.paint(theme.glyphs.pointer, "accentDim")} ${title}${counts ? `  ${counts}` : ""}`);

    for (const line of file.lines) {
      if (line.startsWith("+++") || line.startsWith("---")) continue;
      if (line.startsWith("@@")) out.push(theme.paint(line, "textFaint"));
      else if (line.startsWith("\\")) out.push(theme.paint(line, "textFaint"));
      else if (line.startsWith("+")) out.push(theme.paint(line, "added"));
      else if (line.startsWith("-")) out.push(theme.paint(line, "removed"));
      else out.push(theme.paint(line, "text"));
    }
  }
  return out.join("\n");
}
