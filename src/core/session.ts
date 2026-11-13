/**
 * Session persistence entry point.
 *
 * OWNER: session/mcp teammate. The exported signatures below are FROZEN.
 */
import type { Session, SessionId, SessionStore } from "../core/types.ts";
import type { Logger } from "../util/log.ts";

export interface SessionStoreOptions {
  /** Root directory for session files. Defaults to `<home>/state/sessions`. */
  dir?: string;
  logger?: Logger;
}

export interface SessionStoreExtended extends SessionStore {
  /** Most recently updated session that is not a subagent session. */
  latest(): Promise<Session | undefined>;
  /** Renames a session; used by the auto-title pass. */
  rename(id: SessionId, title: string): Promise<void>;
  /** Removes sessions older than `days`; returns how many were deleted. */
  prune(days: number): Promise<number>;
}

export function createSessionStore(_options: SessionStoreOptions = {}): SessionStoreExtended {
  throw new Error("createSessionStore is not implemented yet");
}

/** Builds a short title from the first user prompt. */
export function deriveTitle(prompt: string, maxLength = 60): string {
  const firstLine = prompt.trim().split(/\r?\n/).find((line) => line.trim().length > 0) ?? "";
  const collapsed = firstLine.replace(/\s+/g, " ").trim();
  if (collapsed.length <= maxLength) return collapsed || "New session";
  return `${collapsed.slice(0, maxLength - 1).trimEnd()}…`;
}
