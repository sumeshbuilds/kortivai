/**
 * AgentEvent -> transcript.
 *
 * A renderer, not a controller: every write goes to the injected sink, so a
 * turn can be replayed byte-for-byte in a test. Assistant text streams live
 * through the markdown state machine; reasoning is collapsed behind a single
 * "thinking" line unless enabled; tool calls render as compact cards.
 */
import type {
  AgentEvent,
  Message,
  Part,
  PermissionDecision,
  PermissionRequest,
  ToolPart,
  Usage,
} from "../core/types.ts";
import type { Sink } from "./sink.ts";
import { bufferSink } from "./sink.ts";
import type { Theme } from "./theme.ts";
import { createMarkdownStream, renderMarkdown, type MarkdownStream } from "./markdown.ts";
import { looksLikeDiff, renderDiff } from "./diff.ts";

const PREVIEW_MAX_LINES = 8;
const PREVIEW_MAX_CHARS = 600;

export interface TranscriptOptions {
  theme: Theme;
  sink: Sink;
  /** Render assistant prose as markdown (default true). */
  markdown?: boolean;
  showReasoning?: boolean;
  showTokenUsage?: boolean;
  /** Echo the user prompt when its message ends (headless). */
  echoUser?: boolean;
}

interface MessageState {
  textSeen: number;
  reasoningSeen: number;
  stream?: MarkdownStream;
  reasoning: string;
  reasoningHeader: boolean;
  wroteText: boolean;
  tools: Set<string>;
}

const TOOL_COLUMN = 7;

export class Transcript {
  private readonly theme: Theme;
  private readonly sink: Sink;
  private readonly useMarkdown: boolean;
  private readonly showReasoning: boolean;
  private readonly showTokenUsage: boolean;
  private readonly echoUser: boolean;
  private readonly states = new Map<string, MessageState>();
  private readonly shownPermissions = new Set<string>();
  private tail = "";

  constructor(options: TranscriptOptions) {
    this.theme = options.theme;
    this.sink = options.sink;
    this.useMarkdown = options.markdown ?? true;
    this.showReasoning = options.showReasoning ?? false;
    this.showTokenUsage = options.showTokenUsage ?? false;
    this.echoUser = options.echoUser ?? true;
  }

  /** Marks a request the shell already rendered, to avoid a duplicate box. */
  notePermissionShown(request: PermissionRequest): void {
    this.shownPermissions.add(permissionKey(request));
  }

  handle(event: AgentEvent): void {
    switch (event.type) {
      case "message.start":
        this.states.set(event.messageId, freshState());
        return;
      case "part.update":
        this.part(event.messageId, event.part);
        return;
      case "message.end":
        this.messageEnd(event.message);
        return;
      case "permission.asked":
        if (!this.shownPermissions.has(permissionKey(event.request))) {
          this.block(renderPermissionBox(event.request, this.theme));
        }
        return;
      case "permission.resolved":
        this.block(renderPermissionResolved(event.request, event.decision, this.theme));
        return;
      case "status":
        if (event.status === "retrying") {
          this.block(renderStatus(event.detail, this.theme));
        }
        return;
      case "agent.error":
        this.block(renderError(event.error, this.theme));
        return;
      default:
        return;
    }
  }

  private part(messageId: string, part: Part): void {
    const state = this.state(messageId);
    switch (part.type) {
      case "text": {
        const delta = part.text.slice(state.textSeen);
        state.textSeen = part.text.length;
        if (!delta) return;
        state.stream ??= createMarkdownStream(this.theme);
        const rendered = this.useMarkdown ? state.stream.push(delta) : delta;
        if (!rendered) return;
        if (!state.wroteText) {
          this.separator();
          state.wroteText = true;
        }
        this.write(rendered);
        return;
      }
      case "reasoning": {
        const delta = part.text.slice(state.reasoningSeen);
        state.reasoningSeen = part.text.length;
        if (!state.reasoningHeader) {
          this.block(`${this.theme.paint(this.theme.glyphs.thinking, "textFaint")} ${this.theme.dim("thinking")}`);
          state.reasoningHeader = true;
        }
        if (this.showReasoning) state.reasoning += delta;
        return;
      }
      case "tool": {
        if (part.status === "pending" || part.status === "running") {
          if (state.tools.has(part.id)) return;
          state.tools.add(part.id);
          this.block(renderToolStart(part, this.theme));
          return;
        }
        if (!state.tools.has(part.id)) {
          state.tools.add(part.id);
          this.block(renderToolResult(part, this.theme));
          return;
        }
        this.block(renderToolResult(part, this.theme));
        return;
      }
      default:
        return;
    }
  }

  private messageEnd(message: Message): void {
    const state = this.state(message.id);
    if (message.role === "user") {
      if (this.echoUser) {
        const text = textOf(message.parts).trim();
        if (text) this.block(renderUserPrompt(text, this.theme));
      }
      return;
    }

    if (state.stream) {
      const rest = this.useMarkdown ? state.stream.flush() : "";
      if (rest) {
        if (!state.wroteText) {
          this.separator();
          state.wroteText = true;
        }
        this.write(`${rest}\n`);
      }
    }

    if (!state.wroteText && message.parts.length > 0) {
      const body = renderParts(message.parts, this.theme, {
        markdown: this.useMarkdown,
        showReasoning: this.showReasoning,
        showTokenUsage: this.showTokenUsage,
      });
      if (body) {
        this.block(body);
        state.wroteText = true;
      }
    } else if (state.reasoning && this.showReasoning) {
      this.block(indentBlock(state.reasoning, (line) => this.theme.dim(line)));
    }

    if (message.error) this.block(renderError(message.error, this.theme));
    if (this.showTokenUsage) {
      const usage = usageOf(message.parts);
      if (usage) this.block(renderUsage(usage, this.theme));
    }
    if (state.wroteText) {
      this.separator();
      this.write("\n");
    }
  }

  private state(messageId: string): MessageState {
    let state = this.states.get(messageId);
    if (!state) {
      state = freshState();
      this.states.set(messageId, state);
    }
    return state;
  }

  private write(text: string): void {
    this.sink.write(text);
    this.tail = `${this.tail}${text}`.slice(-2);
  }

  /** Ensures exactly one blank line between blocks. */
  private separator(): void {
    if (this.tail !== "" && !this.tail.endsWith("\n\n")) this.write("\n");
  }

  private block(text: string): void {
    if (!text) return;
    this.separator();
    this.write(`${text}\n`);
  }
}

function freshState(): MessageState {
  return {
    textSeen: 0,
    reasoningSeen: 0,
    reasoning: "",
    reasoningHeader: false,
    wroteText: false,
    tools: new Set<string>(),
  };
}

function textOf(parts: Part[]): string {
  return parts
    .filter((part): part is Extract<Part, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("");
}

function permissionKey(request: PermissionRequest): string {
  return `${request.tool}:${request.detail}`;
}

export function usageOf(parts: Part[]): Usage | undefined {
  const steps = parts.filter((part): part is Extract<Part, { type: "step" }> => part.type === "step");
  if (steps.length === 0) return undefined;
  const total: Usage = { input: 0, output: 0, reasoning: 0, cost: 0 };
  for (const step of steps) {
    const usage = step.usage;
    if (!usage) continue;
    total.input += usage.input;
    total.output += usage.output;
    total.reasoning = (total.reasoning ?? 0) + (usage.reasoning ?? 0);
    total.cost = (total.cost ?? 0) + (usage.cost ?? 0);
  }
  return total;
}

function indentBlock(text: string, paint: (line: string) => string): string {
  return text
    .replace(/\n+$/, "")
    .split("\n")
    .map((line) => `  ${paint(line)}`)
    .join("\n");
}

export function renderUserPrompt(text: string, theme: Theme): string {
  const lines = text.split("\n");
  const head = `${theme.paint(theme.glyphs.prompt, "accent")} ${theme.paint(lines[0] ?? "", "text")}`;
  return [head, ...lines.slice(1).map((line) => `  ${theme.paint(line, "text")}`)].join("\n");
}

export function renderStatus(detail: string | undefined, theme: Theme): string {
  const suffix = detail ? ` ${theme.dim(detail)}` : "";
  return `  ${theme.paint(theme.glyphs.running, "warn")} ${theme.paint("retrying", "warn")}${suffix}`;
}

export function renderError(message: string, theme: Theme): string {
  const lines = message.split("\n");
  const out = [`  ${theme.paint(theme.glyphs.cross, "danger")} ${theme.paint(lines[0] ?? "", "danger")}`];
  for (const line of lines.slice(1)) out.push(`    ${theme.paint(line.trim(), "textMuted")}`);
  return out.join("\n");
}

export function renderUsage(usage: Usage, theme: Theme): string {
  const bits = [`${formatTokens(usage.input)} in`, `${formatTokens(usage.output)} out`];
  if (usage.reasoning) bits.push(`${formatTokens(usage.reasoning)} reasoning`);
  if (usage.cacheRead) bits.push(`${formatTokens(usage.cacheRead)} cached`);
  if (usage.cost) bits.push(formatCost(usage.cost));
  return `  ${theme.paint(theme.glyphs.dot, "textFaint")} ${theme.paint(bits.join(" · "), "textFaint")}`;
}

export function formatTokens(value: number): string {
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${(value / 1000).toFixed(1)}k`;
  return `${(value / 1_000_000).toFixed(2)}M`;
}

export function formatCost(value: number): string {
  if (value < 0.0001) return "<$0.0001";
  return `$${value.toFixed(4)}`;
}

export function toolSubject(part: ToolPart): string {
  if (part.title) return part.title;
  if (part.input && typeof part.input === "object") {
    const record = part.input as Record<string, unknown>;
    for (const key of ["filePath", "path", "pattern", "command", "url", "query", "name", "prompt"]) {
      const value = record[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
  }
  return "";
}

export function renderToolStart(part: ToolPart, theme: Theme): string {
  const glyph = part.status === "running" ? theme.glyphs.running : theme.glyphs.pending;
  const subject = toolSubject(part);
  const colon = subject ? ` ${theme.paint(subject, "textMuted")}` : "";
  return `  ${theme.paint(glyph, "accentDim")} ${theme.paint(part.name.padEnd(TOOL_COLUMN), "textFaint")}${colon}`;
}

export function renderToolResult(part: ToolPart, theme: Theme): string {
  const glyph =
    part.status === "completed"
      ? theme.paint(theme.glyphs.check, "success")
      : part.status === "denied"
        ? theme.paint(theme.glyphs.denied, "warn")
        : theme.paint(theme.glyphs.cross, "danger");
  const subject = toolSubject(part);
  const head = `  ${glyph} ${theme.paint(part.name.padEnd(TOOL_COLUMN), "textFaint")}${
    subject ? ` ${theme.paint(subject, "text")}` : ""
  }`;
  if (part.status === "error" || part.status === "denied") {
    const reason = (part.error ?? part.output ?? "").split("\n")[0]?.trim() ?? "";
    return reason
      ? `${head}  ${theme.paint(theme.truncate(reason, 60), "danger")}`
      : head;
  }
  const summary = summarizeToolOutput(part.output);
  if (summary.collapsed) return `${head}  ${theme.dim(summary.label)}`;
  if (summary.preview.length === 0) return head;
  return head + "\n" + renderPreview(summary.preview, theme, part.output ?? "");
}

function renderPreview(lines: string[], theme: Theme, raw: string): string {
  if (looksLikeDiff(raw)) {
    return renderDiff(raw, theme)
      .split("\n")
      .map((line) => `  ${line}`)
      .join("\n");
  }
  const spine = theme.paint(theme.glyphs.spine, "border");
  return lines.map((line) => `  ${spine} ${theme.paint(line, "textMuted")}`).join("\n");
}

export interface ToolOutputSummary {
  lines: number;
  preview: string[];
  collapsed: boolean;
  label: string;
}

export function summarizeToolOutput(output: string | undefined): ToolOutputSummary {
  const text = (output ?? "").replace(/\n+$/, "");
  const lines = text === "" ? [] : text.split("\n");
  const collapsed = lines.length > PREVIEW_MAX_LINES || text.length > PREVIEW_MAX_CHARS;
  return {
    lines: lines.length,
    preview: collapsed ? [] : lines,
    collapsed,
    label: `${lines.length} ${lines.length === 1 ? "line" : "lines"}`,
  };
}

function boxChars(theme: Theme): { top: string; bottom: string; side: string; tl: string; tr: string; bl: string; br: string } {
  return theme.glyphs.gutter === "|"
    ? { top: "-", bottom: "-", side: "|", tl: "+", tr: "+", bl: "+", br: "+" }
    : { top: "─", bottom: "─", side: "│", tl: "╭", tr: "╮", bl: "╰", br: "╯" };
}

export function renderPermissionBox(request: PermissionRequest, theme: Theme): string {
  const box = boxChars(theme);
  const width = Math.min(theme.width - 2, 66);
  const inner = width - 4;
  const title = `${box.tl}${box.top} permission ${box.top.repeat(Math.max(0, inner - 11))}${box.tr}`;
  const rows = [
    theme.paint(request.title, "text"),
    theme.paint(theme.truncate(request.detail, inner), "accent"),
    theme.paint(`risk ${request.risk} · ${request.tool}`, "textMuted"),
  ];
  for (const line of (request.preview ?? "").split("\n").slice(0, 3)) {
    if (line.trim()) rows.push(theme.paint(theme.truncate(line, inner), "textMuted"));
  }
  return [
    `  ${theme.paint(title, "border")}`,
    ...rows.map((row) => `  ${theme.paint(box.side, "border")} ${row}`),
    `  ${theme.paint(`${box.bl}${box.bottom.repeat(width - 2)}${box.br}`, "border")}`,
  ].join("\n");
}

export function renderPermissionResolved(
  request: PermissionRequest,
  decision: PermissionDecision,
  theme: Theme,
): string {
  const allowed = decision !== "deny";
  const glyph = allowed ? theme.glyphs.check : theme.glyphs.cross;
  const label = decision === "allow-always" ? "allowed (always)" : allowed ? "allowed" : "denied";
  return `  ${theme.paint(glyph, allowed ? "success" : "danger")} ${theme.paint(label, allowed ? "success" : "danger")} ${theme.dim(
    request.detail,
  )}`;
}

/** Stable, pure render of one complete message; used for headless output. */
export function renderWholeTurn(message: Message, options: TranscriptOptions): string {
  const sink = bufferSink();
  const transcript = new Transcript({ ...options, sink });
  transcript.handle({
    type: "message.end",
    sessionId: message.sessionId,
    messageId: message.id,
    message,
  });
  return sink.text().replace(/\n+$/, "");
}

function renderParts(
  parts: Part[],
  theme: Theme,
  options: { markdown: boolean; showReasoning: boolean; showTokenUsage: boolean },
): string {
  const blocks: string[] = [];
  for (const part of parts) {
    if (part.type === "text") {
      const text = options.markdown ? renderMarkdown(part.text, theme) : part.text;
      if (text.trim()) blocks.push(text);
    } else if (part.type === "reasoning") {
      if (options.showReasoning) {
        blocks.push(
          `${theme.paint(theme.glyphs.thinking, "textFaint")} ${theme.dim("thinking")}\n${indentBlock(
            part.text,
            (line) => theme.dim(line),
          )}`,
        );
      } else {
        blocks.push(`${theme.paint(theme.glyphs.thinking, "textFaint")} ${theme.dim("thinking")}`);
      }
    } else if (part.type === "tool") {
      blocks.push(renderToolResult(part, theme));
    }
  }
  return blocks.join("\n\n");
}
