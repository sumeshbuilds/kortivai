/**
 * Live end-to-end proof against a real model provider.
 *
 * Skipped unless explicitly enabled, because it spends real tokens and needs
 * a real key:
 *
 *   KORTIVAI_LIVE_TEST=1 DEEPSEEK_API_KEY=sk-... \
 *     node --experimental-test-isolation=none --test tests/e2e/live-deepseek.test.ts
 *
 * This is the only test that proves the agent is genuinely *workable*:
 * a real model, the real provider transport, the real agent loop, the real
 * tool registry, real permissions and real session persistence, asked to do
 * a real filesystem task which is then verified from outside the agent.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createKortivRuntime } from "../../src/core/wiring.ts";

const enabled = process.env.KORTIVAI_LIVE_TEST === "1" && Boolean(process.env.DEEPSEEK_API_KEY);
const model = process.env.KORTIVAI_LIVE_MODEL ?? "deepseek/deepseek-chat";

test(
  `live: a real model fixes a real bug through the real tool chain (${model})`,
  { skip: enabled ? false : "set KORTIVAI_LIVE_TEST=1 and DEEPSEEK_API_KEY to run" },
  async () => {
    const home = await mkdtemp(join(tmpdir(), "kortivai-live-home-"));
    const cwd = await mkdtemp(join(tmpdir(), "kortivai-live-cwd-"));
    process.env.KORTIVAI_HOME = home;

    const runtime = await createKortivRuntime({
      cwd,
      autoApprove: true,
      skipMcp: true,
      overrides: { model, maxSteps: 12, ui: { showReasoning: false } },
    });

    try {
      // A small, unambiguous bug: `add` subtracts.
      await writeFile(
        join(cwd, "math.js"),
        [
          "export function add(a, b) {",
          "  return a - b;",
          "}",
          "",
          "export function mul(a, b) {",
          "  return a * b;",
          "}",
          "",
        ].join("\n"),
        "utf8",
      );

      const session = await runtime.agents.createSession();
      const texts: string[] = [];
      runtime.events.subscribe((event) => {
        if (event.type === "part.update" && event.part.type === "text") {
          texts.push(event.part.text);
        }
      });

      const message = await runtime.agents.run({
        sessionId: session.id,
        prompt:
          "The exported `add` function in math.js is wrong. Fix it so that add(2, 3) returns 5, and change nothing else in the file.",
      });

      assert.ok(!message.error, `turn failed: ${message.error ?? ""}`);

      const fixed = await readFile(join(cwd, "math.js"), "utf8");
      assert.match(fixed, /return a \+ b;/, `the model did not fix the bug; file is:\n${fixed}`);
      assert.match(fixed, /return a \* b;/, "the unrelated function was modified");

      // The transcript must show the agent actually used tools, not just talked.
      const toolEvents = message.parts.filter((part) => part.type === "tool");
      assert.ok(
        toolEvents.length > 0,
        `expected the agent to call tools, got parts: ${message.parts.map((p) => p.type).join(",")}`,
      );
      for (const part of toolEvents) {
        if (part.type === "tool") {
          assert.notEqual(part.status, "error", `tool ${part.name} failed: ${part.error ?? ""}`);
        }
      }

      // Session state must be durable, not just in memory.
      const persisted = await runtime.sessions.get(session.id);
      assert.ok(persisted, "the session must be persisted to disk");
      const messages = await runtime.sessions.messages(session.id);
      assert.ok(messages.length >= 2, "the session must contain the user turn and the assistant turn");

      const answer = texts.join("");
      assert.ok(answer.trim().length > 0, "the agent produced no text output");
      console.log(`\n--- live agent output ---\n${answer.trim()}\n-------------------------\n`);
    } finally {
      await runtime.close();
      await rm(home, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  },
);
