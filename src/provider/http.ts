/**
 * HTTP-level error translation shared by every provider.
 *
 * Everything that can go wrong below the protocol layer (DNS, TLS, connection
 * resets, timeouts, auth rejections, rate limits) becomes a `ProviderError` or
 * `AuthError` with a `hint` the user can act on. Aborts are never wrapped: the
 * agent runtime distinguishes "user cancelled" from "provider failed".
 */
import { AuthError, ProviderError, isAbortError } from "../util/errors.ts";

const DEFAULT_HINT = "Check your network connection, then retry.";

/** Status-aware error with a status-specific hint. */
export function httpStatusError(
  provider: string,
  status: number,
  detail: string,
  hint?: string,
): ProviderError | AuthError {
  const suffix = detail ? ` ${detail}` : "";

  if (status === 401 || status === 403) {
    return new AuthError(`Authentication failed for ${provider} (HTTP ${status}).${suffix}`, {
      hint: hint ?? "Check the API key, then retry.",
    });
  }
  if (status === 404) {
    return new ProviderError(provider, `Endpoint not found for ${provider} (HTTP 404).${suffix}`, {
      hint: "Check `providers.<id>.baseURL` in kortivai.json — it must point at an OpenAI-compatible root.",
      status,
      retryable: false,
    });
  }
  if (status === 429) {
    return new ProviderError(provider, `Rate limited by ${provider} (HTTP 429).${suffix}`, {
      hint: "Wait a moment and retry, or switch to a different model.",
      status,
      retryable: true,
    });
  }
  if (status >= 500) {
    return new ProviderError(provider, `${provider} is unavailable (HTTP ${status}).${suffix}`, {
      hint: "This is usually transient; retry in a few seconds.",
      status,
      retryable: true,
    });
  }
  if (status === 400 || status === 422) {
    return new ProviderError(provider, `${provider} rejected the request (HTTP ${status}).${suffix}`, {
      hint: "The model or a message shape was rejected. Run `kortivai models` and retry, or lower the tool/context size.",
      status,
      retryable: false,
    });
  }
  return new ProviderError(provider, `${provider} request failed (HTTP ${status}).${suffix}`, {
    hint,
    status,
  });
}

/**
 * Wraps a transport failure. Returns the original abort untouched so callers
 * can rethrow it and the runtime can treat the turn as cancelled.
 */
export function networkError(
  provider: string,
  error: unknown,
  baseURL: string,
  signal?: AbortSignal,
): unknown {
  if (isAbortError(error) || signal?.aborted) return error;
  const detail = error instanceof Error ? error.message : String(error);
  return new ProviderError(provider, `Could not reach ${provider} at ${baseURL}: ${detail}`, {
    hint: DEFAULT_HINT,
    retryable: true,
    cause: error,
  });
}

/** Hint shown when a provider needs a credential it does not have. */
export function credentialHint(providerId: string, env: string[]): string {
  const variable = env[0];
  return variable
    ? `Set ${variable}, or run \`kortivai auth login ${providerId}\` to store a key.`
    : `Run \`kortivai auth login ${providerId}\` to store a key.`;
}
