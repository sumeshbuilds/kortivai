/**
 * Skills and plugins.
 *
 * OWNER: session/mcp teammate. The exported signatures below are FROZEN.
 *
 * A *skill* is a `SKILL.md` file with YAML frontmatter (`name`,
 * `description`) plus optional bundled files. The agent sees only the name
 * and description until it loads the skill, keeping the prompt small.
 *
 * A *plugin* is a local ES module exporting `default` (or `plugin`) as a
 * {@link Plugin}. Plugins receive a context and may return lifecycle hooks.
 */
import type { Plugin, PluginRegistry, ResolvedConfig, SkillInfo, SkillRegistry, ToolDef } from "../core/types.ts";
import type { Logger } from "../util/log.ts";

export interface SkillRegistryOptions {
  cwd: string;
  config: ResolvedConfig;
  logger?: Logger;
}

export function createSkillRegistry(_options: SkillRegistryOptions): SkillRegistry {
  throw new Error("createSkillRegistry is not implemented yet");
}

/** Parses one SKILL.md; returns undefined when the file is not a valid skill. */
export function parseSkillFile(_path: string, _contents: string, _dir: string): SkillInfo | undefined {
  return undefined;
}

/** The `skill` tool, which loads a skill's full instructions on demand. */
export function createSkillTool(_registry: SkillRegistry): ToolDef {
  throw new Error("createSkillTool is not implemented yet");
}

export interface PluginRegistryOptions {
  cwd: string;
  config: ResolvedConfig;
  logger?: Logger;
}

export function createPluginRegistry(_options: PluginRegistryOptions): Promise<PluginRegistry> {
  throw new Error("createPluginRegistry is not implemented yet");
}

export type { Plugin, PluginRegistry, SkillInfo, SkillRegistry };
