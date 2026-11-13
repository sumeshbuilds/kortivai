/**
 * MCP (Model Context Protocol) client layer.
 *
 * OWNER: session/mcp teammate. The exported signatures below are FROZEN.
 *
 * Every entry point degrades gracefully: an unreachable server, a bad config
 * or a failing handshake is recorded as `status: "error"` and never prevents
 * the agent from starting.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type {
  McpClient,
  McpServerConfig,
  McpToolInfo,
  ResolvedConfig,
  ToolDef,
  ToolOutcome,
} from "../core/types.ts";
import { errorMessage } from "../util/errors.ts";
import type { Logger } from "../util/log.ts";
import { nullLogger } from "../util/log.ts";

export interface McpManagerOptions {
  config: ResolvedConfig;
  logger?: Logger;
  /** Per-call permission prompt; `trusted` servers skip it. */
  askBeforeCall?: (server: string, tool: string, args: unknown) => Promise<boolean>;
}

export interface McpServerStatus {
  server: string;
  status: McpClient["status"];
  error?: string;
  toolCount: number;
}

export interface McpManager {
  connectAll(): Promise<void>;
  closeAll(): Promise<void>;
  reload(): Promise<void>;
  /** Tools bridged into the agent's tool registry, named `<server>_<tool>`. */
  tools(): ToolDef[];
  status(): McpServerStatus[];
}

type AnyTransport = StdioClientTransport | StreamableHTTPClientTransport;

const CONNECT_TIMEOUT_MS = 15_000;
const REQUEST_TIMEOUT_MS = 60_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** MCP tool names must be safe for the model and for log lines. */
function sanitizeToolName(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9_-]/g, "_");
  return cleaned || "tool";
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * Joins text content; images/resources become short placeholders so a large
 * blob never lands in the transcript.
 */
function normalizeToolResult(result: unknown): ToolOutcome {
  if (!isRecord(result)) return { output: stringify(result), isError: false };
  const isError = result.isError === true;

  if (Array.isArray(result.content)) {
    const lines: string[] = [];
    for (const item of result.content) {
      if (!isRecord(item)) continue;
      const type = typeof item.type === "string" ? item.type : "unknown";
      switch (type) {
        case "text":
          lines.push(typeof item.text === "string" ? item.text : stringify(item.text));
          break;
        case "image":
          lines.push(`[image ${typeof item.mimeType === "string" ? item.mimeType : "image"}]`);
          break;
        case "audio":
          lines.push(`[audio ${typeof item.mimeType === "string" ? item.mimeType : "audio"}]`);
          break;
        case "resource":
        case "resource_link": {
          const nested = isRecord(item.resource) ? item.resource : undefined;
          const uri =
            typeof item.uri === "string"
              ? item.uri
              : nested && typeof nested.uri === "string"
                ? nested.uri
                : undefined;
          lines.push(`[resource ${uri ?? "embedded"}]`);
          break;
        }
        default:
          lines.push(`[${type} content]`);
          break;
      }
    }
    if (lines.length > 0) return { output: lines.join("\n"), isError };
    if (result.structuredContent !== undefined) {
      return { output: stringify(result.structuredContent), isError };
    }
    return { output: "", isError };
  }

  if (result.toolResult !== undefined) return { output: stringify(result.toolResult), isError };
  return { output: stringify(result), isError };
}

interface ClientShell {
  client: McpClient;
  /** Wires the SDK client and transport before a connection attempt. */
  setSdk(sdk: Client | undefined, transport: AnyTransport | undefined): void;
  /** Forces the terminal error state without attempting a connection. */
  fail(message: string): void;
}

function createClientShell(name: string): ClientShell {
  let sdk: Client | undefined;
  let transport: AnyTransport | undefined;
  let status: McpClient["status"] = "disconnected";
  let error: string | undefined;

  const client: McpClient = {
    server: name,

    get status() {
      return status;
    },

    get error() {
      return error;
    },

    async connect() {
      if (status === "connected") return;
      if (!sdk || !transport) {
        status = "error";
        error ??= "MCP client is not configured";
        return;
      }
      status = "connecting";
      error = undefined;
      try {
        await sdk.connect(transport, { timeout: CONNECT_TIMEOUT_MS });
        status = "connected";
      } catch (cause) {
        error = errorMessage(cause);
        status = "error";
        try {
          await sdk.close();
        } catch {
          // The transport may already be gone; the error state stands.
        }
      }
    },

    async listTools() {
      if (status !== "connected" || !sdk) return [];
      try {
        const result = await sdk.listTools(undefined, { timeout: REQUEST_TIMEOUT_MS });
        return (result.tools ?? []).map((tool) => ({
          server: name,
          name: tool.name,
          description: tool.description ?? "",
          parameters: (tool.inputSchema ?? { type: "object", properties: {} }) as Record<
            string,
            unknown
          >,
        }));
      } catch (cause) {
        error = errorMessage(cause);
        status = "error";
        return [];
      }
    },

    async callTool(toolName, args) {
      if (status !== "connected" || !sdk) {
        const detail = error ? `: ${error}` : "";
        return { output: `MCP server "${name}" is not connected${detail}`, isError: true };
      }
      try {
        const result = await sdk.callTool(
          { name: toolName, arguments: isRecord(args) ? args : {} },
          undefined,
          { timeout: REQUEST_TIMEOUT_MS },
        );
        return normalizeToolResult(result);
      } catch (cause) {
        return {
          output: `MCP call "${toolName}" on "${name}" failed: ${errorMessage(cause)}`,
          isError: true,
        };
      }
    },

    async close() {
      const current = sdk;
      sdk = undefined;
      transport = undefined;
      status = "disconnected";
      error = undefined;
      try {
        await current?.close();
      } catch {
        // Closing is best-effort and must be safe to repeat.
      }
    },
  };

  return {
    client,
    setSdk(nextSdk, nextTransport) {
      sdk = nextSdk;
      transport = nextTransport;
    },
    fail(message) {
      error = message;
      status = "error";
    },
  };
}

/**
 * Exposed for tests: connects a single server config without a manager.
 *
 * Never rejects on a connection failure — the returned client reports
 * `status: "error"` with `error` set instead, so startup can continue.
 */
export async function connectMcpServer(
  name: string,
  config: unknown,
  logger: Logger = nullLogger,
): Promise<McpClient> {
  const shell = createClientShell(name);
  const settings = (config ?? {}) as McpServerConfig;
  const kind = settings.type ?? (settings.url ? "remote" : "local");

  if (kind === "remote") {
    if (!settings.url) {
      shell.fail("remote MCP server is missing `url`");
      logger.warn(`MCP server "${name}" has no url`);
      return shell.client;
    }
    try {
      const transport = new StreamableHTTPClientTransport(new URL(settings.url), {
        requestInit: settings.headers ? { headers: settings.headers } : undefined,
      });
      shell.setSdk(new Client({ name: `kortivai:${name}`, version: "0.1.0" }), transport);
    } catch (cause) {
      shell.fail(`invalid MCP url "${settings.url}": ${errorMessage(cause)}`);
      logger.warn(`MCP server "${name}" has an invalid url`, cause);
      return shell.client;
    }
  } else {
    if (!settings.command) {
      shell.fail("local MCP server is missing `command`");
      logger.warn(`MCP server "${name}" has no command`);
      return shell.client;
    }
    try {
      const transport = new StdioClientTransport({
        command: settings.command,
        args: settings.args ?? [],
        env: settings.env ? { ...getDefaultEnvironment(), ...settings.env } : undefined,
        stderr: "ignore",
      });
      shell.setSdk(new Client({ name: `kortivai:${name}`, version: "0.1.0" }), transport);
    } catch (cause) {
      shell.fail(`could not start MCP server "${name}": ${errorMessage(cause)}`);
      logger.warn(`MCP server "${name}" could not be started`, cause);
      return shell.client;
    }
  }

  await shell.client.connect();
  if (shell.client.status === "connected") {
    logger.debug(`MCP server "${name}" connected`);
  } else {
    logger.warn(`MCP server "${name}" unavailable`, shell.client.error);
  }
  return shell.client;
}

interface ManagedServer {
  config: McpServerConfig;
  client: McpClient;
  tools: McpToolInfo[];
}

export function createMcpManager(options: McpManagerOptions): McpManager {
  const logger = options.logger ?? nullLogger;
  const servers = new Map<string, ManagedServer>();

  async function connectOne(name: string, config: McpServerConfig): Promise<void> {
    let client: McpClient;
    try {
      client = await connectMcpServer(name, config, logger.child(name));
    } catch (cause) {
      // connectMcpServer degrades internally; this guards against the
      // unexpected so one bad server can never abort startup.
      logger.warn(`MCP server "${name}" failed to connect`, cause);
      const shell = createClientShell(name);
      shell.fail(errorMessage(cause));
      client = shell.client;
    }

    let tools: McpToolInfo[] = [];
    if (client.status === "connected") {
      try {
        tools = await client.listTools();
      } catch (cause) {
        logger.warn(`failed to list tools for MCP server "${name}"`, cause);
        tools = [];
      }
    } else {
      logger.warn(`MCP server "${name}" is unavailable; skipping`, client.error);
    }

    servers.set(name, { config, client, tools });
  }

  async function disconnectAll(): Promise<void> {
    const current = [...servers.values()];
    servers.clear();
    for (const entry of current) {
      try {
        await entry.client.close();
      } catch (cause) {
        logger.warn(`failed to close MCP server "${entry.client.server}"`, cause);
      }
    }
  }

  const manager: McpManager = {
    async connectAll() {
      const configs = options.config.mcp ?? {};
      for (const [name, config] of Object.entries(configs)) {
        if (!config || config.enabled === false) continue;
        const existing = servers.get(name);
        if (existing?.client.status === "connected") continue;
        if (existing) {
          try {
            await existing.client.close();
          } catch {
            // Reconnecting replaces the entry anyway.
          }
        }
        await connectOne(name, config);
      }
    },

    async closeAll() {
      await disconnectAll();
    },

    async reload() {
      await disconnectAll();
      await manager.connectAll();
    },

    tools() {
      const out: ToolDef[] = [];
      for (const [server, entry] of servers) {
        if (entry.client.status !== "connected") continue;
        const trusted = entry.config.trusted === true;
        for (const tool of entry.tools) {
          out.push({
            name: `${sanitizeToolName(server)}_${sanitizeToolName(tool.name)}`,
            description:
              tool.description || `MCP tool "${tool.name}" provided by server "${server}".`,
            parameters: tool.parameters,
            readOnly: false,
            async execute(input) {
              if (!trusted && options.askBeforeCall) {
                const allowed = await options.askBeforeCall(server, tool.name, input);
                if (!allowed) {
                  return {
                    title: `${server}/${tool.name}`,
                    output: "Denied by the user.",
                    isError: true,
                  };
                }
              }
              const outcome = await entry.client.callTool(tool.name, input);
              return { title: `${server}/${tool.name}`, ...outcome };
            },
          });
        }
      }
      return out;
    },

    status() {
      return [...servers.entries()].map(([server, entry]) => ({
        server,
        status: entry.client.status,
        error: entry.client.error,
        toolCount: entry.client.status === "connected" ? entry.tools.length : 0,
      }));
    },
  };

  return manager;
}
