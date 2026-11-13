/**
 * KortivAI — frozen cross-module contracts.
 *
 * This file is the single source of truth for every module boundary. It is
 * owned by the Lead and is intentionally dependency-free (types only) so that
 * providers, tools, the agent runtime, MCP/skills and the UI can all be built
 * in parallel against a stable surface.
 *
 * Do not add runtime code here. Do not import anything but `node:*` types.
 */

/* ------------------------------------------------------------------ *
 * Identifiers and basic primitives
 * ------------------------------------------------------------------ */

export type SessionId = string;
export type MessageId = string;
export type PartId = string;
export type CallId = string;

/** `provider/model`, e.g. `deepseek/deepseek-chat`. */
export type ModelKey = string;

export interface ModelRef {
  provider: string;
  model: string;
}

export interface Usage {
  input: number;
  output: number;
  reasoning?: number;
  cacheRead?: number;
  cacheWrite?: number;
  /** USD, derived from the model catalog. 0 when unknown. */
  cost?: number;
}

export type FinishReason =
  | "stop"
  | "length"
  | "tool-calls"
  | "content-filter"
  | "error"
  | "aborted"
  | "unknown";

/* ------------------------------------------------------------------ *
 * Message / part model (opencode-style: a message is a list of parts)
 * ------------------------------------------------------------------ */

export interface TextPart {
  type: "text";
  id: PartId;
  text: string;
  /** Set for user-authored text coming from a file/@-mention. */
  synthetic?: boolean;
}

export interface ReasoningPart {
  type: "reasoning";
  id: PartId;
  text: string;
}

export type ToolStatus = "pending" | "running" | "completed" | "error" | "denied";

export interface ToolPart {
  type: "tool";
  id: PartId;
  callId: CallId;
  name: string;
  input: unknown;
  /** One-line human summary supplied by the tool (e.g. the file path). */
  title?: string;
  metadata?: Record<string, unknown>;
  status: ToolStatus;
  output?: string;
  error?: string;
  startedAt?: number;
  endedAt?: number;
}

export interface StepPart {
  type: "step";
  id: PartId;
  finishReason: FinishReason;
  usage?: Usage;
  model?: ModelRef;
}

export type Part = TextPart | ReasoningPart | ToolPart | StepPart;

export type MessageRole = "user" | "assistant";

export interface Message {
  id: MessageId;
  sessionId: SessionId;
  role: MessageRole;
  parts: Part[];
  createdAt: number;
  /** Set on assistant messages. */
  model?: ModelRef;
  /** Set when the turn ended in a provider/agent failure. */
  error?: string;
  /** Set for messages produced by a subagent, pointing at the parent call. */
  parentCallId?: CallId;
  agent?: string;
}

/* ------------------------------------------------------------------ *
 * Provider layer
 * ------------------------------------------------------------------ */

export interface ModelCost {
  /** USD per 1M input tokens. */
  input: number;
  /** USD per 1M output tokens. */
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface ModelInfo {
  id: string;
  name: string;
  contextWindow: number;
  maxOutput: number;
  supportsTools: boolean;
  supportsReasoning: boolean;
  supportsImages?: boolean;
  cost?: ModelCost;
}

export interface ProviderInfo {
  id: string;
  name: string;
  /** Env vars consulted, in order, for credentials. */
  env: string[];
  /** Base URL default; overridable in config as `providers.<id>.baseURL`. */
  baseURL?: string;
  /** True for local servers that need no credential (ollama, lmstudio). */
  keyless?: boolean;
  models: ModelInfo[];
}

/** Normalized content sent to a provider. */
export type ModelContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mime: string }
  | { type: "tool-call"; callId: CallId; name: string; input: unknown };

export interface ModelToolResult {
  callId: CallId;
  name: string;
  content: string;
  isError: boolean;
}

export type ModelMessage =
  | { role: "user" | "assistant"; content: ModelContent[] }
  | { role: "tool"; results: ModelToolResult[] };

export interface ToolSchema {
  name: string;
  description: string;
  /** JSON Schema (object root) describing the tool input. */
  parameters: Record<string, unknown>;
}

export interface ChatRequest {
  model: ModelRef;
  system: string;
  messages: ModelMessage[];
  tools: ToolSchema[];
  temperature?: number;
  maxTokens?: number;
  /** Called on every incremental token so the UI can show progress. */
  onEvent: (event: StreamEvent) => void;
  signal: AbortSignal;
}

export type StreamEvent =
  | { type: "text-delta"; text: string }
  | { type: "reasoning-delta"; text: string }
  | { type: "tool-call"; callId: CallId; name: string; input: unknown }
  | { type: "usage"; usage: Usage }
  | { type: "finish"; reason: FinishReason }
  | { type: "error"; error: string; retryable: boolean };

export interface Provider {
  info: ProviderInfo;
  /** Throws {@link ProviderError} on transport/auth failure. */
  chat(request: ChatRequest): Promise<void>;
}

export interface ProviderRegistry {
  list(): ProviderInfo[];
  get(id: string): Provider | undefined;
  /** Resolves the effective model catalog after config overrides. */
  models(providerId: string): ModelInfo[];
  /** Resolves `provider/model` (or a bare model id) to a concrete ref. */
  resolveModel(key: string): ModelRef | undefined;
  /** True when a usable credential exists (env or auth store). */
  hasCredential(providerId: string): Promise<boolean>;
  /** Providers with at least one usable credential. */
  available(): Promise<ProviderInfo[]>;
}

/* ------------------------------------------------------------------ *
 * Permission layer
 * ------------------------------------------------------------------ */

export type PermissionAction = "allow" | "deny" | "ask";
export type PermissionDecision = "allow" | "allow-always" | "deny";

export interface PermissionRequest {
  sessionId: SessionId;
  tool: string;
  /** Short imperative question, e.g. `Run shell command`. */
  title: string;
  /** Concrete subject: the command, the absolute path, the URL. */
  detail: string;
  risk: "low" | "medium" | "high";
  /** Extra context lines shown under the detail. */
  preview?: string;
}

export interface PermissionRule {
  tool: string;
  /** Glob matched against the request detail (path or command). */
  pattern?: string;
  action: PermissionAction;
}

export interface PermissionManager {
  /** Resolves a request to a decision, consulting rules then the asker. */
  check(request: PermissionRequest): Promise<PermissionDecision>;
  /** Records a session/global "always" answer. */
  remember(request: PermissionRequest, scope: "session" | "project"): void;
  /** Current effective rules (config + learned). */
  rules(): PermissionRule[];
  /**
   * Layers extra higher-priority rules on top, sharing the asker and any
   * learned answers. Used for per-agent policy (e.g. the read-only `plan`
   * agent) without mutating global state.
   */
  scope(rules: PermissionRule[]): PermissionManager;
}

export interface PermissionAsker {
  ask(request: PermissionRequest): Promise<PermissionDecision>;
}

/* ------------------------------------------------------------------ *
 * Tool layer
 * ------------------------------------------------------------------ */

export interface ToolOutcome {
  /** One-line label for the transcript, e.g. `src/core/agent.ts`. */
  title?: string;
  output: string;
  metadata?: Record<string, unknown>;
  isError?: boolean;
}

export interface SubagentRequest {
  agent: string;
  prompt: string;
  description?: string;
  sessionId: SessionId;
  signal: AbortSignal;
}

export interface ToolContext {
  sessionId: SessionId;
  /** Working directory the tool must respect. */
  cwd: string;
  signal: AbortSignal;
  /** Permission gate — every side-effecting tool must call this first. */
  permission: PermissionManager;
  /** Streams partial metadata to the UI (e.g. lines written so far). */
  progress(metadata: Record<string, unknown>): void;
  /** Invokes a subagent; only available to the `task` tool. */
  subagent?(request: SubagentRequest): Promise<string>;
  /** Appends to the session log. */
  log(level: "debug" | "info" | "warn" | "error", message: string): void;
}

export interface ToolDef<Input = Record<string, unknown>> {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /** Read-only tools never need permission and may run in plan mode. */
  readOnly?: boolean;
  /** Side-effecting tools are blocked in plan mode. */
  destructive?: boolean;
  /** Tools the model may call; hidden tools exist for internal use. */
  hidden?: boolean;
  execute(input: Input, ctx: ToolContext): Promise<ToolOutcome>;
}

export interface ToolRegistry {
  all(): ToolDef[];
  /** Visible to the model, minus anything disabled by agent/config. */
  enabled(): ToolDef[];
  get(name: string): ToolDef | undefined;
  schemas(): ToolSchema[];
  /** Executes by name, applying permission checks and normalizing results. */
  execute(name: string, input: unknown, ctx: ToolContext): Promise<ToolOutcome>;
}

/* ------------------------------------------------------------------ *
 * Agent / runtime layer
 * ------------------------------------------------------------------ */

export type AgentName = string;

export interface AgentInfo {
  name: AgentName;
  description: string;
  /** `primary` shows in the TUI switcher; `subagent` is task-only. */
  mode: "primary" | "subagent";
  model?: ModelRef;
  temperature?: number;
  maxSteps?: number;
  /** Extra system prompt appended after the base prompt and AGENTS.md. */
  prompt?: string;
  tools?: Record<string, boolean>;
  permissions?: PermissionRule[];
  /** Built-in agents cannot be deleted by config. */
  builtin?: boolean;
}

export interface AgentDefinition extends AgentInfo {
  /** Fully composed system prompt for this agent. */
  systemPrompt: string;
}

export interface RunInput {
  sessionId: SessionId;
  /** Plain text prompt, already expanded for file mentions. */
  prompt: string;
  agent?: AgentName;
  model?: ModelRef;
  signal?: AbortSignal;
}

export interface AgentRuntime {
  readonly agent: AgentInfo;
  /** Runs one full turn (possibly many provider round-trips). */
  run(input: RunInput): Promise<Message>;
  /** Aborts an in-flight turn for a session. */
  abort(sessionId: SessionId): void;
  isBusy(sessionId: SessionId): boolean;
}

/* ------------------------------------------------------------------ *
 * Sessions
 * ------------------------------------------------------------------ */

export interface Session {
  id: SessionId;
  title: string;
  cwd: string;
  agent: AgentName;
  model: ModelRef;
  parentId?: SessionId;
  createdAt: number;
  updatedAt: number;
  usage?: Usage;
  /** Free-form tags; `subagent` sessions are hidden from the session list. */
  tags?: string[];
}

export interface SessionStore {
  create(init: Omit<Session, "id" | "createdAt" | "updatedAt">): Promise<Session>;
  get(id: SessionId): Promise<Session | undefined>;
  list(): Promise<Session[]>;
  save(session: Session): Promise<void>;
  delete(id: SessionId): Promise<void>;
  /** Messages are appended in order; the id is generated if omitted. */
  append(sessionId: SessionId, message: Message): Promise<Message>;
  messages(sessionId: SessionId): Promise<Message[]>;
  /** Rewrites one message in place (used for streaming part updates). */
  update(sessionId: SessionId, message: Message): Promise<void>;
}

/* ------------------------------------------------------------------ *
 * MCP
 * ------------------------------------------------------------------ */

export interface McpServerConfig {
  type?: "local" | "remote";
  /** Command for local stdio servers. */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** URL for remote servers. */
  url?: string;
  headers?: Record<string, string>;
  enabled?: boolean;
  /** `true` trusts the server, skipping per-call permission prompts. */
  trusted?: boolean;
}

export interface McpToolInfo {
  server: string;
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface McpClient {
  readonly server: string;
  connect(): Promise<void>;
  listTools(): Promise<McpToolInfo[]>;
  callTool(name: string, args: unknown): Promise<ToolOutcome>;
  close(): Promise<void>;
  readonly status: "disconnected" | "connecting" | "connected" | "error";
  readonly error?: string;
}

/* ------------------------------------------------------------------ *
 * Skills and plugins
 * ------------------------------------------------------------------ */

export interface SkillInfo {
  name: string;
  description: string;
  /** Absolute path to SKILL.md. */
  path: string;
  /** Directory containing the skill's bundled resources. */
  dir: string;
  /** Body of SKILL.md after the frontmatter, used when the skill is loaded. */
  instructions: string;
  /** Optional frontmatter metadata (allowed-tools, etc.). */
  metadata?: Record<string, unknown>;
}

export interface SkillRegistry {
  list(): SkillInfo[];
  get(name: string): SkillInfo | undefined;
  /** Rescans the configured skill directories. */
  reload(): Promise<void>;
}

export type PluginHook =
  | "chat.params"
  | "chat.message"
  | "tool.before"
  | "tool.after"
  | "permission.ask";

export interface PluginContext {
  cwd: string;
  config: KortivConfig;
  log(level: "debug" | "info" | "warn" | "error", message: string): void;
}

export type Plugin = (ctx: PluginContext) => PluginHooks | void;

export interface PluginHooks {
  "chat.params"?: (input: ChatParamsHook) => void | Promise<void>;
  "chat.message"?: (input: ChatMessageHook) => void | Promise<void>;
  "tool.before"?: (input: ToolBeforeHook) => void | Promise<void>;
  "tool.after"?: (input: ToolAfterHook) => void | Promise<void>;
  "permission.ask"?: (input: PermissionHook) => void | Promise<void>;
}

export interface ChatParamsHook {
  model: ModelRef;
  temperature?: number;
  maxTokens?: number;
  system: string;
}

export interface ChatMessageHook {
  sessionId: SessionId;
  message: Message;
}

export interface ToolBeforeHook {
  sessionId: SessionId;
  tool: string;
  input: unknown;
  /** Set to false to veto the call. */
  allowed: boolean;
}

export interface ToolAfterHook {
  sessionId: SessionId;
  tool: string;
  input: unknown;
  outcome: ToolOutcome;
}

export interface PermissionHook {
  request: PermissionRequest;
  decision: PermissionDecision;
}

export interface PluginRegistry {
  hooks(): PluginHooks[];
  register(plugin: Plugin): Promise<void>;
}

/* ------------------------------------------------------------------ *
 * Configuration
 * ------------------------------------------------------------------ */

export interface ProviderConfig {
  /** Overrides the built-in base URL. */
  baseURL?: string;
  /** Literal key; prefer `apiKeyEnv` so secrets stay out of the file. */
  apiKey?: string;
  apiKeyEnv?: string;
  /** Extra headers, e.g. for gateways. */
  headers?: Record<string, string>;
  /** Extra models to merge into the catalog. */
  models?: Record<string, Partial<ModelInfo>>;
  /** Mark as keyless local server. */
  keyless?: boolean;
}

export interface UiConfig {
  theme?: "kortiv" | "mono" | "auto";
  showReasoning?: boolean;
  showTokenUsage?: boolean;
  /** Render assistant output as markdown (default true). */
  markdown?: boolean;
  animations?: boolean;
}

export interface SubagentConfig {
  description?: string;
  model?: string;
  temperature?: number;
  maxSteps?: number;
  prompt?: string;
  tools?: Record<string, boolean>;
}

export interface AgentConfig {
  description?: string;
  mode?: "primary" | "subagent";
  model?: string;
  temperature?: number;
  maxSteps?: number;
  prompt?: string;
  tools?: Record<string, boolean>;
  permissions?: PermissionRule[];
}

export interface KortivConfig {
  $schema?: string;
  /** Default model as `provider/model`. */
  model?: string;
  /** Cheaper model used for title generation and similar chores. */
  smallModel?: string;
  temperature?: number;
  /** Max provider round-trips per turn. */
  maxSteps?: number;
  /** Replaces the built-in base system prompt when set. */
  systemPrompt?: string;
  /** Extra instruction files, relative to the project root. */
  instructions?: string[];
  /** Disable AGENTS.md discovery entirely. */
  disableAgentsMd?: boolean;
  permissions?: PermissionRule[];
  providers?: Record<string, ProviderConfig>;
  mcp?: Record<string, McpServerConfig>;
  skills?: { paths?: string[]; disabled?: boolean };
  plugins?: string[];
  agents?: Record<string, AgentConfig>;
  subagents?: Record<string, SubagentConfig>;
  ui?: UiConfig;
  /** Extra directories searched for skills and AGENTS.md, in order. */
  assetPaths?: string[];
}

/** Config after loading + merging, with every default resolved. */
export interface ResolvedConfig extends KortivConfig {
  cwd: string;
  /** Where the top-priority config file was found, if any. */
  source?: string;
  /** Merged config files from lowest to highest priority. */
  sources: string[];
}

/* ------------------------------------------------------------------ *
 * Events
 * ------------------------------------------------------------------ */

export type AgentEvent =
  | { type: "session.start"; sessionId: SessionId; session: Session }
  | { type: "session.end"; sessionId: SessionId; reason: "done" | "aborted" | "error" }
  | { type: "message.start"; sessionId: SessionId; messageId: MessageId; role: MessageRole }
  | { type: "part.update"; sessionId: SessionId; messageId: MessageId; part: Part }
  | { type: "message.end"; sessionId: SessionId; messageId: MessageId; message: Message }
  | { type: "status"; sessionId: SessionId; status: "idle" | "busy" | "retrying"; detail?: string }
  | { type: "permission.asked"; sessionId: SessionId; request: PermissionRequest }
  | { type: "permission.resolved"; sessionId: SessionId; request: PermissionRequest; decision: PermissionDecision }
  | { type: "agent.error"; sessionId: SessionId; error: string };

export type Unsubscribe = () => void;

export interface EventBus {
  emit(event: AgentEvent): void;
  subscribe(listener: (event: AgentEvent) => void): Unsubscribe;
}

/* ------------------------------------------------------------------ *
 * Errors
 * ------------------------------------------------------------------ */

export interface KortivErrorShape {
  name: string;
  message: string;
  /** Actionable next step shown to the user. */
  hint?: string;
  retryable?: boolean;
  cause?: unknown;
}
