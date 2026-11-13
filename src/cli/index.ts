#!/usr/bin/env node
/**
 * KortivAI bin entry.
 *
 * Thin by design: parse, dispatch, map errors. Commands own their output; the
 * entry owns exit codes and the `--help` / `--version` surfaces.
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { KortivError, errorChain, errorMessage } from "../util/errors.ts";
import { parseArgs, type ParsedArgs } from "./args.ts";
import { createIo, type CliContext, type CliIo } from "./io.ts";
import { runCommand } from "./cmd/run.ts";
import { modelsCommand } from "./cmd/models.ts";
import { sessionsCommand } from "./cmd/sessions.ts";
import { agentsCommand } from "./cmd/agents.ts";

export function packageVersion(): string {
  try {
    const url = new URL("../../package.json", import.meta.url);
    const parsed = JSON.parse(readFileSync(url, "utf8")) as { version?: string };
    return parsed.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

interface CommandHelp {
  summary: string;
  usage: string;
  options?: string[];
  examples: string[];
}

const COMMAND_HELP: Record<string, CommandHelp> = {
  run: {
    summary: "Run one turn without the terminal UI, then exit.",
    usage: 'kortivai run [prompt] [options]',
    options: [
      "-m, --model <provider/model>   model for this turn",
      "-a, --agent <name>             agent to run (build, plan, ...)",
      "    --yolo                     approve every permission request",
      "    --plan                     shorthand for --agent plan",
      "    --json                     print a machine-readable result",
      "    --quiet                    no progress output on stderr",
      "    --continue, --session <id> resume a saved session",
      "    --no-mcp                   skip MCP servers",
    ],
    examples: [
      'kortivai run "explain src/core/agent.ts"',
      'echo "add tests for the parser" | kortivai run',
      'kortivai run --json "summarise the last commit" > result.json',
    ],
  },
  models: {
    summary: "List providers, their models, context windows and credential status.",
    usage: "kortivai models [--json]",
    examples: ["kortivai models", "kortivai models --json"],
  },
  sessions: {
    summary: "List saved sessions, or remove one.",
    usage: "kortivai sessions [rm <id>] [--json]",
    examples: ["kortivai sessions", "kortivai sessions rm 3f9c2a11"],
  },
  agents: {
    summary: "List the agents available to `--agent`.",
    usage: "kortivai agents [--json]",
    examples: ["kortivai agents"],
  },
  tui: {
    summary: "Start the interactive terminal UI.",
    usage: "kortivai [tui]",
    examples: ["kortivai"],
  },
  help: {
    summary: "Show help, optionally for one command.",
    usage: "kortivai help [command]",
    examples: ["kortivai help run"],
  },
};

export function renderHelp(command?: string): string {
  const version = packageVersion();
  const topic = command ? COMMAND_HELP[command] : undefined;
  if (topic) {
    return [
      `KORTIVAI ${version} — ${topic.summary}`,
      "",
      "USAGE",
      `  ${topic.usage}`,
      ...(topic.options ? ["", "OPTIONS", ...topic.options.map((line) => `  ${line}`)] : []),
      "",
      "EXAMPLES",
      ...topic.examples.map((line) => `  ${line}`),
    ].join("\n");
  }

  return [
    `KORTIVAI ${version} — terminal AI coding agent`,
    "",
    "USAGE",
    "  kortivai [command] [options]",
    '  kortivai run "<prompt>" [options]',
    "",
    "COMMANDS",
    "  (none)      Start the interactive terminal UI",
    "  run         Run one turn headlessly and print the result",
    "  models      Providers, models, context windows, credential status",
    "  sessions    List saved sessions, or remove one",
    "  agents      List the agents available to --agent",
    "  help        Show help for a command",
    "",
    "OPTIONS",
    "  -m, --model <provider/model>   model for this run",
    "  -a, --agent <name>             agent to run (build, plan, ...)",
    "  -C, --cwd <dir>                working directory",
    "  -c, --continue                 continue the most recent session",
    "  -s, --session <id>             resume a session by id (prefix ok)",
    "      --yolo                     approve every permission request",
    "      --plan                     shorthand for --agent plan",
    "      --no-mcp                   do not start MCP servers",
    "      --json                     machine-readable output",
    "      --quiet                    no progress output on stderr",
    "      --debug                    print the cause chain for errors",
    "  -h, --help                     show this help",
    "  -v, --version                  print the version",
    "",
    "EXAMPLES",
    '  kortivai run "explain src/core/agent.ts"',
    '  kortivai run --model deepseek/deepseek-chat --json "summarise the repo"',
    '  echo "add tests for the parser" | kortivai run',
    '  kortivai --plan "map the auth flow"',
    "  kortivai sessions",
    "",
    "ENVIRONMENT",
    "  KORTIVAI_HOME   state directory (sessions, auth, logs)",
    "  NO_COLOR        disable colour; FORCE_COLOR=1..3 forces a tier",
  ].join("\n");
}

export function renderCliError(error: unknown, debug: boolean): string {
  const message = error instanceof KortivError ? error.message : errorMessage(error);
  const hint = error instanceof KortivError ? error.hint : undefined;
  const lines = [`kortivai: ${message}`];
  if (hint) lines.push(`  hint: ${hint}`);
  else if (!(error instanceof KortivError)) lines.push("  hint: run with --debug to see the cause chain.");
  if (debug) {
    for (const entry of errorChain(error).slice(1)) {
      lines.push(`  caused by: ${entry.replace(/\n\s*/g, " ")}`);
    }
  }
  return lines.join("\n");
}

export async function main(argv: string[], io: CliIo = createIo()): Promise<number> {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    io.stderr.write(`${renderCliError(error, false)}\n`);
    return 1;
  }

  const debug = parsed.flags.debug === true;
  const ctx: CliContext = { io, flags: parsed.flags, positionals: parsed.positionals };

  try {
    if (parsed.flags.version === true || parsed.command === "version") {
      io.stdout.write(`kortivai ${packageVersion()}\n`);
      return 0;
    }
    const helpTopic =
      parsed.command === "help"
        ? parsed.positionals[0]
        : parsed.flags.help === true && parsed.command !== "tui"
          ? parsed.command
          : undefined;
    if (parsed.flags.help === true || parsed.command === "help") {
      io.stdout.write(`${renderHelp(helpTopic)}\n`);
      return 0;
    }

    switch (parsed.command) {
      case "run":
        return await runCommand(ctx);
      case "models":
        return await modelsCommand(ctx);
      case "sessions":
        return await sessionsCommand(ctx);
      case "agents":
        return await agentsCommand(ctx);
      case "tui":
        // A piped stdin falls back to a headless one-shot so scripts never hang.
        if (!io.stdinIsTTY) return await runCommand(ctx);
        throw new KortivError("The interactive TUI is not available in this build yet.", {
          hint: 'Use `kortivai run "<prompt>"` for a one-shot turn.',
        });
      default:
        throw new KortivError(`Unknown command "${parsed.command}".`, {
          hint: "Run `kortivai --help` to see available commands.",
        });
    }
  } catch (error) {
    io.stderr.write(`${renderCliError(error, debug)}\n`);
    return 1;
  }
}

const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === entry) {
  process.exitCode = await main(process.argv.slice(2));
}
