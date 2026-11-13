/**
 * `kortivai run [prompt]` — one headless turn.
 *
 * stdout carries only the answer (or JSON), so the command composes in a
 * shell. Progress and tool cards go to stderr; nothing is written when stdout
 * is redirected and `--quiet` or `--json` is set.
 */
import type { ModelRef, PermissionAsker } from "../../core/types.ts";
import { textOf } from "../../core/agent.ts";
import { KortivError, errorMessage } from "../../util/errors.ts";
import { createTheme, resolveThemeName } from "../../ui/theme.ts";
import { Transcript, renderError, usageOf } from "../../ui/transcript.ts";
import type { CliContext } from "../io.ts";
import { flagBool, flagString, readAll } from "../io.ts";
import { agentFromFlags, loadRuntime, resolveSession, runtimeOptions } from "../runtime.ts";

const denyAll: PermissionAsker = { ask: async () => "deny" };

export async function runCommand(ctx: CliContext): Promise<number> {
  const { io, flags } = ctx;
  const json = flagBool(flags, "json");
  try {
    return await execute(ctx);
  } catch (error) {
    if (!json) throw error;
    const hint = error instanceof KortivError ? (error.hint ?? null) : null;
    io.stdout.write(`${JSON.stringify({ ok: false, error: errorMessage(error), hint }, null, 2)}\n`);
    return 1;
  }
}

async function execute(ctx: CliContext): Promise<number> {
  const { io, flags, positionals } = ctx;
  const json = flagBool(flags, "json");
  const quiet = flagBool(flags, "quiet");

  let prompt = positionals.join(" ").trim();
  if (!prompt && !io.stdinIsTTY) prompt = (await readAll(io.stdin)).trim();
  if (!prompt) {
    throw new KortivError("No prompt given.", {
      hint: 'Pass one, or pipe it: kortivai run "explain src/core/agent.ts"',
    });
  }

  const started = Date.now();
  const runtime = await loadRuntime(
    runtimeOptions(ctx, { asker: flagBool(flags, "yolo") ? undefined : denyAll }),
  );
  let unsubscribe: () => void = () => {};

  try {
    const theme = createTheme({
      name: resolveThemeName(runtime.config.ui?.theme),
      env: io.env,
      isTTY: io.stdoutIsTTY,
      columns: io.columns,
    });
    const transcript = new Transcript({
      theme,
      sink: io.stderr,
      markdown: runtime.config.ui?.markdown,
      showReasoning: runtime.config.ui?.showReasoning,
      showTokenUsage: runtime.config.ui?.showTokenUsage,
      echoUser: true,
    });
    if (!quiet && !json) unsubscribe = runtime.events.subscribe((event) => transcript.handle(event));

    const agentName = agentFromFlags(ctx);
    const session =
      (await resolveSession(runtime, {
        session: flagString(flags, "session"),
        continueLatest: flagBool(flags, "continue"),
      })) ??
      (await runtime.agents.createSession({
        cwd: flagString(flags, "cwd") ?? io.cwd,
        agent: agentName,
        model: flagString(flags, "model"),
      }));

    const modelKey = flagString(flags, "model");
    let model: ModelRef | undefined;
    if (modelKey) {
      model = runtime.providers.resolveModel(modelKey);
      if (!model) {
        throw new KortivError(`Unknown model "${modelKey}".`, {
          hint: "Run `kortivai models` to list configured models.",
        });
      }
    }

    const message = await runtime.agents.run({
      sessionId: session.id,
      prompt,
      agent: agentName ?? session.agent,
      model,
    });

    const error = message.error;
    const text = error ? "" : textOf(message.parts).trim();

    if (json) {
      io.stdout.write(
        `${JSON.stringify(
          {
            ok: !error,
            sessionId: session.id,
            agent: agentName ?? session.agent,
            model: message.model ?? session.model,
            text,
            error: error ?? null,
            usage: usageOf(message.parts) ?? null,
            durationMs: Date.now() - started,
          },
          null,
          2,
        )}\n`,
      );
    } else if (text) {
      io.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
    }

    if (error) {
      io.stderr.write(`${renderError(error, theme)}\n`);
      return 1;
    }
    return 0;
  } finally {
    unsubscribe();
    try {
      await runtime.close();
    } catch {
      // Closing MCP servers is best-effort.
    }
  }
}
