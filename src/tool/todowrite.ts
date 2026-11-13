import type { ToolDef, ToolContext, ToolOutcome } from "../core/types.ts";
import { fail } from "./shared.ts";

export type TodoStatus = "pending" | "in_progress" | "completed" | "cancelled";

export interface TodoItem {
  content: string;
  status: TodoStatus;
}

const STATUSES: readonly TodoStatus[] = ["pending", "in_progress", "completed", "cancelled"];

/**
 * Session-scoped and intentionally in-memory: todos are working state for the
 * current conversation, not user-owned files, so they survive neither a
 * restart nor a permission denial.
 */
const store = new Map<string, TodoItem[]>();

export function getTodos(sessionId: string): TodoItem[] {
  return store.get(sessionId) ?? [];
}

export function setTodos(sessionId: string, todos: TodoItem[]): void {
  store.set(sessionId, todos);
}

const MARKERS: Record<TodoStatus, string> = {
  pending: "[ ]",
  in_progress: "[~]",
  completed: "[x]",
  cancelled: "[-]",
};

/** `state -> string`, used by both the write and read tools. */
export function renderTodos(todos: readonly TodoItem[]): string {
  if (todos.length === 0) return "The todo list is empty.";
  const lines = todos.map((todo) => `- ${MARKERS[todo.status]} ${todo.content}`);
  const done = todos.filter((todo) => todo.status === "completed").length;
  const cancelled = todos.filter((todo) => todo.status === "cancelled").length;
  const suffix = cancelled > 0 ? `, ${cancelled} cancelled` : "";
  return `${lines.join("\n")}\n\n${done}/${todos.length} completed${suffix}`;
}

const ITEM_SCHEMA = {
  type: "object",
  properties: {
    content: { type: "string", description: "Imperative description of the task, e.g. \"Add permission tests\"." },
    status: {
      type: "string",
      enum: STATUSES,
      description: "pending, in_progress (exactly one at a time), completed, or cancelled.",
    },
  },
  required: ["content", "status"],
  additionalProperties: false,
} as const;

const PARAMETERS = {
  type: "object",
  properties: {
    todos: {
      type: "array",
      description:
        "The COMPLETE todo list after this call. Send every item every time: the previous list is replaced, so an item " +
        "you leave out is deleted.",
      items: ITEM_SCHEMA,
    },
  },
  required: ["todos"],
  additionalProperties: false,
} as const;

export const todowriteTool: ToolDef = {
  name: "todowrite",
  description:
    "Create or update the plan for the current session and show it to the user. Send the whole list on every call — it " +
    "replaces the previous one. Keep exactly one item `in_progress`, mark items `completed` immediately when they are " +
    "done, and use `cancelled` for work you abandoned. Use it for multi-step work (3+ steps) and skip it for trivial " +
    "requests. Never use it as a substitute for doing the work.",
  parameters: PARAMETERS,
  // Not `destructive`: it only touches this session's in-memory checklist.
  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome> {
    const raw = input["todos"];
    if (!Array.isArray(raw)) {
      return fail('Invalid input for "todowrite": field "todos" must be an array.');
    }
    const todos: TodoItem[] = [];
    for (let index = 0; index < raw.length; index += 1) {
      const entry: unknown = raw[index];
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
        return fail(`Invalid input for "todowrite": todos[${index}] must be an object.`);
      }
      const record = entry as Record<string, unknown>;
      const content = record["content"];
      const status = record["status"];
      if (typeof content !== "string" || content.trim() === "") {
        return fail(`Invalid input for "todowrite": todos[${index}].content must be a non-empty string.`);
      }
      if (typeof status !== "string" || !STATUSES.includes(status as TodoStatus)) {
        return fail(
          `Invalid input for "todowrite": todos[${index}].status must be one of ${STATUSES.join(", ")}.`,
        );
      }
      todos.push({ content: content.trim(), status: status as TodoStatus });
    }

    setTodos(ctx.sessionId, todos);
    const body = renderTodos(todos);
    ctx.progress({ tool: "todowrite", todos: todos.length });
    return {
      title: todos.length === 0 ? "Cleared todos" : `${todos.length} todo${todos.length === 1 ? "" : "s"}`,
      output: body,
      metadata: { count: todos.length, todos },
    };
  },
};
