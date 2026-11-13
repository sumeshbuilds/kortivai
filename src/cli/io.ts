/**
 * The CLI's only door to the outside world. Commands receive a CliIo so tests
 * can capture output without spawning a process.
 */
import type { Sink } from "../ui/sink.ts";
import { bufferSink } from "../ui/sink.ts";
import type { Flags } from "./args.ts";

export interface CliIo {
  stdout: Sink;
  stderr: Sink;
  stdin: NodeJS.ReadStream;
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdoutIsTTY: boolean;
  stdinIsTTY: boolean;
  columns: number;
}

export interface CliContext {
  io: CliIo;
  flags: Flags;
  positionals: string[];
}

export interface MemoryIo extends CliIo {
  out(): string;
  err(): string;
}

export function createIo(): CliIo {
  return {
    stdout: process.stdout,
    stderr: process.stderr,
    stdin: process.stdin,
    cwd: process.cwd(),
    env: process.env,
    stdoutIsTTY: Boolean(process.stdout.isTTY),
    stdinIsTTY: Boolean(process.stdin.isTTY),
    columns: process.stdout.columns ?? 80,
  };
}

export function memoryIo(overrides: Partial<CliIo> = {}): MemoryIo {
  const out = bufferSink();
  const err = bufferSink();
  return {
    stdout: out,
    stderr: err,
    stdin: process.stdin,
    cwd: process.cwd(),
    env: process.env,
    stdoutIsTTY: false,
    stdinIsTTY: false,
    columns: 80,
    out: () => out.text(),
    err: () => err.text(),
    ...overrides,
  };
}

/** Reads a whole stream; used when a prompt is piped into `run`. */
export async function readAll(stream: NodeJS.ReadStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer));
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function flagString(flags: Flags, name: string): string | undefined {
  const value = flags[name];
  return typeof value === "string" ? value : undefined;
}

export function flagBool(flags: Flags, name: string): boolean {
  return flags[name] === true;
}
