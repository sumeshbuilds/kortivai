import type {
  EventBus,
  KortivConfig,
  PermissionAsker,
  PermissionManager,
  PluginRegistry,
  ProviderRegistry,
  ResolvedConfig,
  SkillRegistry,
  ToolDef,
  ToolRegistry,
} from "./types.ts";
import { createEventBus } from "./events.ts";
import { loadConfig, DEFAULT_MAX_STEPS } from "./config.ts";
import type { AgentRuntimeHost } from "./agent.ts";
import { createAgentRuntime } from "./agent.ts";
import type { SessionStoreExtended } from "./session.ts";
import { createSessionStore } from "./session.ts";
import { createProviderRegistry } from "../provider/index.ts";
import { createPermissionManager } from "../permission/index.ts";
import { createMcpManager } from "../mcp/index.ts";
import type { McpManager } from "../mcp/index.ts";
import { createPluginRegistry, createSkillRegistry, createSkillTool } from "../skill/index.ts";
import { createToolRegistry } from "../tool/index.ts";
import { createLogger, type Logger } from "../util/log.ts";
import { resolve } from "node:path";

export interface KortivRuntime {
  config: ResolvedConfig;
  events: EventBus;
  providers: ProviderRegistry;
  sessions: SessionStoreExtended;
  permissions: PermissionManager;
  skills: SkillRegistry;
  plugins: PluginRegistry;
  mcp: McpManager;
  agents: AgentRuntimeHost;
  logger: Logger;
  /** Base registry, before per-agent tool filtering. */
  baseTools: ToolRegistry;
  /** Disconnects MCP servers and flushes state. */
  close(): Promise<void>;
}

export interface CreateRuntimeOptions {
  cwd?: string;
  /** CLI flag overrides, highest priority. */
  overrides?: KortivConfig;
  /** Interactive permission asker. When omitted, `ask` rules are denied. */
  asker?: PermissionAsker;
  /** `--yolo`: allow everything without asking. */
  autoApprove?: boolean;
  logger?: Logger;
  /** Skip MCP connect (used by tests and `--no-mcp`). */
  skipMcp?: boolean;
  /** Skip `.env` loading (tests manage their own environment). */
  skipEnv?: boolean;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

/**
 * Builds the whole object graph once and hands it to a frontend (TUI or
 * headless). Frontends never construct providers, tools or stores directly.
 */
export async function createKortivRuntime(
  options: CreateRuntimeOptions = {},
): Promise<KortivRuntime> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const config = await loadConfig({
    cwd,
    overrides: options.overrides,
    skipEnv: options.skipEnv,
  });
  const logger = options.logger ?? createLogger();
  const events = createEventBus((error) => logger.warn("event listener threw", error));

  const providers = await createProviderRegistry({
    config,
    logger: logger.child("provider"),
    fetchImpl: options.fetchImpl,
  });
  const sessions = createSessionStore({ logger: logger.child("session") });

  const permissions = createPermissionManager({
    rules: config.permissions ?? [],
    asker: options.asker,
    autoApprove: options.autoApprove,
    onResolved: (request, decision) => {
      events.emit({
        type: "permission.resolved",
        sessionId: request.sessionId,
        request,
        decision,
      });
    },
  });

  const skills = createSkillRegistry({ cwd, config, logger: logger.child("skill") });
  const plugins: PluginRegistry = await createPluginRegistry({
    cwd,
    config,
    logger: logger.child("plugin"),
  });

  const mcp = createMcpManager({
    config,
    logger: logger.child("mcp"),
    askBeforeCall: async (server, tool) => {
      if (config.mcp?.[server]?.trusted) return true;
      const decision = await permissions.check({
        sessionId: "mcp",
        tool: `mcp:${server}`,
        title: `Call MCP tool ${tool} on "${server}"`,
        detail: `${server}/${tool}`,
        risk: "medium",
      });
      return decision !== "deny";
    },
  });

  if (!options.skipMcp) {
    try {
      await mcp.connectAll();
    } catch (error) {
      logger.warn("MCP startup failed; continuing without MCP tools", error);
    }
  }

  const extraTools = (): ToolDef[] => [...mcp.tools(), createSkillTool(skills)];

  const baseTools = createToolRegistry({
    cwd,
    config,
    logger: logger.child("tool"),
    extraTools: extraTools(),
  });

  /** Collects the tool names an agent disabled via `tools: { name: false }`. */
  const disabledFor = (tools: Record<string, boolean> | undefined): string[] =>
    Object.entries(tools ?? {})
      .filter(([, enabled]) => enabled === false)
      .map(([name]) => name);

  let subagentDepth = 0;

  const agents = createAgentRuntime({
    config,
    providers,
    sessions,
    events,
    permissions,
    logger: logger.child("agent"),
    skills,
    plugins,
    createTools: ({ agent, session }) =>
      createToolRegistry({
        cwd: session.cwd,
        config,
        logger: logger.child("tool"),
        extraTools: extraTools(),
        disabled: disabledFor(agent.tools),
      }),
    runSubagent: async ({ agent, prompt, sessionId, signal }) => {
      if (subagentDepth >= 3) {
        return "Refused: subagents cannot nest more than three levels deep.";
      }
      const definition = agents.getAgent(agent) ?? agents.getAgent("general");
      if (!definition) return `Unknown subagent "${agent}".`;
      const parent = await sessions.get(sessionId);
      const childModel =
        definition.model ?? parent?.model ?? (config.model ? providers.resolveModel(config.model) : undefined);
      if (!childModel) {
        return "Refused: no model is configured for the subagent.";
      }
      const child = await sessions.create({
        title: `↳ ${agent}`,
        cwd: parent?.cwd ?? config.cwd,
        agent: definition.name,
        model: childModel,
        parentId: sessionId,
        tags: ["subagent"],
      });
      subagentDepth += 1;
      try {
        const result = await agents.run({
          sessionId: child.id,
          prompt,
          agent: definition.name,
          signal,
        });
        return (
          result.parts
            .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
            .map((part) => part.text)
            .join("")
            .trim() || "Subagent produced no output."
        );
      } finally {
        subagentDepth -= 1;
      }
    },
  });

  logger.info("runtime ready", {
    cwd,
    configSources: config.sources,
    maxSteps: config.maxSteps ?? DEFAULT_MAX_STEPS,
  });

  return {
    config,
    events,
    providers,
    sessions,
    permissions,
    skills,
    plugins,
    mcp,
    agents,
    logger,
    baseTools,
    async close() {
      try {
        await mcp.closeAll();
      } catch (error) {
        logger.warn("failed to close MCP servers", error);
      }
    },
  };
}
