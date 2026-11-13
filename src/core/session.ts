/**
 * Session persistence entry point.
 *
 * OWNER: session/mcp teammate. The exported signatures below are FROZEN.
 *
 * One JSON file per session (`<id>.json`, holding `{ session, messages }`)
 * written atomically, plus a small in-memory cache so the agent can stream
 * into a message it already appended without re-reading the file every time.
 *
 * Persistence is deliberately forgiving: a session file that cannot be parsed
 * is logged and skipped, never thrown out of startup or a session listing.
 */
import { rm } from "node:fs/promises";
import { basename, join } from "node:path";
import type { Message, Session, SessionId, SessionStore } from "../core/types.ts";
import { listDir, readTextOrNull, writeJsonAtomic } from "../util/fsx.ts";
import { messageId as newMessageId, sessionId as newSessionId } from "../util/ids.ts";
import type { Logger } from "../util/log.ts";
import { nullLogger } from "../util/log.ts";
import { sessionsDir } from "../util/paths.ts";

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
  /**
   * `list()` deliberately hides subagent sessions (mirrors opencode); pass
   * `true` for the full history.
   */
  list(includeSubagents?: boolean): Promise<Session[]>;
}

interface SessionFile {
  session: Session;
  messages: Message[];
}

function isSessionFile(name: string): boolean {
  return name.endsWith(".json") && !name.startsWith(".");
}

function parseSessionFile(parsed: unknown): SessionFile {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("not a session file");
  }
  const record = parsed as { session?: unknown; messages?: unknown };
  const session = record.session as Session | undefined;
  if (!session || typeof session !== "object" || typeof session.id !== "string" || !session.id) {
    throw new Error("missing session payload");
  }
  const messages = Array.isArray(record.messages) ? (record.messages as Message[]) : [];
  return { session, messages };
}

export function createSessionStore(options: SessionStoreOptions = {}): SessionStoreExtended {
  const dir = options.dir ?? sessionsDir();
  const logger = options.logger ?? nullLogger;
  const cache = new Map<SessionId, SessionFile>();

  /** Rejects ids that would escape the session directory. */
  function fileFor(id: SessionId): string | undefined {
    const name = `${id}.json`;
    if (!id || name !== basename(name)) return undefined;
    return join(dir, name);
  }

  async function readFromDisk(id: SessionId): Promise<SessionFile | undefined> {
    const path = fileFor(id);
    if (!path) return undefined;
    const raw = await readTextOrNull(path);
    if (raw === null) return undefined;
    try {
      return parseSessionFile(JSON.parse(raw) as unknown);
    } catch (error) {
      logger.warn(`skipping unreadable session file ${path}`, error);
      return undefined;
    }
  }

  async function load(id: SessionId): Promise<SessionFile | undefined> {
    const cached = cache.get(id);
    if (cached) return cached;
    const record = await readFromDisk(id);
    if (record) cache.set(record.session.id, record);
    return record;
  }

  async function persist(record: SessionFile): Promise<void> {
    const path = fileFor(record.session.id);
    if (!path) throw new Error(`Invalid session id "${record.session.id}"`);
    await writeJsonAtomic(path, { session: record.session, messages: record.messages });
  }

  const store: SessionStoreExtended = {
    async create(init) {
      const now = Date.now();
      const session: Session = { ...init, id: newSessionId(), createdAt: now, updatedAt: now };
      const record: SessionFile = { session, messages: [] };
      await persist(record);
      cache.set(session.id, record);
      return session;
    },

    async get(id) {
      return (await load(id))?.session;
    },

    async list(includeSubagents = false) {
      let entries: { name: string; dir: boolean }[];
      try {
        entries = await listDir(dir);
      } catch {
        // A missing sessions directory simply means "no sessions yet".
        return [];
      }
      const out: Session[] = [];
      for (const entry of entries) {
        if (entry.dir || !isSessionFile(entry.name)) continue;
        const id = entry.name.slice(0, -".json".length);
        const record = cache.get(id) ?? (await readFromDisk(id));
        if (!record) continue;
        cache.set(record.session.id, record);
        if (!includeSubagents && record.session.tags?.includes("subagent")) continue;
        out.push(record.session);
      }
      return out.sort(
        (a, b) =>
          b.updatedAt - a.updatedAt ||
          b.createdAt - a.createdAt ||
          a.id.localeCompare(b.id),
      );
    },

    async save(session) {
      const record = cache.get(session.id) ?? (await load(session.id));
      const next: SessionFile = { session, messages: record?.messages ?? [] };
      await persist(next);
      cache.set(session.id, next);
    },

    async delete(id) {
      cache.delete(id);
      const path = fileFor(id);
      if (!path) return;
      try {
        await rm(path, { force: true });
      } catch (error) {
        logger.warn(`failed to delete session file ${path}`, error);
      }
    },

    async append(sessionId, message) {
      const record = await load(sessionId);
      if (!record) throw new Error(`Unknown session ${sessionId}`);
      if (!message.id) message.id = newMessageId();
      if (!message.sessionId) message.sessionId = sessionId;
      record.messages.push(message);
      record.session.updatedAt = Date.now();
      await persist(record);
      return message;
    },

    async messages(sessionId) {
      const record = await load(sessionId);
      return record ? [...record.messages] : [];
    },

    async update(sessionId, message) {
      const record = await load(sessionId);
      if (!record) throw new Error(`Unknown session ${sessionId}`);
      const index = record.messages.findIndex((entry) => entry.id === message.id);
      if (index >= 0) record.messages[index] = message;
      else record.messages.push(message);
      record.session.updatedAt = Date.now();
      await persist(record);
    },

    async latest() {
      const sessions = await store.list();
      return sessions[0];
    },

    async rename(id, title) {
      const record = await load(id);
      if (!record) throw new Error(`Unknown session ${id}`);
      record.session.title = title;
      record.session.updatedAt = Date.now();
      await persist(record);
    },

    async prune(days) {
      if (!Number.isFinite(days) || days < 0) return 0;
      const cutoff = Date.now() - days * 86_400_000;
      let removed = 0;
      for (const session of await store.list(true)) {
        if (session.updatedAt >= cutoff) continue;
        await store.delete(session.id);
        removed += 1;
      }
      return removed;
    },
  };

  return store;
}

/** Builds a short title from the first user prompt. */
export function deriveTitle(prompt: string, maxLength = 60): string {
  const firstLine = prompt.trim().split(/\r?\n/).find((line) => line.trim().length > 0) ?? "";
  const collapsed = firstLine.replace(/\s+/g, " ").trim();
  if (collapsed.length <= maxLength) return collapsed || "New session";
  return `${collapsed.slice(0, maxLength - 1).trimEnd()}...`;
}
