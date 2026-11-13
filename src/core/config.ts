import { resolve, join } from "node:path";
import { z } from "zod";
import { ConfigError } from "../util/errors.ts";
import { exists, readTextOrNull } from "../util/fsx.ts";
import { APP_NAME, homeDir, projectRoot } from "../util/paths.ts";
import type { KortivConfig, ResolvedConfig } from "./types.ts";

const permissionRuleSchema = z
  .object({
    tool: z.string().min(1),
    pattern: z.string().optional(),
    action: z.enum(["allow", "deny", "ask"]),
  })
  .strict();

const modelInfoSchema = z
  .object({
    id: z.string().optional(),
    name: z.string().optional(),
    contextWindow: z.number().int().positive().optional(),
    maxOutput: z.number().int().positive().optional(),
    supportsTools: z.boolean().optional(),
    supportsReasoning: z.boolean().optional(),
    supportsImages: z.boolean().optional(),
    cost: z
      .object({
        input: z.number().nonnegative(),
        output: z.number().nonnegative(),
        cacheRead: z.number().nonnegative().optional(),
        cacheWrite: z.number().nonnegative().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const providerConfigSchema = z
  .object({
    baseURL: z.string().url().optional(),
    apiKey: z.string().optional(),
    apiKeyEnv: z.string().optional(),
    headers: z.record(z.string(), z.string()).optional(),
    models: z.record(z.string(), modelInfoSchema).optional(),
    keyless: z.boolean().optional(),
  })
  .strict();

const mcpServerSchema = z
  .object({
    type: z.enum(["local", "remote"]).optional(),
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    url: z.string().optional(),
    headers: z.record(z.string(), z.string()).optional(),
    enabled: z.boolean().optional(),
    trusted: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Boolean(value.command || value.url), {
    message: "an MCP server needs either `command` (local) or `url` (remote)",
  });

const agentConfigSchema = z
  .object({
    description: z.string().optional(),
    mode: z.enum(["primary", "subagent"]).optional(),
    model: z.string().optional(),
    temperature: z.number().min(0).max(2).optional(),
    maxSteps: z.number().int().positive().optional(),
    prompt: z.string().optional(),
    tools: z.record(z.string(), z.boolean()).optional(),
    permissions: z.array(permissionRuleSchema).optional(),
  })
  .strict();

const subagentConfigSchema = z
  .object({
    description: z.string().optional(),
    model: z.string().optional(),
    temperature: z.number().min(0).max(2).optional(),
    maxSteps: z.number().int().positive().optional(),
    prompt: z.string().optional(),
    tools: z.record(z.string(), z.boolean()).optional(),
  })
  .strict();

export const configSchema = z
  .object({
    $schema: z.string().optional(),
    model: z.string().optional(),
    smallModel: z.string().optional(),
    temperature: z.number().min(0).max(2).optional(),
    maxSteps: z.number().int().positive().max(200).optional(),
    systemPrompt: z.string().optional(),
    instructions: z.array(z.string()).optional(),
    disableAgentsMd: z.boolean().optional(),
    permissions: z.array(permissionRuleSchema).optional(),
    providers: z.record(z.string(), providerConfigSchema).optional(),
    mcp: z.record(z.string(), mcpServerSchema).optional(),
    skills: z
      .object({ paths: z.array(z.string()).optional(), disabled: z.boolean().optional() })
      .strict()
      .optional(),
    plugins: z.array(z.string()).optional(),
    agents: z.record(z.string(), agentConfigSchema).optional(),
    subagents: z.record(z.string(), subagentConfigSchema).optional(),
    ui: z
      .object({
        theme: z.enum(["kortiv", "mono", "auto"]).optional(),
        showReasoning: z.boolean().optional(),
        showTokenUsage: z.boolean().optional(),
        markdown: z.boolean().optional(),
        animations: z.boolean().optional(),
      })
      .strict()
      .optional(),
    assetPaths: z.array(z.string()).optional(),
  })
  .strict();

export const DEFAULT_MAX_STEPS = 40;
export const DEFAULT_TEMPERATURE = 0;

/** Candidate config files, lowest priority first. */
export function configCandidates(cwd: string): string[] {
  const root = projectRoot(cwd);
  const out = [join(homeDir(), "config.json")];
  if (root !== resolve(cwd)) out.push(join(root, `${APP_NAME}.json`));
  out.push(join(cwd, `${APP_NAME}.json`), join(cwd, `.${APP_NAME}`, "config.json"));
  return [...new Set(out.map((path) => resolve(path)))];
}

/**
 * Loads `.env` files into `process.env` without overwriting variables that
 * are already set, so a real environment always wins over a checked-in file.
 * Supports `KEY=value`, `export KEY=value`, quotes and `#` comments.
 */
export async function loadEnvFile(path: string): Promise<string[]> {
  const raw = await readTextOrNull(path);
  if (!raw) return [];
  const applied: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(trimmed);
    if (!match) continue;
    const key = match[1]!;
    let value = match[2]!.trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    } else {
      const hash = value.indexOf(" #");
      if (hash !== -1) value = value.slice(0, hash).trim();
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
      applied.push(key);
    }
  }
  return applied;
}

/** Loads `.env` then `.env.local` from the project root and cwd. */
export async function loadProjectEnv(cwd: string): Promise<string[]> {
  const root = projectRoot(cwd);
  const files = [
    join(root, ".env"),
    join(cwd, ".env"),
    join(root, ".env.local"),
    join(cwd, ".env.local"),
  ];
  const seen = new Set<string>();
  const applied: string[] = [];
  for (const file of files) {
    const abs = resolve(file);
    if (seen.has(abs)) continue;
    seen.add(abs);
    if (!(await exists(abs))) continue;
    for (const key of await loadEnvFile(abs)) {
      if (!applied.includes(key)) applied.push(key);
    }
  }
  return applied;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Deep merge where later sources win. Arrays concat for the listed keys. */
export function mergeConfig(base: KortivConfig, override: KortivConfig): KortivConfig {
  const concatKeys = new Set(["permissions", "instructions", "plugins", "assetPaths"]);
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue;
    const previous = out[key];
    if (concatKeys.has(key) && Array.isArray(previous) && Array.isArray(value)) {
      out[key] = [...previous, ...value];
      continue;
    }
    if (isPlainObject(previous) && isPlainObject(value)) {
      out[key] = mergeConfig(previous as KortivConfig, value as KortivConfig);
      continue;
    }
    out[key] = value;
  }
  return out as KortivConfig;
}

function formatZodError(path: string, error: z.ZodError): string {
  const details = error.issues
    .map((issue) => {
      const where = issue.path.length ? issue.path.join(".") : "(root)";
      return `  - ${where}: ${issue.message}`;
    })
    .join("\n");
  return `Invalid configuration in ${path}:\n${details}`;
}

export async function readConfigFile(path: string): Promise<KortivConfig | null> {
  const raw = await readTextOrNull(path);
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonComments(raw));
  } catch (error) {
    throw new ConfigError(`Could not parse ${path} as JSON.`, {
      hint: "Fix the syntax, or delete the file to fall back to defaults.",
      cause: error,
    });
  }
  const result = configSchema.safeParse(parsed);
  if (!result.success) {
    throw new ConfigError(formatZodError(path, result.error), {
      hint: "Unknown keys are rejected so typos surface early. Compare against the shipped kortivai.example.json.",
    });
  }
  return result.data as KortivConfig;
}

/** Tolerates `//` and trailing commas so hand-edited config stays friendly. */
export function stripJsonComments(input: string): string {
  let out = "";
  let inString = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < input.length; i += 1) {
    const char = input[i]!;
    const next = input[i + 1];
    if (inLine) {
      if (char === "\n") {
        inLine = false;
        out += char;
      }
      continue;
    }
    if (inBlock) {
      if (char === "*" && next === "/") {
        inBlock = false;
        i += 1;
      }
      continue;
    }
    if (inString) {
      out += char;
      if (char === "\\") {
        out += next ?? "";
        i += 1;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }
    if (char === "/" && next === "/") {
      inLine = true;
      i += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      inBlock = true;
      i += 1;
      continue;
    }
    out += char;
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

export interface LoadConfigOptions {
  cwd: string;
  /** Values from CLI flags; highest priority. */
  overrides?: KortivConfig;
  /** Skip `.env` loading (tests set their own environment). */
  skipEnv?: boolean;
}

/**
 * Loads and merges every config source. Throws {@link ConfigError} with the
 * offending file and field when a file is invalid.
 */
export async function loadConfig(options: LoadConfigOptions): Promise<ResolvedConfig> {
  const cwd = resolve(options.cwd);
  if (!options.skipEnv) await loadProjectEnv(cwd);

  const sources: string[] = [];
  let merged: KortivConfig = {};
  for (const candidate of configCandidates(cwd)) {
    const config = await readConfigFile(candidate);
    if (!config) continue;
    sources.push(candidate);
    merged = mergeConfig(merged, config);
  }

  if (options.overrides) {
    const result = configSchema.strict().safeParse(options.overrides);
    // CLI overrides are constructed by us; a failure here is a bug, not user
    // error, so surface it as a config error with the same shape.
    if (!result.success) throw new ConfigError(formatZodError("command line", result.error));
    merged = mergeConfig(merged, result.data as KortivConfig);
  }

  const envOverrides = readEnvOverrides();
  merged = mergeConfig(merged, envOverrides);

  const resolved: ResolvedConfig = {
    ...merged,
    cwd,
    sources,
  };
  if (sources.length > 0) resolved.source = sources[sources.length - 1];
  return resolved;
}

export function readEnvOverrides(): KortivConfig {
  const out: KortivConfig = {};
  const model = process.env.KORTIVAI_MODEL;
  if (model) out.model = model;
  const small = process.env.KORTIVAI_SMALL_MODEL;
  if (small) out.smallModel = small;
  const temperature = process.env.KORTIVAI_TEMPERATURE;
  if (temperature !== undefined && temperature !== "") {
    const parsed = Number(temperature);
    if (Number.isFinite(parsed)) out.temperature = parsed;
  }
  const maxSteps = process.env.KORTIVAI_MAX_STEPS;
  if (maxSteps) {
    const parsed = Number.parseInt(maxSteps, 10);
    if (Number.isFinite(parsed)) out.maxSteps = parsed;
  }
  return out;
}

export function effectiveTemperature(config: KortivConfig): number {
  return config.temperature ?? DEFAULT_TEMPERATURE;
}

export function effectiveMaxSteps(config: KortivConfig): number {
  return config.maxSteps ?? DEFAULT_MAX_STEPS;
}
