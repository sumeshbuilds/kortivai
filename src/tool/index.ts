/**
 * Tool layer entry point.
 *
 * OWNER: tools teammate. The exported signatures below are FROZEN — the agent
 * runtime and CLI depend on them.
 */
import type { ResolvedConfig, ToolDef, ToolRegistry } from "../core/types.ts";
import type { Logger } from "../util/log.ts";

export interface ToolRegistryOptions {
  cwd: string;
  config: ResolvedConfig;
  logger?: Logger;
  /** Injected by the runtime: MCP-backed and skill-backed tools. */
  extraTools?: ToolDef[];
  /** Tool names disabled by the active agent or config. */
  disabled?: string[];
}

export function createToolRegistry(_options: ToolRegistryOptions): ToolRegistry {
  throw new Error("createToolRegistry is not implemented yet");
}

/** Every built-in tool, for docs and tests. */
export function builtinTools(): ToolDef[] {
  return [];
}
