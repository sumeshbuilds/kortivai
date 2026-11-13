import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { existsSync, statSync } from "node:fs";

export const APP_NAME = "kortivai";

/** Highest-priority override for all persistent agent state. */
export function homeDir(): string {
  const override = process.env.KORTIVAI_HOME;
  if (override && override.trim()) return resolve(override);
  const home = homedir();
  if (process.platform === "win32") {
    const appData = process.env.APPDATA;
    return appData ? join(appData, APP_NAME) : join(home, `.${APP_NAME}`);
  }
  if (process.platform === "darwin") {
    return join(home, "Library", "Application Support", APP_NAME);
  }
  const xdg = process.env.XDG_DATA_HOME;
  return xdg ? join(xdg, APP_NAME) : join(home, ".local", "share", APP_NAME);
}

/** State the user owns and may inspect: sessions, auth, logs. */
export function stateDir(): string {
  return join(homeDir(), "state");
}

export function authFile(): string {
  return join(homeDir(), "auth.json");
}

export function logDir(): string {
  return join(homeDir(), "log");
}

export function sessionsDir(): string {
  return join(stateDir(), "sessions");
}

export function cacheDir(): string {
  return join(homeDir(), "cache");
}

/** Per-project scratch, gitignored by the shipped template. */
export function projectDir(cwd: string): string {
  return join(cwd, `.${APP_NAME}`);
}

/** Normalizes to forward slashes so logs and snapshots are platform-stable. */
export function toPosix(path: string): string {
  return path.split(sep).join("/");
}

/** Absolute, symlink-free-ish, normalized path. */
export function normalize(path: string, cwd = process.cwd()): string {
  return resolve(cwd, path);
}

/**
 * Guards every filesystem tool: a path must stay inside the session root.
 * Returns the absolute path, or throws for an escape attempt.
 */
export function assertInside(root: string, candidate: string): string {
  const absRoot = resolve(root);
  const abs = resolve(absRoot, candidate);
  if (abs !== absRoot && !abs.startsWith(absRoot + sep)) {
    throw new Error(`Path escapes the working directory: ${candidate}`);
  }
  return abs;
}

export function isInside(root: string, candidate: string): boolean {
  const absRoot = resolve(root);
  const abs = resolve(absRoot, candidate);
  return abs === absRoot || abs.startsWith(absRoot + sep);
}

export function relativeTo(root: string, target: string): string {
  const absRoot = resolve(root);
  const abs = resolve(target);
  if (!abs.startsWith(absRoot + sep)) return abs;
  return toPosix(abs.slice(absRoot.length + 1));
}

/** True when the path exists and is a directory. */
export function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Walks up from `from` looking for `names`, stopping at the filesystem root.
 * Used for project root and AGENTS.md discovery.
 */
export function findUp(names: string[], from = process.cwd(), stopAt?: string): string | undefined {
  let current = resolve(from);
  const stop = stopAt ? resolve(stopAt) : undefined;
  for (;;) {
    for (const name of names) {
      const candidate = join(current, name);
      if (existsSync(candidate)) return candidate;
    }
    if (stop && current === stop) return undefined;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/** The project root: nearest `.git` or agent config, else cwd. */
export function projectRoot(cwd = process.cwd()): string {
  const marker = findUp([".git", `.${APP_NAME}`, "kortivai.json", "AGENTS.md"], cwd);
  if (!marker) return resolve(cwd);
  const dir = marker.endsWith(`${sep}.git`) || marker.endsWith(".git") ? dirname(marker) : dirname(marker);
  return dir;
}

export function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) {
    return join(homedir(), path.slice(2));
  }
  return path;
}

export function isAbsolutePath(path: string): boolean {
  return isAbsolute(expandHome(path));
}
