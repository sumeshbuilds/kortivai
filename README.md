# KortivAI

An open-source terminal AI coding agent, rebuilt in the spirit of
[opencode](https://opencode.ai) — with its own design, its own permission
model, and no vendor lock-in.

KortivAI runs in your terminal, edits your repository through a permissioned
tool system, and talks to any model you point it at: DeepSeek, OpenAI-compatible
gateways, Anthropic, Gemini, or a local Ollama server. It is provider-thin and
transport-honest: every provider is a few hundred lines over plain `fetch`, so
you can read what is being sent.

> **Not affiliated with the opencode project.** KortivAI is an independent
> rebuild that shares a philosophy and a shape, not code or a team.

---

## Why this exists

Most agent CLIs are either a thin wrapper around one vendor's API, or a
black box. KortivAI is built around four commitments:

1. **The model is replaceable.** A provider is an interface, not a dependency.
   Switching from DeepSeek to a local Ollama model is one config line.
2. **Nothing happens without permission.** Every side-effecting tool asks first.
   The `plan` agent physically cannot write, even with `--yolo`.
3. **State is yours and inspectable.** Sessions are plain JSON on disk. There is
   no server, no account, no telemetry.
4. **The design is a tool, not a chatbot.** The terminal UI is hand-rolled ANSI
   with a real design system — restrained, hierarchical, and readable at a glance.

---

## Requirements

- **Node.js 20.19+** to run a build. **Node.js 24+** to run the TypeScript
  sources directly (KortivAI uses Node's native type stripping in development).
- No build step is required for local development.

## Install

```bash
git clone <your-fork-url> kortivai
cd kortivai
npm install
npm run build
npm link          # optional: puts `kortivai` on your PATH
```

Or run the sources directly:

```bash
node src/cli/index.ts --help
```

---

## Quick start

### 1. Give it a model

DeepSeek is the default. Export a key (or run `kortivai auth login deepseek`):

```bash
export DEEPSEEK_API_KEY=sk-...        # PowerShell: $env:DEEPSEEK_API_KEY="sk-..."
```

KortivAI reads `.env` and `.env.local` from your project root as well, so a
gitignored `.env` works. Existing environment variables always win over a file.

To use something else, set the model once:

```bash
kortivai --model ollama/qwen2.5-coder:7b "explain this repo"
```

### 2. Talk to it

```bash
kortivai                       # interactive terminal UI
kortivai "fix the failing test in src/cart.test.ts"
kortivai run "add a --json flag to the export command"   # headless, scriptable
```

Inside the interactive UI, `Tab` switches agent, `Ctrl+C` cancels a running
turn, `Ctrl+D` exits, and `@path/to/file` attaches a file to your message.

Slash commands: `/help /model /agent /new /sessions /resume /mcp /skills
/agents /init /clear /compact /exit`.

### 3. Teach it your project

Drop an `AGENTS.md` at your repo root. KortivAI discovers it automatically —
from the root down to your working directory — and treats it as your rules.
`kortivai init` writes a starter config and `AGENTS.md`.

---

## Agents

| Agent | Mode | What it does |
| --- | --- | --- |
| `build` | primary | Default. Full read/write/run access. |
| `plan` | primary | Read-only. Explores and proposes; cannot write or patch. |
| `general` | subagent | Multi-step research, invoked by the `task` tool via `@general`. |

Define your own in `kortivai.json` — `agents` for selectable ones, `subagents`
for task-only ones:

```json
{
  "agents": {
    "review": {
      "description": "Reviews a diff without changing anything.",
      "mode": "primary",
      "prompt": "You review code. Report concrete problems with file and line.",
      "tools": { "write": false, "edit": false, "patch": false }
    }
  }
}
```

Per-agent `tools: { name: false }` removes a tool from the model's schema
entirely; per-agent `permissions` layer on top of the global rules and win.

---

## Permissions

Rules are checked in order. **The most specific match wins**: a rule matching
tool *and* pattern beats a tool-only rule, and among equally specific rules the
last one wins. `!pattern` negates.

```json
{
  "permissions": [
    { "tool": "read",  "action": "allow" },
    { "tool": "bash",  "pattern": "git status*", "action": "allow" },
    { "tool": "bash",  "pattern": "rm -rf /*",    "action": "deny"  },
    { "tool": "bash",  "pattern": "*",            "action": "ask"   },
    { "tool": "write", "action": "ask" }
  ]
}
```

Without a matching rule, read-only tools are allowed and everything else asks.
With no interactive asker available, `ask` becomes a refusal — never a silent
allow. `deny` is absolute: it is not overridable by `--yolo`.

---

## Tools

| Tool | Read-only | Purpose |
| --- | --- | --- |
| `read` | yes | Read a file with line numbers, offset/limit, binary detection |
| `write` | no | Create or replace a file, returning a diff summary |
| `edit` | no | Exact-string replacement; refuses ambiguous or missing matches |
| `patch` | no | Apply a unified diff |
| `bash` | no | Run a shell command, streaming output, with timeout and abort |
| `glob` | yes | Find files by pattern |
| `grep` | yes | Regex content search with `file:line:text` results |
| `list` | yes | List a directory |
| `webfetch` | yes | Fetch a URL and reduce HTML to readable text |
| `todowrite` | yes | Maintain the turn's task checklist |
| `task` | no | Delegate to a subagent |
| `skill` | yes | Load a skill's full instructions on demand |

Every tool is defined once, in one file, with a JSON Schema and a description
written for the model. Filesystem tools refuse paths outside the session root.

---

## MCP servers

KortivAI speaks the Model Context Protocol. Each server's tools are bridged in
as `<server>_<tool>`.

```json
{
  "mcp": {
    "filesystem": {
      "type": "local",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]
    },
    "remote": { "type": "remote", "url": "https://example.com/mcp" }
  }
}
```

A server that fails to connect is reported and skipped — it never stops the
agent from starting. `trusted: true` skips the per-call permission prompt for
that server; only set it for servers you wrote or fully trust.

## Skills

A skill is a directory with a `SKILL.md` that has `name` and `description`
frontmatter. Only the name and description are loaded up front; the body is
fetched on demand when the agent decides the skill applies, which keeps the
prompt small.

```
.kortivai/skills/pdf-forms/SKILL.md
```

## Plugins

A plugin is a local ES module exporting a function. It receives a context and
may return lifecycle hooks (`chat.params`, `chat.message`, `tool.before`,
`tool.after`, `permission.ask`).

```js
export default function plugin(ctx) {
  return {
    "tool.before": ({ tool, input }) => {
      ctx.log("info", `about to run ${tool}`);
    },
  };
}
```

A broken plugin is logged and skipped, never fatal.

---

## Configuration

Copy [`kortivai.example.json`](kortivai.example.json) to `kortivai.json`.
It is JSON **with comments** (`//` and trailing commas are accepted).

Precedence, lowest to highest:

1. `~/.kortivai/config.json`
2. `<project-root>/kortivai.json`
3. `<cwd>/.kortivai/config.json`
4. `KORTIVAI_*` environment variables
5. command-line flags

Arrays such as `permissions` and `instructions` concatenate; objects deep-merge.
**Unknown keys are rejected**, so a typo fails loudly instead of being ignored.

## State, secrets and privacy

Everything KortivAI owns lives under `KORTIVAI_HOME` (default `~/.kortivai`):

```
~/.kortivai/
  config.json     global config
  auth.json       provider credentials (written 0600)
  state/sessions/ one JSON file per session
  log/            debug logs, with keys redacted
```

- Set `KORTIVAI_HOME` to relocate all of it — useful for CI, sandboxes, and
  throwaway runs.
- Credentials are read from the environment first; `auth.json` is a fallback
  and is never written into your project.
- The logger redacts anything shaped like an API key before it reaches disk.
- There is no server, no account, and no telemetry. Session files are plain
  JSON you can read and delete.

---

## Architecture

```
src/core/       types, config, prompt, events, agent loop, sessions, wiring
src/provider/   model catalog, auth, one file per wire protocol
src/tool/       one tool per file + the registry
src/permission/ rule matching, askers, per-agent scoping
src/mcp/        MCP client -> bridged tools
src/skill/      SKILL.md discovery + plugin loading
src/ui/         theme, markdown, diff, transcript, prompt, spinner
src/cli/        argument parsing, dispatch, one file per command
src/util/       errors, ids, paths, fs, glob, log
```

`src/core/types.ts` is the frozen contract between all of them — types only, no
runtime code — which is what lets the layers be built and tested independently.
`src/core/wiring.ts` is the single place the object graph is assembled; a
frontend never builds a provider or a store itself.

The agent loop is deliberately small: stream a provider turn, execute any tool
calls it produced, feed the results back, repeat until it stops or the step
budget runs out. Consecutive read-only tool calls run concurrently; a
side-effecting call always runs alone, in order.

Use it as a library:

```ts
import { createKortivRuntime } from "kortivai";

const runtime = await createKortivRuntime({ cwd: process.cwd() });
runtime.events.subscribe((event) => { /* stream the turn */ });
const session = await runtime.agents.createSession();
await runtime.agents.run({ sessionId: session.id, prompt: "Explain this repo" });
await runtime.close();
```

---

## Development

```bash
npm run typecheck   # tsc --noEmit
npm run test        # unit + e2e
npm run build       # emit dist/
npm run verify      # typecheck + test + build
```

### Testing notes

- Tests use the built-in `node:test` runner. **Always pass
  `--experimental-test-isolation=none`** (the `npm test` script does): a bare
  `node --test` spawns each file as a piped child process, which fails in
  restricted sandboxes.
- `tests/e2e/` drives the **real** agent loop, tool registry, permission
  manager, and session store, with only the model provider scripted. That is
  what proves the layers compose.
- No test makes a real network call.

### Live proof against a real model

The one test that proves the agent is genuinely workable is opt-in, because it
spends real tokens:

```bash
KORTIVAI_LIVE_TEST=1 DEEPSEEK_API_KEY=sk-... \
  node --experimental-test-isolation=none --test tests/e2e/live-deepseek.test.ts
```

It writes a file with a real bug, asks a real model to fix it, and then
verifies the fix from outside the agent — the full chain: provider transport,
agent loop, tool execution, permissions, and session persistence.

---

## License

MIT. See [LICENSE](LICENSE).

Inspired by [opencode](https://opencode.ai) (MIT). KortivAI is an independent
project and is not affiliated with or endorsed by the opencode team.
