# AGENTS.md — working on KortivAI

Guidance for any AI coding agent (including KortivAI itself) working in this
repository.

## What this project is

KortivAI is an open-source terminal AI coding agent, rebuilt in the spirit of
[opencode](https://opencode.ai). It runs in Node, talks to any OpenAI-compatible
or Anthropic/Gemini endpoint over plain `fetch`, and edits your repo through a
permissioned tool system.

## Non-negotiable engineering rules

1. **`npm run typecheck` must be clean before you claim anything works.**
2. **Run the tests you touched, and report the exact command and result.**
   `node --experimental-test-isolation=none --test tests/` — note that a bare
   `node --test` spawns piped child processes, which fails in restricted
   sandboxes; keep the `--experimental-test-isolation=none` flag.
3. **Never claim verified behaviour you did not verify.** If you only reasoned
   about it, say so.
4. **No new runtime dependency** unless the task explicitly needs one. The
   provider layer, the UI, the glob matcher and the argument parser are all
   deliberately dependency-free.
5. **Do not commit, push, or rewrite history.** Leave the working tree for review.

## Architecture: the contracts are frozen

`src/core/types.ts` is the single source of truth for every module boundary.
Read it before changing anything. It is types-only and dependency-free on
purpose so the layers can be built and tested independently.

```
src/core/      types, config, prompt, events, agent loop, sessions, wiring
src/provider/  model catalog, auth, one file per wire protocol
src/tool/      one file per tool + the registry
src/permission/ rule matching, askers, per-agent scoping
src/mcp/       MCP client -> bridged tools
src/skill/     SKILL.md discovery + plugin loading
src/ui/        theme, markdown, diff, transcript, prompt, spinner
src/cli/       arg parsing, command dispatch, one file per command
src/util/      errors, ids, paths, fs, glob, log
```

`src/core/wiring.ts` is the only place the object graph is assembled. A
frontend never constructs a provider, tool registry, store or permission
manager itself — it asks the runtime.

## Conventions

- **ESM with explicit `.ts` extensions** in relative imports.
- **Erasable syntax only**: no `enum`, no `namespace`, no constructor parameter
  properties. `tsconfig` enforces this via `erasableSyntaxOnly` so Node can run
  the sources directly with type stripping.
- **No `any`.** Prefer `unknown` plus narrowing. `strict` and
  `noUncheckedIndexedAccess` are on.
- Errors: throw `KortivError` subclasses from `src/util/errors.ts` and set a
  `hint` that tells the user what to do next. Never leak a raw stack trace as
  the whole user-facing message.
- **Paths**: every filesystem tool must keep writes inside `ctx.cwd` via
  `assertInside()` / `isInside()` from `src/util/paths.ts`.
- **Permissions**: a side-effecting tool calls `ctx.permission.check()` *before*
  it acts. Never bypass it.
- **Secrets**: read keys from the environment or `~/.kortivai/auth.json`. Never
  log a key, never put one in a config file, never commit `.env`.
- **State location**: everything user-owned lives under `KORTIVAI_HOME`
  (`~/.kortivai` by default). Tests must redirect it to a temp directory.
- Keep renderers **pure**: `state -> string` into an injected sink. Only
  `src/ui/prompt.ts` and `src/ui/tui.ts` may touch `process.stdin`/`stdout`.

## Testing

- Runner: built-in `node:test` with `node:assert/strict`. No test framework.
- Unit tests live in `tests/*.test.ts`; the end-to-end harness is
  `tests/e2e/`.
- **No test may make a real network call.** The e2e harness injects a scripted
  provider through `ProviderRegistryOptions.fetchImpl` or a fake registry.
- Set `KORTIVAI_HOME` to a temp dir and clean up after yourself.

## Style

- Comments explain *why*, not *what*. Delete a comment that restates the code.
- Prefer small, single-purpose modules over large multi-purpose ones.
- Match the surrounding code. Do not reformat files you are not changing.
