/** `kortivai agents` — primary and subagent inventory. */
import { createTheme, resolveThemeName } from "../../ui/theme.ts";
import { renderTable } from "../../ui/table.ts";
import type { CliContext } from "../io.ts";
import { flagBool } from "../io.ts";
import { loadRuntime, runtimeOptions } from "../runtime.ts";

const DEFAULT_AGENT = "build";

export async function agentsCommand(ctx: CliContext): Promise<number> {
  const { io } = ctx;
  const runtime = await loadRuntime(runtimeOptions(ctx, { skipMcp: true }));
  try {
    const theme = createTheme({
      name: resolveThemeName(runtime.config.ui?.theme),
      env: io.env,
      isTTY: io.stdoutIsTTY,
      columns: io.columns,
    });
    const agents = runtime.agents.agents();

    if (flagBool(ctx.flags, "json")) {
      io.stdout.write(
        `${JSON.stringify(
          {
            agents: agents.map((agent) => ({
              name: agent.name,
              mode: agent.mode,
              description: agent.description,
              model: agent.model,
              builtin: Boolean(agent.builtin),
              default: agent.name === DEFAULT_AGENT,
            })),
          },
          null,
          2,
        )}\n`,
      );
      return 0;
    }

    if (agents.length === 0) {
      io.stdout.write("No agents are defined.\n");
      return 0;
    }

    const rows = agents.map((agent) => [
      agent.name === DEFAULT_AGENT ? theme.glyphs.pointer : " ",
      agent.name,
      agent.mode,
      agent.model ? `${agent.model.provider}/${agent.model.model}` : "default",
      agent.description,
    ]);
    io.stdout.write(`${renderTable(["", "NAME", "MODE", "MODEL", "DESCRIPTION"], rows, theme)}\n`);
    return 0;
  } finally {
    try {
      await runtime.close();
    } catch {
      // best effort
    }
  }
}
