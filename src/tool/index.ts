/**
 * Tool layer entry point.
 *
 * OWNER: tools teammate. The exported signatures below are FROZEN — the agent
 * runtime and CLI depend on them.
 *
 * The registry is deliberately dumb: it looks tools up, validates the model's
 * arguments against the tool's JSON Schema and normalises the result. It never
 * prompts for permission — each tool calls `ctx.permission.check()` itself,
 * because only the tool knows the concrete path/command being authorised.
 */
import type { ResolvedConfig, ToolDef, ToolContext, ToolOutcome, ToolRegistry, ToolSchema } from "../core/types.ts";
import { errorMessage } from "../util/errors.ts";
import { bashTool } from "./bash.ts";
import { editTool } from "./edit.ts";
import { globTool } from "./glob.ts";
import { grepTool } from "./grep.ts";
import { listTool } from "./list.ts";
import { patchTool } from "./patch.ts";
import { readTool } from "./read.ts";
import { taskTool } from "./task.ts";
import { todoreadTool } from "./todoread.ts";
import { todowriteTool } from "./todowrite.ts";
import { webfetchTool } from "./webfetch.ts";
import { writeTool } from "./write.ts";
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

/* ------------------------------------------------------------------ *
 * JSON Schema validation
 *
 * A deliberately small subset: object, string, number, integer, boolean,
 * array, enum, minimum/maximum, required, additionalProperties, anyOf/oneOf.
 * It exists to catch the model's malformed arguments with a message naming
 * the offending field, not to be a general-purpose validator.
 * ------------------------------------------------------------------ */

type JsonSchema = Record<string, unknown>;

function typeName(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function fieldPath(parent: string, key: string): string {
  return parent === "" ? key : `${parent}.${key}`;
}

function matchesType(expected: string, value: unknown): boolean {
  switch (expected) {
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value);
    case "array":
      return Array.isArray(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "string":
      return typeof value === "string";
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    default:
      return true;
  }
}

function validateValue(schema: JsonSchema, value: unknown, path: string): string | undefined {
  const expected = schema["type"];
  if (typeof expected === "string" && !matchesType(expected, value)) {
    const label = path === "" ? "input" : `field "${path}"`;
    return `${label} must be ${expected === "integer" || expected === "object" || expected === "array" ? "an" : "a"} ${expected}, received ${typeName(value)}.`;
  }

  const enumValues = schema["enum"];
  if (Array.isArray(enumValues)) {
    if (!enumValues.some((candidate) => candidate === value)) {
      return `field "${path}" must be one of ${enumValues.map((candidate) => JSON.stringify(candidate)).join(", ")}.`;
    }
  }

  if (typeof value === "number") {
    const minimum = schema["minimum"];
    const maximum = schema["maximum"];
    if (typeof minimum === "number" && value < minimum) {
      return `field "${path}" must be >= ${minimum}.`;
    }
    if (typeof maximum === "number" && value > maximum) {
      return `field "${path}" must be <= ${maximum}.`;
    }
  }

  if (expected === "object" && typeof value === "object" && value !== null && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const properties = schema["properties"];
    const known = new Set<string>();
    if (properties && typeof properties === "object" && !Array.isArray(properties)) {
      for (const [key, child] of Object.entries(properties as Record<string, unknown>)) {
        known.add(key);
        const childSchema = child as JsonSchema;
        if (record[key] === undefined) continue;
        const error = validateValue(childSchema, record[key], fieldPath(path, key));
        if (error) return error;
      }
    }

    const required = schema["required"];
    if (Array.isArray(required)) {
      for (const key of required) {
        if (typeof key === "string" && record[key] === undefined) {
          return `field "${fieldPath(path, key)}" is required but missing.`;
        }
      }
    }

    if (schema["additionalProperties"] === false) {
      for (const key of Object.keys(record)) {
        if (!known.has(key)) {
          return `field "${fieldPath(path, key)}" is not allowed (additionalProperties: false).`;
        }
      }
    }
  }

  if (expected === "array" && Array.isArray(value)) {
    const items = schema["items"];
    if (items && typeof items === "object" && !Array.isArray(items)) {
      for (let index = 0; index < value.length; index += 1) {
        const error = validateValue(items as JsonSchema, value[index], `${path}[${index}]`);
        if (error) return error;
      }
    }
  }

  for (const keyword of ["anyOf", "oneOf"] as const) {
    const branches = schema[keyword];
    if (!Array.isArray(branches) || branches.length === 0) continue;
    let firstError: string | undefined;
    for (const branch of branches) {
      if (typeof branch !== "object" || branch === null) continue;
      const error = validateValue(branch as JsonSchema, value, path);
      if (!error) return undefined;
      firstError ??= error;
    }
    if (firstError) return firstError;
  }

  return undefined;
}

function validateInput(tool: ToolDef, input: unknown): string | undefined {
  const value = input === undefined ? {} : input;
  const error = validateValue(tool.parameters as JsonSchema, value, "");
  return error ? `Invalid input for tool "${tool.name}": ${error}` : undefined;
}

/* ------------------------------------------------------------------ *
 * Registry
 * ------------------------------------------------------------------ */

export function createToolRegistry(options: ToolRegistryOptions): ToolRegistry {
  const disabled = new Set(options.disabled ?? []);
  const tools = new Map<string, ToolDef>();
  const builtins = new Set<string>();

  for (const tool of builtinTools()) {
    tools.set(tool.name, tool);
    builtins.add(tool.name);
  }
  for (const tool of options.extraTools ?? []) {
    if (!tool || typeof tool.name !== "string" || tool.name === "") continue;
    if (builtins.has(tool.name)) {
      // A remote or skill tool must not silently replace `bash`/`write`.
      options.logger?.warn(`ignoring extra tool "${tool.name}": a built-in tool has that name`);
      continue;
    }
    tools.set(tool.name, tool);
  }

  const all = (): ToolDef[] => [...tools.values()];
  const isEnabled = (tool: ToolDef): boolean => !tool.hidden && !disabled.has(tool.name);
  const enabled = (): ToolDef[] => all().filter(isEnabled);

  return {
    all,
    enabled,
    get(name: string): ToolDef | undefined {
      return tools.get(name);
    },
    schemas(): ToolSchema[] {
      return enabled().map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      }));
    },
    async execute(name: string, input: unknown, ctx: ToolContext): Promise<ToolOutcome> {
      const tool = tools.get(name);
      if (!tool) {
        const available = enabled()
          .map((candidate) => candidate.name)
          .sort((a, b) => a.localeCompare(b))
          .join(", ");
        return {
          output: `Unknown tool "${name}". Available tools: ${available}.`,
          isError: true,
          metadata: { unknownTool: name },
        };
      }
      if (disabled.has(name)) {
        return {
          output: `Tool "${name}" is disabled for this agent.`,
          isError: true,
          metadata: { disabled: true, tool: name },
        };
      }

      const invalid = validateInput(tool, input);
      if (invalid) {
        return { output: invalid, isError: true, metadata: { validation: true, tool: name } };
      }

      try {
        const outcome = await tool.execute((input ?? {}) as Record<string, unknown>, ctx);
        if (!outcome || typeof outcome !== "object") {
          return {
            output: `Tool "${name}" returned no result.`,
            isError: true,
            metadata: { tool: name },
          };
        }
        return {
          ...outcome,
          output: typeof outcome.output === "string" ? outcome.output : String(outcome.output ?? ""),
        };
      } catch (error) {
        return { output: errorMessage(error), isError: true, metadata: { tool: name } };
      }
    },
  };
}

/** Every built-in tool, for docs and tests. */
export function builtinTools(): ToolDef[] {
  return [
    readTool,
    writeTool,
    editTool,
    patchTool,
    bashTool,
    globTool,
    grepTool,
    listTool,
    webfetchTool,
    todowriteTool,
    todoreadTool,
    taskTool,
  ];
}
