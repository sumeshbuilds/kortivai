/**
 * KortivAI design system.
 *
 * Everything here is pure: no process access, no streams. Capability
 * detection takes an env object, so colour tiers and glyph sets are testable
 * without a TTY. Renderers take a {@link Theme} and return strings.
 *
 * Identity: a graphite terminal with a single warm quartz-amber accent, used
 * only for interactive or brand moments. State colour is semantic and rare.
 */

/* ------------------------------------------------------------------ *
 * ANSI primitives
 * ------------------------------------------------------------------ */

export const ESC = "\u001b";
export const RESET = `${ESC}[0m`;

const ANSI_PATTERN = /\u001b\[[0-9;?]*[A-Za-z]/g;

export function sgr(codes: Array<number | string>): string {
  return codes.length ? `${ESC}[${codes.join(";")}m` : "";
}

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}

/* ------------------------------------------------------------------ *
 * Colour capability
 * ------------------------------------------------------------------ */

/** 0 = none, 1 = 16 colour, 2 = 256 colour, 3 = truecolor. */
export type ColorLevel = 0 | 1 | 2 | 3;

export type ThemeName = "kortiv" | "mono";

export type EnvLike = Record<string, string | undefined>;

export const DEFAULT_WIDTH = 80;

function forceColorLevel(raw: string | undefined): ColorLevel | undefined {
  if (raw === undefined || raw === "") return undefined;
  const value = raw.toLowerCase();
  if (value === "false") return 0;
  if (value === "true") return 1;
  if (value === "0") return 0;
  if (value === "2") return 2;
  if (value === "3") return 3;
  return 1;
}

/**
 * Resolves the colour tier from the environment. FORCE_COLOR is an explicit
 * opt-in and wins over NO_COLOR; otherwise piped output stays plain.
 */
export function detectColorLevel(env: EnvLike, isTTY = false): ColorLevel {
  const forced = forceColorLevel(env.FORCE_COLOR);
  if (forced !== undefined) return forced;
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return 0;
  if (!isTTY) return 0;
  const colorterm = (env.COLORTERM ?? "").toLowerCase();
  if (colorterm.includes("truecolor") || colorterm.includes("24bit")) return 3;
  const term = (env.TERM ?? "").toLowerCase();
  if (term === "dumb") return 0;
  if (term.includes("256color")) return 2;
  if (env.WT_SESSION || env.TERM_PROGRAM || term) return 1;
  return 1;
}

/* ------------------------------------------------------------------ *
 * Glyphs
 * ------------------------------------------------------------------ */

export interface Glyphs {
  /** Input prompt sigil. */
  prompt: string;
  /** Vertical spine used for assistant output and tool previews. */
  spine: string;
  pointer: string;
  check: string;
  cross: string;
  warn: string;
  bullet: string;
  arrow: string;
  pending: string;
  running: string;
  denied: string;
  /** Left gutter bar for code blocks and quotes. */
  gutter: string;
  rule: string;
  ellipsis: string;
  thinking: string;
  dot: string;
  /** Animated frames; a single frame when animations are off. */
  spinner: string[];
}

export const GLYPHS_UNICODE: Glyphs = {
  prompt: "❯",
  spine: "│",
  pointer: "▸",
  check: "✔",
  cross: "✖",
  warn: "▲",
  bullet: "•",
  arrow: "→",
  pending: "○",
  running: "◐",
  denied: "⊘",
  gutter: "▏",
  rule: "─",
  ellipsis: "…",
  thinking: "∴",
  dot: "·",
  spinner: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
};

export const GLYPHS_ASCII: Glyphs = {
  prompt: ">",
  spine: "|",
  pointer: ">",
  check: "+",
  cross: "x",
  warn: "!",
  bullet: "-",
  arrow: "->",
  pending: "o",
  running: "*",
  denied: "x",
  gutter: "|",
  rule: "-",
  ellipsis: "...",
  thinking: "~",
  dot: ".",
  spinner: ["|", "/", "-", "\\"],
};

/**
 * Picks a glyph set. Windows consoles without a UTF-8 terminal (no
 * WT_SESSION, no TERM) get the ASCII fallback; KORTIVAI_ASCII forces it and
 * KORTIVAI_UNICODE forces the unicode set.
 */
export function detectGlyphs(env: EnvLike, platform: NodeJS.Platform = process.platform): Glyphs {
  if (env.KORTIVAI_ASCII === "1" || env.KORTIVAI_ASCII === "true") return GLYPHS_ASCII;
  if (env.KORTIVAI_UNICODE === "1" || env.KORTIVAI_UNICODE === "true") return GLYPHS_UNICODE;
  if (env.WT_SESSION || env.TERM_PROGRAM || env.TERM || env.COLORTERM) return GLYPHS_UNICODE;
  const locale = `${env.LC_ALL ?? ""}${env.LC_CTYPE ?? ""}${env.LANG ?? ""}`.toLowerCase();
  if (locale.includes("utf-8") || locale.includes("utf8")) return GLYPHS_UNICODE;
  return platform === "win32" ? GLYPHS_ASCII : GLYPHS_UNICODE;
}

/* ------------------------------------------------------------------ *
 * Palette and token styles
 * ------------------------------------------------------------------ */

export type Token =
  | "accent"
  | "accentDim"
  | "text"
  | "textMuted"
  | "textFaint"
  | "border"
  | "success"
  | "warn"
  | "danger"
  | "info"
  | "added"
  | "removed"
  | "code";

export type Palette = Record<Token, string>;

export const KORTIV_PALETTE: Palette = {
  accent: "#e8a33d",
  accentDim: "#9c6f2f",
  text: "#d8d2c6",
  textMuted: "#938c7d",
  textFaint: "#625c51",
  border: "#423d34",
  success: "#8fbf6b",
  warn: "#e0b44e",
  danger: "#e06c6c",
  info: "#6fa8c7",
  added: "#8fbf6b",
  removed: "#e06c6c",
  code: "#c9b98e",
};

/** `mono` keeps the glyph language and hierarchy but drops every hue. */
export const MONO_PALETTE: Palette = {
  accent: "",
  accentDim: "",
  text: "",
  textMuted: "",
  textFaint: "",
  border: "",
  success: "",
  warn: "",
  danger: "",
  info: "",
  added: "",
  removed: "",
  code: "",
};

export interface StyleSpec {
  fg?: Token;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
}

const KORTIV_STYLES: Record<Token, StyleSpec> = {
  accent: { fg: "accent", bold: true },
  accentDim: { fg: "accentDim" },
  text: { fg: "text" },
  textMuted: { fg: "textMuted" },
  textFaint: { fg: "textFaint", dim: true },
  border: { fg: "border" },
  success: { fg: "success" },
  warn: { fg: "warn" },
  danger: { fg: "danger" },
  info: { fg: "info" },
  added: { fg: "added" },
  removed: { fg: "removed" },
  code: { fg: "code" },
};

const MONO_STYLES: Record<Token, StyleSpec> = {
  accent: { bold: true },
  accentDim: { dim: true },
  text: {},
  textMuted: { dim: true },
  textFaint: { dim: true },
  border: { dim: true },
  success: { bold: true },
  warn: { bold: true },
  danger: { bold: true },
  info: { bold: true },
  added: { bold: true },
  removed: { bold: true },
  code: {},
};

/* ------------------------------------------------------------------ *
 * Width-aware helpers (wcwidth-lite)
 * ------------------------------------------------------------------ */

function isZeroWidth(codePoint: number): boolean {
  return (
    (codePoint >= 0x0300 && codePoint <= 0x036f) ||
    (codePoint >= 0x1ab0 && codePoint <= 0x1aff) ||
    (codePoint >= 0x200b && codePoint <= 0x200f) ||
    (codePoint >= 0x20d0 && codePoint <= 0x20ff) ||
    (codePoint >= 0xfe00 && codePoint <= 0xfe0f) ||
    codePoint === 0x200d ||
    codePoint === 0xfeff
  );
}

function isWide(codePoint: number): boolean {
  return (
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    (codePoint >= 0x2e80 && codePoint <= 0x303e) ||
    (codePoint >= 0x3041 && codePoint <= 0x33ff) ||
    (codePoint >= 0x3400 && codePoint <= 0x4dbf) ||
    (codePoint >= 0x4e00 && codePoint <= 0x9fff) ||
    (codePoint >= 0xa000 && codePoint <= 0xa4cf) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe4f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x1f300 && codePoint <= 0x1f64f) ||
    (codePoint >= 0x1f900 && codePoint <= 0x1f9ff) ||
    (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  );
}

export function codePointWidth(codePoint: number): 0 | 1 | 2 {
  if (codePoint === 0) return 0;
  if (isZeroWidth(codePoint)) return 0;
  if (isWide(codePoint)) return 2;
  return 1;
}

/** Visible width of a string; ANSI escapes count as zero columns. */
export function displayWidth(text: string): number {
  let width = 0;
  let index = 0;
  for (const match of text.matchAll(ANSI_PATTERN)) {
    width += plainWidth(text.slice(index, match.index));
    index = (match.index ?? 0) + match[0].length;
  }
  return width + plainWidth(text.slice(index));
}

function plainWidth(text: string): number {
  let width = 0;
  for (const char of text) width += codePointWidth(char.codePointAt(0) ?? 0);
  return width;
}

export function padEndVisible(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - displayWidth(text)));
}

export function truncateVisible(text: string, width: number, ellipsis = "…"): string {
  if (width <= 0) return "";
  if (displayWidth(text) <= width) return text;
  const budget = width - plainWidth(ellipsis);
  if (budget <= 0) return ellipsis.slice(0, width);
  let out = "";
  let used = 0;
  let index = 0;
  const matches = [...text.matchAll(ANSI_PATTERN)];
  for (let i = 0; i <= matches.length; i += 1) {
    const escape = matches[i];
    const end = escape?.index ?? text.length;
    for (const char of text.slice(index, end)) {
      const size = codePointWidth(char.codePointAt(0) ?? 0);
      if (used + size > budget) return `${out}${ellipsis}`;
      out += char;
      used += size;
    }
    if (escape) out += escape[0];
    index = end + (escape?.[0].length ?? 0);
  }
  return `${out}${ellipsis}`;
}

/** Word wrap with a hard break for words longer than the width. */
export function wrapVisible(text: string, width: number): string[] {
  if (width <= 0) return [text];
  const lines: string[] = [];
  for (const source of text.split("\n")) {
    let line = "";
    for (const word of source.split(" ")) {
      let rest = word;
      while (displayWidth(rest) > width) {
        if (line) {
          lines.push(line);
          line = "";
        }
        let head = "";
        for (const char of rest) {
          if (displayWidth(head + char) > width) break;
          head += char;
        }
        if (!head) head = rest.slice(0, 1);
        lines.push(head);
        rest = rest.slice(head.length);
      }
      const candidate = line ? `${line} ${rest}` : rest;
      if (displayWidth(candidate) <= width) line = candidate;
      else {
        lines.push(line);
        line = rest;
      }
    }
    lines.push(line);
  }
  return lines;
}

/* ------------------------------------------------------------------ *
 * Theme
 * ------------------------------------------------------------------ */

export interface ThemeOptions {
  name?: ThemeName | "auto";
  env?: EnvLike;
  isTTY?: boolean;
  columns?: number;
  platform?: NodeJS.Platform;
  /** Forces a colour tier; used by tests. */
  level?: ColorLevel;
  /** Forces a glyph set; used by tests. */
  glyphs?: Glyphs;
}

export interface Theme {
  readonly name: ThemeName;
  readonly level: ColorLevel;
  readonly color: boolean;
  readonly glyphs: Glyphs;
  readonly width: number;
  paint(text: string, token: Token): string;
  style(text: string, spec: StyleSpec): string;
  bold(text: string): string;
  dim(text: string): string;
  italic(text: string): string;
  underline(text: string): string;
  truncate(text: string, width?: number): string;
  pad(text: string, width: number): string;
  wrap(text: string, width?: number): string[];
}

export function resolveThemeName(value: string | undefined): ThemeName {
  return value === "mono" ? "mono" : "kortiv";
}

function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.replace("#", "");
  const full =
    clean.length === 3
      ? clean
          .split("")
          .map((char) => `${char}${char}`)
          .join("")
      : clean;
  return [
    Number.parseInt(full.slice(0, 2), 16) || 0,
    Number.parseInt(full.slice(2, 4), 16) || 0,
    Number.parseInt(full.slice(4, 6), 16) || 0,
  ];
}

const ANSI16: Array<[number, number, number]> = [
  [0, 0, 0],
  [128, 0, 0],
  [0, 128, 0],
  [128, 128, 0],
  [0, 0, 128],
  [128, 0, 128],
  [0, 128, 128],
  [192, 192, 192],
  [128, 128, 128],
  [255, 0, 0],
  [0, 255, 0],
  [255, 255, 0],
  [0, 0, 255],
  [255, 0, 255],
  [0, 255, 255],
  [255, 255, 255],
];

function distance(a: [number, number, number], b: [number, number, number]): number {
  return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
}

function nearest16(rgb: [number, number, number]): number {
  let best = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < ANSI16.length; index += 1) {
    const candidate = distance(rgb, ANSI16[index]!);
    if (candidate < bestDistance) {
      bestDistance = candidate;
      best = index;
    }
  }
  return best;
}

function nearest256(rgb: [number, number, number]): number {
  const cube = (value: number) => Math.round((value / 255) * 5);
  const cubeRgb: [number, number, number] = [
    (cube(rgb[0]) * 255) / 5,
    (cube(rgb[1]) * 255) / 5,
    (cube(rgb[2]) * 255) / 5,
  ];
  const cubeCode = 16 + 36 * cube(rgb[0]) + 6 * cube(rgb[1]) + cube(rgb[2]);
  const average = (rgb[0] + rgb[1] + rgb[2]) / 3;
  const grayIndex = Math.min(23, Math.max(0, Math.round((average - 8) / 10)));
  const gray = 8 + grayIndex * 10;
  const grayRgb: [number, number, number] = [gray, gray, gray];
  return distance(rgb, grayRgb) < distance(rgb, cubeRgb) ? 232 + grayIndex : cubeCode;
}

function fgCode(hex: string, level: ColorLevel): string {
  const rgb = hexToRgb(hex);
  if (level === 3) return `38;2;${rgb[0]};${rgb[1]};${rgb[2]}`;
  if (level === 2) return `38;5;${nearest256(rgb)}`;
  const index = nearest16(rgb);
  return String(index < 8 ? 30 + index : 90 + (index - 8));
}

export function createTheme(options: ThemeOptions = {}): Theme {
  const env = options.env ?? process.env;
  const name = resolveThemeName(options.name);
  const level = options.level ?? detectColorLevel(env, options.isTTY ?? false);
  const glyphs = options.glyphs ?? detectGlyphs(env, options.platform);
  const palette = name === "mono" ? MONO_PALETTE : KORTIV_PALETTE;
  const styles = name === "mono" ? MONO_STYLES : KORTIV_STYLES;
  const width = Math.min(500, Math.max(24, options.columns ?? DEFAULT_WIDTH));

  const style = (text: string, spec: StyleSpec): string => {
    if (level === 0 || text === "") return text;
    const codes: number[] = [];
    const fg = spec.fg ? palette[spec.fg] : "";
    if (fg) codes.push(...fgCode(fg, level).split(";").map(Number));
    if (spec.bold) codes.push(1);
    if (spec.dim) codes.push(2);
    if (spec.italic) codes.push(3);
    if (spec.underline) codes.push(4);
    if (codes.length === 0) return text;
    return `${sgr(codes)}${text}${RESET}`;
  };

  return {
    name,
    level,
    color: level > 0,
    glyphs,
    width,
    style,
    paint: (text, token) => style(text, styles[token]),
    bold: (text) => style(text, { bold: true }),
    dim: (text) => style(text, { dim: true }),
    italic: (text) => style(text, { italic: true }),
    underline: (text) => style(text, { underline: true }),
    truncate: (text, limit) => truncateVisible(text, limit ?? width, glyphs.ellipsis),
    pad: (text, limit) => padEndVisible(text, limit),
    wrap: (text, limit) => wrapVisible(text, limit ?? width),
  };
}
