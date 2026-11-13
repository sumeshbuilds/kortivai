/**
 * Markdown -> styled terminal string.
 *
 * The renderer is line-streaming: complete lines are styled the moment they
 * arrive, so the same code path serves a finished string and a live token
 * stream without re-rendering or corrupting partial text. An unterminated
 * fence is still rendered as a code block, never dropped.
 */
import type { Theme } from "./theme.ts";

const RE_FENCE_OPEN = /^\s*```+\s*(.*?)\s*$/;
const RE_FENCE_CLOSE = /^\s*```+\s*$/;
const RE_HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const RE_RULE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const RE_QUOTE = /^\s*>\s?(.*)$/;
const RE_LIST = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;

export function renderMarkdown(text: string, theme: Theme): string {
  const machine = new MarkdownMachine(theme);
  const out = machine.push(text) + machine.flush();
  // A complete render has no trailing line break; the transcript owns spacing.
  return out.endsWith("\n") ? out.slice(0, -1) : out;
}

export interface MarkdownStream {
  push(chunk: string): string;
  flush(): string;
}

export function createMarkdownStream(theme: Theme): MarkdownStream {
  const machine = new MarkdownMachine(theme);
  return {
    push: (chunk) => machine.push(chunk),
    flush: () => machine.flush(),
  };
}

class MarkdownMachine {
  private readonly theme: Theme;
  private buffer = "";
  private fence: string | null = null;
  private listLevel: number | null = null;

  constructor(theme: Theme) {
    this.theme = theme;
  }

  push(chunk: string): string {
    this.buffer += chunk;
    let out = "";
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) break;
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      const rendered = this.emit(line);
      // `null` consumes the line break too (a closing fence is not a line).
      if (rendered !== null) out += `${rendered}\n`;
    }
    return out;
  }

  flush(): string {
    if (this.buffer === "") return "";
    const line = this.buffer;
    this.buffer = "";
    return this.emit(line) ?? "";
  }

  private emit(line: string): string | null {
    const { theme } = this;
    const glyphs = theme.glyphs;

    if (this.fence !== null) {
      if (RE_FENCE_CLOSE.test(line)) {
        this.fence = null;
        return null;
      }
      return this.codeLine(line);
    }

    const opening = RE_FENCE_OPEN.exec(line);
    if (opening) {
      this.fence = opening[1] ?? "";
      this.listLevel = null;
      return `${theme.paint(glyphs.gutter, "border")} ${theme.paint(this.fence || "code", "textFaint")}`;
    }

    if (line.trim() === "") {
      this.listLevel = null;
      return "";
    }

    const heading = RE_HEADING.exec(line);
    if (heading) {
      this.listLevel = null;
      return this.heading(heading[1]!.length, heading[2] ?? "");
    }

    if (RE_RULE.test(line)) {
      this.listLevel = null;
      return theme.paint(glyphs.rule.repeat(Math.max(8, theme.width - 2)), "border");
    }

    const quote = RE_QUOTE.exec(line);
    if (quote) {
      this.listLevel = null;
      return `${theme.paint(glyphs.gutter, "border")} ${theme.paint(renderInline(quote[1] ?? "", theme), "textMuted")}`;
    }

    const item = RE_LIST.exec(line);
    if (item) {
      const indent = item[1]!.replace(/\t/g, "  ");
      const level = Math.min(6, Math.floor(indent.length / 2));
      this.listLevel = level;
      const ordered = /^\d/.test(item[2]!);
      const marker = ordered ? item[2]!.padEnd(3) : glyphs.bullet;
      return `${"  ".repeat(level)}${theme.paint(marker, "accentDim")} ${renderInline(item[3] ?? "", theme)}`;
    }

    if (this.listLevel !== null && /^\s+\S/.test(line)) {
      return `${"  ".repeat(this.listLevel + 1)}${renderInline(line.trim(), theme)}`;
    }

    this.listLevel = null;
    return renderInline(line, theme);
  }

  private codeLine(line: string): string {
    const { theme } = this;
    const gutter = theme.paint(theme.glyphs.gutter, "border");
    return line ? `${gutter} ${theme.paint(line, "code")}` : gutter;
  }

  private heading(level: number, title: string): string {
    const { theme } = this;
    const glyphs = theme.glyphs;
    const text = renderInline(title, theme);
    const plain = stripForWidth(title);
    if (level === 1) {
      const marker = theme.paint(glyphs.pointer, "accent");
      const rule = theme.paint(glyphs.rule.repeat(Math.min(theme.width - 2, plain + 2)), "border");
      return `${marker} ${theme.paint(text, "accent")}\n${rule}`;
    }
    if (level === 2) {
      const marker = theme.paint(glyphs.pointer, "accentDim");
      const rule = theme.paint(glyphs.rule.repeat(Math.min(theme.width - 2, plain + 2)), "border");
      return `${marker} ${theme.bold(text)}\n${rule}`;
    }
    if (level === 3) return `${theme.paint(glyphs.pointer, "accentDim")} ${theme.bold(text)}`;
    return `${theme.paint(glyphs.dot, "textFaint")} ${theme.dim(text)}`;
  }
}

function stripForWidth(text: string): number {
  let width = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    width += code >= 0x1100 && code <= 0x115f ? 2 : 1;
  }
  return width;
}

/** Inline formatting: code spans, emphasis, links, strikethrough. */
export function renderInline(text: string, theme: Theme): string {
  const parts = text.split(/(`[^`]*`)/g);
  let out = "";
  for (const part of parts) {
    if (part.length >= 2 && part.startsWith("`") && part.endsWith("`")) {
      out += theme.paint(part.slice(1, -1), "code");
      continue;
    }
    out += emphasis(part, theme);
  }
  return out;
}

function emphasis(text: string, theme: Theme): string {
  let out = text;
  out = out.replace(/\*\*([^*\n]+)\*\*/g, (_match, inner: string) => theme.bold(inner));
  out = out.replace(/__([^_\n]+)__/g, (_match, inner: string) => theme.bold(inner));
  out = out.replace(/(^|[^*\w])\*([^*\n]+)\*/g, (_match, lead: string, inner: string) => `${lead}${theme.italic(inner)}`);
  out = out.replace(/(^|[^_\w])_([^_\n]+)_/g, (_match, lead: string, inner: string) => `${lead}${theme.italic(inner)}`);
  out = out.replace(/~~([^~\n]+)~~/g, (_match, inner: string) => theme.dim(inner));
  out = out.replace(
    /\[([^\]\n]+)\]\(([^)\s]+)\)/g,
    (_match, label: string, url: string) =>
      `${theme.style(label, { fg: "accent", underline: true })} ${theme.dim(`(${url})`)}`,
  );
  return out;
}
