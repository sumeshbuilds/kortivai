import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { parseArgs } from "../src/cli/args.ts";
import { memoryIo } from "../src/cli/io.ts";
import { KortivError } from "../src/util/errors.ts";
import { main, packageVersion, renderCliError, renderHelp } from "../src/cli/index.ts";
import { formatContext } from "../src/cli/cmd/models.ts";
import { formatAge } from "../src/cli/cmd/sessions.ts";

const TMP_ROOT = resolve(process.cwd(), ".kortivai-tmp");
let workDir = "";
const savedEnv: Record<string, string | undefined> = {};

before(() => {
  rmSync(TMP_ROOT, { recursive: true, force: true });
  mkdirSync(join(TMP_ROOT, "home"), { recursive: true });
  process.env.KORTIVAI_HOME = join(TMP_ROOT, "home");
  for (const key of ["KORTIVAI_MODEL", "KORTIVAI_SMALL_MODEL", "KORTIVAI_TEMPERATURE", "KORTIVAI_MAX_STEPS"]) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

after(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(TMP_ROOT, { recursive: true, force: true });
});

function freshCwd(): string {
  workDir = mkdtempSync(join(TMP_ROOT, "cwd-"));
  return workDir;
}

/* ------------------------------------------------------------------ *
 * Argument parsing
 * ------------------------------------------------------------------ */

test("parseArgs defaults to the interactive command", () => {
  assert.deepEqual(parseArgs([]), { command: "tui", positionals: [], flags: {} });
});

test("parseArgs recognises every command", () => {
  for (const command of ["run", "models", "sessions", "agents", "help", "tui", "version"]) {
    assert.equal(parseArgs([command]).command, command);
  }
});

test("parseArgs collects positionals for run", () => {
  const parsed = parseArgs(["run", "fix", "the", "bug"]);
  assert.equal(parsed.command, "run");
  assert.deepEqual(parsed.positionals, ["fix", "the", "bug"]);
});

test("parseArgs handles long and short value flags", () => {
  assert.equal(parseArgs(["--model", "deepseek/deepseek-chat"]).flags.model, "deepseek/deepseek-chat");
  assert.equal(parseArgs(["-m", "deepseek/deepseek-chat"]).flags.model, "deepseek/deepseek-chat");
  assert.equal(parseArgs(["--model=x/y"]).flags.model, "x/y");
  assert.equal(parseArgs(["-mz/y"]).flags.model, "z/y");
  assert.equal(parseArgs(["--agent", "plan"]).flags.agent, "plan");
  assert.equal(parseArgs(["-a", "plan"]).flags.agent, "plan");
  assert.equal(parseArgs(["--cwd", "/tmp/x"]).flags.cwd, "/tmp/x");
  assert.equal(parseArgs(["-C", "/tmp/x"]).flags.cwd, "/tmp/x");
  assert.equal(parseArgs(["--session", "abc"]).flags.session, "abc");
  assert.equal(parseArgs(["-s", "abc"]).flags.session, "abc");
});

test("parseArgs handles every boolean flag", () => {
  const flags = parseArgs([
    "--help",
    "--version",
    "--continue",
    "--yolo",
    "--plan",
    "--no-mcp",
    "--debug",
    "--json",
    "--quiet",
  ]).flags;
  assert.deepEqual(flags, {
    help: true,
    version: true,
    continue: true,
    yolo: true,
    plan: true,
    noMcp: true,
    debug: true,
    json: true,
    quiet: true,
  });
});

test("parseArgs handles short boolean aliases and clusters", () => {
  assert.equal(parseArgs(["-h"]).flags.help, true);
  assert.equal(parseArgs(["-v"]).flags.version, true);
  assert.equal(parseArgs(["-c"]).flags.continue, true);
  const clustered = parseArgs(["-cv"]).flags;
  assert.equal(clustered.continue, true);
  assert.equal(clustered.version, true);
});

test("parseArgs stops flag parsing at --", () => {
  const parsed = parseArgs(["run", "--", "--not-a-flag"]);
  assert.deepEqual(parsed.positionals, ["--not-a-flag"]);
  assert.equal(parsed.flags.quiet, undefined);
});

test("parseArgs rejects an unknown flag with a hint", () => {
  assert.throws(
    () => parseArgs(["--frobnicate"]),
    (error: unknown) =>
      error instanceof KortivError &&
      /Unknown option "--frobnicate"/.test(error.message) &&
      Boolean(error.hint),
  );
  assert.throws(() => parseArgs(["-z"]), /Unknown option "-z"/);
});

test("parseArgs rejects a missing flag value", () => {
  assert.throws(
    () => parseArgs(["--model"]),
    (error: unknown) => error instanceof KortivError && /needs a value/.test(error.message),
  );
  assert.throws(() => parseArgs(["-s"]), /needs a value/);
});

test("parseArgs rejects an unknown command", () => {
  assert.throws(
    () => parseArgs(["explain"]),
    (error: unknown) => error instanceof KortivError && /Unknown command "explain"/.test(error.message),
  );
});

/* ------------------------------------------------------------------ *
 * Entry point
 * ------------------------------------------------------------------ */

test("--help exits 0 and prints usage with examples", async () => {
  const io = memoryIo();
  assert.equal(await main(["--help"], io), 0);
  const out = io.out();
  assert.match(out, /USAGE/);
  assert.match(out, /COMMANDS/);
  assert.match(out, /EXAMPLES/);
  assert.match(out, /kortivai run "explain src\/core\/agent\.ts"/);
});

test("command-scoped help is specific", async () => {
  const io = memoryIo();
  assert.equal(await main(["help", "run"], io), 0);
  assert.match(io.out(), /Run one turn/);
  assert.match(io.out(), /--yolo/);
});

test("--version exits 0 and matches package.json", async () => {
  const io = memoryIo();
  assert.equal(await main(["--version"], io), 0);
  assert.equal(io.out().trim(), `kortivai ${packageVersion()}`);
});

test("an unknown command exits 1 with an actionable error", async () => {
  const io = memoryIo();
  assert.equal(await main(["explain"], io), 1);
  assert.match(io.err(), /Unknown command "explain"/);
  assert.match(io.err(), /hint:/);
});

test("an unknown option exits 1 before any command runs", async () => {
  const io = memoryIo();
  assert.equal(await main(["--nope"], io), 1);
  assert.match(io.err(), /Unknown option "--nope"/);
});

test("renderCliError maps hints and the debug cause chain", () => {
  const plainError = renderCliError(new KortivError("boom", { hint: "try again" }), false);
  assert.match(plainError, /^kortivai: boom/);
  assert.match(plainError, /hint: try again/);
  const debugged = renderCliError(
    new KortivError("outer", { hint: "inner fix", cause: new Error("socket closed") }),
    true,
  );
  assert.match(debugged, /caused by: socket closed/);
});

/* ------------------------------------------------------------------ *
 * Pure command helpers
 * ------------------------------------------------------------------ */

test("formatContext and formatAge are stable", () => {
  assert.equal(formatContext(128_000), "128k");
  assert.equal(formatContext(1_000_000), "1M");
  assert.equal(formatContext(8192), "8k");
  assert.equal(formatAge(Date.now()), "just now");
  assert.equal(formatAge(Date.now() - 5 * 60_000), "5m");
  assert.equal(formatAge(Date.now() - 3 * 3_600_000), "3h");
});

test("renderHelp lists every documented command", () => {
  const help = renderHelp();
  for (const command of ["run", "models", "sessions", "agents", "help"]) {
    assert.match(help, new RegExp(`^  ${command}\\s`, "m"));
  }
});

/* ------------------------------------------------------------------ *
 * Run path
 * ------------------------------------------------------------------ */

test("run exits non-zero with an actionable error when no provider can serve the model", async () => {
  const io = memoryIo({ cwd: freshCwd(), env: process.env });
  const code = await main(["run", "--model", "kortivai-test-missing/none", "hello"], io);
  assert.notEqual(code, 0);
  assert.ok(io.err().trim().length > 0, "an error must be reported on stderr");
  assert.match(io.err(), /hint:/i);
  assert.ok(!/\n\s+at .+:\d+:\d+/.test(io.err()), "must not leak a raw stack trace");
  assert.equal(io.out(), "");
});

test("run --json reports the failure as a machine-readable object", async () => {
  const io = memoryIo({ cwd: freshCwd(), env: process.env });
  const code = await main(["run", "--json", "--model", "kortivai-test-missing/none", "hello"], io);
  assert.notEqual(code, 0);
  const parsed = JSON.parse(io.out()) as { ok: boolean; error: string; hint: string | null };
  assert.equal(parsed.ok, false);
  assert.ok(parsed.error.length > 0);
});

test("run without a prompt is refused instead of hanging", async () => {
  const emptyStdin = Readable.from([]) as unknown as NodeJS.ReadStream;
  const io = memoryIo({ cwd: freshCwd(), stdin: emptyStdin, stdinIsTTY: false });
  const code = await main(["run"], io);
  assert.equal(code, 1);
  assert.match(io.err(), /No prompt given/);
});
