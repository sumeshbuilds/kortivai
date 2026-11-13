/**
 * Shared runtime plumbing for the CLI: the only place commands touch
 * createKortivRuntime, config loading, and error translation.
 */
import type { Session } from "../core/types.ts";
import { createKortivRuntime, type CreateRuntimeOptions, type KortivRuntime } from "../core/wiring.ts";
import { KortivError, errorMessage } from "../util/errors.ts";
import { createLogger } from "../util/log.ts";
import type { CliContext } from "./io.ts";
import { flagBool, flagString } from "./io.ts";

const STUB_HINT =
  "A subsystem is still a stub in this build (provider, tool, session or MCP). Run with --debug for the cause chain.";

export async function loadRuntime(options: CreateRuntimeOptions): Promise<KortivRuntime> {
  try {
    return await createKortivRuntime(options);
  } catch (error) {
    if (error instanceof KortivError) throw error;
    const message = errorMessage(error);
    throw new KortivError(`Runtime failed to initialise: ${message}`, {
      hint: /not implemented/i.test(message)
        ? STUB_HINT
        : "Run with --debug to see the cause chain.",
      cause: error,
    });
  }
}

/** Builds runtime options from CLI flags; flags always win over config. */
export function runtimeOptions(ctx: CliContext, extra: CreateRuntimeOptions = {}): CreateRuntimeOptions {
  const debug = flagBool(ctx.flags, "debug");
  const model = flagString(ctx.flags, "model");
  return {
    cwd: flagString(ctx.flags, "cwd") ?? ctx.io.cwd,
    overrides: model ? { model } : undefined,
    autoApprove: flagBool(ctx.flags, "yolo"),
    skipMcp: flagBool(ctx.flags, "noMcp"),
    logger: createLogger({ silent: !debug, stderr: debug, name: "cli.log" }),
    ...extra,
  };
}

/** `--agent` wins; `--plan` is shorthand for the read-only agent. */
export function agentFromFlags(ctx: CliContext): string | undefined {
  return flagString(ctx.flags, "agent") ?? (flagBool(ctx.flags, "plan") ? "plan" : undefined);
}

export async function resolveSession(
  runtime: KortivRuntime,
  options: { session?: string; continueLatest?: boolean },
): Promise<Session | undefined> {
  if (options.session) {
    const sessions = await runtime.sessions.list();
    const match =
      sessions.find((session) => session.id === options.session) ??
      sessions.find((session) => session.id.startsWith(options.session!));
    if (!match) {
      throw new KortivError(`No session matches "${options.session}".`, {
        hint: "Run `kortivai sessions` to list saved sessions.",
      });
    }
    return match;
  }
  if (options.continueLatest) return runtime.sessions.latest();
  return undefined;
}
