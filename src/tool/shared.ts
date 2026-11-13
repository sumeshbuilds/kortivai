/**
 * Shared plumbing for the built-in tools: the permission gate, path
 * containment, output normalisation and an ignore-aware directory walker.
 *
 * Every side-effecting tool calls {@link gate} before it touches anything.
 */
import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { diffLines } from "diff";
import type { PermissionRequest, ToolContext, ToolOutcome } from "../core/types.ts";
import { assertInside, isInside, relativeTo } from "../util/paths.ts";

/** Long lines are cut so one minified file cannot flood the transcript. */
export const MAX_LINE_CHARS = 2000;

/** Directories no built-in search or listing descends into by default. */
export const DEFAULT_IGNORES: ReadonlySet<string> = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
  ".parcel-cache",
  ".venv",
  "venv",
  "__pycache__",
  "target",
  "vendor",
  ".idea",
]);

export interface GateRequest {
  tool: string;
  /** Short imperative question shown to the user. */
  title: string;
  /** Concrete subject: the absolute path, command or URL. */
  detail: string;
  risk: "low" | "medium" | "high";
  preview?: string;
}

/** Builds a non-throwing error outcome so the model sees a readable reason. */
export function fail(message: string, metadata?: Record<string, unknown>): ToolOutcome {
  return metadata ? { output: message, isError: true, metadata } : { output: message, isError: true };
}

/** True when the caller aborted before we did anything observable. */
export function isAborted(ctx: ToolContext): boolean {
  return ctx.signal.aborted;
}

export function abortedOutcome(): ToolOutcome {
  return { output: "Aborted before the tool ran.", isError: true, metadata: { aborted: true } };
}

/**
 * Resolves a request to a decision and, when denied, returns the refusal
 * outcome the tool should hand back. Returns undefined when allowed.
 *
 * A denial is marked with `metadata.denied` so the runtime can render the
 * call as `denied` rather than a generic failure.
 */
export async function gate(ctx: ToolContext, request: GateRequest): Promise<ToolOutcome | undefined> {
  const full: PermissionRequest = { sessionId: ctx.sessionId, ...request };
  const decision = await ctx.permission.check(full);
  if (decision !== "deny") return undefined;
  return {
    title: request.title,
    output: `Permission denied: ${request.detail}`,
    isError: true,
    metadata: { denied: true, tool: request.tool },
  };
}

/** Absolute path that must stay inside the session root. */
export function resolveInCwd(ctx: ToolContext, path: string): string {
  return assertInside(ctx.cwd, path);
}

/**
 * `assertInside` only compares the literal path. A symlink inside the
 * workspace can still lead outside it, so resolve the deepest existing
 * ancestor and re-check. Returns true when the path escapes.
 */
export async function escapesViaSymlink(root: string, candidate: string): Promise<boolean> {
  let current = candidate;
  for (;;) {
    try {
      return !isInside(root, await fs.realpath(current));
    } catch {
      const parent = dirname(current);
      if (parent === current) return false;
      current = parent;
    }
  }
}

/** Posix-style path relative to the session root, for transcripts. */
export function displayPath(ctx: ToolContext, absolute: string): string {
  return relativeTo(ctx.cwd, absolute);
}

export function truncateLine(line: string, max = MAX_LINE_CHARS): string {
  if (line.length <= max) return line;
  return `${line.slice(0, max)}… (line truncated, ${line.length} chars)`;
}

export function isIgnoredName(name: string): boolean {
  return DEFAULT_IGNORES.has(name);
}

/** Number of lines in a diff chunk, tolerating a missing trailing newline. */
function lineCount(value: string): number {
  if (value === "") return 0;
  const trimmed = value.endsWith("\n") ? value.slice(0, -1) : value;
  return trimmed.split("\n").length;
}

export interface LineChangeSummary {
  added: number;
  removed: number;
}

/** `+added -removed` counts used for write/edit/patch summaries. */
export function lineChanges(oldText: string, newText: string): LineChangeSummary {
  let added = 0;
  let removed = 0;
  for (const change of diffLines(oldText, newText)) {
    const count = change.count ?? lineCount(change.value);
    if (change.added) added += count;
    else if (change.removed) removed += count;
  }
  return { added, removed };
}

export interface WalkedFile {
  abs: string;
  /** Path relative to the walk root, posix separators. */
  rel: string;
  name: string;
}

export interface WalkOptions {
  signal?: AbortSignal;
  /** Overrides the default ignore predicate for directory names. */
  skipDir?: (name: string) => boolean;
  /** Hard cap on yielded files; stops the walk early. */
  maxFiles?: number;
}

/**
 * Depth-first walk of regular files under `root`. Symlinks are skipped: a
 * symlinked directory could otherwise carry a tool outside the session root.
 */
export async function* walkFiles(root: string, options: WalkOptions = {}): AsyncGenerator<WalkedFile> {
  const skipDir = options.skipDir ?? isIgnoredName;
  const maxFiles = options.maxFiles ?? Number.POSITIVE_INFINITY;
  let yielded = 0;

  async function* recurse(dir: string): AsyncGenerator<WalkedFile> {
    if (options.signal?.aborted || yielded >= maxFiles) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (options.signal?.aborted || yielded >= maxFiles) return;
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (skipDir(entry.name)) continue;
        yield* recurse(abs);
      } else if (entry.isFile()) {
        yielded += 1;
        yield { abs, rel: relativeTo(root, abs), name: entry.name };
      }
    }
  }

  yield* recurse(root);
}

export interface TextFile {
  text: string;
  bytes: number;
  binary: boolean;
}

/** Reads a file for text tools, sniffing for NUL bytes without decoding them. */
export async function readTextFile(abs: string): Promise<TextFile> {
  const buffer = await fs.readFile(abs);
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
  const binary = sample.includes(0);
  return { text: binary ? "" : buffer.toString("utf8"), bytes: buffer.length, binary };
}

/** First `maxLines` lines of `text`, used for permission previews. */
export function previewLines(text: string, maxLines = 12, maxChars = 1200): string {
  const lines = text.split("\n");
  const head = lines.slice(0, maxLines).join("\n");
  const clipped = head.length > maxChars ? `${head.slice(0, maxChars)}…` : head;
  return lines.length > maxLines ? `${clipped}\n… (${lines.length - maxLines} more lines)` : clipped;
}
