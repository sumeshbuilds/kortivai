/**
 * Credential store at `authFile()` (`$KORTIVAI_HOME/auth.json`).
 *
 * The file is the user's own key vault: it is created with mode `0600` where
 * the platform supports POSIX modes, written atomically so a crash mid-write
 * cannot truncate it, and never logged — not even its field names.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { authFile } from "../util/paths.ts";
import { KortivError } from "../util/errors.ts";

/** Credentials persisted at `~/.kortivai/auth.json`. Never logged. */
export interface AuthEntry {
  apiKey?: string;
  baseURL?: string;
  /** Free-form label shown by `kortivai auth list`. */
  label?: string;
}

export interface AuthStore {
  [providerId: string]: AuthEntry;
}

const PERMISSIONS = 0o600;

/** True when `error` is Node's ENOENT. */
function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

function sanitizeEntry(value: unknown): AuthEntry | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const entry: AuthEntry = {};
  for (const key of ["apiKey", "baseURL", "label"] as const) {
    const field = record[key];
    if (typeof field === "string" && field.length > 0) entry[key] = field;
  }
  return Object.keys(entry).length > 0 ? entry : undefined;
}

/**
 * Reads the credential store. A missing file is an empty store; a corrupt file
 * throws so the user can fix it instead of silently losing their keys.
 */
export async function readAuth(): Promise<AuthStore> {
  const file = authFile();
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (error) {
    if (isMissing(error)) return {};
    throw new KortivError(`Could not read the credential store at ${file}.`, {
      hint: "Check the file permissions, or delete it and run `kortivai auth login <provider>` again.",
      cause: error,
    });
  }

  if (!raw.trim()) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new KortivError(`The credential store at ${file} is not valid JSON.`, {
      hint: `Fix or delete ${file}, then run \`kortivai auth login <provider>\` again.`,
      cause: error,
    });
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new KortivError(`The credential store at ${file} must be a JSON object of providers.`, {
      hint: `Delete ${file} and run \`kortivai auth login <provider>\` again.`,
    });
  }

  const store: AuthStore = {};
  for (const [providerId, value] of Object.entries(parsed as Record<string, unknown>)) {
    const entry = sanitizeEntry(value);
    if (entry) store[providerId] = entry;
  }
  return store;
}

/** Replaces the store atomically, dropping empty entries. */
export async function writeAuth(store: AuthStore): Promise<void> {
  const file = authFile();
  const clean: AuthStore = {};
  for (const [providerId, value] of Object.entries(store ?? {})) {
    const entry = sanitizeEntry(value);
    if (entry) clean[providerId] = entry;
  }

  const dir = dirname(file);
  const temp = `${file}.${process.pid}.tmp`;
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(temp, `${JSON.stringify(clean, null, 2)}\n`, { encoding: "utf8", mode: PERMISSIONS });
    // rename() is atomic within a directory, so readers never see a partial file.
    renameSync(temp, file);
    restrictPermissions(file);
  } catch (error) {
    try {
      if (existsSync(temp)) rmSync(temp, { force: true });
    } catch {
      // Cleanup is best-effort; the original error matters more.
    }
    throw new KortivError(`Could not write the credential store at ${file}.`, {
      hint: "Check that the directory is writable, or set KORTIVAI_HOME to a writable path.",
      cause: error,
    });
  }
}

/** chmod is a no-op on Windows but is required on POSIX. */
function restrictPermissions(path: string): void {
  if (process.platform === "win32") return;
  try {
    chmodSync(path, PERMISSIONS);
  } catch {
    // Best effort: the file is still written with mode 0600 at creation.
  }
}
