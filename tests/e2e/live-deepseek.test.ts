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
      // Tool calls may land in earlier assistant messages, so inspect the whole
      // persisted session rather than only the final message.
      const history = await runtime.sessions.messages(session.id);
      const toolParts = history.flatMap((entry) =>
        entry.parts.filter((part) => part.type === "tool"),
      );
      assert.ok(
        toolParts.length > 0,
        `expected the agent to call tools, got: ${history
          .map((entry) => entry.parts.map((part) => part.type).join("+"))
          .join(" | ")}`,
      );
      // File-mutating and reading tools must all succeed. `bash` is allowed to
      // fail only for the documented sandbox limitation (a piped child process
      // is refused with EPERM here); any other failure is a real defect.
      const sandboxBash = new Set<string>();
      for (const part of toolParts) {
        if (part.type !== "tool") continue;
        if (part.status === "error") {
          const isSandboxSpawn = part.name === "bash" && /EPERM/i.test(part.error ?? "");
          if (isSandboxSpawn) {
            sandboxBash.add(part.name);
            continue;
          }
          assert.fail(`tool ${part.name} failed: ${part.error ?? ""}`);
        }
        assert.equal(part.status, "completed", `tool ${part.name} ended as ${part.status}`);
      }
      assert.ok(
        toolParts.some((part) => part.type === "tool" && part.name === "edit"),
        `expected an edit call, saw: ${toolParts.map((part) => (part.type === "tool" ? part.name : "")).join(",")}`,
      );
      if (sandboxBash.size > 0) {
        console.log("note: bash could not spawn in this sandbox (EPERM); file edits ran normally.");
      }

      // Session state must be durable, not just in memory.
      const persisted = await runtime.sessions.get(session.id);
      assert.ok(persisted, "the session must be persisted to disk");
      assert.ok(history.length >= 2, "the session must contain the user turn and the assistant turn");
      assert.ok(!message.error, `the final message reported an error: ${message.error ?? ""}`);

      const answer = history
        .filter((entry) => entry.role === "assistant")
        .map((entry) =>
          entry.parts
            .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
            .map((part) => part.text)
            .join(""),
        )
        .filter((text) => text.trim().length > 0)
        .join("\n\n");
      assert.ok(answer.trim().length > 0, "the agent produced no text output");
      console.log(`\n--- live agent output ---\n${answer.trim()}\n-------------------------\n`);
    } finally {
      await runtime.close();
      await rm(home, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  },
);
