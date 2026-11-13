import test from "node:test";
import assert from "node:assert/strict";
import {
  GLYPHS_ASCII,
  GLYPHS_UNICODE,
  createTheme,
  detectColorLevel,
  detectGlyphs,
  displayWidth,
  padEndVisible,
  stripAnsi,
  truncateVisible,
  wrapVisible,
} from "../src/ui/theme.ts";
import { renderMarkdown } from "../src/ui/markdown.ts";
import { looksLikeDiff, parseDiffSummary, renderDiff } from "../src/ui/diff.ts";

/** Colour-off theme: assertions read as plain text and stay stable. */
function plain() {
  return createTheme({ level: 0, glyphs: GLYPHS_UNICODE, columns: 80 });
}

/* ------------------------------------------------------------------ *
 * Capability detection
 * ------------------------------------------------------------------ */

test("detectColorLevel reads COLORTERM, TERM, NO_COLOR and FORCE_COLOR", () => {
  assert.equal(detectColorLevel({ COLORTERM: "truecolor", TERM: "xterm-256color" }, true), 3);
  assert.equal(detectColorLevel({ COLORTERM: "24bit" }, true), 3);
  assert.equal(detectColorLevel({ TERM: "xterm-256color" }, true), 2);
  assert.equal(detectColorLevel({ TERM: "xterm" }, true), 1);
  assert.equal(detectColorLevel({}, true), 1);
  assert.equal(detectColorLevel({ COLORTERM: "truecolor" }, false), 0);
  assert.equal(detectColorLevel({ TERM: "dumb" }, true), 0);
  assert.equal(detectColorLevel({ NO_COLOR: "1", COLORTERM: "truecolor" }, true), 0);
  assert.equal(detectColorLevel({ NO_COLOR: "1", FORCE_COLOR: "3" }, false), 3);
  assert.equal(detectColorLevel({ FORCE_COLOR: "0" }, true), 0);
  assert.equal(detectColorLevel({ FORCE_COLOR: "true" }, false), 1);
});

test("detectGlyphs falls back to ASCII on a legacy Windows console", () => {
  assert.equal(detectGlyphs({ TERM: "xterm-256color" }, "linux").gutter, GLYPHS_UNICODE.gutter);
  assert.equal(detectGlyphs({ WT_SESSION: "abc" }, "win32").gutter, GLYPHS_UNICODE.gutter);
  assert.equal(detectGlyphs({ LANG: "en_US.UTF-8" }, "win32").gutter, GLYPHS_UNICODE.gutter);
  assert.equal(detectGlyphs({}, "win32").gutter, GLYPHS_ASCII.gutter);
  assert.equal(detectGlyphs({ KORTIVAI_ASCII: "1", TERM: "xterm" }, "linux").gutter, GLYPHS_ASCII.gutter);
  assert.equal(detectGlyphs({}, "linux").spinner.length, GLYPHS_UNICODE.spinner.length);
});

/* ------------------------------------------------------------------ *
 * Theme and width
 * ------------------------------------------------------------------ */

test("colour tiers emit the matching SGR sequence", () => {
  const truecolor = createTheme({ level: 3, glyphs: GLYPHS_UNICODE });
  assert.match(truecolor.paint("x", "accent"), /38;2;\d+;\d+;\d+/);
  const palette256 = createTheme({ level: 2, glyphs: GLYPHS_UNICODE });
  assert.match(palette256.paint("x", "accent"), /38;5;\d+/);
  const sixteen = createTheme({ level: 1, glyphs: GLYPHS_UNICODE });
  assert.match(sixteen.paint("x", "accent"), /\u001b\[\d+m/);
  assert.equal(stripAnsi(sixteen.paint("x", "accent")), "x");
});

test("mono theme keeps hierarchy without hue", () => {
  const mono = createTheme({ name: "mono", level: 3, glyphs: GLYPHS_UNICODE });
  const painted = mono.paint("danger", "danger");
  assert.equal(stripAnsi(painted), "danger");
  assert.ok(!painted.includes("38;"));
  assert.ok(painted.includes("\u001b[1m"));
});

test("level 0 returns unstyled text", () => {
  const theme = plain();
  assert.equal(theme.paint("x", "accent"), "x");
  assert.equal(theme.bold("x"), "x");
  assert.ok(!theme.color);
});

test("width helpers treat CJK as two columns and ignore ANSI", () => {
  assert.equal(displayWidth("中文"), 4);
  assert.equal(displayWidth("abc"), 3);
  assert.equal(displayWidth("\u001b[31mab\u001b[0m"), 2);
  assert.equal(padEndVisible("中", 4), "中  ");
  assert.equal(truncateVisible("abcdef", 4, "…"), "abc…");
  assert.equal(displayWidth(truncateVisible("中文中文", 5, "…")), 5);
  assert.deepEqual(wrapVisible("one two three", 7), ["one two", "three"]);
});

/* ------------------------------------------------------------------ *
 * Markdown
 * ------------------------------------------------------------------ */

test("markdown headings render a marker and a rule", () => {
  const out = renderMarkdown("# Title\n\nbody", plain());
  const lines = out.split("\n");
  assert.equal(lines[0], "▸ Title");
  assert.match(lines[1]!, /^─{3,}$/);
  assert.equal(lines[3], "body");
  assert.equal(renderMarkdown("### Sub", plain()), "▸ Sub");
});

test("markdown renders fenced code with a language label and gutter", () => {
  const out = renderMarkdown("```ts\nconst x = 1;\n```", plain());
  assert.equal(out, "▏ ts\n▏ const x = 1;");
});

test("an unterminated fence still renders as code and loses no text", () => {
  const out = renderMarkdown("```ts\nconst x = 1;\npartial", plain());
  assert.ok(out.startsWith("▏ ts\n"));
  assert.ok(out.includes("▏ const x = 1;"));
  assert.ok(out.includes("▏ partial"));
});

test("markdown renders nested lists at increasing indentation", () => {
  const out = renderMarkdown("- one\n  - two\n    - three\n1. first", plain());
  const lines = out.split("\n");
  assert.equal(lines[0], "• one");
  assert.equal(lines[1], "  • two");
  assert.equal(lines[2], "    • three");
  assert.equal(lines[3], "1.  first");
});

test("markdown inline code, emphasis and links survive colour-off mode", () => {
  const out = renderMarkdown("use `run()` and **bold** and [docs](https://kortiv.dev)", plain());
  assert.equal(out, "use run() and bold and docs (https://kortiv.dev)");
});

test("markdown renders rules and blockquotes", () => {
  const theme = plain();
  const rule = renderMarkdown("---", theme);
  assert.match(rule, /^─+$/);
  assert.equal(renderMarkdown("> note", theme), "▏ note");
});

test("markdown styling is re-applied when colour is on", () => {
  const out = renderMarkdown("# Title", createTheme({ level: 3, glyphs: GLYPHS_UNICODE }));
  assert.ok(out.includes("\u001b["));
  assert.equal(stripAnsi(out).split("\n")[0], "▸ Title");
});

/* ------------------------------------------------------------------ *
 * Diff
 * ------------------------------------------------------------------ */

const SAMPLE_DIFF = [
  "diff --git a/src/a.ts b/src/a.ts",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,3 +1,3 @@",
  "-old line",
  "+new line",
  " context",
].join("\n");

test("diff renders file header, hunk and added/removed lines", () => {
  const out = stripAnsi(renderDiff(SAMPLE_DIFF, plain()));
  const lines = out.split("\n");
  assert.equal(lines[0], "▸ src/a.ts  +1 -1");
  assert.equal(lines[1], "@@ -1,3 +1,3 @@");
  assert.equal(lines[2], "-old line");
  assert.equal(lines[3], "+new line");
  assert.equal(lines[4], " context");
});

test("diff colours added and removed lines", () => {
  const out = renderDiff(SAMPLE_DIFF, createTheme({ level: 3, glyphs: GLYPHS_UNICODE }));
  assert.notEqual(out, stripAnsi(out));
  assert.equal(stripAnsi(out).includes("+new line"), true);
});

test("diff summaries and sniffing", () => {
  assert.deepEqual(parseDiffSummary(SAMPLE_DIFF), [{ path: "src/a.ts", added: 1, removed: 1 }]);
  assert.equal(looksLikeDiff(SAMPLE_DIFF), true);
  assert.equal(looksLikeDiff("just prose"), false);
});
