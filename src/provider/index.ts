/**
 * Provider layer entry point.
 *
 * The exports below are the FROZEN public surface: the agent runtime, CLI and
 * tests import them by name. The implementation lives in the sibling modules —
 * `registry.ts` (catalog + config), one file per wire protocol, and `auth.ts`
 * for the on-disk credential store.
 */
import type { ModelInfo, ModelRef, Provider, ProviderInfo, ProviderRegistry, ResolvedConfig } from "../core/types.ts";
import type { Logger } from "../util/log.ts";
import { readAuth as readAuthFile, writeAuth as writeAuthFile, type AuthEntry, type AuthStore } from "./auth.ts";
import {
  builtinProviderInfos,
  createProviderRegistry as buildRegistry,
  type ProviderRegistryOptions as RegistryOptions,
} from "./registry.ts";

export type { AuthEntry, AuthStore };

export interface ProviderRegistryOptions {
  config: ResolvedConfig;
  logger?: Logger;
  /** Injectable for tests and for proxying. */
  fetchImpl?: typeof fetch;
}

export async function createProviderRegistry(
  options: ProviderRegistryOptions,
): Promise<ProviderRegistry> {
  const internal: RegistryOptions = {
    config: options.config,
    logger: options.logger,
    fetchImpl: options.fetchImpl,
    credentialResolver: (providerId, config) => resolveCredential(providerId, config),
  };
  return buildRegistry(internal);
}

/** Static catalog before config overrides and credential filtering. */
export { builtinProviderInfos } from "./registry.ts";

/** Reads `$KORTIVAI_HOME/auth.json`. A missing file is an empty store. */
export async function readAuth(): Promise<AuthStore> {
  return readAuthFile();
}

/** Writes the store atomically with mode 0600 where the platform supports it. */
export async function writeAuth(store: AuthStore): Promise<void> {
  return writeAuthFile(store);
}

/**
 * Resolves the credential for a provider, if any.
 *
 * Order: literal `apiKey` in config, `apiKeyEnv`, the provider's env list, then
 * the auth store. Returns `undefined` when no credential is configured, and
 * never logs or returns the key anywhere except this result.
 */
export async function resolveCredential(
  providerId: string,
  config: ResolvedConfig,
): Promise<{ apiKey?: string; baseURL?: string } | undefined> {
  const providerConfig = config.providers?.[providerId];

  if (providerConfig?.apiKey) {
    return { apiKey: providerConfig.apiKey, baseURL: providerConfig.baseURL };
  }

  if (providerConfig?.apiKeyEnv) {
    const value = process.env[providerConfig.apiKeyEnv];
    if (value) return { apiKey: value, baseURL: providerConfig.baseURL };
  }

  for (const variable of envVarsFor(providerId)) {
    const value = process.env[variable];
    if (value) return { apiKey: value, baseURL: providerConfig?.baseURL };
  }

  const store = await readAuthFile();
  const entry = store[providerId];
  if (entry?.apiKey) {
    return { apiKey: entry.apiKey, baseURL: entry.baseURL ?? providerConfig?.baseURL };
  }
  const baseURL = providerConfig?.baseURL ?? entry?.baseURL;
  return baseURL ? { baseURL } : undefined;
}

/** Env vars consulted for a provider, from the built-in catalog. */
function envVarsFor(providerId: string): string[] {
  const known = builtinProviderInfos().find((info) => info.id === providerId);
  if (known) return known.env;
  const upper = providerId.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  return [`${upper}_API_KEY`];
}

export type { Provider, ProviderInfo, ProviderRegistry, ModelInfo, ModelRef };
