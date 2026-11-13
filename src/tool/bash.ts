import { spawn } from "node:child_process";
import type { ToolDef, ToolContext, ToolOutcome } from "../core/types.ts";
import { displayPath, fail, gate, isAborted, abortedOutcome, resolveInCwd } from "./shared.ts";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const MIN_TIMEOUT_MS = 1_000;
/** Combined stdout+stderr kept in the transcript before we stop appending. */
const MAX_OUTPUT_CHARS = 200_000;
const MAX_PROGRESS_LINE_CHARS = 500;

const PARAMETERS = {
  type: "object",
  properties: {
    command: {
      type: "string",
      description:
        "The shell command line to run. It is passed to the platform shell (cmd.exe on Windows, /bin/sh elsewhere), " +
        "so pipes, redirects and `&&` work.",
    },
    description: {
      type: "string",
      description:
        'A 5-10 word active-voice label for what the command does, shown to the user in the permission prompt (e.g. "Install dependencies"). Never a shell command.',
    },
    timeout: {
      type: "integer",
      minimum: MIN_TIMEOUT_MS,
      maximum: MAX_TIMEOUT_MS,
      description: `Milliseconds before the command is killed. Default ${DEFAULT_TIMEOUT_MS}, maximum ${MAX_TIMEOUT_MS}.`,
    },
    workdir: {
      type: "string",
      description:
        "Directory to run in, relative to the working directory. Defaults to the working directory. Must stay inside it.",
    },
  },
  required: ["command"],
  additionalProperties: false,
} as const;

interface RunResult {
  code: number | null;
  spawnError?: Error;
}

export const bashTool: ToolDef = {
  name: "bash",
  description:
    "Run a shell command and stream its combined stdout and stderr. Use it for builds, tests, git, package managers and " +
    "anything the file tools cannot do. Requires user permission, so keep commands focused and explain them with " +
    "`description`. Long-running commands are killed after `timeout` (default 120s, max 600s) and the call can be " +
    "aborted. Returns the output plus the exit code; a non-zero exit is reported as an error. Do not use it to read or " +
    "edit files when `read`/`edit`/`write` would do.",
  parameters: PARAMETERS,
  destructive: true,
  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome> {
    const command = input["command"];
    const description = input["description"];
    const rawTimeout = input["timeout"];
    const rawWorkdir = input["workdir"];

    if (typeof command !== "string" || command.trim() === "") {
      return fail('Invalid input for "bash": field "command" must be a non-empty string.');
    }
    if (description !== undefined && typeof description !== "string") {
      return fail('Invalid input for "bash": field "description" must be a string.');
    }
    if (rawWorkdir !== undefined && typeof rawWorkdir !== "string") {
      return fail('Invalid input for "bash": field "workdir" must be a string.');
    }
    const timeout = rawTimeout === undefined ? DEFAULT_TIMEOUT_MS : rawTimeout;
    if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout < MIN_TIMEOUT_MS || timeout > MAX_TIMEOUT_MS) {
      return fail(
        `Invalid input for "bash": field "timeout" must be between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS} milliseconds.`,
      );
    }

    let workdir: string;
    try {
      workdir = resolveInCwd(ctx, rawWorkdir ?? ".");
    } catch {
      return fail(`Refusing to run outside the working directory: ${rawWorkdir ?? "."}`);
    }

    const label = typeof description === "string" && description.trim() !== "" ? description.trim() : "Run shell command";
    const denied = await gate(ctx, {
      tool: "bash",
      title: label,
      detail: command,
      risk: "high",
      preview: `cwd: ${displayPath(ctx, workdir) || "."}`,
    });
    if (denied) return denied;
    if (isAborted(ctx)) return abortedOutcome();

    const startedAt = Date.now();
    return await new Promise<ToolOutcome>((resolveOutcome) => {
      // `description` is a label only: it is never concatenated into the
      // command, so a hostile description string cannot execute anything.
      const child = spawn(command, {
        cwd: workdir,
        shell: true,
        windowsHide: true,
        env: process.env,
        detached: process.platform !== "win32",
      });

      let output = "";
      let outputTruncated = false;
      let lineCount = 0;
      let timedOut = false;
      let aborted = false;
      let settled = false;
      const partials = new Map<string, string>();

      const append = (text: string): void => {
        if (output.length >= MAX_OUTPUT_CHARS) {
          outputTruncated = true;
          return;
        }
        const room = MAX_OUTPUT_CHARS - output.length;
        if (text.length > room) {
          output += text.slice(0, room);
          outputTruncated = true;
        } else {
          output += text;
        }
      };

      const consume = (chunk: Buffer, stream: "stdout" | "stderr"): void => {
        const text = chunk.toString("utf8");
        append(text);
        const parts = `${partials.get(stream) ?? ""}${text}`.split(/\r?\n/);
        partials.set(stream, parts.pop() ?? "");
        for (const line of parts) {
          lineCount += 1;
          ctx.progress({
            tool: "bash",
            stream,
            line: line.length > MAX_PROGRESS_LINE_CHARS ? line.slice(0, MAX_PROGRESS_LINE_CHARS) : line,
            lines: lineCount,
          });
        }
      };

      const killTree = (): void => {
        const pid = child.pid;
        if (pid === undefined) return;
        try {
          if (process.platform === "win32") {
            // cmd.exe does not forward signals to its children; kill the tree.
            spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).unref();
          } else {
            process.kill(-pid, "SIGKILL");
          }
        } catch {
          try {
            child.kill("SIGKILL");
          } catch {
            // The process already exited.
          }
        }
      };

      const finish = (code: number | null, spawnError?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        ctx.signal.removeEventListener("abort", onAbort);
        for (const [stream, rest] of partials) {
          if (rest !== "") ctx.progress({ tool: "bash", stream, line: rest, lines: lineCount });
        }

        if (spawnError) {
          resolveOutcome(fail(`Could not run the command: ${spawnError.message}`, { aborted, timedOut }));
          return;
        }

        const notes: string[] = [];
        if (timedOut) notes.push(`[timed out after ${timeout}ms]`);
        if (aborted) notes.push("[aborted]");
        if (code !== null && code !== 0) notes.push(`[exit code ${code}]`);

        let body = output;
        if (outputTruncated) body += "\n… (output truncated)";
        if (body.trim() === "") body = "(no output)";
        const finalOutput = notes.length > 0 ? `${body}\n${notes.join(" ")}` : body;

        resolveOutcome({
          title: label,
          output: finalOutput,
          isError: Boolean(timedOut || aborted || (code !== null && code !== 0)),
          metadata: {
            exitCode: code,
            timedOut,
            aborted,
            truncated: outputTruncated,
            lines: lineCount,
            cwd: displayPath(ctx, workdir) || ".",
            durationMs: Date.now() - startedAt,
          },
        });
      };

      const timer = setTimeout(() => {
        timedOut = true;
        killTree();
      }, timeout);
      const onAbort = (): void => {
        aborted = true;
        killTree();
      };
      ctx.signal.addEventListener("abort", onAbort, { once: true });

      child.stdout?.on("data", (chunk: Buffer) => consume(chunk, "stdout"));
      child.stderr?.on("data", (chunk: Buffer) => consume(chunk, "stderr"));
      child.on("error", (error: Error) => finish(null, error));
      child.on("close", (code: number | null) => finish(code));
    });
  },
};
