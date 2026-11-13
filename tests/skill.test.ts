import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ResolvedConfig, ToolContext } from "../src/core/types.ts";
import {
  createPluginRegistry,
  createSkillRegistry,
  createSkillTool,
  parseSkillFile,
} from "../src/skill/index.ts";
import { nullLogger } from "../src/util/log.ts";

let root = "";
let project = "";
let pathsDir = "";
let assetsDir = "";
let moreAssets = "";

function writeSkill(base: string, name: string, contents: string): { dir: string; file: string } {
  const dir = join(base, name);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "SKILL.md");
  writeFileSync(file, contents, "utf8");
  return { dir, file };
}

function skillDoc(name: string, description: string, body: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\n${body}\n`;
}

before(() => {
  root = mkdtempSync(join(process.cwd(), ".kortivai-skill-test-"));
  process.env.KORTIVAI_HOME = root;

  project = join(root, "project");
  pathsDir = join(root, "paths");
  assetsDir = join(root, "assets");
  moreAssets = join(root, "more-assets");
  mkdirSync(project, { recursive: true });

  writeSkill(
    join(project, ".kortivai", "skills"),
    "alpha",
    skillDoc("alpha", "PROJECT ALPHA", "PROJECT ALPHA instructions"),
  );
  writeSkill(pathsDir, "alpha", skillDoc("alpha", "PATH ALPHA", "PATH ALPHA instructions"));
  writeSkill(pathsDir, "beta", skillDoc("beta", "BETA", "BETA instructions"));
  writeSkill(assetsDir, "alpha", skillDoc("alpha", "ASSET ALPHA", "ASSET ALPHA instructions"));
  writeSkill(assetsDir, "gamma", skillDoc("gamma", "GAMMA", "GAMMA instructions"));
  writeSkill(moreAssets, "delta", skillDoc("delta", "DELTA", "DELTA instructions"));
});

after(() => {
  delete process.env.KORTIVAI_HOME;
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    // A leftover handle must not fail the suite.
  }
});

const toolContext = {
  sessionId: "ses_test",
  cwd: project,
  signal: new AbortController().signal,
  permission: {},
  progress: () => {},
  log: () => {},
} as unknown as ToolContext;

describe("parseSkillFile", () => {
  test("parses YAML frontmatter and keeps the body as instructions", () => {
    const contents = [
      "---",
      "name: demo",
      "description: A demo skill",
      "allowed-tools: Read, Write",
      "---",
      "",
      "# Demo",
      "",
      "Body line one.",
      "",
      "More detail.",
    ].join("\n");

    const skill = parseSkillFile("/abs/SKILL.md", contents, "/abs");
    assert.ok(skill);
    assert.equal(skill.name, "demo");
    assert.equal(skill.description, "A demo skill");
    assert.equal(skill.path, "/abs/SKILL.md");
    assert.equal(skill.dir, "/abs");
    assert.equal(skill.instructions, "# Demo\n\nBody line one.\n\nMore detail.");
    assert.equal(skill.metadata?.["allowed-tools"], "Read, Write");
  });

  test("handles CRLF and quoted values", () => {
    const contents = '---\r\nname: quoted\r\ndescription: "Quoted: description"\r\n---\r\n\r\nBody here.\r\n';
    const skill = parseSkillFile("p", contents, "d");
    assert.equal(skill?.name, "quoted");
    assert.equal(skill?.description, "Quoted: description");
    assert.equal(skill?.instructions, "Body here.");
  });

  test("falls back to the first heading and paragraph without frontmatter", () => {
    const contents = "# Fallback Skill\n\nThis is the description paragraph.\n\nDetails follow.";
    const skill = parseSkillFile("p", contents, "d");
    assert.ok(skill);
    assert.equal(skill.name, "Fallback Skill");
    assert.equal(skill.description, "This is the description paragraph.");
    assert.equal(skill.instructions, contents);
    assert.equal(skill.metadata, undefined);
  });

  test("returns undefined when no usable name exists", () => {
    assert.equal(parseSkillFile("p", "Just a paragraph without a heading.", "d"), undefined);
    assert.equal(parseSkillFile("p", "", "d"), undefined);
    assert.equal(parseSkillFile("p", "---\ndescription: no name\n---\n\nbody", "d"), undefined);
  });
});

describe("skill registry", () => {
  test("discovers in priority order and lets later sources override by name", () => {
    const config: ResolvedConfig = {
      cwd: project,
      sources: [],
      skills: { paths: [pathsDir] },
      assetPaths: [assetsDir],
    };
    const registry = createSkillRegistry({ cwd: project, config, logger: nullLogger });

    assert.deepEqual(
      registry.list().map((skill) => skill.name),
      ["alpha", "beta", "gamma"],
    );

    // assetPaths is last, so it wins the `alpha` collision.
    assert.equal(registry.get("alpha")?.description, "ASSET ALPHA");
    assert.ok(registry.get("alpha")?.instructions.includes("ASSET ALPHA instructions"));
    assert.equal(registry.get("beta")?.description, "BETA");
    assert.equal(registry.get("gamma")?.description, "GAMMA");
    assert.equal(registry.get("nope"), undefined);
  });

  test("uses only the project skills directory when nothing else is configured", () => {
    const config: ResolvedConfig = { cwd: project, sources: [] };
    const registry = createSkillRegistry({ cwd: project, config, logger: nullLogger });
    assert.deepEqual(
      registry.list().map((skill) => skill.name),
      ["alpha"],
    );
    assert.equal(registry.get("alpha")?.description, "PROJECT ALPHA");
  });

  test("reload rescans newly added sources", async () => {
    const config: ResolvedConfig = {
      cwd: project,
      sources: [],
      assetPaths: [assetsDir],
    };
    const registry = createSkillRegistry({ cwd: project, config, logger: nullLogger });
    assert.equal(registry.get("delta"), undefined);

    config.assetPaths = [...config.assetPaths!, moreAssets];
    await registry.reload();
    assert.equal(registry.get("delta")?.description, "DELTA");
  });

  test("skills.disabled yields an empty registry", () => {
    const config: ResolvedConfig = { cwd: project, sources: [], skills: { disabled: true } };
    const registry = createSkillRegistry({ cwd: project, config, logger: nullLogger });
    assert.deepEqual(registry.list(), []);
  });
});

describe("skill tool", () => {
  const config: ResolvedConfig = {
    cwd: project,
    sources: [],
    assetPaths: [assetsDir],
  };

  test("returns the instructions and the absolute resource directory", async () => {
    const registry = createSkillRegistry({ cwd: project, config, logger: nullLogger });
    const tool = createSkillTool(registry);

    assert.equal(tool.name, "skill");
    assert.equal(tool.readOnly, true);

    const outcome = await tool.execute({ name: "alpha" }, toolContext);
    assert.notEqual(outcome.isError, true);
    assert.ok(outcome.output.includes("ASSET ALPHA instructions"));
    assert.ok(outcome.output.includes(join(assetsDir, "alpha")));
    assert.equal(outcome.metadata?.dir, join(assetsDir, "alpha"));
  });

  test("unknown names produce an error that lists what is available", async () => {
    const registry = createSkillRegistry({ cwd: project, config, logger: nullLogger });
    const tool = createSkillTool(registry);

    const outcome = await tool.execute({ name: "ghost" }, toolContext);
    assert.equal(outcome.isError, true);
    assert.ok(outcome.output.includes('Unknown skill "ghost"'));
    assert.ok(outcome.output.includes("alpha"));
    assert.ok(outcome.output.includes("gamma"));
  });
});

describe("plugin registry", () => {
  test("loads valid plugins and skips broken ones without throwing", async () => {
    const dir = join(project, "plugins");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "good.mjs"),
      'export default function (ctx) { ctx.log("info", "hello from good"); return { "chat.params": () => {} }; }\n',
      "utf8",
    );
    writeFileSync(
      join(dir, "named.mjs"),
      'export function plugin() { return { "tool.before": () => {} }; }\n',
      "utf8",
    );
    writeFileSync(
      join(dir, "throws.mjs"),
      'export default function () { throw new Error("setup failed"); }\n',
      "utf8",
    );
    writeFileSync(
      join(dir, "async-throws.mjs"),
      'export default async function () { throw new Error("async boom"); }\n',
      "utf8",
    );
    writeFileSync(join(dir, "import-error.mjs"), 'throw new Error("cannot import");\n', "utf8");
    writeFileSync(join(dir, "no-fn.mjs"), "export const value = 1;\n", "utf8");

    const config: ResolvedConfig = {
      cwd: project,
      sources: [],
      plugins: [
        "plugins/good.mjs",
        "plugins/named.mjs",
        "plugins/throws.mjs",
        "plugins/async-throws.mjs",
        "plugins/import-error.mjs",
        "plugins/no-fn.mjs",
        "plugins/does-not-exist.mjs",
      ],
    };

    const registry = await createPluginRegistry({ cwd: project, config, logger: nullLogger });
    const hooks = registry.hooks();
    assert.equal(hooks.length, 2);
    assert.equal(typeof hooks[0]?.["chat.params"], "function");
    assert.equal(typeof hooks[1]?.["tool.before"], "function");

    // register() shares the same forgiving path.
    await registry.register(() => ({ "permission.ask": () => {} }));
    assert.equal(registry.hooks().length, 3);

    await registry.register(() => {
      throw new Error("register failed");
    });
    assert.equal(registry.hooks().length, 3);
  });

  test("an empty plugin list resolves to a registry with no hooks", async () => {
    const config: ResolvedConfig = { cwd: project, sources: [] };
    const registry = await createPluginRegistry({ cwd: project, config, logger: nullLogger });
    assert.deepEqual(registry.hooks(), []);
  });
});
