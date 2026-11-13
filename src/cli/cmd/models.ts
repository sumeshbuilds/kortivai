/** `kortivai models` — provider/model table with credential status. */
import { createTheme, resolveThemeName } from "../../ui/theme.ts";
import { renderTable } from "../../ui/table.ts";
import type { CliContext } from "../io.ts";
import { flagBool } from "../io.ts";
import { loadRuntime, runtimeOptions } from "../runtime.ts";

export function formatContext(window: number): string {
  if (window >= 1_000_000) return `${Number((window / 1_000_000).toFixed(2))}M`;
  if (window >= 1000) return `${Math.round(window / 1000)}k`;
  return String(window);
}

export async function modelsCommand(ctx: CliContext): Promise<number> {
  const { io } = ctx;
  const runtime = await loadRuntime(runtimeOptions(ctx, { skipMcp: true }));
  try {
    const theme = createTheme({
      name: resolveThemeName(runtime.config.ui?.theme),
      env: io.env,
      isTTY: io.stdoutIsTTY,
      columns: io.columns,
    });
    const available = new Set((await runtime.providers.available()).map((provider) => provider.id));
    const fallback = runtime.config.model;
    const rows: string[][] = [];
    const json: unknown[] = [];

    for (const provider of runtime.providers.list()) {
      const credential = available.has(provider.id)
        ? "yes"
        : provider.keyless
          ? "not needed"
          : "missing";
      const models = runtime.providers.models(provider.id);
      for (const model of models) {
        const key = `${provider.id}/${model.id}`;
        const isDefault = fallback === key || fallback === model.id;
        rows.push([
          isDefault ? theme.glyphs.pointer : " ",
          provider.name,
          model.id,
          formatContext(model.contextWindow),
          credential,
        ]);
      }
      json.push({
        id: provider.id,
        name: provider.name,
        keyless: Boolean(provider.keyless),
        credential: available.has(provider.id),
        env: provider.env,
        models: models.map((model) => ({
          id: model.id,
          name: model.name,
          contextWindow: model.contextWindow,
          maxOutput: model.maxOutput,
          supportsTools: model.supportsTools,
          supportsReasoning: model.supportsReasoning,
          default: fallback === `${provider.id}/${model.id}` || fallback === model.id,
        })),
      });
    }

    if (flagBool(ctx.flags, "json")) {
      io.stdout.write(`${JSON.stringify({ providers: json }, null, 2)}\n`);
      return 0;
    }

    if (rows.length === 0) {
      io.stdout.write("No providers or models are configured.\n");
      io.stderr.write(
        "  hint: add a provider to kortivai.json, then run `kortivai auth login <provider>`.\n",
      );
      return 0;
    }
    io.stdout.write(`${renderTable(["", "PROVIDER", "MODEL", "CONTEXT", "KEY"], rows, theme)}\n`);
    return 0;
  } finally {
    try {
      await runtime.close();
    } catch {
      // best effort
    }
  }
}
