import { randomUUID, createHash } from "node:crypto";

/**
 * Prefixed, sortable-ish identifiers. We keep the opencode convention of a
 * readable prefix so ids are self-describing in logs and JSON files.
 */
export type IdPrefix = "ses" | "msg" | "prt" | "call" | "evt";

export function newId(prefix: IdPrefix): string {
  return `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 24)}`;
}

export function sessionId(): string {
  return newId("ses");
}

export function messageId(): string {
  return newId("msg");
}

export function partId(): string {
  return newId("prt");
}

export function callId(): string {
  return newId("call");
}

/** Short stable hash, used for cache keys and dedupe. */
export function shortHash(input: string, length = 12): string {
  return createHash("sha256").update(input).digest("hex").slice(0, length);
}
