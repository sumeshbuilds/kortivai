/** Working-directory file discovery used by `@path` completion. */
import { readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

const DEFAULT_IGNORES = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  ".next",
  ".turbo",
  ".cache",
]);

export interface WalkOptions {
  limit?: number;
  maxDepth?: number;
  ignore?: string[];
}

/**
 * Relative, posix-style file paths, breadth-first so shallow files complete
 * first. Directory reads that fail (permissions, races) are skipped.
 */
export function walkFiles(root: string, options: WalkOptions = {}): string[] {
  const limit = options.limit ?? 4000;
  const maxDepth = options.maxDepth ?? 6;
  const ignore = new Set([...DEFAULT_IGNORES, ...(options.ignore ?? [])]);
  const out: string[] = [];
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];

  while (queue.length > 0 && out.length < limit) {
    const current = queue.shift()!;
    let entries: ReturnType<typeof readdirSync>;
    try {
      entries = readdirSync(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") && entry.name !== ".env.example") continue;
      if (ignore.has(entry.name)) continue;
      const absolute = join(current.dir, entry.name);
      if (entry.isDirectory()) {
        if (current.depth < maxDepth) queue.push({ dir: absolute, depth: current.depth + 1 });
        continue;
      }
      if (!entry.isFile()) continue;
      out.push(relative(root, absolute).split(sep).join("/"));
      if (out.length >= limit) break;
    }
  }
  return out.sort((a, b) => a.localeCompare(b));
}
