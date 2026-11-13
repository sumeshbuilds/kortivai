import type { KortivErrorShape } from "../core/types.ts";

/**
 * Base class for every error KortivAI raises deliberately. Carries an
 * actionable `hint` that the CLI prints underneath the message.
 */
export class KortivError extends Error {
  readonly hint?: string;
  retryable: boolean;

  constructor(
    message: string,
    options: { hint?: string; retryable?: boolean; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.hint = options.hint;
    this.retryable = options.retryable ?? false;
  }

  toShape(): KortivErrorShape {
    return {
      name: this.name,
      message: this.message,
      hint: this.hint,
      retryable: this.retryable,
      cause: this.cause,
    };
  }
}

export class ConfigError extends KortivError {}

export class AuthError extends KortivError {
  constructor(message: string, options: { hint?: string; cause?: unknown } = {}) {
    super(message, { ...options, retryable: false });
  }
}

export class ProviderError extends KortivError {
  readonly status?: number;
  readonly provider: string;

  constructor(
    provider: string,
    message: string,
    options: { status?: number; hint?: string; retryable?: boolean; cause?: unknown } = {},
  ) {
    super(message, options);
    this.provider = provider;
    this.status = options.status;
    this.retryable = options.retryable ?? (options.status === 429 || (options.status ?? 0) >= 500);
  }
}

export class ToolError extends KortivError {}

export class AbortedError extends KortivError {
  constructor(message = "Aborted") {
    super(message);
  }
}

export function isAbortError(error: unknown): boolean {
  if (error instanceof AbortedError) return true;
  if (error instanceof Error) {
    return error.name === "AbortError" || error.message === "Aborted";
  }
  return false;
}

/** Renders any thrown value as a single readable line for the transcript. */
export function errorMessage(error: unknown): string {
  if (error instanceof KortivError) {
    return error.hint ? `${error.message}\n  hint: ${error.hint}` : error.message;
  }
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/** Collects a readable cause chain, innermost last. */
export function errorChain(error: unknown): string[] {
  const out: string[] = [];
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (current && !seen.has(current)) {
    seen.add(current);
    out.push(errorMessage(current));
    current = current instanceof Error ? current.cause : undefined;
  }
  return out;
}
