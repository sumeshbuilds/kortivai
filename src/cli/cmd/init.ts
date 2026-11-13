/** `kortivai init` — write a commented config and an AGENTS.md starter. */
import { join } from "node:path";
import { KortivError } from "../../util/errors.ts";
import { exists, writeTextAtomic } from "../../util/fsx.ts";
import type { CliContext } from "../io.ts";
import { flagBool } from "../io.ts";

export const CONFIG_FILE = "kortivai.json";
export const AGENTS_FILE = "AGENTS.md";

export const CONFIG_TEMPLATE = `{
  // Default model, as "provider/model".
  "model": "deepseek/deepseek-chat",

  // Cheaper model for chores such as title generation.
  "smallModel": "deepseek/deepseek-chat",

  // Cap provider round-trips per turn.
  "maxSteps": 40,

  // Checked before a side-effecting tool runs: "allow" | "ask" | "deny".
  // \`pattern\` is a glob matched against the command or path.
  "permissions": [
    { "tool": "bash", "pattern": "git status*", "action": "allow" },
    { "tool": "bash", "pattern": "rm *", "action": "deny" }
  ],

  "ui": {
    // "kortiv" (default) or "mono".
    "theme": "kortiv",
    "showReasoning": false,
    "showTokenUsage": true
  }
}
`;

export const AGENTS_TEMPLATE = `# AGENTS.md

Instructions for any AI coding agent working in this repository.

## Commands

- Install: \`npm install\`
- Typecheck: \`npm run typecheck\`
- Test: \`npm test\`

## Conventions

- Explain *why* in comments, not *what*.
- Keep changes inside the module you were asked to touch.
- Never commit secrets; read them from the environment.

## Do not

- Rewrite history or force-push.
- Add a dependency without saying why.
`;

export interface InitResult {
  created: string[];
  skipped: string[];
}

export async function initProject(options: { cwd: string; force?: boolean }): Promise<InitResult> {
  const targets: Array<{ path: string; contents: string }> = [
    { path: join(options.cwd, CONFIG_FILE), contents: CONFIG_TEMPLATE },
    { path: join(options.cwd, AGENTS_FILE), contents: AGENTS_TEMPLATE },
  ];

  const present: string[] = [];
  for (const target of targets) {
    if (await exists(target.path)) present.push(target.path);
  }
  if (present.length > 0 && !options.force) {
    throw new KortivError(`Refusing to overwrite ${present.map((path) => path.split(/[\\/]/).pop()).join(", ")}.`, {
      hint: "Move them aside, edit them by hand, or re-run with --force to overwrite.",
    });
  }

  const created: string[] = [];
  for (const target of targets) {
    await writeTextAtomic(target.path, target.contents);
    created.push(target.path);
  }
  return { created, skipped: present };
}

export async function initCommand(ctx: CliContext): Promise<number> {
  const cwd = ctx.io.cwd;
  const result = await initProject({ cwd, force: flagBool(ctx.flags, "force") });
  for (const path of result.created) {
    ctx.io.stdout.write(`  created ${path}\n`);
  }
  ctx.io.stdout.write(
    "\n  next: set your model in kortivai.json, then run `kortivai run \"hello\"`.\n",
  );
  return 0;
}
