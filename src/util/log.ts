import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { logDir } from "./paths.ts";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * Secrets must never reach a log file. Order matters: whole-header patterns run
 * first, because the generic key/value rule would otherwise redact the scheme
 * word (`Bearer`) and leave the actual token exposed next to it.
 */
const REDACTIONS: Array<{ pattern: RegExp; replacement: string }> = [
  { pattern: /(\bauthorization\b\s*[:=]\s*)([^\r\n]+)/gi, replacement: "$1<redacted>" },
  { pattern: /(\bbearer\s+)([A-Za-z0-9._~+/=-]{8,})/gi, replacement: "$1<redacted>" },
  { pattern: /\b(sk-[A-Za-z0-9_-]{8,})/g, replacement: "<redacted>" },
  { pattern: /\b(nvapi-[A-Za-z0-9_-]{8,})/g, replacement: "<redacted>" },
  { pattern: /\b(oc_sk_[A-Za-z0-9_-]{8,})/g, replacement: "<redacted>" },
  { pattern: /\b(thk_live_[A-Za-z0-9_-]{8,})/g, replacement: "<redacted>" },
  {
    pattern: /("?(?:api[_-]?key|token|secret|password|access[_-]?key)"?\s*[:=]\s*)("?)([^"\r\n,}]{6,})\2/gi,
    replacement: "$1$2<redacted>$2",
  },
];

export function redact(input: string): string {
  let out = input;
  for (const { pattern, replacement } of REDACTIONS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

export interface LoggerOptions {
  /** Minimum level written to the log file. */
  level?: LogLevel;
  /** Also mirror to stderr, used when `--debug` is passed. */
  stderr?: boolean;
  /** File name inside the log directory. */
  name?: string;
  /** Disable file output entirely (useful in tests). */
  silent?: boolean;
}

export interface Logger {
  debug(message: string, meta?: unknown): void;
  info(message: string, meta?: unknown): void;
  warn(message: string, meta?: unknown): void;
  error(message: string, meta?: unknown): void;
  child(scope: string): Logger;
  /** Absolute path of the log file, or "" when file logging is off. */
  readonly file: string;
}

function serialize(meta: unknown): string {
  if (meta === undefined) return "";
  if (meta instanceof Error) {
    return ` ${redact(`${meta.name}: ${meta.message}`)}`;
  }
  try {
    return ` ${redact(JSON.stringify(meta))}`;
  } catch {
    return ` ${redact(String(meta))}`;
  }
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const configured = (process.env.KORTIVAI_LOG_LEVEL as LogLevel | undefined) ?? options.level ?? "info";
  const threshold = LEVEL_ORDER[configured] ?? LEVEL_ORDER.info;
  const silent = options.silent ?? process.env.KORTIVAI_LOG_SILENT === "1";
  const file = silent ? "" : join(logDir(), options.name ?? "kortivai.log");

  let prepared = false;
  const prepare = () => {
    if (prepared || !file) return;
    try {
      mkdirSync(dirname(file), { recursive: true });
    } catch {
      // Logging must never break the agent.
    }
    prepared = true;
  };

  const make = (scope: string): Logger => {
    const write = (entryLevel: LogLevel, message: string, meta?: unknown) => {
      if (LEVEL_ORDER[entryLevel] < threshold) return;
      const line = `${new Date().toISOString()} ${entryLevel.toUpperCase().padEnd(5)} ${scope} ${redact(message)}${serialize(meta)}`;
      if (options.stderr) process.stderr.write(`${line}\n`);
      if (!file) return;
      try {
        prepare();
        appendFileSync(file, `${line}\n`, "utf8");
      } catch {
        // ignore
      }
    };

    return {
      debug: (message, meta) => write("debug", message, meta),
      info: (message, meta) => write("info", message, meta),
      warn: (message, meta) => write("warn", message, meta),
      error: (message, meta) => write("error", message, meta),
      child: (child) => make(`${scope}:${child}`),
      file,
    };
  };

  return make("kortivai");
}

/** Silent logger for tests and library use. */
export const nullLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => nullLogger,
  file: "",
};
