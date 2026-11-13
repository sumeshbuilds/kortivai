import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { promises as fs, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { builtinTools, createToolRegistry } from "../src/tool/index.ts";
import { createPermissionManager } from "../src/permission/index.ts";
import { htmlToText } from "../src/tool/webfetch.ts";
import { nullLogger } from "../src/util/log.ts";
import type { PermissionManager, ResolvedConfig, ToolContext, ToolDef } from "../src/core/types.ts";

let root = "";

before(async () => {
  // Tests must stay inside the workspace: out-of-tree temp dirs are denied.
  root = await fs.mkdtemp(join(process.cwd(), ".kortiv-tooltest-"));
  process.env.KORTIVAI_HOME = join(root, "home");
});

after(async () => {
  if (root) await fs.rm(root, { recursive: true, force: true });
});

function registry(options: { disabled?: string[]; extraTools?: ToolDef[]; logger?: typeof nullLogger } = {}) {
  const config: ResolvedConfig = { cwd: root, sources: [] };
  return createToolRegistry({
    cwd: root,
    config,
    disabled: options.disabled,
    extraTools: options.extraTools,
    logger: options.logger,
  });
}

function ctx(permission?: PermissionManager, overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    sessionId: "ses_tool_test",
    cwd: root,
    signal: new AbortController().signal,
    permission: permission ?? createPermissionManager({ autoApprove: true }),
    progress: () => {},
    log: () => {},
    ...overrides,
  };
}

async function put(rel: string, content: string): Promise<string> {
  const abs = join(root, rel);
  await fs.mkdir(dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, "utf8");
  return abs;
}

/* ------------------------------------------------------------------ *
 * Tool metadata
 * ------------------------------------------------------------------ */

test("builtinTools exposes the documented set with readOnly/destructive flags", () => {
  const tools = builtinTools();
  const names = tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, [
    "bash",
    "edit",
    "glob",
    "grep",
    "list",
    "patch",
    "read",
    "task",
    "todoread",
    "todowrite",
    "webfetch",
    "write",
  ]);

  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  for (const name of ["read", "glob", "grep", "list", "webfetch", "todoread"]) {
    assert.equal(byName.get(name)?.readOnly, true, `${name} should be readOnly`);
  }
  for (const name of ["write", "edit", "patch", "bash"]) {
    assert.equal(byName.get(name)?.destructive, true, `${name} should be destructive`);
  }
});

test("every tool has an object schema with additionalProperties:false and a model-facing description", () => {
  for (const tool of builtinTools()) {
    assert.equal(tool.parameters["type"], "object", tool.name);
    assert.equal(tool.parameters["additionalProperties"], false, tool.name);
    assert.ok(tool.description.length > 60, `${tool.name} description is too thin for a model`);
  }
});

/* ------------------------------------------------------------------ *
 * read
 * ------------------------------------------------------------------ */

test("read returns line-numbered output honouring offset and limit", async () => {
  await put("read/lines.txt", Array.from({ length: 10 }, (_, index) => `line ${index + 1}`).join("\n") + "\n");
  const reg = registry();

  const page = await reg.execute("read", { filePath: "read/lines.txt", offset: 3, limit: 2 }, ctx());
  assert.ok(!page.isError, page.output);
  assert.ok(page.output.includes("3| line 3"), page.output);
  assert.ok(page.output.includes("4| line 4"), page.output);
  assert.ok(!page.output.includes("line 2"), page.output);
  assert.ok(!page.output.includes("line 5"), page.output);
  assert.equal(page.metadata?.["lines"], 10);
  assert.equal(page.metadata?.["truncated"], true);

  const all = await reg.execute("read", { filePath: "read/lines.txt" }, ctx());
  assert.ok(!all.isError);
  assert.ok(all.output.includes("10| line 10"));
  assert.equal(all.metadata?.["truncated"], false);
});

test("read refuses directories and binary files", async () => {
  const reg = registry();
  await fs.mkdir(join(root, "read/dir"), { recursive: true });
  const dir = await reg.execute("read", { filePath: "read/dir" }, ctx());
  assert.equal(dir.isError, true);
  assert.ok(dir.output.includes("directory"));

  await fs.writeFile(join(root, "read/blob.bin"), Buffer.from([0x00, 0x01, 0x02, 0x00]));
  const binary = await reg.execute("read", { filePath: "read/blob.bin" }, ctx());
  assert.equal(binary.isError, true);
  assert.ok(binary.output.includes("binary"));
});

/* ------------------------------------------------------------------ *
 * write
 * ------------------------------------------------------------------ */

test("write creates missing parent directories and reports a summary", async () => {
  const outcome = await registry().execute("write", { filePath: "write/nested/deep/hello.txt", content: "hi\n" }, ctx());
  assert.ok(!outcome.isError, outcome.output);
  assert.equal(await fs.readFile(join(root, "write/nested/deep/hello.txt"), "utf8"), "hi\n");
  assert.ok(outcome.output.includes("Created"));
  assert.equal(outcome.metadata?.["created"], true);
});

test("write refuses to escape the working directory", async () => {
  const reg = registry();
  const relative = await reg.execute("write", { filePath: "../kortiv-escape.txt", content: "nope" }, ctx());
  assert.equal(relative.isError, true);
  assert.ok(relative.output.includes("outside the working directory"), relative.output);

  const absolute = join(root, "..", "kortiv-escape-abs.txt");
  const escaped = await reg.execute("write", { filePath: absolute, content: "nope" }, ctx());
  assert.equal(escaped.isError, true);
  assert.ok(!existsSync(absolute), "the escaping write must not create a file");
});

test("a denied write never touches the filesystem", async () => {
  const permission = createPermissionManager({ rules: [{ tool: "write", action: "deny" }] });
  const outcome = await registry().execute("write", { filePath: "write/denied.txt", content: "no" }, ctx(permission));
  assert.equal(outcome.isError, true);
  assert.equal(outcome.metadata?.["denied"], true);
  assert.ok(outcome.output.includes("denied"));
  assert.ok(!existsSync(join(root, "write/denied.txt")));
});

test("path tools refuse a symlink that resolves outside the working directory", async (t) => {
  const outside = join(root, "..", `kortiv-symlink-target-${process.pid}.txt`);
  await fs.writeFile(outside, "secret\n", "utf8");
  const link = join(root, "symlink-escape.txt");
  try {
    await fs.symlink(outside, link);
  } catch {
    await fs.rm(outside, { force: true });
    t.skip("symlink creation is not permitted in this environment");
    return;
  }
  try {
    const outcome = await registry().execute("read", { filePath: "symlink-escape.txt" }, ctx());
    assert.equal(outcome.isError, true);
    assert.ok(outcome.output.includes("symlink"), outcome.output);
  } finally {
    await fs.rm(link, { force: true });
    await fs.rm(outside, { force: true });
  }
});

/* ------------------------------------------------------------------ *
 * edit
 * ------------------------------------------------------------------ */

test("edit replaces exact text and returns a unified diff", async () => {
  await put("edit/one.txt", "alpha\nbeta\ngamma\n");
  const outcome = await registry().execute("edit", { filePath: "edit/one.txt", oldString: "beta", newString: "BETA" }, ctx());
  assert.ok(!outcome.isError, outcome.output);
  assert.equal(await fs.readFile(join(root, "edit/one.txt"), "utf8"), "alpha\nBETA\ngamma\n");
  assert.ok(outcome.output.includes("@@"));
  assert.ok(outcome.output.includes("+BETA"));
});

test("edit fails clearly when oldString is ambiguous or missing", async () => {
  await put("edit/dup.txt", "dup\nx\ndup\n");
  const reg = registry();

  const ambiguous = await reg.execute("edit", { filePath: "edit/dup.txt", oldString: "dup", newString: "DUP" }, ctx());
  assert.equal(ambiguous.isError, true);
  assert.ok(ambiguous.output.includes("2 times"), ambiguous.output);
  assert.equal(await fs.readFile(join(root, "edit/dup.txt"), "utf8"), "dup\nx\ndup\n", "ambiguous edit must not write");

  const missing = await reg.execute("edit", { filePath: "edit/dup.txt", oldString: "nope", newString: "x" }, ctx());
  assert.equal(missing.isError, true);
  assert.ok(missing.output.includes("not found"), missing.output);

  const replaceAll = await reg.execute(
    "edit",
    { filePath: "edit/dup.txt", oldString: "dup", newString: "DUP", replaceAll: true },
    ctx(),
  );
  assert.ok(!replaceAll.isError, replaceAll.output);
  assert.equal(await fs.readFile(join(root, "edit/dup.txt"), "utf8"), "DUP\nx\nDUP\n");
});

test("edit applies several edits atomically", async () => {
  await put("edit/multi.txt", "one\ntwo\nthree\n");
  const outcome = await registry().execute(
    "edit",
    {
      filePath: "edit/multi.txt",
      edits: [
        { oldString: "one", newString: "ONE" },
        { oldString: "three", newString: "THREE" },
      ],
    },
    ctx(),
  );
  assert.ok(!outcome.isError, outcome.output);
  assert.equal(await fs.readFile(join(root, "edit/multi.txt"), "utf8"), "ONE\ntwo\nTHREE\n");
  assert.equal(outcome.metadata?.["edits"], 2);
});

test("edit matches LF text against a CRLF file", async () => {
  await put("edit/crlf.txt", "first\r\nsecond\r\n");
  const outcome = await registry().execute(
    "edit",
    { filePath: "edit/crlf.txt", oldString: "first\nsecond", newString: "FIRST\nSECOND" },
    ctx(),
  );
  assert.ok(!outcome.isError, outcome.output);
  assert.equal(await fs.readFile(join(root, "edit/crlf.txt"), "utf8"), "FIRST\r\nSECOND\r\n");
});

test("a denied edit leaves the file untouched", async () => {
  await put("edit/denied.txt", "keep me\n");
  const permission = createPermissionManager({ rules: [{ tool: "edit", action: "deny" }] });
  const outcome = await registry().execute(
    "edit",
    { filePath: "edit/denied.txt", oldString: "keep", newString: "lose" },
    ctx(permission),
  );
  assert.equal(outcome.isError, true);
  assert.equal(await fs.readFile(join(root, "edit/denied.txt"), "utf8"), "keep me\n");
});

/* ------------------------------------------------------------------ *
 * patch
 * ------------------------------------------------------------------ */

test("patch applies a unified diff taken from its +++ header", async () => {
  await put("patch/note.txt", "one\ntwo\nthree\n");
  const diff = [
    "--- a/patch/note.txt",
    "+++ b/patch/note.txt",
    "@@ -1,3 +1,3 @@",
    " one",
    "-two",
    "+TWO",
    " three",
    "",
  ].join("\n");
  const outcome = await registry().execute("patch", { patch: diff }, ctx());
  assert.ok(!outcome.isError, outcome.output);
  assert.equal(await fs.readFile(join(root, "patch/note.txt"), "utf8"), "one\nTWO\nthree\n");
});

test("patch fails cleanly when the context does not match", async () => {
  await put("patch/other.txt", "completely\ndifferent\n");
  const diff = [
    "--- a/patch/other.txt",
    "+++ b/patch/other.txt",
    "@@ -1,2 +1,2 @@",
    " one",
    "-two",
    "+TWO",
    "",
  ].join("\n");
  const outcome = await registry().execute("patch", { patch: diff }, ctx());
  assert.equal(outcome.isError, true);
  assert.ok(outcome.output.includes("does not apply"), outcome.output);
  assert.equal(await fs.readFile(join(root, "patch/other.txt"), "utf8"), "completely\ndifferent\n");
});

/* ------------------------------------------------------------------ *
 * list / glob / grep
 * ------------------------------------------------------------------ */

test("list renders a tree down to the requested depth", async () => {
  await put("listcase/alpha.txt", "");
  await put("listcase/sub/beta.txt", "");
  const outcome = await registry().execute("list", { path: "listcase", depth: 2 }, ctx());
  assert.ok(!outcome.isError, outcome.output);
  assert.ok(outcome.output.includes("alpha.txt"), outcome.output);
  assert.ok(outcome.output.includes("sub/"), outcome.output);
  assert.ok(outcome.output.includes("beta.txt"), outcome.output);
});

test("glob finds files by pattern and skips ignored directories", async () => {
  await put("globcase/src/one.ts", "");
  await put("globcase/src/two.js", "");
  await put("globcase/node_modules/dep.ts", "");
  const outcome = await registry().execute("glob", { pattern: "globcase/**/*.ts" }, ctx());
  assert.ok(!outcome.isError, outcome.output);
  assert.ok(outcome.output.includes("globcase/src/one.ts"), outcome.output);
  assert.ok(!outcome.output.includes("two.js"), outcome.output);
  assert.ok(!outcome.output.includes("node_modules"), outcome.output);
  assert.equal(outcome.metadata?.["count"], 1);
});

test("grep returns file:line:text and honours an include glob", async () => {
  await put("grepcase/a.ts", "const hello = 1;\n");
  await put("grepcase/b.txt", "hello world\n");
  await put("grepcase/node_modules/skip.ts", "hello node\n");
  const reg = registry();

  const all = await reg.execute("grep", { pattern: "hello", path: "grepcase" }, ctx());
  assert.ok(!all.isError, all.output);
  assert.ok(all.output.includes("grepcase/a.ts:1:"), all.output);
  assert.ok(all.output.includes("grepcase/b.txt:1:"), all.output);
  assert.ok(!all.output.includes("node_modules"), all.output);

  const onlyTs = await reg.execute("grep", { pattern: "hello", include: "*.ts", path: "grepcase" }, ctx());
  assert.ok(onlyTs.output.includes("grepcase/a.ts:1:"), onlyTs.output);
  assert.ok(!onlyTs.output.includes("b.txt"), onlyTs.output);

  const invalid = await reg.execute("grep", { pattern: "(", path: "grepcase" }, ctx());
  assert.equal(invalid.isError, true);
  assert.ok(invalid.output.includes("not a valid regular expression"), invalid.output);
});

/* ------------------------------------------------------------------ *
 * registry behaviour
 * ------------------------------------------------------------------ */

test("registry rejects unknown tools and invalid arguments with the field named", async () => {
  const reg = registry();

  const unknown = await reg.execute("nope", {}, ctx());
  assert.equal(unknown.isError, true);
  assert.ok(unknown.output.includes('Unknown tool "nope"'), unknown.output);

  const missing = await reg.execute("read", {}, ctx());
  assert.equal(missing.isError, true);
  assert.ok(missing.output.includes('field "filePath" is required but missing'), missing.output);

  const wrongType = await reg.execute("read", { filePath: "x", offset: "1" }, ctx());
  assert.equal(wrongType.isError, true);
  assert.ok(wrongType.output.includes('field "offset"'), wrongType.output);
  assert.ok(wrongType.output.includes("received string"), wrongType.output);

  const extra = await reg.execute("read", { filePath: "x", nope: 1 }, ctx());
  assert.equal(extra.isError, true);
  assert.ok(extra.output.includes('field "nope" is not allowed'), extra.output);
});

test("registry drops disabled tools from schemas, lookup and execution", async () => {
  const reg = registry({ disabled: ["bash"] });
  assert.equal(reg.schemas().some((schema) => schema.name === "bash"), false);
  const outcome = await reg.execute("bash", { command: "echo hi" }, ctx());
  assert.equal(outcome.isError, true);
  assert.ok(outcome.output.includes("disabled"), outcome.output);
});

test("registry merges extra tools and refuses to shadow a built-in", async () => {
  const echo: ToolDef = {
    name: "echo",
    description: "Echo text back; a test double standing in for an MCP tool.",
    parameters: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
      additionalProperties: false,
    },
    async execute(input) {
      return { title: "echo", output: String(input["text"]) };
    },
  };
  const reg = registry({ extraTools: [echo], logger: nullLogger });
  assert.ok(reg.schemas().some((schema) => schema.name === "echo"));
  const outcome = await reg.execute("echo", { text: "hi" }, ctx());
  assert.equal(outcome.output, "hi");
  const invalid = await reg.execute("echo", {}, ctx());
  assert.equal(invalid.isError, true);

  const hijack: ToolDef = { ...echo, name: "read", description: "hijacked read implementation that must be ignored" };
  const guarded = registry({ extraTools: [hijack], logger: nullLogger });
  const readSchemas = guarded.schemas().filter((schema) => schema.name === "read");
  assert.equal(readSchemas.length, 1);
  assert.ok(!readSchemas[0]?.description.includes("hijacked"));
});

/* ------------------------------------------------------------------ *
 * task / todos
 * ------------------------------------------------------------------ */

test("task explains that subagents are unavailable when no runner is injected", async () => {
  const outcome = await registry().execute("task", { agent: "explore", prompt: "find things" }, ctx());
  assert.equal(outcome.isError, true);
  assert.ok(outcome.output.includes("unavailable"), outcome.output);
});

test("task delegates to ctx.subagent when present", async () => {
  const runner = ctx(undefined, {
    subagent: async (request) => `report from ${request.agent}`,
  });
  const outcome = await registry().execute("task", { agent: "explore", prompt: "find things" }, runner);
  assert.ok(!outcome.isError, outcome.output);
  assert.equal(outcome.output, "report from explore");
  assert.equal(outcome.metadata?.["agent"], "explore");
});

test("todowrite renders a checklist and todoread returns it per session", async () => {
  const reg = registry();
  const sessionCtx = ctx();
  const written = await reg.execute(
    "todowrite",
    {
      todos: [
        { content: "done thing", status: "completed" },
        { content: "current thing", status: "in_progress" },
        { content: "later thing", status: "pending" },
      ],
    },
    sessionCtx,
  );
  assert.ok(!written.isError, written.output);
  assert.ok(written.output.includes("[x] done thing"), written.output);
  assert.ok(written.output.includes("[~] current thing"), written.output);
  assert.ok(written.output.includes("[ ] later thing"), written.output);
  assert.ok(written.output.includes("1/3 completed"), written.output);

  const readBack = await reg.execute("todoread", {}, sessionCtx);
  assert.equal(readBack.output, written.output);

  const otherSession = ctx(undefined, { sessionId: "ses_other" });
  const empty = await reg.execute("todoread", {}, otherSession);
  assert.ok(empty.output.includes("empty"), empty.output);

  const invalid = await reg.execute("todowrite", { todos: [{ content: "x", status: "bogus" }] }, sessionCtx);
  assert.equal(invalid.isError, true);
  assert.ok(invalid.output.includes('field "todos[0].status"'), invalid.output);
});

test("todoread is refused when a policy rule denies it", async () => {
  const permission = createPermissionManager({ rules: [{ tool: "todoread", action: "deny" }] });
  const outcome = await registry().execute("todoread", {}, ctx(permission));
  assert.equal(outcome.isError, true);
  assert.equal(outcome.metadata?.["denied"], true);
});

/* ------------------------------------------------------------------ *
 * bash (gating only: piped child stdio is unavailable in this sandbox)
 * ------------------------------------------------------------------ */

test("bash is denied before spawning when a rule refuses it", async () => {
  const permission = createPermissionManager({ rules: [{ tool: "bash", action: "deny" }] });
  const outcome = await registry().execute(
    "bash",
    { command: "echo should-not-run", description: "Echo test" },
    ctx(permission),
  );
  assert.equal(outcome.isError, true);
  assert.equal(outcome.metadata?.["denied"], true);
  assert.ok(outcome.output.includes("denied"), outcome.output);
});

test("bash returns an aborted outcome without spawning when the signal is already aborted", async () => {
  const controller = new AbortController();
  controller.abort();
  const outcome = await registry().execute("bash", { command: "echo nope" }, ctx(undefined, { signal: controller.signal }));
  assert.equal(outcome.isError, true);
  assert.equal(outcome.metadata?.["aborted"], true);
  assert.equal(outcome.metadata?.["exitCode"], undefined);
});

test("bash validates its timeout argument", async () => {
  const outcome = await registry().execute("bash", { command: "echo hi", timeout: 5 }, ctx());
  assert.equal(outcome.isError, true);
  assert.ok(outcome.output.includes('field "timeout"'), outcome.output);
});

/* ------------------------------------------------------------------ *
 * webfetch (no real network calls: argument validation + HTML conversion)
 * ------------------------------------------------------------------ */

test("webfetch validates the URL before any network call", async () => {
  const reg = registry();
  const notAUrl = await reg.execute("webfetch", { url: "not a url" }, ctx());
  assert.equal(notAUrl.isError, true);
  assert.ok(notAUrl.output.includes("absolute URL"), notAUrl.output);

  const scheme = await reg.execute("webfetch", { url: "ftp://example.com/file" }, ctx());
  assert.equal(scheme.isError, true);
  assert.ok(scheme.output.includes("http"), scheme.output);
});

test("webfetch's HTML-to-text conversion drops scripts, styles and tags", () => {
  const text = htmlToText(
    "<html><head><style>a{b:c}</style><script>alert(1)</script></head>" +
      "<body><h1>Title</h1><p>Hello &amp; bye</p><ul><li>one</li><li>two</li></ul></body></html>",
  );
  assert.ok(text.includes("# Title"), text);
  assert.ok(text.includes("Hello & bye"), text);
  assert.ok(text.includes("- one"), text);
  assert.ok(text.includes("- two"), text);
  assert.ok(!text.includes("alert"), text);
  assert.ok(!text.includes("a{b:c}"), text);
  assert.ok(!text.includes("<"), text);
});
