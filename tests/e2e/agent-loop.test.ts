/**
 * End-to-end acceptance tests for the KortivAI agent loop.
 *
 * These drive the REAL loop, REAL tool registry, REAL permission manager and
 * REAL session store, with only the model provider scripted. They are the
 * proof that the layers actually compose â€” unit tests per module cannot show
 * that.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createHarness, eventsOfType } from "./harness.ts";

test("e2e: a text-only turn streams, persists and reports usage", async () => {
  const harness = await createHarness({
    turns: [{ textChunks: ["Hello", ", ", "world"], usage: { input: 12, output: 3 } }],
  });
  try {
    const text = await harness.run("Say hello");
    assert.equal(text, "Hello, world");

    const messages = await harness.sessions.messages(harness.sessionId);
    assert.equal(messages.length, 2, "one user + one assistant message");
    assert.equal(messages[0]!.role, "user");
    assert.equal(messages[1]!.role, "assistant");

    // Streaming must surface the text more than once, not as a single blob.
    const textUpdates = eventsOfType(harness.events, "part.update").filter(
      (event) => event.part.type === "text",
    );
    assert.ok(textUpdates.length >= 3, `expected >=3 streamed text updates, got ${textUpdates.length}`);

    const session = await harness.sessions.get(harness.sessionId);
    assert.equal(session?.usage?.input, 12);
    assert.equal(session?.usage?.output, 3);

    const ends = eventsOfType(harness.events, "session.end");
    assert.equal(ends.length, 1);
    assert.equal(ends[0]!.reason, "done");
  } finally {
    await harness.cleanup();
  }
});

test("e2e: the agent writes a file through the real write tool", async () => {
  const harness = await createHarness({
    turns: [
      { toolCalls: [{ name: "write", input: { filePath: "out/hello.txt", content: "from the agent\n" } }] },
      { text: "Wrote out/hello.txt." },
    ],
  });
  try {
    const text = await harness.run("Create out/hello.txt");
    assert.equal(text, "Wrote out/hello.txt.");

    const written = await readFile(join(harness.cwd, "out", "hello.txt"), "utf8");
    assert.equal(written, "from the agent\n");

    const assistant = (await harness.sessions.messages(harness.sessionId))[1]!;
    const toolPart = assistant.parts.find((part) => part.type === "tool");
    assert.ok(toolPart, "the assistant message must carry a tool part");
    assert.equal(toolPart.status, "completed");

    // The tool result must be fed back to the model on the next round-trip.
    assert.equal(harness.provider.callCount, 2);
    const second = harness.provider.requests[1]!;
    const toolResult = second.messages.find((message) => message.role === "tool");
    assert.ok(toolResult, "second request must include the tool result");
    if (toolResult?.role === "tool") {
      assert.equal(toolResult.results[0]!.isError, false);
      assert.ok(toolResult.results[0]!.name === "write");
    }

    // The model must actually have been offered the tool schema.
    const names = harness.provider.requests[0]!.tools.map((tool) => tool.name);
    assert.ok(names.includes("write"), `write tool missing from schema: ${names.join(",")}`);
    assert.ok(names.includes("read"));
    assert.ok(names.includes("bash"));
  } finally {
    await harness.cleanup();
  }
});

test("e2e: the agent reads then edits an existing file", async () => {
  const harness = await createHarness({
    turns: [
      { toolCalls: [{ name: "read", input: { filePath: "src/app.ts" } }] },
      {
        toolCalls: [
          {
            name: "edit",
            input: {
              filePath: "src/app.ts",
              edits: [{ oldString: "const port = 3000;", newString: "const port = 8080;" }],
            },
          },
        ],
      },
      { text: "Changed the port to 8080." },
    ],
  });
  try {
    await mkdir(join(harness.cwd, "src"), { recursive: true });
    await writeFile(join(harness.cwd, "src", "app.ts"), "const port = 3000;\nconsole.log(port);\n");

    const text = await harness.run("Change the port to 8080");
    assert.equal(text, "Changed the port to 8080.");

    const updated = await readFile(join(harness.cwd, "src", "app.ts"), "utf8");
    assert.equal(updated, "const port = 8080;\nconsole.log(port);\n");

    // Read tool output must have reached the model before the edit decision.
    const second = harness.provider.requests[1]!;
    const toolResult = second.messages.find((message) => message.role === "tool");
    assert.ok(toolResult && toolResult.role === "tool");
    assert.match(toolResult.results[0]!.content, /const port = 3000;/);
  } finally {
    await harness.cleanup();
  }
});

test("e2e: a denied permission prevents the side effect and reports the block", async () => {
  const harness = await createHarness({
    turns: [
      { toolCalls: [{ name: "write", input: { filePath: "secret.txt", content: "should not exist" } }] },
      { text: "I was not allowed to write that file." },
    ],
    answers: ["deny"],
  });
  try {
    await harness.run("Write secret.txt");

    await assert.rejects(
      () => readFile(join(harness.cwd, "secret.txt"), "utf8"),
      /ENOENT/,
      "a denied write must not create the file",
    );

    assert.equal(harness.asker.requests.length, 1, "the user must be asked exactly once");
    assert.equal(harness.asker.requests[0]!.tool, "write");

    const resolved = eventsOfType(harness.events, "permission.resolved");
    assert.equal(resolved.length, 1);
    assert.equal(resolved[0]!.decision, "deny");

    const assistant = (await harness.sessions.messages(harness.sessionId))[1]!;
    const toolPart = assistant.parts.find((part) => part.type === "tool");
    assert.equal(toolPart?.status, "error");

    // The model must be told it failed, so it can adapt rather than retry blindly.
    const second = harness.provider.requests[1]!;
    const toolResult = second.messages.find((message) => message.role === "tool");
    assert.ok(toolResult && toolResult.role === "tool");
    assert.equal(toolResult.results[0]!.isError, true);
  } finally {
    await harness.cleanup();
  }
});

test("e2e: the read-only plan agent cannot write even with auto-approve", async () => {
  const harness = await createHarness({
    turns: [
      { toolCalls: [{ name: "write", input: { filePath: "blocked.txt", content: "nope" } }] },
      { text: "Planning only." },
    ],
    autoApprove: true,
  });
  try {
    await harness.run("Write blocked.txt", "plan");

    await assert.rejects(
      () => readFile(join(harness.cwd, "blocked.txt"), "utf8"),
      /ENOENT/,
      "the plan agent's own policy must beat global auto-approve",
    );

    // The write tool is also removed from the plan agent's schema entirely.
    const names = harness.provider.requests[0]!.tools.map((tool) => tool.name);
    assert.ok(!names.includes("write"), `plan agent must not be offered write: ${names.join(",")}`);
  } finally {
    await harness.cleanup();
  }
});

test("e2e: aborting mid-turn ends the turn without a crash", async () => {
  const harness = await createHarness({
    turns: [{ textChunks: ["partial"], finishReason: "stop" }],
  });
  try {
    const controller = new AbortController();
    controller.abort();
    const message = await harness.agent.run({
      sessionId: harness.sessionId,
      prompt: "Do something slow",
      signal: controller.signal,
    });

    assert.equal(message.error, "aborted");
    const ends = eventsOfType(harness.events, "session.end");
    assert.equal(ends.at(-1)?.reason, "aborted");
  } finally {
    await harness.cleanup();
  }
});

test("e2e: the step budget stops a runaway tool loop and says so", async () => {
  // The model asks for a read forever; maxSteps must terminate it.
  const harness = await createHarness({
    turns: Array.from({ length: 10 }, () => ({
      toolCalls: [{ name: "read", input: { filePath: "loop.txt" } }],
    })),
    config: { maxSteps: 3 },
  });
  try {
    await writeFile(join(harness.cwd, "loop.txt"), "loop\n");
    const text = await harness.run("Loop forever");

    assert.match(text, /Stopped after 3 steps/);
    assert.equal(harness.provider.callCount, 3);
  } finally {
    await harness.cleanup();
  }
});

test("e2e: a failing provider surfaces an actionable error, not a stack trace", async () => {
  const harness = await createHarness({
    turns: [{ error: "upstream is unhappy", retryable: false }],
  });
  try {
    const text = await harness.run("Do something");
    assert.match(text, /Error:/);
  } finally {
    await harness.cleanup();
  }
});
