import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createEditorState, reduceEditor, type EditorKey, type EditorState } from "../src/ui/editor.ts";
import { createKeyDecoder, decodeKeys } from "../src/ui/input.ts";
import { complete, tokenAt, SLASH_COMMANDS } from "../src/ui/completion.ts";
import { decidePermission } from "../src/ui/permission.ts";
import {
  renderBanner,
  renderPromptPrefix,
  renderSessionSummary,
  renderStatusLine,
  shortenPath,
} from "../src/ui/status.ts";
import { GLYPHS_UNICODE, createTheme, displayWidth, stripAnsi } from "../src/ui/theme.ts";
import { walkFiles } from "../src/cli/files.ts";

const TMP_ROOT = resolve(process.cwd(), ".kortivai-tmp");

before(() => {
  mkdirSync(TMP_ROOT, { recursive: true });
});

after(() => {
  rmSync(TMP_ROOT, { recursive: true, force: true });
});

function plain() {
  return createTheme({ level: 0, glyphs: GLYPHS_UNICODE, columns: 80 });
}

function type(state: EditorState, text: string): EditorState {
  return reduceEditor(state, { name: "text", text }).state;
}

function press(state: EditorState, name: EditorKey["name"]): ReturnType<typeof reduceEditor> {
  return reduceEditor(state, { name });
}

/* ------------------------------------------------------------------ *
 * Editor reducer
 * ------------------------------------------------------------------ */

test("editor inserts text at the cursor", () => {
  let state = createEditorState();
  state = type(state, "hello");
  assert.equal(state.buffer, "hello");
  assert.equal(state.cursor, 5);
  state = press(state, "left").state;
  state = type(state, "X");
  assert.equal(state.buffer, "hellXo");
  assert.equal(state.cursor, 5);
});

test("editor arrows, home and end move within bounds", () => {
  let state = type(createEditorState(), "abc");
  state = press(state, "home").state;
  assert.equal(state.cursor, 0);
  assert.equal(press(state, "left").state.cursor, 0);
  state = press(state, "right").state;
  assert.equal(state.cursor, 1);
  state = press(state, "end").state;
  assert.equal(state.cursor, 3);
  assert.equal(press(state, "right").state.cursor, 3);
});

test("editor backspace and delete respect boundaries", () => {
  let state = type(createEditorState(), "abc");
  state = press(state, "backspace").state;
  assert.equal(state.buffer, "ab");
  state = press(state, "home").state;
  assert.equal(press(state, "backspace").state.buffer, "ab");
  state = press(state, "delete").state;
  assert.equal(state.buffer, "b");
  state = press(state, "end").state;
  assert.equal(press(state, "delete").state.buffer, "b");
});

test("editor ctrl-u and ctrl-k kill to the boundaries", () => {
  let state = type(createEditorState(), "hello world");
  state = press(state, "home").state;
  for (let index = 0; index < 5; index += 1) state = press(state, "right").state;
  assert.equal(press(state, "ctrl-u").state.buffer, " world");
  state = type(createEditorState(), "hello world");
  state = press(state, "home").state;
  for (let index = 0; index < 5; index += 1) state = press(state, "right").state;
  assert.equal(press(state, "ctrl-k").state.buffer, "hello");
});

test("editor walks history and restores the draft at both edges", () => {
  let state = createEditorState({ history: ["one", "two"] });
  state = type(state, "draft");
  state = press(state, "up").state;
  assert.equal(state.buffer, "two");
  state = press(state, "up").state;
  assert.equal(state.buffer, "one");
  state = press(state, "up").state;
  assert.equal(state.buffer, "one");
  state = press(state, "down").state;
  assert.equal(state.buffer, "two");
  state = press(state, "down").state;
  assert.equal(state.buffer, "draft");
  assert.equal(press(state, "down").state.buffer, "draft");
  assert.equal(press(createEditorState(), "up").state.buffer, "");
});

test("editor enter submits, resets and records history", () => {
  const result = reduceEditor(type(createEditorState({ history: ["old"] }), "new task"), { name: "enter" });
  assert.equal(result.submitted, "new task");
  assert.equal(result.state.buffer, "");
  assert.equal(result.state.cursor, 0);
  assert.deepEqual(result.state.history, ["old", "new task"]);
  const empty = reduceEditor(createEditorState(), { name: "enter" });
  assert.equal(empty.submitted, undefined);
});

test("editor ctrl-d exits on an empty line and deletes otherwise", () => {
  assert.equal(press(createEditorState(), "ctrl-d").exit, true);
  const state = press(type(createEditorState(), "ab"), "left").state;
  assert.equal(press(state, "ctrl-d").state.buffer, "a");
  const atEnd = type(createEditorState(), "ab");
  assert.equal(press(atEnd, "ctrl-d").state.buffer, "ab");
});

test("editor ctrl-c clears then exits, and exits immediately when idle twice", () => {
  let result = reduceEditor(type(createEditorState(), "half typed"), { name: "ctrl-c" });
  assert.equal(result.cancelled, true);
  assert.equal(result.exit, undefined);
  assert.equal(result.state.buffer, "");
  assert.equal(result.state.interrupts, 1);

  result = reduceEditor(result.state, { name: "ctrl-c" });
  assert.equal(result.exit, true);

  const idle = reduceEditor(createEditorState(), { name: "ctrl-c" });
  assert.equal(idle.cancelled, true);
  assert.equal(idle.exit, undefined);
  assert.equal(reduceEditor(idle.state, { name: "ctrl-c" }).exit, true);
});

test("editor any other key resets the interrupt counter", () => {
  const first = reduceEditor(createEditorState(), { name: "ctrl-c" });
  const typed = type(first.state, "a");
  assert.equal(typed.interrupts, 0);
  assert.equal(reduceEditor(typed, { name: "ctrl-c" }).exit, undefined);
});

/* ------------------------------------------------------------------ *
 * Key decoding
 * ------------------------------------------------------------------ */

test("decoder maps control bytes and escape sequences", () => {
  assert.deepEqual(decodeKeys("a"), [{ name: "text", text: "a" }]);
  assert.deepEqual(decodeKeys("\u001b[A"), [{ name: "up" }]);
  assert.deepEqual(decodeKeys("\u001b[3~"), [{ name: "delete" }]);
  assert.deepEqual(decodeKeys("\u001b[H"), [{ name: "home" }]);
  assert.deepEqual(decodeKeys("\u0003"), [{ name: "ctrl-c" }]);
  assert.deepEqual(decodeKeys("\u0004"), [{ name: "ctrl-d" }]);
  assert.deepEqual(decodeKeys("\u0015"), [{ name: "ctrl-u" }]);
  assert.deepEqual(decodeKeys("\r"), [{ name: "enter" }]);
  assert.deepEqual(decodeKeys("\u007f"), [{ name: "backspace" }]);
  assert.deepEqual(decodeKeys("\t"), [{ name: "tab" }]);
  assert.deepEqual(decodeKeys("ab"), [{ name: "text", text: "ab" }]);
});

test("decoder holds a split escape sequence until it completes", () => {
  const decoder = createKeyDecoder();
  assert.deepEqual(decoder.push("\u001b["), []);
  assert.deepEqual(decoder.push("A"), [{ name: "up" }]);
});

/* ------------------------------------------------------------------ *
 * Completion
 * ------------------------------------------------------------------ */

test("slash completion matches commands by prefix", () => {
  assert.deepEqual(complete("/he"), { matches: ["/help"], replacement: "/help" });
  assert.deepEqual(complete("/mo").matches, ["/model"]);
  assert.equal(complete("/").matches.length, SLASH_COMMANDS.length);
  assert.deepEqual(complete("/zzz"), { matches: [] });
});

test("completion never matches once an argument is present", () => {
  assert.deepEqual(complete("/model deep").matches, []);
});

test("at-file completion matches paths and stops at ambiguity", () => {
  const files = ["src/theme.ts", "src/tokens.ts", "README.md"];
  assert.deepEqual(complete("@README", { files }), { matches: ["@README.md"], replacement: "@README.md" });
  assert.deepEqual(complete("@src/t", { files }), { matches: ["@src/theme.ts", "@src/tokens.ts"] });
  assert.deepEqual(complete("@nope", { files }), { matches: [] });
  assert.deepEqual(complete("@theme", { files }).matches, ["@src/theme.ts"]);
});

test("completion walks a temp directory and ignores node_modules", () => {
  const cwd = mkdtempSync(join(TMP_ROOT, "files-"));
  mkdirSync(join(cwd, "src"), { recursive: true });
  mkdirSync(join(cwd, "node_modules", "pkg"), { recursive: true });
  writeFileSync(join(cwd, "src", "app.ts"), "");
  writeFileSync(join(cwd, "README.md"), "");
  writeFileSync(join(cwd, "node_modules", "pkg", "index.js"), "");

  const files = walkFiles(cwd);
  assert.deepEqual(files, ["README.md", "src/app.ts"]);
  assert.deepEqual(complete("@src/ap", { files }), { matches: ["@src/app.ts"], replacement: "@src/app.ts" });
  assert.deepEqual(complete("@", { files }).matches, ["@README.md", "@src/app.ts"]);
});

test("tokenAt finds the token under the cursor", () => {
  const line = "explain @src/theme.ts please";
  const span = tokenAt(line, 12);
  assert.equal(span.text, "@src/theme.ts");
  assert.equal(line.slice(span.start, span.end), "@src/theme.ts");
});

/* ------------------------------------------------------------------ *
 * Status and chrome
 * ------------------------------------------------------------------ */

test("status line renders agent, model and cwd, and truncates to width", () => {
  const theme = plain();
  const line = stripAnsi(
    renderStatusLine(
      { agent: "build", model: "deepseek/deepseek-chat", cwd: "/home/dev/code/kortivai" },
      theme,
    ),
  );
  assert.match(line, /build/);
  assert.match(line, /deepseek\/deepseek-chat/);
  assert.match(line, /kortivai/);

  const narrow = createTheme({ level: 0, glyphs: GLYPHS_UNICODE, columns: 40 });
  const clipped = renderStatusLine(
    { agent: "build", model: "deepseek/deepseek-reasoner", cwd: "/home/dev/code/kortivai", usage: { input: 12_345, output: 678 } },
    narrow,
  );
  assert.ok(displayWidth(clipped) <= 40, `expected <= 40, got ${displayWidth(clipped)}`);
  assert.ok(stripAnsi(clipped).startsWith("  build"));
});

test("status line is plain when colour level is 0", () => {
  const line = renderStatusLine({ agent: "plan", model: "m", cwd: "/tmp" }, plain());
  assert.equal(line.includes("\u001b"), false);
  assert.match(stripAnsi(line), /plan/);
});

test("plan is visible in the prompt prefix", () => {
  const plan = stripAnsi(renderPromptPrefix({ agent: "plan" }, plain()));
  assert.match(plan, /plan/);
  assert.match(plan, /❯/);
  const build = stripAnsi(renderPromptPrefix({ agent: "build", busy: true }, plain()));
  assert.match(build, /working/);
});

test("banner and exit summary render the essentials", () => {
  const banner = stripAnsi(
    renderBanner(
      { name: "kortivai", version: "0.1.0", cwd: "/home/dev/code/kortivai", model: "deepseek/deepseek-chat", agent: "build" },
      plain(),
    ),
  );
  assert.match(banner, /KORTIVAI 0\.1\.0/);
  assert.match(banner, /deepseek\/deepseek-chat/);
  assert.match(banner, /\/help for commands/);

  const summary = stripAnsi(
    renderSessionSummary({ sessionId: "3f9c2a11aa", messages: 4, usage: { input: 1200, output: 340, cost: 0.0021 } }, plain()),
  );
  assert.match(summary, /4 messages/);
  assert.match(summary, /1\.2k in \/ 340 out/);
  assert.match(summary, /session 3f9c2a11/);
});

test("shortenPath compresses the home directory", () => {
  assert.equal(shortenPath("/home/dev/code/kortivai", "/home/dev"), "~/code/kortivai");
});

test("shortenPath truncates a long Windows path at separators, never mid-drive", () => {
  // Regression: backslash paths used to be split on "/" without normalising,
  // so the whole path became one segment and truncation produced ".../C:\...".
  const shortened = shortenPath("C:\\Users\\ompra\\AppData\\Local\\Temp\\dsh-0Iw2Fj\\deep\\project");
  assert.match(shortened, /^(?:\.\.\.|…)\//, `expected a truncation marker: ${shortened}`);
  assert.ok(!shortened.includes("\\"), "chrome uses forward slashes");
  assert.ok(!shortened.includes("C:"), "the drive letter is dropped when truncating");
  assert.ok(shortened.endsWith("project"), "the identifying tail is kept");
  assert.ok(shortened.length <= 44, `too long: ${shortened}`);
});

test("shortenPath leaves a short path untouched", () => {
  assert.equal(shortenPath("/srv/app"), "/srv/app");
});

/* ------------------------------------------------------------------ *
 * Permission helper
 * ------------------------------------------------------------------ */

test("permission helper maps y/n/a and ignores other keys", () => {
  assert.equal(decidePermission("y"), "allow");
  assert.equal(decidePermission({ name: "text", text: "Y" }), "allow");
  assert.equal(decidePermission("n"), "deny");
  assert.equal(decidePermission({ name: "text", text: "n" }), "deny");
  assert.equal(decidePermission("a"), "allow-always");
  assert.equal(decidePermission({ name: "text", text: "A" }), "allow-always");
  assert.equal(decidePermission("enter"), "deny");
  assert.equal(decidePermission("escape"), "deny");
  assert.equal(decidePermission("x"), undefined);
  assert.equal(decidePermission("left"), undefined);
});
