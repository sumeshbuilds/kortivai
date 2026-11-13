import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Message, Part, ResolvedConfig } from "../src/core/types.ts";
import { createSessionStore, deriveTitle } from "../src/core/session.ts";
import { connectMcpServer, createMcpManager } from "../src/mcp/index.ts";
import { nullLogger } from "../src/util/log.ts";

let root = "";

before(() => {
  root = mkdtempSync(join(process.cwd(), ".kortivai-session-test-"));
  // Never write to the real user profile from a test.
  process.env.KORTIVAI_HOME = root;
});

after(() => {
  delete process.env.KORTIVAI_HOME;
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    // A leftover handle must not fail the suite.
  }
});

function tempDir(name: string): string {
  const path = join(root, name);
  mkdirSync(path, { recursive: true });
  return path;
}

function textPart(text: string): Part {
  return { type: "text", id: `prt_${Math.random().toString(16).slice(2)}`, text };
}

function newMessage(sessionId: string, text: string, id = ""): Message {
  return {
    id,
    sessionId,
    role: "user",
    parts: [textPart(text)],
    createdAt: Date.now(),
  };
}

function textOf(message: Message | undefined): string {
  return (message?.parts ?? [])
    .filter((part): part is Extract<Part, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("");
}

function init(title = "New session") {
  return {
    title,
    cwd: root,
    agent: "build",
    model: { provider: "test", model: "test-model" },
  };
}

describe("deriveTitle", () => {
  test("keeps short prompts and collapses whitespace", () => {
    assert.equal(deriveTitle("Fix the   login bug"), "Fix the login bug");
    assert.equal(deriveTitle("  \n\n  second line \n third"), "second line");
  });

  test("falls back to a default for empty input", () => {
    assert.equal(deriveTitle("   "), "New session");
  });

  test("truncates long prompts to maxLength with an ellipsis", () => {
    const long = "a".repeat(100);
    const title = deriveTitle(long, 20);
    assert.equal(title, `${"a".repeat(19)}...`);
    assert.equal(title.length, 22);
  });
});

describe("session store", () => {
  test("create/get round-trips and save persists edits", async () => {
    const store = createSessionStore({ dir: tempDir("create"), logger: nullLogger });
    const session = await store.create(init("hello"));

    assert.match(session.id, /^ses_/);
    assert.equal(session.createdAt, session.updatedAt);
    assert.ok(session.createdAt > 0);
    assert.deepEqual(await store.get(session.id), session);
    assert.equal(await store.get("ses_missing"), undefined);

    session.title = "renamed";
    session.updatedAt = Date.now() + 1000;
    await store.save(session);
    assert.equal((await store.get(session.id))?.title, "renamed");
  });

  test("append assigns a missing id and update replaces by id", async () => {
    const store = createSessionStore({ dir: tempDir("append"), logger: nullLogger });
    const session = await store.create(init());

    const first = await store.append(session.id, newMessage("", "one"));
    assert.match(first.id, /^msg_/);
    assert.equal(first.sessionId, session.id);

    const second = await store.append(session.id, newMessage(session.id, "two", "msg_fixed"));
    assert.equal(second.id, "msg_fixed");

    const stored = await store.messages(session.id);
    assert.equal(stored.length, 2);
    assert.deepEqual(
      stored.map((entry) => entry.id),
      [first.id, "msg_fixed"],
    );

    // The agent streams into the message it already appended.
    second.parts.push(textPart("+more"));
    second.parts[0] = textPart("TWO");
    await store.update(session.id, second);

    const updated = await store.messages(session.id);
    assert.equal(updated.length, 2);
    assert.equal(textOf(updated[1]), "TWO+more");
    assert.equal(await store.append("ses_nope", newMessage("ses_nope", "x")).catch(() => "threw"), "threw");
  });

  test("persists across store instances", async () => {
    const dir = tempDir("persist");
    const writer = createSessionStore({ dir, logger: nullLogger });
    const session = await writer.create(init("persisted"));
    await writer.append(session.id, newMessage(session.id, "remember me"));

    const reader = createSessionStore({ dir, logger: nullLogger });
    assert.equal((await reader.get(session.id))?.title, "persisted");
    const messages = await reader.messages(session.id);
    assert.equal(messages.length, 1);
    assert.equal(textOf(messages[0]), "remember me");
  });

  test("list hides subagent sessions, sorts newest first, and latest() mirrors it", async () => {
    const store = createSessionStore({ dir: tempDir("list"), logger: nullLogger });
    const first = await store.create(init("first"));
    const sub = await store.create({ ...init("sub"), tags: ["subagent"], parentId: first.id });
    const second = await store.create(init("second"));
    second.updatedAt = Date.now() + 60_000;
    await store.save(second);

    const visible = await store.list();
    assert.deepEqual(
      visible.map((entry) => entry.id),
      [second.id, first.id],
    );
    assert.ok(!visible.some((entry) => entry.id === sub.id));

    const all = await store.list(true);
    assert.equal(all.length, 3);
    assert.equal((await store.latest())?.id, second.id);
  });

  test("rename, delete and prune", async () => {
    const store = createSessionStore({ dir: tempDir("lifecycle"), logger: nullLogger });
    const stale = await store.create(init("stale"));
    stale.updatedAt = Date.now() - 10 * 86_400_000;
    await store.save(stale);
    const fresh = await store.create(init("fresh"));

    await store.rename(fresh.id, "renamed fresh");
    assert.equal((await store.get(fresh.id))?.title, "renamed fresh");

    assert.equal(await store.prune(5), 1);
    assert.equal(await store.get(stale.id), undefined);
    assert.ok(await store.get(fresh.id));

    await store.delete(fresh.id);
    assert.equal(await store.get(fresh.id), undefined);
    assert.deepEqual(await store.list(), []);
  });

  test("corrupt or malformed session files are skipped, never thrown", async () => {
    const dir = tempDir("corrupt");
    const store = createSessionStore({ dir, logger: nullLogger });
    const good = await store.create(init("good"));

    writeFileSync(join(dir, "corrupt.json"), "{ this is not json", "utf8");
    writeFileSync(join(dir, "missing-payload.json"), JSON.stringify({ messages: [] }), "utf8");
    writeFileSync(join(dir, "notes.txt"), "not a session", "utf8");

    const listed = await store.list(true);
    assert.deepEqual(
      listed.map((entry) => entry.id),
      [good.id],
    );
    assert.equal(await store.get("corrupt"), undefined);

    // A fresh store pointed at the same directory must also survive it.
    const reader = createSessionStore({ dir, logger: nullLogger });
    assert.deepEqual(
      (await reader.list()).map((entry) => entry.id),
      [good.id],
    );
  });
});

describe("mcp manager graceful degradation", () => {
  test("unreachable servers report error and contribute no tools", async () => {
    const config: ResolvedConfig = {
      cwd: root,
      sources: [],
      mcp: {
        ghost: { type: "local", command: "kortivai-definitely-not-a-real-binary-xyz" },
        offline: { type: "remote", url: "http://127.0.0.1:9/mcp" },
        skipped: { type: "local", command: "echo", enabled: false },
      },
    };

    const manager = createMcpManager({ config, logger: nullLogger });
    await assert.doesNotReject(() => manager.connectAll());

    const statuses = manager.status();
    const ghost = statuses.find((entry) => entry.server === "ghost");
    const offline = statuses.find((entry) => entry.server === "offline");
    assert.equal(ghost?.status, "error");
    assert.ok(ghost?.error);
    assert.equal(offline?.status, "error");
    assert.equal(manager.tools().length, 0);
    assert.ok(!statuses.some((entry) => entry.server === "skipped"));

    // Repeated close/reload must stay safe.
    await manager.closeAll();
    await manager.closeAll();
    await assert.doesNotReject(() => manager.reload());
    assert.equal(manager.tools().length, 0);
    await manager.closeAll();
  });

  test("a malformed server config degrades without throwing", async () => {
    const config: ResolvedConfig = {
      cwd: root,
      sources: [],
      mcp: { broken: { type: "remote" } },
    };
    const manager = createMcpManager({ config, logger: nullLogger });
    await assert.doesNotReject(() => manager.connectAll());

    const status = manager.status().find((entry) => entry.server === "broken");
    assert.equal(status?.status, "error");
    assert.ok(status?.error);
    assert.equal(manager.tools().length, 0);
    await manager.closeAll();
  });

  test("connectMcpServer degrades instead of throwing", async () => {
    const client = await connectMcpServer("broken", { type: "remote" }, nullLogger);
    assert.equal(client.server, "broken");
    assert.equal(client.status, "error");
    assert.ok(client.error);
    assert.deepEqual(await client.listTools(), []);

    const outcome = await client.callTool("anything", {});
    assert.equal(outcome.isError, true);

    await client.close();
    await client.close();
    assert.equal(client.status, "disconnected");
  });

  test("enabled servers with no tools contribute nothing but stay reported", async () => {
    const config: ResolvedConfig = {
      cwd: root,
      sources: [],
      mcp: { ghost: { type: "local", command: "kortivai-definitely-not-a-real-binary-xyz", trusted: true } },
    };
    const manager = createMcpManager({
      config,
      logger: nullLogger,
      askBeforeCall: async () => true,
    });
    await manager.connectAll();
    assert.equal(manager.tools().length, 0);
    assert.equal(manager.status().length, 1);
    await manager.closeAll();
  });
});
