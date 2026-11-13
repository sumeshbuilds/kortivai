/**
 * Provider layer entry point.
 *
 * OWNER: provider teammate. The exported signatures below are FROZEN — the
 * agent runtime, CLI and tests depend on them. Replace the stub bodies with
 * the real implementation; add new exports freely.
 */
import type {
  ModelInfo,
  ModelRef,
  Provider,
  ProviderInfo,
  ProviderRegistry,
  ResolvedConfig,
} from "../core/types.ts";
import type { Logger } from "../util/log.ts";

/** Credentials persisted at `~/.kortivai/auth.json`. Never logged. */
export interface AuthEntry {
  apiKey?: string;
  baseURL?: string;
  /** Free-form label shown by `kortivai auth list`. */
  label?: string;
}

export interface AuthStore {
  [providerId: string]: AuthEntry;
}

export interface ProviderRegistryOptions {
  config: ResolvedConfig;
  logger?: Logger;
  /** Injectable for tests and for proxying. */
  fetchImpl?: typeof fetch;
}

export async function createProviderRegistry(
  _options: ProviderRegistryOptions,
): Promise<ProviderRegistry> {
  throw new Error("createProviderRegistry is not implemented yet");
}

/** Static catalog before config overrides and credential filtering. */
export function builtinProviderInfos(): ProviderInfo[] {
  return [];
}

export async function readAuth(): Promise<AuthStore> {
  return {};
}

export async function writeAuth(_store: AuthStore): Promise<void> {
  throw new Error("writeAuth is not implemented yet");
}

/** Resolves the credential for a provider, if any. */
export async function resolveCredential(
  _providerId: string,
  _config: ResolvedConfig,
): Promise<{ apiKey?: string; baseURL?: string } | undefined> {
  return undefined;
}

export type { Provider, ProviderInfo, ProviderRegistry, ModelInfo, ModelRef };
