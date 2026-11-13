/**
 * Pure argument parser: `string[] -> ParsedArgs`. No I/O, no process access,
 * so every flag rule is unit-testable.
 */
import { KortivError } from "../util/errors.ts";

export type Flags = Record<string, string | boolean | undefined>;

export interface ParsedArgs {
  command: string;
  positionals: string[];
  flags: Flags;
}

interface FlagSpec {
  name: string;
  key: string;
  short?: string;
  type: "boolean" | "string";
}

const FLAG_SPECS: FlagSpec[] = [
  { name: "help", key: "help", short: "h", type: "boolean" },
  { name: "version", key: "version", short: "v", type: "boolean" },
  { name: "model", key: "model", short: "m", type: "string" },
  { name: "agent", key: "agent", short: "a", type: "string" },
  { name: "cwd", key: "cwd", short: "C", type: "string" },
  { name: "continue", key: "continue", short: "c", type: "boolean" },
  { name: "session", key: "session", short: "s", type: "string" },
  { name: "yolo", key: "yolo", type: "boolean" },
  { name: "plan", key: "plan", type: "boolean" },
  { name: "no-mcp", key: "noMcp", type: "boolean" },
  { name: "debug", key: "debug", type: "boolean" },
  { name: "json", key: "json", type: "boolean" },
  { name: "quiet", key: "quiet", type: "boolean" },
  { name: "force", key: "force", type: "boolean" },
  { name: "base-url", key: "baseUrl", type: "string" },
];

const HELP_HINT = "Run `kortivai --help` to see available options.";

export const COMMANDS = ["run", "models", "sessions", "agents", "auth", "init", "help", "tui", "version"] as const;

function unknownFlag(flag: string): KortivError {
  return new KortivError(`Unknown option "${flag}".`, { hint: HELP_HINT });
}

function missingValue(flag: string): KortivError {
  return new KortivError(`Option "${flag}" needs a value.`, {
    hint: `Pass it as \`${flag} value\`.`,
  });
}

function booleanValue(flag: string, raw: string): boolean {
  if (raw === "false" || raw === "0" || raw === "no") return false;
  if (raw === "true" || raw === "1" || raw === "yes" || raw === "") return true;
  throw new KortivError(`Option "${flag}" takes no value.`, { hint: HELP_HINT });
}

/**
 * Parses argv (without the node/script prefix). Throws {@link KortivError}
 * for an unknown option, a missing value, or an unknown command.
 */
export function parseArgs(argv: string[]): ParsedArgs {
  const flags: Flags = {};
  const positionals: string[] = [];
  let onlyPositionals = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;

    if (onlyPositionals || !token.startsWith("-") || token === "-") {
      positionals.push(token);
      continue;
    }
    if (token === "--") {
      onlyPositionals = true;
      continue;
    }
    if (token.startsWith("--")) {
      const equals = token.indexOf("=");
      const name = equals >= 0 ? token.slice(2, equals) : token.slice(2);
      const spec = FLAG_SPECS.find((candidate) => candidate.name === name);
      if (!spec) throw unknownFlag(`--${name}`);
      if (spec.type === "boolean") {
        flags[spec.key] = equals >= 0 ? booleanValue(`--${name}`, token.slice(equals + 1)) : true;
        continue;
      }
      if (equals >= 0) {
        const value = token.slice(equals + 1);
        if (!value) throw missingValue(`--${name}`);
        flags[spec.key] = value;
        continue;
      }
      const next = argv[index + 1];
      if (next === undefined) throw missingValue(`--${name}`);
      flags[spec.key] = next;
      index += 1;
      continue;
    }

    const body = token.slice(1);
    for (let cursor = 0; cursor < body.length; cursor += 1) {
      const letter = body[cursor]!;
      const spec = FLAG_SPECS.find((candidate) => candidate.short === letter);
      if (!spec) throw unknownFlag(`-${letter}`);
      if (spec.type === "boolean") {
        flags[spec.key] = true;
        continue;
      }
      const rest = body.slice(cursor + 1);
      if (rest) {
        flags[spec.key] = rest.startsWith("=") ? rest.slice(1) : rest;
        break;
      }
      const next = argv[index + 1];
      if (next === undefined) throw missingValue(`-${letter}`);
      flags[spec.key] = next;
      index += 1;
      break;
    }
  }

  const first = positionals[0];
  if (first !== undefined && (COMMANDS as readonly string[]).includes(first)) {
    positionals.shift();
    return { command: first, positionals, flags };
  }
  if (first !== undefined) {
    throw new KortivError(`Unknown command "${first}".`, {
      hint: "Run `kortivai --help` to see available commands.",
    });
  }
  return { command: "tui", positionals, flags };
}
