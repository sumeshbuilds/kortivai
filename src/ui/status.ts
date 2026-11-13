/** Pure chrome: banner, status line, prompt prefix, exit summary. */
import type { Usage } from "../core/types.ts";
import type { Theme } from "./theme.ts";
import { displayWidth } from "./theme.ts";
import { formatCost, formatTokens } from "./transcript.ts";

export interface StatusInfo {
  agent: string;
  model: string;
  cwd: string;
  busy?: boolean;
  cancelling?: boolean;
  usage?: Usage;
}

export interface BannerInfo extends StatusInfo {
  name: string;
  version: string;
}

const PLAN_AGENT = "plan";

export function agentToken(agent: string): "info" | "accent" {
  return agent === PLAN_AGENT ? "info" : "accent";
}

/** `~`-shortened, tail-truncated path for one-line chrome. */
export function shortenPath(path: string, home?: string): string {
  // Normalise separators first: on Windows a backslash path contains no "/",
  // so truncation silently treated the whole path as a single segment.
  const normalized = path.replace(/\\/g, "/");
  const normalizedHome = home?.replace(/\\/g, "/").replace(/\/+$/, "");
  let out = normalized;
  if (normalizedHome && normalized.toLowerCase().startsWith(normalizedHome.toLowerCase())) {
    out = `~${normalized.slice(normalizedHome.length)}`;
  }
  if (displayWidth(out) <= 44) return out;
  // Keep the tail, since that is what identifies the directory. A Windows
  // drive letter is dropped because ".../C:/Users/x" reads as broken chrome.
  const segments = out
    .split("/")
    .filter((segment) => segment.length > 0 && !/^[A-Za-z]:$/.test(segment));
  let tail = "";
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const candidate = `…/${segments[index] ?? ""}${tail}`;
    if (displayWidth(candidate) > 44) break;
    tail = `/${segments[index] ?? ""}${tail}`;
  }
  return tail === "" ? `…/${segments.at(-1) ?? ""}` : `…${tail}`;
}

export function renderPromptPrefix(info: Pick<StatusInfo, "agent" | "busy" | "cancelling">, theme: Theme): string {
  const token = agentToken(info.agent);
  const state = info.cancelling ? theme.paint(" cancelling…", "warn") : info.busy ? theme.paint(" working…", "warn") : "";
  return `${theme.paint(info.agent, token)} ${theme.paint(theme.glyphs.prompt, token)}${state} `;
}

export function renderStatusLine(info: StatusInfo, theme: Theme): string {
  const separator = theme.paint(` ${theme.glyphs.dot} `, "textFaint");
  const agent = theme.paint(info.agent, agentToken(info.agent));
  const segments: string[] = [theme.paint(info.model, "textMuted"), theme.paint(shortenPath(info.cwd), "textFaint")];

  if (info.cancelling) segments.push(theme.paint("cancelling…", "warn"));
  else if (info.busy) segments.push(theme.paint("working…", "warn"));
  if (info.usage) {
    const usage = `${formatTokens(info.usage.input)} in / ${formatTokens(info.usage.output)} out`;
    segments.push(theme.paint(usage, "textFaint"));
    if (info.usage.cost) segments.push(theme.paint(formatCost(info.usage.cost), "textFaint"));
  }

  // Drop the least important segments first, then let the terminal clip.
  while (segments.length > 1 && displayWidth(`${agent}${separator}${segments.join(separator)}`) > theme.width - 2) {
    segments.pop();
  }
  return theme.truncate(`  ${agent}${separator}${segments.join(separator)}`, theme.width);
}

export function renderBanner(info: BannerInfo, theme: Theme): string {
  const heading = `  ${theme.paint(theme.glyphs.pointer, "accent")} ${theme.paint(
    info.name.toUpperCase(),
    "accent",
  )} ${theme.paint(info.version, "textMuted")} ${theme.dim("· terminal AI coding agent")}`;
  const rule = theme.paint(theme.glyphs.rule.repeat(Math.min(theme.width - 2, 52)), "border");
  const row = (label: string, value: string, token: "text" | "info" | "accent") =>
    `  ${theme.paint(label.padEnd(7), "textFaint")}${theme.paint(value, token)}`;
  const hints = theme.dim("  /help for commands · Ctrl+C cancels · Ctrl+D exits");
  return [
    "",
    heading,
    `  ${rule}`,
    row("cwd", shortenPath(info.cwd), "text"),
    row("model", info.model, "text"),
    row("agent", info.agent, agentToken(info.agent)),
    "",
    hints,
  ].join("\n");
}

export function renderSessionSummary(
  input: { sessionId: string; messages: number; usage?: Usage },
  theme: Theme,
): string {
  const bits = [`${input.messages} ${input.messages === 1 ? "message" : "messages"}`];
  if (input.usage) {
    bits.push(`${formatTokens(input.usage.input)} in / ${formatTokens(input.usage.output)} out`);
    if (input.usage.cost) bits.push(formatCost(input.usage.cost));
  }
  bits.push(`session ${input.sessionId.slice(0, 8)}`);
  return `  ${theme.paint(theme.glyphs.dot, "textFaint")} ${theme.paint(bits.join(" · "), "textMuted")}`;
}
