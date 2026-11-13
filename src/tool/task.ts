import type { ToolDef, ToolContext, ToolOutcome } from "../core/types.ts";
import { abortedOutcome, fail, isAborted } from "./shared.ts";

const PARAMETERS = {
  type: "object",
  properties: {
    agent: {
      type: "string",
      description:
        'Name of the subagent to run, e.g. "explore" or "general". Subagents are configured by the user; use the name they provide.',
    },
    prompt: {
      type: "string",
      description:
        "The full, self-contained task for the subagent. It cannot see this conversation, so include every path, command and constraint it needs.",
    },
    description: {
      type: "string",
      description: 'A 3-5 word label for the task, shown in the UI (e.g. "Find auth callers").',
    },
  },
  required: ["agent", "prompt"],
  additionalProperties: false,
} as const;

export const taskTool: ToolDef = {
  name: "task",
  description:
    "Delegate a self-contained piece of work to a subagent and get its final report back. Use it to explore a large " +
    "codebase or run an independent investigation without filling this conversation with raw file contents. The " +
    "subagent starts with an empty context: state the goal, the paths and the exact deliverable in `prompt`. Do not " +
    "delegate work you could finish with a single read or grep. The subagent's own tool calls are permissioned " +
    "separately, and it cannot ask you follow-up questions.",
  parameters: PARAMETERS,
  // Side effects happen inside the subagent, whose tools gate themselves.
  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome> {
    const agent = input["agent"];
    const prompt = input["prompt"];
    const description = input["description"];
    if (typeof agent !== "string" || agent.trim() === "") {
      return fail('Invalid input for "task": field "agent" must be a non-empty string.');
    }
    if (typeof prompt !== "string" || prompt.trim() === "") {
      return fail('Invalid input for "task": field "prompt" must be a non-empty string.');
    }
    if (description !== undefined && typeof description !== "string") {
      return fail('Invalid input for "task": field "description" must be a string.');
    }

    if (!ctx.subagent) {
      return fail(
        "Subagents are unavailable in this session: the runtime did not provide a subagent runner. " +
          "Do the work directly with the other tools.",
      );
    }
    if (isAborted(ctx)) return abortedOutcome();

    try {
      const result = await ctx.subagent({
        agent: agent.trim(),
        prompt,
        description: typeof description === "string" ? description : undefined,
        sessionId: ctx.sessionId,
        signal: ctx.signal,
      });
      return {
        title: typeof description === "string" && description.trim() !== "" ? description.trim() : `${agent.trim()} task`,
        output: result,
        metadata: { agent: agent.trim() },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return fail(`Subagent "${agent}" failed: ${message}`, { agent });
    }
  },
};
