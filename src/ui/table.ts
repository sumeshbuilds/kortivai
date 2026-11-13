/** Aligned, ANSI-aware tables for the information commands. */
import type { Theme } from "./theme.ts";
import { displayWidth, padEndVisible } from "./theme.ts";

export interface TableOptions {
  indent?: string;
  gap?: number;
  /** Skip the header rule (used when a banner already separates the block). */
  noRule?: boolean;
}

export function renderTable(
  headers: string[],
  rows: string[][],
  theme: Theme,
  options: TableOptions = {},
): string {
  const indent = options.indent ?? "  ";
  const gap = " ".repeat(options.gap ?? 2);
  const widths = headers.map((header, column) =>
    Math.max(displayWidth(header), ...rows.map((row) => displayWidth(row[column] ?? ""))),
  );
  const line = (cells: string[], paint: (cell: string) => string) => {
    const padded = cells.map((cell, column) =>
      column === cells.length - 1 ? cell : padEndVisible(cell, widths[column]!),
    );
    return (indent + padded.map(paint).join(gap)).replace(/\s+$/, "");
  };

  const out: string[] = [line(headers, (cell) => theme.paint(cell, "textFaint"))];
  if (!options.noRule) {
    const total = widths.reduce((sum, width) => sum + width, 0) + gap.length * (widths.length - 1);
    out.push(indent + theme.paint(theme.glyphs.rule.repeat(total), "border"));
  }
  for (const row of rows) out.push(line(row, (cell) => theme.paint(cell, "text")));
  return out.join("\n");
}
