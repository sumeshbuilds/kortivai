/**
 * Tests for the foundation layer the Lead owns: config loading and merging,
 * prompt composition, glob matching, redaction, and default-model resolution.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_MODEL,
  configSchema,
  effectiveMaxSteps,
  loadConfig,
  mergeConfig,
  readConfigFile,
  stripJsonComments,
} from "../src/core/config.ts";
import {
  BASE_SYSTEM_PROMPT,
  composeSystemPrompt,
  loadAgentInstructions,
  renderSkills,
} from "../src/core/prompt.ts";
import { globToRegExp, matchAny, matchGlob } from "../src/util/glob.ts";
import { redact } from "../src/util/log.ts";
import { assertInside, isInside, relativeTo, toPosix } from "../src/util/paths.ts";
import { createEventBus } from "../src/core/events.ts";
import type { AgentEvent, AgentInfo } from "../src/core/types.ts";

async function withTempDirs(
  run: (paths: { home: string; cwd: string }) => Promise<void>,
): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "kortivai-core-home-"));
  const cwd = await mkdtemp(join(tmpdir(), "kortivai-core-cwd-"));
  const previousHome = process.env.KORTIVAI_HOME;
  process.env.KORTIVAI_HOME = home;
  try {
    await run({ home, cwd });
  } finally {
    if (previousHome === undefined) delete process.env.KORTIVAI_HOME;
    else process.env.KORTIVAI_HOME = previousHome;
    await rm(home, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
}

/* ------------------------------- config ------------------------------- */

test("stripJsonComments removes line comments and trailing commas but not strings", () => {
  const input = [
    "{",
    '  // a comment, with a comma',
    '  "url": "https://example.com//not-a-comment",',
    '  "n": 1,',
    "}",
  ].join("\n");
  const stripped = stripJsonComments(input);
  const parsed = JSON.parse(stripped) as Record<string, unknown>;
  assert.equal(parsed["url"], "https://example.com//not-a-comment");
  assert.equal(parsed["n"], 1);
});

test("readConfigFile rejects an unknown key instead of silently ignoring it", async () => {
  await withTempDirs(async ({ cwd }) => {
    const path = join(cwd, "bad.json");
    await writeFile(path, JSON.stringify({ model: "deepseek/deepseek-chat", modle: "typo" }));
    await assert.rejects(() => readConfigFile(path), /Invalid configuration/);
  });
});

test("readConfigFile accepts a commented config (JSONC)", async () => {
  await withTempDirs(async ({ cwd }) => {
    const path = join(cwd, "ok.json");
    await writeFile(
      path,
      ['{', '  // the model', '  "model": "deepseek/deepseek-chat",', '  "maxSteps": 12,', "}"].join("\n"),
    );
    const config = await readConfigFile(path);
    assert.equal(config?.model, "deepseek/deepseek-chat");
    assert.equal(config?.maxSteps, 12);
  });
});

test("mergeConfig deep-merges objects and concatenates permission arrays", () => {
  const merged = mergeConfig(
    { model: "a/a", permissions: [{ tool: "read", action: "allow" }], ui: { theme: "kortiv" } },
    { model: "b/b", permissions: [{ tool: "write", action: "ask" }], ui: { showReasoning: true } },
  );
  assert.equal(merged.model, "b/b");
  assert.equal(merged.permissions?.length, 2);
  assert.equal(merged.ui?.theme, "kortiv");
  assert.equal(merged.ui?.showReasoning, true);
});

test("loadConfig applies the highest-priority file and records its sources", async () => {
  await withTempDirs(async ({ home, cwd }) => {
    await writeFile(join(home, "config.json"), JSON.stringify({ model: "global/model", maxSteps: 5 }));
    await writeFile(join(cwd, "kortivai.json"), JSON.stringify({ model: "project/model" }));

    const config = await loadConfig({ cwd, skipEnv: true });
    assert.equal(config.model, "project/model", "project config must beat the global config");
    assert.equal(config.maxSteps, 5, "keys the project does not set survive from the global file");
    assert.equal(config.sources.length, 2);
    assert.ok(config.source?.endsWith("kortivai.json"));
  });
});

test("loadConfig lets CLI overrides win over every file", async () => {
  await withTempDirs(async ({ cwd }) => {
    await writeFile(join(cwd, "kortivai.json"), JSON.stringify({ model: "project/model", maxSteps: 9 }));
    const config = await loadConfig({ cwd, skipEnv: true, overrides: { maxSteps: 2 } });
    assert.equal(config.model, "project/model");
    assert.equal(config.maxSteps, 2);
    assert.equal(effectiveMaxSteps(config), 2);
  });
});

test("the shipped example config validates against the real schema", async () => {
  const { fileURLToPath } = await import("node:url");
  const example = fileURLToPath(new URL("../kortivai.example.json", import.meta.url));
  const config = await readConfigFile(example);
  assert.ok(config, "kortivai.example.json must parse");
  assert.ok((config?.permissions?.length ?? 0) > 0);
  assert.ok(config?.model);
});

test("configSchema rejects an out-of-range temperature and an invalid action", () => {
  assert.equal(configSchema.safeParse({ temperature: 5 }).success, false);
  assert.equal(configSchema.safeParse({ permissions: [{ tool: "bash", action: "maybe" }] }).success, false);
  assert.equal(configSchema.safeParse({ mcp: { x: { args: ["a"] } } }).success, false, "an MCP server needs a command or url");
});

/* ------------------------------- prompt ------------------------------- */

const AGENT: AgentInfo = { name: "build", description: "d", mode: "primary", prompt: "Agent-specific rule." };

test("composeSystemPrompt layers base, agent, environment, project rules and skills", () => {
  const prompt = composeSystemPrompt({
    agent: AGENT,
    config: {},
    environment: {
      cwd: "/repo",
      platform: "linux",
      date: "2026-01-01",
      model: "deepseek/deepseek-chat",
      agent: "build",
      isGitRepo: true,
      gitBranch: "main",
    },
    instructions: [{ path: "/repo/AGENTS.md", content: "Run npm test." }],
    skills: [{ name: "pdf", description: "Fill PDFs", path: "/s/SKILL.md", dir: "/s", instructions: "x" }],
  });

  assert.ok(prompt.includes(BASE_SYSTEM_PROMPT), "base prompt present");
  assert.ok(prompt.includes("Agent-specific rule."), "agent prompt present");
  assert.ok(prompt.includes("<cwd>/repo</cwd>"), "environment present");
  assert.ok(prompt.includes("Run npm test."), "project instructions present");
  assert.ok(prompt.includes("main"), "git branch present");
  assert.ok(prompt.includes("pdf"), "skill listed");
  assert.ok(prompt.indexOf("Run npm test.") > prompt.indexOf("Agent-specific rule."), "project rules come after the agent prompt");
});

test("a custom systemPrompt replaces the built-in base prompt", () => {
  const prompt = composeSystemPrompt({
    agent: AGENT,
    config: { systemPrompt: "You are a custom agent." },
    environment: {
      cwd: "/r",
      platform: "linux",
      date: "2026-01-01",
      model: "m",
      agent: "build",
    },
    instructions: [],
  });
  assert.ok(prompt.startsWith("You are a custom agent."));
  assert.ok(!prompt.includes(BASE_SYSTEM_PROMPT.split("\n")[0]!));
});

test("loadAgentInstructions discovers AGENTS.md and honours the disable flag", async () => {
  await withTempDirs(async ({ cwd }) => {
    await writeFile(join(cwd, "AGENTS.md"), "Root rules: use pnpm.");
    await mkdir(join(cwd, "packages", "app"), { recursive: true });
    await writeFile(join(cwd, "packages", "app", "AGENTS.md"), "Nested rule: use vitest.");

    const found = await loadAgentInstructions(join(cwd, "packages", "app"), {});
    assert.equal(found.length, 2, "root and nested instruction files are both loaded");
    assert.match(found[0]!.content, /Root rules/);
    assert.match(found[1]!.content, /Nested rule/);

    const disabled = await loadAgentInstructions(cwd, { disableAgentsMd: true });
    assert.equal(disabled.length, 0);
  });
});

test("renderSkills returns an empty string when there are no skills", () => {
  assert.equal(renderSkills([]), "");
});

/* -------------------------------- glob -------------------------------- */

test("matchGlob handles stars, doublestars, braces and negation-free patterns", () => {
  assert.ok(matchGlob("*.ts", "src/a.ts"), "bare pattern matches basename at any depth");
  assert.ok(matchGlob("src/**/*.ts", "src/core/agent.ts"));
  assert.ok(matchGlob("src/**/*.ts", "src/agent.ts"));
  assert.ok(!matchGlob("src/**/*.ts", "tests/agent.ts"));
  assert.ok(matchGlob("*.{js,ts}", "index.ts"));
  assert.ok(matchGlob("file?.[jt]s", "file1.ts"));
  assert.ok(!matchGlob("file?.[jt]s", "file10.ts"));
  assert.ok(matchGlob("git status*", "git status --short"));
});

test("matchAny lets a later rule win and supports negation", () => {
  assert.equal(matchAny(["*", "git push*"], "git push origin main"), true);
  assert.equal(matchAny(["git push*", "*"], "git push origin main"), true);
  assert.equal(matchAny(["!*.env"], ".env"), false);
  assert.equal(matchAny([], "anything"), undefined, "no pattern means no opinion");
});

test("globToRegExp anchors the whole path", () => {
  assert.ok(globToRegExp("src/*.ts").test("src/a.ts"));
  assert.ok(!globToRegExp("src/*.ts").test("x/src/a.ts"));
});

/* ------------------------------ redaction ----------------------------- */

test("redact removes keys in every shape the logger may see", () => {
  const raw = [
    "key sk-abcdef1234567890",
    "nvapi-abcdef1234567890",
    "oc_sk_abcdef1234567890",
    "thk_live_abcdef1234567890",
    '{"api_key":"supersecretvalue"}',
    "Authorization: Bearer abcdefghijklmnop",
  ].join("\n");
  const safe = redact(raw);
  for (const secret of [
    "sk-abcdef1234567890",
    "nvapi-abcdef1234567890",
    "oc_sk_abcdef1234567890",
    "thk_live_abcdef1234567890",
    "supersecretvalue",
    "abcdefghijklmnop",
  ]) {
    assert.ok(!safe.includes(secret), `secret leaked: ${secret}`);
  }
});

/* -------------------------------- paths -------------------------------- */

test("assertInside permits children and refuses escapes", () => {
  const root = join(tmpdir(), "kortivai-root");
  assert.equal(assertInside(root, "a/b.txt"), join(root, "a", "b.txt"));
  assert.throws(() => assertInside(root, "../escape.txt"), /escapes/);
  assert.ok(isInside(root, "deep/nested/file.txt"));
  assert.ok(!isInside(root, "../outside"));
  assert.equal(toPosix(relativeTo(root, join(root, "x", "y.ts"))), "x/y.ts");
});

/* -------------------------------- events ------------------------------- */

test("the event bus isolates a throwing listener from the others", () => {
  const seen: string[] = [];
  const bus = createEventBus(() => seen.push("error-seen"));
  const event: AgentEvent = { type: "status", sessionId: "s", status: "idle" };
  bus.subscribe(() => {
    throw new Error("bad listener");
  });
  bus.subscribe(() => seen.push("second"));
  bus.emit(event);
  assert.deepEqual(seen, ["error-seen", "second"]);
});

test("unsubscribe stops delivery", () => {
  const bus = createEventBus();
  let count = 0;
  const off = bus.subscribe(() => {
    count += 1;
  });
  bus.emit({ type: "status", sessionId: "s", status: "idle" });
  off();
  bus.emit({ type: "status", sessionId: "s", status: "idle" });
  assert.equal(count, 1);
});

/* --------------------------- default model ---------------------------- */

test("a runtime with a DeepSeek key and no configured model picks the default model", async () => {
  await withTempDirs(async ({ cwd }) => {
    const previous = process.env.DEEPSEEK_API_KEY;
    process.env.DEEPSEEK_API_KEY = "sk-test-not-a-real-key";
    try {
      const { createKortivRuntime } = await import("../src/core/wiring.ts");
      const runtime = await createKortivRuntime({ cwd, skipMcp: true, skipEnv: true });
      assert.equal(runtime.config.model, DEFAULT_MODEL);

      // An explicitly configured model is never overridden.
      const explicit = await createKortivRuntime({
        cwd,
        skipMcp: true,
        skipEnv: true,
        overrides: { model: "deepseek/deepseek-reasoner" },
      });
      assert.equal(explicit.config.model, "deepseek/deepseek-reasoner");
      await runtime.close();
      await explicit.close();
    } finally {
      if (previous === undefined) delete process.env.DEEPSEEK_API_KEY;
      else process.env.DEEPSEEK_API_KEY = previous;
    }
  });
});
