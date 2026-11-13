import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

export async function ensureDir(path: string): Promise<void> {
  await fs.mkdir(path, { recursive: true });
}

export async function exists(path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

export async function readText(path: string): Promise<string> {
  return fs.readFile(path, "utf8");
}

export async function readTextOrNull(path: string): Promise<string | null> {
  try {
    return await fs.readFile(path, "utf8");
  } catch {
    return null;
  }
}

/**
 * Atomic write: temp file in the same directory, then rename. Prevents a
 * crashed process from leaving a half-written session or config file.
 */
export async function writeTextAtomic(path: string, contents: string): Promise<void> {
  await ensureDir(dirname(path));
  const tmp = join(dirname(path), `.${randomBytes(6).toString("hex")}.tmp`);
  await fs.writeFile(tmp, contents, "utf8");
  try {
    await fs.rename(tmp, path);
  } catch (error) {
    await fs.rm(tmp, { force: true });
    throw error;
  }
}

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await writeTextAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

export async function readJson<T>(path: string): Promise<T | null> {
  const raw = await readTextOrNull(path);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function listDir(path: string): Promise<{ name: string; dir: boolean }[]> {
  const entries = await fs.readdir(path, { withFileTypes: true });
  return entries
    .map((entry) => ({ name: entry.name, dir: entry.isDirectory() }))
    .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
}

export async function fileSize(path: string): Promise<number> {
  try {
    const stat = await fs.stat(path);
    return stat.size;
  } catch {
    return 0;
  }
}

/** Detects a binary file by sniffing for NUL bytes in the first chunk. */
export function looksBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
  return sample.includes(0);
}
