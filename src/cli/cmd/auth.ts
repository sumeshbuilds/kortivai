/**
 * `kortivai auth` — manage API keys in `$KORTIVAI_HOME/auth.json`.
 *
 * Keys are read from stdin or a masked prompt and never from argv, so they do
 * not land in shell history. Nothing here ever prints a key back.
 */
import { createTheme, resolveThemeName } from "../../ui/theme.ts";
import { renderTable } from "../../ui/table.ts";
import { readAuth, writeAuth, type AuthEntry, type AuthStore } from "../../provider/auth.ts";
import type { ProviderInfo } from "../../core/types.ts";
import { KortivError } from "../../util/errors.ts";
import type { CliContext, CliIo } from "../io.ts";
import { flagBool, flagString } from "../io.ts";
import { loadRuntime, runtimeOptions } from "../runtime.ts";

/** Long enough to be a real key; short values are almost always a paste error. */
const MIN_KEY_LENGTH = 8;

export type CredentialSource = "not-needed" | "stored" | "env" | "missing";

/**
 * Where a provider's credential comes from. Environment variables win over the
 * store, so this order is what the user actually experiences.
 */
export function credentialSource(
  provider: ProviderInfo,
  env: Record<string, string | undefined>,
  store: AuthStore,
): { source: CredentialSource; detail: string } {
  if (provider.keyless) return { source: "not-needed", detail: "" };
  const fromEnv = provider.env.find((name) => (env[name] ?? "").trim() !== "");
  if (fromEnv) return { source: "env", detail: fromEnv };
  if ((store[provider.id]?.apiKey ?? "").trim() !== "") return { source: "stored", detail: "auth.json" };
  return { source: "missing", detail: "" };
}

/** Trims a pasted key and rejects values that cannot be a key. */
export function normalizeKey(raw: string): string {
  const key = raw.trim();
  if (key === "") {
    throw new KortivError("No API key was provided.", {
      hint: "Paste the key at the prompt, or pipe it: echo $KEY | kortivai auth login deepseek",
    });
  }
  if (/\s/.test(key)) {
    throw new KortivError("That API key contains whitespace.", {
      hint: "Copy just the key value, without spaces or a surrounding sentence.",
    });
  }
  if (key.length < MIN_KEY_LENGTH) {
    throw new KortivError(`That key looks too short (${key.length} characters).`, {
      hint: "Check that the whole key was pasted.",
    });
  }
  return key;
}

/** Returns a new store with `entry` merged under `providerId`. */
export function withEntry(store: AuthStore, providerId: string, entry: AuthEntry): AuthStore {
  return { ...store, [providerId]: { ...store[providerId], ...entry } };
}

/** Returns a new store without `providerId`. */
export function withoutEntry(store: AuthStore, providerId: string): AuthStore {
  const next: AuthStore = {};
  for (const [id, entry] of Object.entries(store)) {
    if (id !== providerId) next[id] = entry;
  }
  return next;
}

async function readAll(stdin: CliIo["stdin"]): Promise<string> {
  const chunks: string[] = [];
  for await (const chunk of stdin) chunks.push(String(chunk));
  return chunks.join("");
}

/** Reads one secret line: masked in a TTY, plain from a pipe. */
async function readSecret(io: CliIo, prompt: string): Promise<string> {
  if (!io.stdinIsTTY) {
    const text = await readAll(io.stdin);
    const line = text.split(/\r?\n/).find((candidate) => candidate.trim() !== "");
    return line ?? "";
  }

  io.stdout.write(prompt);
  const stdin = io.stdin;
  const wasRaw = Boolean(stdin.isRaw);
  stdin.setRawMode?.(true);
  stdin.resume();
  try {
    return await new Promise<string>((resolve, reject) => {
      let buffer = "";
      const finish = (error?: Error) => {
        stdin.off("data", onData);
        io.stdout.write("\n");
        if (error) reject(error);
        else resolve(buffer);
      };
      const onData = (chunk: Buffer | string) => {
        for (const char of chunk.toString("utf8")) {
          if (char === "\r" || char === "\n") return finish();
          if (char === "\u0003") {
            return finish(new KortivError("Cancelled.", { hint: "Nothing was written." }));
          }
          if (char === "\u007f" || char === "\b") {
            if (buffer.length > 0) {
              buffer = buffer.slice(0, -1);
              io.stdout.write("\b \b");
            }
            continue;
          }
          // Ignore escape sequences (arrow keys) rather than storing them.
          if (char === "\u001b" || char === "[") continue;
          buffer += char;
          io.stdout.write("*");
        }
      };
      stdin.on("data", onData);
    });
  } finally {
    stdin.setRawMode?.(wasRaw);
    stdin.pause();
  }
}

function describe(source: CredentialSource, detail: string): string {
  if (source === "env") return `env (${detail})`;
  if (source === "stored") return "stored";
  if (source === "not-needed") return "not needed";
  return "missing";
}

export async function authCommand(ctx: CliContext): Promise<number> {
  const { io } = ctx;
  const action = ctx.positionals[0] ?? "list";
  const providerId = ctx.positionals[1];
  const json = flagBool(ctx.flags, "json");

  const runtime = await loadRuntime(runtimeOptions(ctx, { skipMcp: true }));
  try {
    const theme = createTheme({
      name: resolveThemeName(runtime.config.ui?.theme),
      env: io.env,
      isTTY: io.stdoutIsTTY,
      columns: io.columns,
    });
    const providers = runtime.providers.list();

    if (action === "list") {
      const store = await readAuth();
      const rows = providers.map((provider) => {
        const { source, detail } = credentialSource(provider, io.env, store);
        return [provider.id, provider.name, provider.env.join(", ") || "—", describe(source, detail)];
      });
      if (json) {
        io.stdout.write(
          `${JSON.stringify(
            providers.map((provider) => ({
              id: provider.id,
              name: provider.name,
              keyless: Boolean(provider.keyless),
              ...credentialSource(provider, io.env, store),
            })),
            null,
            2,
          )}\n`,
        );
        return 0;
      }
      io.stdout.write(`${renderTable(["PROVIDER", "NAME", "ENV VAR", "CREDENTIAL"], rows, theme)}\n`);
      return 0;
    }

    if (action === "login" || action === "set") {
      const provider = providers.find((candidate) => candidate.id === providerId);
      if (!provider) {
        throw new KortivError(
          providerId ? `Unknown provider "${providerId}".` : "Name the provider to store a key for.",
          {
            hint: `Known providers: ${providers.map((candidate) => candidate.id).join(", ")}`,
          },
        );
      }
      if (provider.keyless) {
        io.stdout.write(`${provider.name} needs no credential.\n`);
        return 0;
      }

      const baseURL = flagString(ctx.flags, "baseUrl");
      const raw = await readSecret(io, `Paste the API key for ${provider.name} (input is hidden): `);
      const apiKey = normalizeKey(raw);
      const store = withEntry(await readAuth(), provider.id, baseURL ? { apiKey, baseURL } : { apiKey });
      await writeAuth(store);
      io.stdout.write(
        `${theme.paint("stored", "info")} ${provider.id} key in auth.json${baseURL ? ` (base URL ${baseURL})` : ""}\n`,
      );
      if (provider.env.some((name) => (io.env[name] ?? "").trim() !== "")) {
        io.stdout.write(
          `  note: ${provider.env.join("/")} is set in your environment and takes precedence over auth.json.\n`,
        );
      }
      return 0;
    }

    if (action === "logout" || action === "remove" || action === "rm") {
      if (!providerId) {
        throw new KortivError("Name the provider whose key you want to remove.", {
          hint: `Known providers: ${providers.map((candidate) => candidate.id).join(", ")}`,
        });
      }
      const store = await readAuth();
      if (!store[providerId]) {
        io.stdout.write(`No stored credential for ${providerId}.\n`);
        return 0;
      }
      await writeAuth(withoutEntry(store, providerId));
      io.stdout.write(`removed ${providerId} from auth.json\n`);
      return 0;
    }

    throw new KortivError(`Unknown auth action "${action}".`, {
      hint: "Use `kortivai auth list`, `kortivai auth login <provider>`, or `kortivai auth logout <provider>`.",
    });
  } finally {
    try {
      await runtime.close();
    } catch {
      // best effort
    }
  }
}
