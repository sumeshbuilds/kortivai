/** Pure completion for slash commands and `@path` file mentions. */
import type { Theme } from "./theme.ts";
import { displayWidth } from "./theme.ts";

export interface SlashCommand {
  name: string;
  description: string;
}

export const SLASH_COMMANDS: SlashCommand[] = [
  { name: "/help", description: "Show this command list" },
  { name: "/model", description: "Show or switch the model" },
  { name: "/agent", description: "Show or switch the agent" },
  { name: "/new", description: "Start a new session" },
  { name: "/sessions", description: "List saved sessions" },
  { name: "/resume", description: "Resume a session by id" },
  { name: "/mcp", description: "MCP server status" },
  { name: "/skills", description: "List discovered skills" },
  { name: "/agents", description: "List available agents" },
  { name: "/init", description: "Write kortivai.json and AGENTS.md" },
  { name: "/clear", description: "Clear the screen" },
  { name: "/compact", description: "Shrink the conversation history" },
  { name: "/exit", description: "Exit KortivAI" },
];

export interface CompletionContext {
  /** Relative, posix-style paths gathered from the working directory. */
  files?: string[];
  commands?: SlashCommand[];
}

export interface CompletionResult {
  matches: string[];
  /** Full replacement for the token being completed, when unambiguous. */
  replacement?: string;
}

export function findCommand(name: string): SlashCommand | undefined {
  const needle = name.startsWith("/") ? name : `/${name}`;
  return SLASH_COMMANDS.find((command) => command.name === needle);
}

export function commonPrefix(items: string[]): string {
  if (items.length === 0) return "";
  let prefix = items[0]!;
  for (const item of items.slice(1)) {
    while (prefix && !item.toLowerCase().startsWith(prefix.toLowerCase())) {
      prefix = prefix.slice(0, -1);
    }
  }
  return prefix;
}

function matchFiles(query: string, files: string[]): string[] {
  const needle = query.toLowerCase();
  const wantsBasename = !query.includes("/");
  return files.filter((file) => {
    if (file.toLowerCase().startsWith(needle)) return true;
    if (!wantsBasename) return false;
    const base = file.slice(file.lastIndexOf("/") + 1).toLowerCase();
    return base.startsWith(needle);
  });
}

/**
 * Completes the token under the cursor. Slash commands complete to their
 * name; `@path` completes against the supplied file list.
 */
export function complete(prefix: string, context: CompletionContext = {}): CompletionResult {
  const commands = context.commands ?? SLASH_COMMANDS;

  if (prefix.startsWith("/") && !prefix.includes(" ")) {
    const matches = commands.map((command) => command.name).filter((name) => name.startsWith(prefix));
    return finish(prefix, matches);
  }

  if (prefix.startsWith("@")) {
    const query = prefix.slice(1);
    const matches = matchFiles(query, context.files ?? []).map((file) => `@${file}`);
    return finish(prefix, matches);
  }

  return { matches: [] };
}

function finish(prefix: string, matches: string[]): CompletionResult {
  const replacement = pick(prefix, matches);
  return replacement === undefined ? { matches } : { matches, replacement };
}

/** One match completes outright; several complete as far as they agree. */
function pick(prefix: string, matches: string[]): string | undefined {
  if (matches.length === 1) return matches[0];
  const shared = commonPrefix(matches);
  return shared.length > prefix.length ? shared : undefined;
}

export interface TokenSpan {
  start: number;
  end: number;
  text: string;
}

/** The whitespace-delimited token containing (or ending at) the cursor. */
export function tokenAt(line: string, cursor: number): TokenSpan {
  let start = cursor;
  while (start > 0 && !/\s/.test(line[start - 1]!)) start -= 1;
  let end = cursor;
  while (end < line.length && !/\s/.test(line[end]!)) end += 1;
  return { start, end, text: line.slice(start, end) };
}

export function renderCompletionList(items: string[], theme: Theme): string {
  if (items.length === 0) return "";
  const width = Math.max(...items.map((item) => displayWidth(item))) + 2;
  const columns = Math.max(1, Math.floor((theme.width - 2) / width));
  const rows: string[] = [];
  for (let index = 0; index < items.length; index += columns) {
    rows.push(
      `  ${items
        .slice(index, index + columns)
        .map((item) => item.padEnd(width))
        .join("")
        .trimEnd()}`,
    );
  }
  return theme.paint(rows.join("\n"), "textMuted");
}
