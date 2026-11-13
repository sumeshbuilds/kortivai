import { join, relative, resolve } from "node:path";
import { homedir } from "node:os";
import { readdir, readFile } from "node:fs/promises";
import { exists, readTextOrNull } from "../util/fsx.ts";
import { findUp, projectRoot, toPosix } from "../util/paths.ts";
import type { AgentDefinition, AgentInfo, KortivConfig, SkillInfo } from "./types.ts";

export const BRAND = "KortivAI";

/** Base behavioural contract, agency- and model-agnostic. */
export const BASE_SYSTEM_PROMPT = `You are ${BRAND}, an open-source terminal coding agent.

You help with software engineering tasks: implementing features, fixing bugs, explaining code, refactoring, writing tests, and running commands. You work directly in the user's repository through tools.

## How you work

- Investigate before you act. Read the relevant files, and prefer searching the codebase over guessing.
- Match the surrounding code: its naming, structure, formatting, and idioms. Do not impose a different style.
- Make the smallest change that fully solves the problem. Do not add unrequested abstractions, options, or dependencies.
- Do not leave the task half-done: wire up what you add, remove what you replace, and keep the project compiling.
- Verify your work with the project's own checks (tests, typecheck, lint, build) and report the exact commands and results.
- When a request is ambiguous and a wrong guess would be expensive, ask one focused question instead of guessing.
- Never claim something works when you have not verified it. Say what you did not verify.

## Editing rules

- Prefer the dedicated read/edit/write tools over shell redirection so changes are reviewable.
- Read a file before editing it. Use edit for targeted changes and write only when creating or fully replacing a file.
- Keep exact existing text in an edit's old text, including indentation, so the match is unambiguous.
- Never commit, push, amend, rebase, or force-push unless the user explicitly asks.
- Never run destructive commands (recursive deletes, history rewrites, mass resets) without explicit confirmation.
- Do not add secrets, credentials, or personal data to the repository.

## Communication

- Be concise and concrete. Lead with the result, not the process.
- Write in the user's language.
- Use short paragraphs and lists. Use fenced code blocks with a language tag.
- Reference files as relative paths, optionally with a line number.
- Do not open a reply with flattery or filler, and do not narrate tool calls that the transcript already shows.
- Report failures plainly, including the actual error output.`;

export interface PromptEnvironment {
  cwd: string;
  platform: NodeJS.Platform;
  date: string;
  model: string;
  agent: string;
  isGitRepo?: boolean;
  gitBranch?: string;
}

export function describeEnvironment(env: PromptEnvironment): string {
  const lines = [
    "<environment>",
    `  <cwd>${toPosix(env.cwd)}</cwd>`,
    `  <platform>${env.platform}</platform>`,
    `  <date>${env.date}</date>`,
    `  <model>${env.model}</model>`,
    `  <agent>${env.agent}</agent>`,
    `  <git>${env.isGitRepo ? `repository, branch ${env.gitBranch ?? "unknown"}` : "not a repository"}</git>`,
    "</environment>",
  ];
  return lines.join("\n");
}

export interface LoadedInstruction {
  path: string;
  content: string;
}

/**
 * Walks from `cwd` up to the repository root (or, outside a repo, no higher
 * than the user's home) collecting every `AGENTS.md` on the way. Returned
 * root-first so nested files are appended later and win by position.
 */
async function discoverInstructionChain(cwd: string): Promise<string[]> {
  const home = resolve(homedir());
  const gitRoot = await findGitRoot(cwd);
  const chain: string[] = [];
  let current = resolve(cwd);

  for (let depth = 0; depth < 24; depth += 1) {
    for (const name of ["AGENTS.md", "KORTIVAI.md"]) {
      const candidate = join(current, name);
      if (await exists(candidate)) chain.push(candidate);
    }
    if (gitRoot && current === gitRoot) break;
    const parent = resolve(current, "..");
    if (parent === current) break;
    // Never escape above the user's home directory: a stray AGENTS.md in an
    // unrelated ancestor must not become this project's rules.
    if (!gitRoot && (current === home || !parent.startsWith(home))) break;
    current = parent;
  }

  return chain.reverse();
}

async function findGitRoot(cwd: string): Promise<string | undefined> {
  let dir = resolve(cwd);
  for (;;) {
    if (await exists(join(dir, ".git"))) return dir;
    const parent = resolve(dir, "..");
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * Discovers `AGENTS.md` from the project root down to the working directory.
 * Nested files are appended after the root file so the most specific
 * instructions win by position. `KORTIVAI.md` is accepted as an alias.
 */
export async function loadAgentInstructions(
  cwd: string,
  config: Pick<KortivConfig, "instructions" | "disableAgentsMd"> = {},
): Promise<LoadedInstruction[]> {
  const found: LoadedInstruction[] = [];
  const seen = new Set<string>();

  const push = async (path: string) => {
    const abs = resolve(path);
    if (seen.has(abs)) return;
    seen.add(abs);
    const content = await readTextOrNull(abs);
    if (content && content.trim()) found.push({ path: abs, content: content.trim() });
  };

  if (!config.disableAgentsMd) {
    for (const path of await discoverInstructionChain(cwd)) await push(path);
  }

  for (const extra of config.instructions ?? []) {
    const abs = resolve(cwd, extra);
    if (await exists(abs)) await push(abs);
  }

  return found;
}

export function renderInstructions(instructions: LoadedInstruction[], cwd: string): string {
  if (instructions.length === 0) return "";
  const blocks = instructions.map((instruction) => {
    const label = toPosix(relative(cwd, instruction.path)) || instruction.path;
    return `<project-instructions path="${label}">\n${instruction.content}\n</project-instructions>`;
  });
  return [
    "The following project instructions were found in the repository. They are the user's own rules and take precedence over your defaults.",
    ...blocks,
  ].join("\n\n");
}

export function renderSkills(skills: SkillInfo[]): string {
  if (skills.length === 0) return "";
  const lines = skills.map((skill) => `- ${skill.name}: ${skill.description}`);
  return [
    "<available-skills>",
    "Reusable task instructions are available. When a task clearly matches one, load it with the `skill` tool before acting, and follow its instructions.",
    ...lines,
    "</available-skills>",
  ].join("\n");
}

export interface ComposePromptInput {
  agent: AgentInfo;
  config: KortivConfig;
  environment: PromptEnvironment;
  instructions: LoadedInstruction[];
  skills?: SkillInfo[];
}

/**
 * Composes the final system prompt: base (or user override) â†’ agent prompt â†’
 * environment â†’ project instructions â†’ skills.
 */
export function composeSystemPrompt(input: ComposePromptInput): string {
  const { agent, config, environment, instructions, skills = [] } = input;
  const sections: string[] = [];

  sections.push(config.systemPrompt?.trim() || BASE_SYSTEM_PROMPT);
  if (agent.prompt?.trim()) sections.push(agent.prompt.trim());
  sections.push(describeEnvironment(environment));

  const rendered = renderInstructions(instructions, environment.cwd);
  if (rendered) sections.push(rendered);

  const renderedSkills = renderSkills(skills);
  if (renderedSkills) sections.push(renderedSkills);

  return sections.join("\n\n");
}

export function toAgentDefinition(
  info: AgentInfo,
  input: Omit<ComposePromptInput, "agent">,
): AgentDefinition {
  return { ...info, systemPrompt: composeSystemPrompt({ ...input, agent: info }) };
}

/** Best-effort git metadata; never throws. */
export async function detectGit(cwd: string): Promise<{ isGitRepo: boolean; branch?: string }> {
  let dir = resolve(cwd);
  for (;;) {
    const gitDir = join(dir, ".git");
    if (await exists(gitDir)) {
      const head = await readTextOrNull(join(gitDir, "HEAD"));
      const branch = head?.startsWith("ref: refs/heads/")
        ? head.slice("ref: refs/heads/".length).trim()
        : undefined;
      return { isGitRepo: true, branch };
    }
    const parent = resolve(dir, "..");
    if (parent === dir) return { isGitRepo: false };
    dir = parent;
  }
}

/** Lists `.md` files under a directory, used by the skills registry. */
export async function listMarkdownFiles(dir: string, depth = 3): Promise<string[]> {
  const out: string[] = [];
  const walk = async (current: string, remaining: number): Promise<void> => {
    if (remaining < 0) return;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) await walk(full, remaining - 1);
      else if (entry.name.toLowerCase().endsWith(".md")) out.push(full);
    }
  };
  await walk(dir, depth);
  return out;
}

export async function readIfExists(path: string): Promise<string | undefined> {
  const content = await readTextOrNull(path);
  return content ?? undefined;
}

export async function readFileText(path: string): Promise<string> {
  return readFile(path, "utf8");
}
