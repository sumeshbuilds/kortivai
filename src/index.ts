/**
 * KortivAI — public library surface.
 *
 * Embed the agent in another tool:
 *
 * ```ts
 * import { createKortivRuntime } from "kortivai";
 *
 * const runtime = await createKortivRuntime({ cwd: process.cwd() });
 * const session = await runtime.agents.createSession();
 * runtime.events.subscribe((event) => {
 *   if (event.type === "part.update" && event.part.type === "text") {
 *     process.stdout.write(event.part.text);
 *   }
 * });
 * await runtime.agents.run({ sessionId: session.id, prompt: "Explain this repo" });
 * await runtime.close();
 * ```
 */

export { createKortivRuntime } from "./core/wiring.ts";
export type { KortivRuntime, CreateRuntimeOptions } from "./core/wiring.ts";

export { createAgentRuntime, toModelMessages, pruneHistory, accumulateUsage } from "./core/agent.ts";
export type { AgentRuntimeHost, AgentRuntimeOptions, CreateToolsInput } from "./core/agent.ts";

export { createEventBus } from "./core/events.ts";
export { createSessionStore, deriveTitle } from "./core/session.ts";
export type { SessionStoreExtended, SessionStoreOptions } from "./core/session.ts";

export {
  loadConfig,
  readConfigFile,
  mergeConfig,
  configCandidates,
  loadProjectEnv,
  stripJsonComments,
  configSchema,
  DEFAULT_MAX_STEPS,
  DEFAULT_TEMPERATURE,
} from "./core/config.ts";

export {
  BASE_SYSTEM_PROMPT,
  BRAND,
  composeSystemPrompt,
  loadAgentInstructions,
  detectGit,
  renderInstructions,
  renderSkills,
} from "./core/prompt.ts";
export type { LoadedInstruction, PromptEnvironment } from "./core/prompt.ts";

export { createToolRegistry, builtinTools } from "./tool/index.ts";
export { createPermissionManager, createPromptAsker } from "./permission/index.ts";
export type { PermissionManagerOptions } from "./permission/index.ts";

export { createProviderRegistry, builtinProviderInfos, readAuth, writeAuth } from "./provider/index.ts";
export type { AuthStore, AuthEntry, ProviderRegistryOptions } from "./provider/index.ts";

export { createMcpManager, connectMcpServer } from "./mcp/index.ts";
export type { McpManager, McpServerStatus, McpManagerOptions } from "./mcp/index.ts";

export { createSkillRegistry, createSkillTool, createPluginRegistry, parseSkillFile } from "./skill/index.ts";

export { createLogger, nullLogger, redact } from "./util/log.ts";
export type { Logger, LogLevel } from "./util/log.ts";

export {
  KortivError,
  ConfigError,
  AuthError,
  ProviderError,
  ToolError,
  AbortedError,
  isAbortError,
  errorMessage,
} from "./util/errors.ts";

export { matchGlob, matchAny, globToRegExp } from "./util/glob.ts";

export type {
  AgentDefinition,
  AgentEvent,
  AgentInfo,
  AgentRuntime,
  ChatRequest,
  EventBus,
  FinishReason,
  KortivConfig,
  McpClient,
  McpServerConfig,
  Message,
  ModelInfo,
  ModelMessage,
  ModelRef,
  Part,
  PermissionDecision,
  PermissionManager,
  PermissionRequest,
  PermissionRule,
  Plugin,
  PluginHooks,
  PluginRegistry,
  Provider,
  ProviderInfo,
  ProviderRegistry,
  ResolvedConfig,
  Session,
  SessionId,
  SessionStore,
  SkillInfo,
  SkillRegistry,
  StreamEvent,
  ToolContext,
  ToolDef,
  ToolOutcome,
  ToolRegistry,
  ToolSchema,
  Usage,
} from "./core/types.ts";
