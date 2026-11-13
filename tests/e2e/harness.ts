/**
 * End-to-end harness.
 *
 * Builds a real object graph — real agent loop, real tool registry, real
 * permission manager, real session store — with only the *provider* replaced
 * by a scripted fake. That means these tests prove wiring and tool execution
 * without a network call, while still exercising the code paths a live run
 * uses.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEventBus } from "../../src/core/events.ts";
import { createAgentRuntime, type AgentRuntimeHost } from "../../src/core/agent.ts";
import { createSessionStore } from "../../src/core/session.ts";
import { createPermissionManager } from "../../src/permission/index.ts";
import { createToolRegistry } from "../../src/tool/index.ts";
import { nullLogger } from "../../src/util/log.ts";
import type {
  AgentEvent,
  ChatRequest,
  FinishReason,
  ModelInfo,
  PermissionAsker,
  PermissionDecision,
  PermissionRequest,
  Provider,
  ProviderInfo,
  ProviderRegistry,
  ResolvedConfig,
  StreamEvent,
  Usage,
} from "../../src/core/types.ts";

export interface ScriptedToolCall {
  name: string;
  input: unknown;
}

export interface ScriptedTurn {
  text?: string;
  /** Emitted in chunks so streaming and part merging get exercised. */
  textChunks?: string[];
  reasoning?: string;
  toolCalls?: ScriptedToolCall[];
  finishReason?: FinishReason;
  usage?: Usage;
  /** Simulates a transport failure. */
  error?: string;
  retryable?: boolean;
}

const TEST_MODELS: ModelInfo[] = [
  {
    id: "test-model",
    name: "Test Model",
    contextWindow: 128_000,
    maxOutput: 8192,
    supportsTools: true,
    supportsReasoning: true,
    cost: { input: 0, output: 0 },
  },
];

export class ScriptedProvider implements Provider {
  readonly info: ProviderInfo;
  readonly requests: ChatRequest[] = [];
  private readonly turns: ScriptedTurn[];
  private index = 0;

  constructor(turns: ScriptedTurn[], id = "test") {
    this.turns = [...turns];
    this.info = {
      id,
      name: "Scripted",
      env: [],
      models: TEST_MODELS,
    };
  }

  get callCount(): number {
    return this.requests.length;
  }

  /** The turn that will be served next, without consuming it. */
  peek(): ScriptedTurn | undefined {
    return this.turns[this.index];
  }

  async chat(request: ChatRequest): Promise<void> {
    this.requests.push(request);
    const turn = this.turns[this.index] ?? {
      text: "(script exhausted)",
      finishReason: "stop" as FinishReason,
    };
    this.index += 1;

    const emit = (event: StreamEvent) => request.onEvent(event);
    const abortIfNeeded = () => {
      if (request.signal.aborted) throw Object.assign(new Error("Aborted"), { name: "AbortError" });
    };

    if (turn.reasoning) emit({ type: "reasoning-delta", text: turn.reasoning });

    const chunks = turn.textChunks ?? (turn.text ? [turn.text] : []);
    for (const chunk of chunks) {
      abortIfNeeded();
      emit({ type: "text-delta", text: chunk });
    }

    for (const [position, call] of (turn.toolCalls ?? []).entries()) {
      emit({
        type: "tool-call",
        callId: `call_test_${this.index}_${position}`,
        name: call.name,
        input: call.input,
      });
    }

    if (turn.error) {
      emit({ type: "error", error: turn.error, retryable: turn.retryable ?? false });
      return;
    }

    emit({
      type: "usage",
      usage: turn.usage ?? { input: 10, output: 5 },
    });
    emit({
      type: "finish",
      reason: turn.finishReason ?? (turn.toolCalls?.length ? "tool-calls" : "stop"),
    });
  }
}

export class FakeProviderRegistry implements ProviderRegistry {
  private readonly providers = new Map<string, Provider>();

  constructor(providers: Provider[]) {
    for (const provider of providers) this.providers.set(provider.info.id, provider);
  }

  list(): ProviderInfo[] {
    return [...this.providers.values()].map((provider) => provider.info);
  }

  get(id: string): Provider | undefined {
    return this.providers.get(id);
  }

  models(providerId: string): ModelInfo[] {
    return this.providers.get(providerId)?.info.models ?? [];
  }

  resolveModel(key: string): { provider: string; model: string } | undefined {
    if (key.includes("/")) {
      const [provider, ...rest] = key.split("/");
      const model = rest.join("/");
      return this.providers.has(provider!) ? { provider: provider!, model } : undefined;
    }
    for (const provider of this.providers.values()) {
      if (provider.info.models.some((model) => model.id === key)) {
        return { provider: provider.info.id, model: key };
      }
    }
    return undefined;
  }

  async hasCredential(providerId: string): Promise<boolean> {
    return this.providers.has(providerId);
  }

  async available(): Promise<ProviderInfo[]> {
    return this.list();
  }
}

/** Records every permission request and answers with the scripted verdict. */
export class ScriptedAsker implements PermissionAsker {
  readonly requests: PermissionRequest[] = [];
  private readonly answers: PermissionDecision[];

  constructor(answers: PermissionDecision[] = ["allow"]) {
    this.answers = [...answers];
  }

  async ask(request: PermissionRequest): Promise<PermissionDecision> {
    this.requests.push(request);
    return this.answers.shift() ?? this.answers[this.answers.length - 1] ?? "deny";
  }
}

export interface HarnessOptions {
  turns: ScriptedTurn[];
  /** Permission answers, in order. Defaults to allow. */
  answers?: PermissionDecision[];
  autoApprove?: boolean;
  config?: Partial<ResolvedConfig>;
  /** Extra tools merged into the registry (mirrors MCP/skill bridging). */
  extraTools?: Parameters<typeof createToolRegistry>[0]["extraTools"];
}

export interface Harness {
  readonly cwd: string;
  readonly home: string;
  readonly sessionId: string;
  readonly sessions: ReturnType<typeof createSessionStore>;
  readonly agent: AgentRuntimeHost;
  readonly provider: ScriptedProvider;
  readonly asker: ScriptedAsker;
  readonly events: AgentEvent[];
  /** Runs a turn against the harness session and returns its final text. */
  run(prompt: string, agent?: string): Promise<string>;
  cleanup(): Promise<void>;
}

/**
 * `KORTIVAI_HOME` is redirected before any store is constructed so tests can
 * never touch the developer's real profile.
 */
export async function createHarness(options: HarnessOptions): Promise<Harness> {
  const home = await mkdtemp(join(tmpdir(), "kortivai-home-"));
  const cwd = await mkdtemp(join(tmpdir(), "kortivai-cwd-"));
  process.env.KORTIVAI_HOME = home;

  const provider = new ScriptedProvider(options.turns);
  const providers = new FakeProviderRegistry([provider]);
  const events: AgentEvent[] = [];
  const bus = createEventBus();
  bus.subscribe((event) => events.push(event));

  const sessions = createSessionStore({ dir: join(home, "state", "sessions") });
  const asker = new ScriptedAsker(options.answers ?? ["allow"]);
  const permissions = createPermissionManager({
    rules: options.config?.permissions ?? [],
    asker,
    autoApprove: options.autoApprove ?? false,
  });

  const config: ResolvedConfig = {
    cwd,
    sources: [],
    model: "test/test-model",
    ...options.config,
  };

  const toolOptions = {
    cwd,
    config,
    logger: nullLogger,
    extraTools: options.extraTools,
  };

  const agent = createAgentRuntime({
    config,
    providers,
    sessions,
    events: bus,
    permissions,
    logger: nullLogger,
    createTools: ({ agent: definition, session }) =>
      createToolRegistry({
        ...toolOptions,
        cwd: session.cwd,
        disabled: Object.entries(definition.tools ?? {})
          .filter(([, enabled]) => enabled === false)
          .map(([name]) => name),
      }),
  });

  const session = await sessions.create({
    title: "harness",
    cwd,
    agent: "build",
    model: { provider: "test", model: "test-model" },
  });

  return {
    cwd,
    home,
    sessionId: session.id,
    sessions,
    agent,
    provider,
    asker,
    events,
    async run(prompt: string, agentName?: string): Promise<string> {
      const message = await agent.run({
        sessionId: session.id,
        prompt,
        ...(agentName ? { agent: agentName } : {}),
      });
      return message.parts
        .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
        .map((part) => part.text)
        .join("");
    },
    async cleanup(): Promise<void> {
      await rm(home, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    },
  };
}

export function eventsOfType<T extends AgentEvent["type"]>(
  events: AgentEvent[],
  type: T,
): Extract<AgentEvent, { type: T }>[] {
  return events.filter((event): event is Extract<AgentEvent, { type: T }> => event.type === type);
}
