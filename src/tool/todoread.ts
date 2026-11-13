import type { ToolDef, ToolContext, ToolOutcome } from "../core/types.ts";
import { gate } from "./shared.ts";
import { getTodos, renderTodos } from "./todowrite.ts";

const PARAMETERS = {
  type: "object",
  properties: {},
  required: [],
  additionalProperties: false,
} as const;

export const todoreadTool: ToolDef = {
  name: "todoread",
  description:
    "Show the current session's todo list. Call it to re-check the plan after a long stretch of work or after a " +
    "context-heavy detour. Read-only, takes no arguments.",
  parameters: PARAMETERS,
  readOnly: true,
  async execute(_input: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome> {
    // Gated like the other read-only tools so a policy rule can still refuse.
    const denied = await gate(ctx, {
      tool: "todoread",
      title: "Read todo list",
      detail: `session:${ctx.sessionId}`,
      risk: "low",
    });
    if (denied) return denied;

    const todos = getTodos(ctx.sessionId);
    return {
      title: todos.length === 0 ? "No todos" : `${todos.length} todo${todos.length === 1 ? "" : "s"}`,
      output: renderTodos(todos),
      metadata: { count: todos.length, todos },
    };
  },
};
