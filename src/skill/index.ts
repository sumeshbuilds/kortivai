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
 *
 * Both layers are forgiving by design: a malformed skill is skipped and a
 * broken plugin is logged and skipped, never thrown out of startup.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type {
  Plugin,
  PluginContext,
  PluginHooks,
  PluginRegistry,
  ResolvedConfig,
  SkillInfo,
  SkillRegistry,
  ToolDef,
} from "../core/types.ts";
import type { Logger } from "../util/log.ts";
import { nullLogger } from "../util/log.ts";
import { APP_NAME } from "../util/paths.ts";

export interface SkillRegistryOptions {
  cwd: string;
  config: ResolvedConfig;
  logger?: Logger;
}

/* ------------------------------------------------------------------ *
 * Frontmatter parsing (tolerant YAML subset)
 * ------------------------------------------------------------------ */

interface Frontmatter {
  data: Record<string, unknown>;
  body: string;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function unquote(value: string): string {
  const text = value.trim();
  if (
    text.length > 1 &&
    ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'")))
  ) {
    return text.slice(1, -1);
  }
  return text;
}

function parseScalar(value: string): unknown {
  const text = value.trim();
  if (!text) return "";
  if (
    text.length > 1 &&
    ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'")))
  ) {
    return text.slice(1, -1);
  }
  if (text.startsWith("[") && text.endsWith("]")) {
    return text
      .slice(1, -1)
      .split(",")
      .map((entry) => parseScalar(entry))
      .filter((entry) => entry !== "");
  }
  if (text === "true") return true;
  if (text === "false") return false;
  return text;
}

function parseYamlBlock(raw: string): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  let container: { key: string; list: unknown[]; map: Record<string, unknown> } | undefined;

  const flush = () => {
    if (!container) return;
    data[container.key] = container.list.length > 0 ? container.list : container.map;
    container = undefined;
  };

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const top = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(line);
    if (top && !/^[ \t]/.test(line)) {
      flush();
      const key = top[1]!;
      const value = top[2]!.trim();
      if (value === "") container = { key, list: [], map: {} };
      else data[key] = parseScalar(value);
      continue;
    }

    if (!container) continue;
    const item = /^-\s*(.*)$/.exec(trimmed);
    if (item) {
      container.list.push(parseScalar(item[1]!));
      continue;
    }
    const nested = /^([^:]+):\s*(.*)$/.exec(trimmed);
    if (nested) container.map[nested[1]!.trim()] = parseScalar(nested[2]!.trim());
  }

  flush();
  return data;
}

function parseFrontmatter(contents: string): Frontmatter {
  const normalized = contents.replace(/^\uFEFF/, "");
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(normalized);
  if (!match) return { data: {}, body: normalized };
  return { data: parseYamlBlock(match[1] ?? ""), body: normalized.slice(match[0].length) };
}

function asText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

function firstHeading(body: string): string | undefined {
  return /^#{1,6}[ \t]+(.+?)[ \t]*$/m.exec(body)?.[1]?.trim() || undefined;
}

/** The first body paragraph, skipping headings and blank lines. */
function firstParagraph(body: string): string | undefined {
  const collected: string[] = [];
  let started = false;
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!started) {
      if (!trimmed || /^#{1,6}\s/.test(trimmed)) continue;
      started = true;
    }
    if (!trimmed || /^#{1,6}\s/.test(trimmed)) break;
    collected.push(trimmed);
  }
  const paragraph = collected.join(" ").trim();
  return paragraph || undefined;
}

/** Parses one SKILL.md; returns undefined when the file is not a valid skill. */
export function parseSkillFile(path: string, contents: string, dir: string): SkillInfo | undefined {
  const { data, body } = parseFrontmatter(contents);

  const frontName = asText(data.name)?.trim();
  const name = frontName || firstHeading(body) || "";
  if (!name) return undefined;

  const description = asText(data.description)?.trim() || firstParagraph(body) || "";

  const metadata: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (key === "name" || key === "description") continue;
    metadata[key] = value;
  }

  return {
    name,
    description,
    path,
    dir,
    instructions: body.trim(),
    metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
  };
}

/* ------------------------------------------------------------------ *
 * Discovery
 * ------------------------------------------------------------------ */

function skillRoots(cwd: string, config: ResolvedConfig): string[] {
  const roots: string[] = [join(cwd, `.${APP_NAME}`, "skills")];
  for (const path of config.skills?.paths ?? []) roots.push(resolve(cwd, path));
  for (const path of config.assetPaths ?? []) roots.push(resolve(cwd, path));
  return [...new Set(roots)];
}

/** A root is either a skills directory (`<name>/SKILL.md`) or a skill itself. */
function findSkillFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  for (const candidate of ["SKILL.md", "skill.md"]) {
    const direct = join(root, candidate);
    if (isFile(direct)) return [direct];
  }

  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const out: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules") continue;
    for (const candidate of ["SKILL.md", "skill.md"]) {
      const file = join(root, entry.name, candidate);
      if (isFile(file)) {
        out.push(file);
        break;
      }
    }
  }
  return out.sort();
}

function scanSkills(roots: string[], logger: Logger): SkillInfo[] {
  const found = new Map<string, SkillInfo>();
  const visited = new Set<string>();
  for (const root of roots) {
    for (const file of findSkillFiles(root)) {
      if (visited.has(file)) continue;
      visited.add(file);
      let contents: string;
      try {
        contents = readFileSync(file, "utf8");
      } catch (error) {
        logger.warn(`could not read skill file ${file}; skipping`, error);
        continue;
      }
      const skill = parseSkillFile(file, contents, dirname(file));
      if (!skill) {
        logger.warn(`ignoring skill file without a usable name: ${file}`);
        continue;
      }
      // Later sources override earlier ones with the same name.
      found.set(skill.name, skill);
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function createSkillRegistry(options: SkillRegistryOptions): SkillRegistry {
  const { cwd, config } = options;
  const logger = options.logger ?? nullLogger;
  let skills = new Map<string, SkillInfo>();

  const load = () => {
    if (config.skills?.disabled) {
      skills = new Map();
      return;
    }
    skills = new Map(scanSkills(skillRoots(cwd, config), logger).map((skill) => [skill.name, skill]));
  };

  load();

  return {
    list: () => [...skills.values()],

    get(name) {
      const direct = skills.get(name);
      if (direct) return direct;
      const lower = name.toLowerCase();
      for (const [key, skill] of skills) {
        if (key.toLowerCase() === lower) return skill;
      }
      return undefined;
    },

    async reload() {
      load();
    },
  };
}

/* ------------------------------------------------------------------ *
 * The `skill` tool
 * ------------------------------------------------------------------ */

/** The `skill` tool, which loads a skill's full instructions on demand. */
export function createSkillTool(registry: SkillRegistry): ToolDef {
  return {
    name: "skill",
    description:
      "Load the complete instructions for an available skill by name. Use it whenever a task clearly matches a listed skill, before acting.",
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Exact skill name from the available-skills list.",
        },
      },
      required: ["name"],
      additionalProperties: false,
    },
    readOnly: true,
    async execute(input) {
      const requested =
        typeof input === "object" && input !== null && typeof (input as { name?: unknown }).name === "string"
          ? ((input as { name: string }).name).trim()
          : "";
      const skill = requested ? registry.get(requested) : undefined;

      if (!skill) {
        const available = registry.list().map((entry) => entry.name);
        const hint = available.length > 0 ? available.join(", ") : "(none installed)";
        return {
          title: `skill: ${requested || "?"}`,
          output: `Unknown skill "${requested}". Available skills: ${hint}`,
          isError: true,
        };
      }

      return {
        title: `skill: ${skill.name}`,
        output: [
          `<skill name="${skill.name}" path="${skill.path}">`,
          skill.instructions,
          "</skill>",
          "",
          `Skill resources are in: ${skill.dir}`,
        ].join("\n"),
        metadata: { skill: skill.name, dir: skill.dir },
      };
    },
  };
}

/* ------------------------------------------------------------------ *
 * Plugins
 * ------------------------------------------------------------------ */

export interface PluginRegistryOptions {
  cwd: string;
  config: ResolvedConfig;
  logger?: Logger;
}

export function createPluginRegistry(options: PluginRegistryOptions): Promise<PluginRegistry> {
  const { cwd, config } = options;
  const logger = options.logger ?? nullLogger;
  const hooks: PluginHooks[] = [];

  async function setup(plugin: Plugin, label: string): Promise<void> {
    const context: PluginContext = {
      cwd,
      config,
      log: (level, message) => {
        logger[level](`[plugin ${label}] ${message}`);
      },
    };
    try {
      const result = await plugin(context);
      if (result && typeof result === "object") hooks.push(result);
    } catch (error) {
      logger.warn(`plugin "${label}" threw during setup; skipping`, error);
    }
  }

  async function loadFromPath(entry: string): Promise<void> {
    const target = resolve(cwd, entry);
    const label = relative(cwd, target) || target;
    try {
      const module = (await import(pathToFileURL(target).href)) as {
        default?: unknown;
        plugin?: unknown;
      };
      const candidate = module.default ?? module.plugin;
      if (typeof candidate !== "function") {
        logger.warn(`plugin "${label}" does not export a default or plugin function; skipping`);
        return;
      }
      await setup(candidate as Plugin, label);
    } catch (error) {
      logger.warn(`failed to load plugin "${label}"; skipping`, error);
    }
  }

  const registry: PluginRegistry = {
    hooks: () => [...hooks],
    register: (plugin) => setup(plugin, plugin.name || "anonymous"),
  };

  return (async () => {
    for (const entry of config.plugins ?? []) {
      if (typeof entry !== "string" || !entry.trim()) continue;
      await loadFromPath(entry);
    }
    return registry;
  })();
}

export type { Plugin, PluginRegistry, SkillInfo, SkillRegistry };
