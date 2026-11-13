import type {
  AgentDefinition,
  AgentEvent,
  AgentInfo,
  AgentRuntime,
  EventBus,
  FinishReason,
  Message,
  ModelContent,
  ModelMessage,
  ModelRef,
  Part,
  PermissionManager,
  PermissionRule,
  PluginRegistry,
  ProviderRegistry,
  ResolvedConfig,
  RunInput,
  Session,
  SessionId,
  SessionStore,
  SkillRegistry,
  StreamEvent,
  ToolContext,
  ToolPart,
  ToolOutcome,
  ToolRegistry,
  Usage,
} from "./types.ts";
import { AbortedError, ProviderError, errorMessage, isAbortError } from "../util/errors.ts";
import { messageId as newMessageId, partId as newPartId } from "../util/ids.ts";
import type { Logger } from "../util/log.ts";
import {
  composeSystemPrompt,
  detectGit,
  loadAgentInstructions,
  type LoadedInstruction,
} from "./prompt.ts";
import { DEFAULT_MAX_STEPS } from "./config.ts";
import { deriveTitle } from "./session.ts";

export interface CreateToolsInput {
  agent: AgentDefinition;
  session: Session;
}

export interface AgentRuntimeOptions {
  config: ResolvedConfig;
  providers: ProviderRegistry;
  sessions: SessionStore;
  events: EventBus;
  permissions: PermissionManager;
  logger: Logger;
  /** Builds the per-agent, per-session tool registry. */
  createTools: (input: CreateToolsInput) => ToolRegistry;
  skills?: SkillRegistry;
  plugins?: PluginRegistry;
  /** Runs a nested agent turn. Supplied by the `task` tool wiring. */
  runSubagent?: (input: {
    agent: string;
    prompt: string;
    sessionId: SessionId;
    signal: AbortSignal;
  }) => Promise<string>;
}

export interface AgentRuntimeHost extends AgentRuntime {
  agents(): AgentDefinition[];
  getAgent(name: string): AgentDefinition | undefined;
  setAgent(sessionId: SessionId, name: string): void;
  createSession(input?: { cwd?: string; agent?: string; model?: string }): Promise<Session>;
  readonly events: EventBus;
}

const RETRY_LIMIT = 3;

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new AbortedError());
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new AbortedError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Converts stored parts into the normalized provider wire format. */
export function toModelMessages(messages: Message[]): ModelMessage[] {
  const out: ModelMessage[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      const content = message.parts
        .filter((part): part is Extract<Part, { type: "text" }> => part.type === "text")
        .map((part) => ({ type: "text" as const, text: part.text }));
      if (content.length > 0) out.push({ role: "user", content });
      continue;
    }

    const assistantContent: ModelContent[] = [];
    for (const part of message.parts) {
      if (part.type === "text" && part.text.trim()) {
        assistantContent.push({ type: "text", text: part.text });
      } else if (part.type === "tool") {
        assistantContent.push({
          type: "tool-call",
          callId: part.callId,
          name: part.name,
          input: part.input,
        });
      }
    }
    if (assistantContent.length > 0) out.push({ role: "assistant", content: assistantContent });

    const results = message.parts
      .filter(
        (part): part is ToolPart =>
          part.type === "tool" && part.status !== "pending" && part.status !== "running",
      )
      .map((part) => ({
        callId: part.callId,
        name: part.name,
        content:
          part.status === "error" || part.status === "denied"
            ? `Error: ${part.error ?? "tool call failed"}`
            : (part.output ?? ""),
        isError: part.status === "error" || part.status === "denied",
      }));
    if (results.length > 0) out.push({ role: "tool", results });
  }
  return out;
}

/**
 * Keeps the newest messages that fit the context window. Roughly 3.5
 * characters per token is a deliberately conservative planning estimate.
 */
export function pruneHistory(
  messages: ModelMessage[],
  contextWindow: number,
  reserve = 8192,
): ModelMessage[] {
  const budget = Math.max(contextWindow - reserve, 4096);
  const estimate = (message: ModelMessage) => Math.ceil(JSON.stringify(message).length / 3.5);
  let total = 0;
  const kept: ModelMessage[] = [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    const size = estimate(message);
    if (kept.length > 0 && total + size > budget) break;
    total += size;
    kept.unshift(message);
  }
  // A tool result must never be the first message: providers reject orphans.
  while (kept.length > 0 && kept[0]!.role === "tool") kept.shift();
  return kept;
}

export function accumulateUsage(current: Usage | undefined, next: Usage): Usage {
  return {
    input: (current?.input ?? 0) + next.input,
    output: (current?.output ?? 0) + next.output,
    reasoning: (current?.reasoning ?? 0) + (next.reasoning ?? 0),
    cacheRead: (current?.cacheRead ?? 0) + (next.cacheRead ?? 0),
    cacheWrite: (current?.cacheWrite ?? 0) + (next.cacheWrite ?? 0),
    cost: (current?.cost ?? 0) + (next.cost ?? 0),
  };
}

export function textOf(parts: Part[]): string {
  return parts
    .filter((part): part is Extract<Part, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("");
}

interface BuiltinAgentSeed {
  name: string;
  description: string;
  mode: "primary" | "subagent";
  prompt?: string;
  tools?: Record<string, boolean>;
  permissions?: PermissionRule[];
  temperature?: number;
  maxSteps?: number;
  modelKey?: string;
  builtin: boolean;
}

const BUILTIN_AGENTS: BuiltinAgentSeed[] = [
  {
    name: "build",
    description: "Full-access agent for implementing changes.",
    mode: "primary",
    builtin: true,
    prompt:
      "You are the default agent. You may read, write, run commands, and delegate to subagents.",
  },
  {
    name: "plan",
    description: "Read-only agent for exploring a codebase and planning.",
    mode: "primary",
    builtin: true,
    prompt:
      "You are in planning mode. Investigate and propose. You cannot modify files or run state-changing commands. Produce a concrete, ordered plan naming the files you would change, and stop before implementing.",
    tools: { write: false, edit: false, patch: false },
    permissions: [
      { tool: "write", action: "deny" },
      { tool: "edit", pattern: "*", action: "deny" },
      { tool: "patch", action: "deny" },
      { tool: "bash", pattern: "*", action: "ask" },
    ],
  },
  {
    name: "general",
    description: "Subagent for multi-step research, search and exploration.",
    mode: "subagent",
    builtin: true,
    prompt:
      "You are a research subagent. Answer the question you were given as completely as you can, then stop. You cannot ask the user follow-up questions, so state any assumptions you made.",
  },
];

export function createAgentRuntime(options: AgentRuntimeOptions): AgentRuntimeHost {
  const { config, providers, sessions, events, permissions, logger } = options;
  const controllers = new Map<SessionId, AbortController>();
  const agentOverrides = new Map<SessionId, string>();
  let definitions: Map<string, AgentDefinition> | undefined;

  const emit = (event: AgentEvent) => events.emit(event);

  /** Resolves a `provider/model` string, tolerating a bare model id. */
  function refFromKey(key: string | undefined): ModelRef | undefined {
    if (!key) return undefined;
    return providers.resolveModel(key);
  }

  function buildDefinitions(): Map<string, AgentDefinition> {
    const map = new Map<string, AgentDefinition>();

    for (const seed of BUILTIN_AGENTS) {
      map.set(seed.name, {
        name: seed.name,
        description: seed.description,
        mode: seed.mode,
        prompt: seed.prompt,
        tools: seed.tools,
        permissions: seed.permissions,
        temperature: seed.temperature,
        maxSteps: seed.maxSteps,
        model: refFromKey(seed.modelKey),
        builtin: true,
        systemPrompt: "",
      });
    }

    for (const [name, custom] of Object.entries(config.agents ?? {})) {
      const previous = map.get(name);
      map.set(name, {
        name,
        description: custom.description ?? previous?.description ?? name,
        mode: custom.mode ?? previous?.mode ?? "primary",
        prompt: custom.prompt ?? previous?.prompt,
        tools: custom.tools ?? previous?.tools,
        permissions: custom.permissions ?? previous?.permissions,
        temperature: custom.temperature ?? previous?.temperature,
        maxSteps: custom.maxSteps ?? previous?.maxSteps,
        model: refFromKey(custom.model) ?? previous?.model,
        builtin: false,
        systemPrompt: "",
      });
    }

    for (const [name, custom] of Object.entries(config.subagents ?? {})) {
      const previous = map.get(name);
      map.set(name, {
        name,
        description: custom.description ?? previous?.description ?? `Subagent ${name}`,
        mode: "subagent",
        prompt: custom.prompt ?? previous?.prompt,
        tools: custom.tools ?? previous?.tools,
        permissions: previous?.permissions,
        temperature: custom.temperature ?? previous?.temperature,
        maxSteps: custom.maxSteps ?? previous?.maxSteps,
        model: refFromKey(custom.model) ?? previous?.model,
        builtin: false,
        systemPrompt: "",
      });
    }

    return map;
  }

  function allDefinitions(): Map<string, AgentDefinition> {
    definitions ??= buildDefinitions();
    return definitions;
  }

  function resolveAgent(name?: string): AgentDefinition {
    const map = allDefinitions();
    return (name ? map.get(name) : undefined) ?? map.get("build")!;
  }

  function resolveModel(
    preferred?: ModelRef,
    agentModel?: ModelRef,
  ): ModelRef {
    const chosen =
      preferred ??
      agentModel ??
      (config.model ? providers.resolveModel(config.model) : undefined);
    if (!chosen) {
      throw new ProviderError("none", "No model configured.", {
        hint: 'Set `model` in kortivai.json (for example "deepseek/deepseek-chat"), or pass --model.',
      });
    }
    return chosen;
  }

  async function createSession(
    input: { cwd?: string; agent?: string; model?: string } = {},
  ): Promise<Session> {
    const agent = resolveAgent(input.agent);
    const model = resolveModel(refFromKey(input.model), agent.model);
    const session = await sessions.create({
      title: "New session",
      cwd: input.cwd ?? config.cwd,
      agent: agent.name,
      model,
    });
    logger.info("session created", { id: session.id, agent: agent.name, model });
    return session;
  }

  async function loadInstructions(cwd: string): Promise<LoadedInstruction[]> {
    try {
      return await loadAgentInstructions(cwd, config);
    } catch (error) {
      logger.warn("failed to load project instructions", error);
      return [];
    }
  }

  /** One provider round-trip, streaming parts into `message`. */
  async function streamTurn(input: {
    session: Session;
    agent: AgentDefinition;
    message: Message;
    history: Message[];
    tools: ToolRegistry;
    model: ModelRef;
    signal: AbortSignal;
  }): Promise<{ finishReason: FinishReason; usage?: Usage; aborted: boolean }> {
    const { session, agent, message, history, tools, model, signal } = input;
    const provider = providers.get(model.provider);
    if (!provider) {
      throw new ProviderError(model.provider, `Unknown provider "${model.provider}".`, {
        hint: "Run `kortivai models` to list configured providers.",
      });
    }

    const instructions = await loadInstructions(session.cwd);
    const git = await detectGit(session.cwd);
    const system = composeSystemPrompt({
      agent,
      config,
      environment: {
        cwd: session.cwd,
        platform: process.platform,
        date: new Date().toISOString().slice(0, 10),
        model: `${model.provider}/${model.model}`,
        agent: agent.name,
        isGitRepo: git.isGitRepo,
        gitBranch: git.branch,
      },
      instructions,
      skills: options.skills?.list() ?? [],
    });

    const info = providers.models(model.provider).find((entry) => entry.id === model.model);
    const modelMessages = pruneHistory(toModelMessages(history), info?.contextWindow ?? 128_000);

    let textPart = message.parts.find(
      (part): part is Extract<Part, { type: "text" }> => part.type === "text",
    );
    let reasoningPart = message.parts.find(
      (part): part is Extract<Part, { type: "reasoning" }> => part.type === "reasoning",
    );
    let usage: Usage | undefined;
    let finishReason: FinishReason = "unknown";
    let streamError: string | undefined;
    // Providers report whether a failure is worth retrying; an error the model
    // endpoint considers permanent must not be retried, or we burn the script
    // and silently return a stale turn.
    let streamErrorRetryable = false;

    const params: { system: string; temperature?: number; maxTokens?: number } = {
      system,
      temperature: agent.temperature ?? config.temperature,
    };
    for (const hooks of options.plugins?.hooks() ?? []) {
      await hooks["chat.params"]?.({ model, ...params });
    }

    const onEvent = (event: StreamEvent) => {
      switch (event.type) {
        case "text-delta": {
          textPart ??= pushText(message, "");
          textPart.text += event.text;
          emit({
            type: "part.update",
            sessionId: session.id,
            messageId: message.id,
            part: { ...textPart },
          });
          break;
        }
        case "reasoning-delta": {
          if (!reasoningPart) {
            reasoningPart = { type: "reasoning", id: newPartId(), text: "" };
            message.parts.push(reasoningPart);
          }
          reasoningPart.text += event.text;
          emit({
            type: "part.update",
            sessionId: session.id,
            messageId: message.id,
            part: { ...reasoningPart },
          });
          break;
        }
        case "tool-call": {
          const part: ToolPart = {
            type: "tool",
            id: newPartId(),
            callId: event.callId,
            name: event.name,
            input: event.input,
            status: "pending",
          };
          message.parts.push(part);
          emit({
            type: "part.update",
            sessionId: session.id,
            messageId: message.id,
            part: { ...part },
          });
          break;
        }
        case "usage":
          usage = event.usage;
          break;
        case "finish":
          finishReason = event.reason;
          break;
        case "error":
          streamError = event.error;
          streamErrorRetryable = event.retryable;
          break;
        default:
          break;
      }
    };

    for (let attempt = 1; ; attempt += 1) {
      streamError = undefined;
      streamErrorRetryable = false;
      try {
        await provider.chat({
          model,
          system,
          messages: modelMessages,
          tools: tools.schemas(),
          temperature: params.temperature,
          maxTokens: params.maxTokens,
          onEvent,
          signal,
        });
        if (streamError) {
          throw new ProviderError(model.provider, streamError, {
            retryable: streamErrorRetryable,
          });
        }
        break;
      } catch (error) {
        if (isAbortError(error) || signal.aborted) {
          return { finishReason: "aborted", usage, aborted: true };
        }
        const retryable = error instanceof ProviderError ? error.retryable : false;
        if (!retryable || attempt >= RETRY_LIMIT) throw error;
        const delay = Math.min(1000 * 2 ** (attempt - 1), 8000);
        logger.warn(`provider error, retrying in ${delay}ms`, errorMessage(error));
        emit({
          type: "status",
          sessionId: session.id,
          status: "retrying",
          detail: `attempt ${attempt + 1}/${RETRY_LIMIT}`,
        });
        await sleep(delay, signal);
      }
    }

    if (finishReason === "unknown" && message.parts.some((part) => part.type === "tool")) {
      finishReason = "tool-calls";
    }
    return { finishReason, usage, aborted: false };
  }

  function pushText(message: Message, text: string): Extract<Part, { type: "text" }> {
    const part = { type: "text" as const, id: newPartId(), text };
    message.parts.push(part);
    return part;
  }

  /**
   * Executes pending tool calls. Consecutive read-only calls run
   * concurrently; a side-effecting call always runs alone, in order.
   */
  async function runTools(input: {
    session: Session;
    agent: AgentDefinition;
    message: Message;
    tools: ToolRegistry;
    signal: AbortSignal;
  }): Promise<void> {
    const { session, agent, message, tools, signal } = input;
    const calls = message.parts.filter(
      (part): part is ToolPart => part.type === "tool" && part.status === "pending",
    );
    if (calls.length === 0) return;

    const scoped = agent.permissions?.length ? permissions.scope(agent.permissions) : permissions;

    const executeOne = async (part: ToolPart): Promise<void> => {
      part.status = "running";
      part.startedAt = Date.now();
      emit({ type: "part.update", sessionId: session.id, messageId: message.id, part: { ...part } });
      const result = await executeTool({ session, part, tools, scoped, signal });
      part.status = result.status;
      if (result.outcome.title) part.title = result.outcome.title;
      part.output = result.outcome.output;
      if (result.outcome.metadata) part.metadata = { ...(part.metadata ?? {}), ...result.outcome.metadata };
      part.error = result.error;
      part.endedAt = Date.now();
      emit({ type: "part.update", sessionId: session.id, messageId: message.id, part: { ...part } });
      await sessions.update(session.id, message);
    };

    let index = 0;
    while (index < calls.length) {
      const head = calls[index]!;
      const batch: ToolPart[] = [head];
      if (tools.get(head.name)?.readOnly === true) {
        while (index + batch.length < calls.length) {
          const next = calls[index + batch.length]!;
          if (tools.get(next.name)?.readOnly !== true) break;
          batch.push(next);
        }
      }
      index += batch.length;
      if (batch.length === 1) await executeOne(batch[0]!);
      else await Promise.all(batch.map((part) => executeOne(part)));
    }
  }

  async function executeTool(input: {
    session: Session;
    part: ToolPart;
    tools: ToolRegistry;
    scoped: PermissionManager;
    signal: AbortSignal;
  }): Promise<{ status: ToolPart["status"]; outcome: ToolOutcome; error?: string }> {
    const { session, part, tools, scoped, signal } = input;

    if (!tools.get(part.name)) {
      const text = `Unknown tool "${part.name}".`;
      return { status: "error", outcome: { output: text, isError: true }, error: text };
    }

    const ctx: ToolContext = {
      sessionId: session.id,
      cwd: session.cwd,
      signal,
      permission: scoped,
      progress: (metadata) => {
        part.metadata = { ...(part.metadata ?? {}), ...metadata };
        emit({
          type: "part.update",
          sessionId: session.id,
          messageId: part.id,
          part: { ...part },
        });
      },
      subagent: options.runSubagent
        ? (request) =>
            options.runSubagent!({
              agent: request.agent,
              prompt: request.prompt,
              sessionId: session.id,
              signal: request.signal,
            })
        : undefined,
      log: (level, message) => logger.child("tool").debug(`${part.name}: ${message}`, { level }),
    };

    const hooks = options.plugins?.hooks() ?? [];
    const veto: { allowed: boolean } = { allowed: true };
    for (const hook of hooks) {
      await hook["tool.before"]?.({
        sessionId: session.id,
        tool: part.name,
        input: part.input,
        allowed: veto.allowed,
      });
    }

    try {
      const outcome = await tools.execute(part.name, part.input, ctx);
      for (const hook of hooks) {
        await hook["tool.after"]?.({
          sessionId: session.id,
          tool: part.name,
          input: part.input,
          outcome,
        });
      }
      if (outcome.isError) {
        return { status: "error", outcome, error: outcome.output };
      }
      return { status: "completed", outcome };
    } catch (error) {
      if (isAbortError(error)) {
        return {
          status: "error",
          outcome: { output: "Tool call aborted.", isError: true },
          error: "aborted",
        };
      }
      const text = errorMessage(error);
      return { status: "error", outcome: { output: text, isError: true }, error: text };
    }
  }

  async function runTurn(input: RunInput): Promise<Message> {
    const session = await sessions.get(input.sessionId);
    if (!session) throw new Error(`Unknown session ${input.sessionId}`);

    const agent = resolveAgent(input.agent ?? agentOverrides.get(session.id) ?? session.agent);
    const model = resolveModel(input.model, agent.model);

    const controller = new AbortController();
    controllers.set(session.id, controller);
    const signal = input.signal ?? controller.signal;
    const onAbort = () => controller.abort();
    input.signal?.addEventListener("abort", onAbort, { once: true });

    const tools = options.createTools({ agent, session });
    const maxSteps = agent.maxSteps ?? config.maxSteps ?? DEFAULT_MAX_STEPS;

    try {
      emit({ type: "status", sessionId: session.id, status: "busy" });

      const userMessage: Message = {
        id: newMessageId(),
        sessionId: session.id,
        role: "user",
        parts: [{ type: "text", id: newPartId(), text: input.prompt }],
        createdAt: Date.now(),
        agent: agent.name,
      };
      await sessions.append(session.id, userMessage);
      emit({
        type: "message.end",
        sessionId: session.id,
        messageId: userMessage.id,
        message: userMessage,
      });

      if (!session.title || session.title === "New session") {
        session.title = deriveTitle(input.prompt);
      }
      session.agent = agent.name;
      session.model = model;
      session.updatedAt = Date.now();
      await sessions.save(session);
      emit({ type: "session.start", sessionId: session.id, session });

      const history = await sessions.messages(session.id);
      let lastAssistant: Message | undefined;

      for (let step = 0; step < maxSteps; step += 1) {
        const assistant: Message = {
          id: newMessageId(),
          sessionId: session.id,
          role: "assistant",
          parts: [],
          createdAt: Date.now(),
          model,
          agent: agent.name,
        };
        await sessions.append(session.id, assistant);
        emit({
          type: "message.start",
          sessionId: session.id,
          messageId: assistant.id,
          role: "assistant",
        });

        const result = await streamTurn({
          session,
          agent,
          message: assistant,
          history,
          tools,
          model,
          signal,
        });

        if (result.usage) {
          assistant.parts.push({
            type: "step",
            id: newPartId(),
            finishReason: result.finishReason,
            usage: result.usage,
            model,
          });
          session.usage = accumulateUsage(session.usage, result.usage);
        }

        const hasToolCalls = assistant.parts.some(
          (part) => part.type === "tool" && part.status === "pending",
        );

        if (result.aborted) {
          assistant.error = "aborted";
          await sessions.update(session.id, assistant);
          emit({
            type: "message.end",
            sessionId: session.id,
            messageId: assistant.id,
            message: assistant,
          });
          emit({ type: "session.end", sessionId: session.id, reason: "aborted" });
          return assistant;
        }

        history.push(assistant);
        lastAssistant = assistant;

        if (!hasToolCalls) {
          await sessions.update(session.id, assistant);
          emit({
            type: "message.end",
            sessionId: session.id,
            messageId: assistant.id,
            message: assistant,
          });
          session.updatedAt = Date.now();
          await sessions.save(session);
          emit({ type: "session.end", sessionId: session.id, reason: "done" });
          return assistant;
        }

        await runTools({ session, agent, message: assistant, tools, signal });
        await sessions.update(session.id, assistant);
        emit({
          type: "message.end",
          sessionId: session.id,
          messageId: assistant.id,
          message: assistant,
        });
        history[history.length - 1] = assistant;
      }

      const notice: Message = {
        id: newMessageId(),
        sessionId: session.id,
        role: "assistant",
        parts: [
          {
            type: "text",
            id: newPartId(),
            text: `Stopped after ${maxSteps} steps without finishing. Ask me to continue, or raise \`maxSteps\` in your config.`,
          },
        ],
        createdAt: Date.now(),
        model,
        agent: agent.name,
      };
      await sessions.append(session.id, notice);
      emit({
        type: "message.start",
        sessionId: session.id,
        messageId: notice.id,
        role: "assistant",
      });
      emit({
        type: "message.end",
        sessionId: session.id,
        messageId: notice.id,
        message: notice,
      });
      session.updatedAt = Date.now();
      await sessions.save(session);
      emit({ type: "session.end", sessionId: session.id, reason: "done" });
      // Return the notice, not the last tool-call message: the caller needs to
      // see *why* the turn ended, otherwise a budget stop looks like silence.
      return notice;
    } catch (error) {
      const text = errorMessage(error);
      if (isAbortError(error)) {
        emit({ type: "session.end", sessionId: session.id, reason: "aborted" });
      } else {
        logger.error("turn failed", error);
        emit({ type: "agent.error", sessionId: session.id, error: text });
        emit({ type: "session.end", sessionId: session.id, reason: "error" });
      }
      const failed: Message = {
        id: newMessageId(),
        sessionId: session.id,
        role: "assistant",
        parts: [{ type: "text", id: newPartId(), text: `Error: ${text}` }],
        createdAt: Date.now(),
        model,
        agent: agent.name,
        error: text,
      };
      try {
        await sessions.append(session.id, failed);
      } catch {
        // Persisting the failure is best-effort.
      }
      return failed;
    } finally {
      controllers.delete(session.id);
      input.signal?.removeEventListener("abort", onAbort);
      emit({ type: "status", sessionId: session.id, status: "idle" });
    }
  }

  return {
    get agent(): AgentInfo {
      return resolveAgent("build");
    },
    events,
    agents: () => [...allDefinitions().values()],
    getAgent: (name) => allDefinitions().get(name),
    setAgent: (sessionId, name) => {
      agentOverrides.set(sessionId, name);
    },
    createSession,
    run: runTurn,
    abort: (sessionId) => {
      controllers.get(sessionId)?.abort();
    },
    isBusy: (sessionId) => controllers.has(sessionId),
  };
}
