import type { ToolDef, ToolContext, ToolOutcome } from "../core/types.ts";
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
    const todos = getTodos(ctx.sessionId);
    return {
      title: todos.length === 0 ? "No todos" : `${todos.length} todo${todos.length === 1 ? "" : "s"}`,
      output: renderTodos(todos),
      metadata: { count: todos.length, todos },
    };
  },
};
