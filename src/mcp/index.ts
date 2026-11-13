/**
 * MCP (Model Context Protocol) client layer.
 *
 * OWNER: session/mcp teammate. The exported signatures below are FROZEN.
 */
import type { McpClient, ResolvedConfig, ToolDef } from "../core/types.ts";
import type { Logger } from "../util/log.ts";

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

export function createMcpManager(_options: McpManagerOptions): McpManager {
  throw new Error("createMcpManager is not implemented yet");
}

/** Exposed for tests: connects a single server config without a manager. */
export async function connectMcpServer(
  _name: string,
  _config: unknown,
  _logger?: Logger,
): Promise<McpClient> {
  throw new Error("connectMcpServer is not implemented yet");
}
