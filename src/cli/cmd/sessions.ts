/** `kortivai sessions` — list saved sessions, or remove one. */
import { KortivError } from "../../util/errors.ts";
import { createTheme, resolveThemeName } from "../../ui/theme.ts";
import { renderTable } from "../../ui/table.ts";
import type { CliContext } from "../io.ts";
import { flagBool } from "../io.ts";
import { loadRuntime, runtimeOptions } from "../runtime.ts";

export function formatAge(timestamp: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000));
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
  if (seconds < 2_592_000) return `${Math.floor(seconds / 86_400)}d`;
  return new Date(timestamp).toISOString().slice(0, 10);
}

export async function sessionsCommand(ctx: CliContext): Promise<number> {
  const { io, flags, positionals } = ctx;
  const runtime = await loadRuntime(runtimeOptions(ctx, { skipMcp: true }));
  try {
    const theme = createTheme({
      name: resolveThemeName(runtime.config.ui?.theme),
      env: io.env,
      isTTY: io.stdoutIsTTY,
      columns: io.columns,
    });
    const sessions = (await runtime.sessions.list())
      .filter((session) => !(session.tags ?? []).includes("subagent"))
      .sort((a, b) => b.updatedAt - a.updatedAt);

    if (positionals[0] === "rm" || positionals[0] === "remove") {
      const target = positionals[1];
      if (!target) {
        throw new KortivError("Which session?", {
          hint: "Run `kortivai sessions` to see ids, then `kortivai sessions rm <id>`.",
        });
      }
      const match =
        sessions.find((session) => session.id === target) ??
        sessions.find((session) => session.id.startsWith(target));
      if (!match) {
        throw new KortivError(`No session matches "${target}".`, {
          hint: "Run `kortivai sessions` to list saved sessions.",
        });
      }
      await runtime.sessions.delete(match.id);
      if (flagBool(flags, "json")) io.stdout.write(`${JSON.stringify({ removed: match.id })}\n`);
      else io.stdout.write(`removed ${match.id.slice(0, 8)}  ${match.title}\n`);
      return 0;
    }

    const counts = await Promise.all(
      sessions.slice(0, 50).map(async (session) => (await runtime.sessions.messages(session.id)).length),
    );

    if (flagBool(flags, "json")) {
      io.stdout.write(
        `${JSON.stringify(
          {
            sessions: sessions.slice(0, 50).map((session, index) => ({
              id: session.id,
              title: session.title,
              agent: session.agent,
              cwd: session.cwd,
              updatedAt: session.updatedAt,
              messages: counts[index] ?? 0,
            })),
          },
          null,
          2,
        )}\n`,
      );
      return 0;
    }

    if (sessions.length === 0) {
      io.stdout.write("No saved sessions.\n");
      return 0;
    }

    const rows = sessions
      .slice(0, 50)
      .map((session, index) => [
        session.id.slice(0, 8),
        formatAge(session.updatedAt),
        session.title,
        String(counts[index] ?? 0),
      ]);
    io.stdout.write(`${renderTable(["ID", "UPDATED", "TITLE", "MSGS"], rows, theme)}\n`);
    return 0;
  } finally {
    try {
      await runtime.close();
    } catch {
      // best effort
    }
  }
}
