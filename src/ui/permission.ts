/** Pure single-key permission decision used by the interactive shell. */
import type { PermissionDecision } from "../core/types.ts";
import type { EditorKey } from "./editor.ts";
import type { Theme } from "./theme.ts";

export type PermissionAnswer = EditorKey | string;

function normalize(answer: PermissionAnswer): string {
  if (typeof answer === "string") return answer.trim().toLowerCase();
  if (answer.name === "text") return (answer.text ?? "").trim().toLowerCase();
  return answer.name;
}

/**
 * Maps one keypress to a decision. `undefined` means "not an answer yet", so
 * the prompt can keep waiting instead of guessing.
 */
export function decidePermission(answer: PermissionAnswer): PermissionDecision | undefined {
  switch (normalize(answer)) {
    case "y":
    case "yes":
      return "allow";
    case "a":
    case "always":
      return "allow-always";
    case "n":
    case "no":
    case "enter":
    case "escape":
    case "ctrl-c":
      return "deny";
    default:
      return undefined;
  }
}

export function renderPermissionPrompt(theme: Theme): string {
  return [
    theme.paint("y", "success"),
    theme.dim("allow"),
    theme.paint("n", "danger"),
    theme.dim("deny"),
    theme.paint("a", "warn"),
    theme.dim("always"),
  ].join(" ");
}
