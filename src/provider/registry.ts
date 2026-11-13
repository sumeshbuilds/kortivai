/**
 * The provider registry: static catalog + config overrides + credentials.
 *
 * `deepseek` is the default provider. Every OpenAI-compatible gateway shares
 * one implementation ({@link createOpenAIProvider}); only the base URL, key and
 * catalog differ. Anthropic and Google have their own wire formats.
 *
 * Credentials are resolved on every `chat()` call rather than eagerly, so a key
 * added after startup (`kortivai auth login`) is picked up without rebuilding
 * the registry.
 */
import type {
  ModelInfo,
  ModelRef,
  Provider,
  ProviderConfig,
  ProviderInfo,
  ProviderRegistry,
  ResolvedConfig,
} from "../core/types.ts";
import type { Logger } from "../util/log.ts";
import { nullLogger } from "../util/log.ts";
import { readAuth } from "./auth.ts";
import { DEFAULT_PROVIDER_ID, PROVIDER_SEEDS, type ProviderSeed } from "./catalog.ts";
import { createOpenAIProvider } from "./openai.ts";
import { createAnthropicProvider } from "./anthropic.ts";
import { createGeminiProvider } from "./gemini.ts";

export interface ProviderRegistryOptions {
  config: ResolvedConfig;
  logger?: Logger;
  /** Injectable for tests and for proxying. */
  fetchImpl?: typeof fetch;
  /**
   * Overrides credential lookup (config -> env list -> auth store). Used by
   * `index.ts` so the frozen `resolveCredential` signature stays authoritative.
   */
  credentialResolver?: (
    providerId: string,
    config: ResolvedConfig,
  ) => Promise<Credential | undefined>;
}

/** What a credential lookup may find: a key, a URL override, or both. */
export interface Credential {
  apiKey?: string;
  baseURL?: string;
}

/** Defaults for a model a user adds in config with only an id. */
const MODEL_DEFAULTS: Omit<ModelInfo, "id" | "name"> = {
  contextWindow: 128_000,
  maxOutput: 8_192,
  supportsTools: true,
  supportsReasoning: false,
};

/** Static catalog before config overrides and credential filtering. */
export function builtinProviderInfos(): ProviderInfo[] {
  return PROVIDER_SEEDS.map((seed) => seed.info);
}

/**
 * Merges `providers.<id>.models` over the built-in catalog. An override may
 * name an existing model (patched in place) or introduce a brand-new one
 * (given sensible defaults). Catalog order is preserved.
 */
export function mergeModelCatalog(
  base: ModelInfo[],
  overrides: Record<string, Partial<ModelInfo>> | undefined,
): ModelInfo[] {
  const models = base.map((model) => ({ ...model }));
  if (!overrides) return models;

  const index = new Map(models.map((model, position) => [model.id, position]));
  for (const [key, patch] of Object.entries(overrides)) {
    if (!patch) continue;
    const existing = index.get(key);
    if (existing !== undefined) {
      const current = models[existing]!;
      models[existing] = { ...current, ...patch, id: patch.id ?? current.id };
      continue;
    }
    models.push({ ...MODEL_DEFAULTS, name: key, ...patch, id: patch.id ?? key });
  }
  return models;
}

/** Applies every config override to one catalog entry. */
export function resolveProviderInfo(seed: ProviderInfo, config: ProviderConfig | undefined): ProviderInfo {
  const info: ProviderInfo = {
    ...seed,
    models: mergeModelCatalog(seed.models, config?.models),
  };
  if (config?.baseURL) info.baseURL = config.baseURL;
  if (config?.keyless) info.keyless = true;
  return info;
}

/** Case-insensitive model lookup within one catalog. */
export function findModel(models: ModelInfo[], modelId: string): ModelInfo | undefined {
  const wanted = modelId.toLowerCase();
  return models.find((entry) => entry.id.toLowerCase() === wanted);
}

/**
 * Built-in credential order: literal config key, `apiKeyEnv`, the provider's
 * env list, then the auth store. Kept here (rather than in index.ts) so the
 * registry works standalone; `index.ts` wraps this as `resolveCredential`.
 */
export async function inlineCredential(
  providerId: string,
  config: ResolvedConfig,
): Promise<{ apiKey?: string; baseURL?: string } | undefined> {
  const providerConfig = config.providers?.[providerId];
  if (providerConfig?.apiKey) return { apiKey: providerConfig.apiKey, baseURL: providerConfig.baseURL };

  if (providerConfig?.apiKeyEnv) {
    const named = process.env[providerConfig.apiKeyEnv];
    if (named) return { apiKey: named, baseURL: providerConfig.baseURL };
  }

  const seed = PROVIDER_SEEDS.find((entry) => entry.info.id === providerId);
  for (const variable of seed?.info.env ?? []) {
    const value = process.env[variable];
    if (value) return { apiKey: value, baseURL: providerConfig?.baseURL };
  }

  const store = await readAuth();
  const entry = store[providerId];
  if (entry?.apiKey) {
    return { apiKey: entry.apiKey, baseURL: entry.baseURL ?? providerConfig?.baseURL };
  }
  const baseURL = providerConfig?.baseURL ?? entry?.baseURL;
  return baseURL ? { baseURL } : undefined;
}

/** Env-var name consulted for a custom (user-added) provider. */
function envFor(id: string): string[] {
  const upper = id.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  return [`${upper}_API_KEY`];
}

export async function createProviderRegistry(
  options: ProviderRegistryOptions,
): Promise<ProviderRegistry> {
  const { config } = options;
  const logger = options.logger ?? nullLogger;
  const fetchImpl = options.fetchImpl;

  const resolveCredential = async (providerId: string): Promise<Credential> => {
    const resolved =
      (await options.credentialResolver?.(providerId, config)) ??
      (await inlineCredential(providerId, config));
    return resolved ?? {};
  };

  const entries: ProviderInfo[] = [];
  const providers = new Map<string, Provider>();

  /** Builds the wire-protocol implementation for one catalog entry. */
  function rawProvider(
    seed: ProviderSeed,
    info: ProviderInfo,
    apiKey?: string,
    baseURLOverride?: string,
  ): Provider {
    const providerConfig = config.providers?.[info.id];
    const scoped = logger.child(`provider:${info.id}`);
    const modelInfo = (modelId: string): ModelInfo | undefined => findModel(info.models, modelId);
    const shared = {
      info,
      baseURL: baseURLOverride ?? info.baseURL ?? "",
      apiKey,
      headers: providerConfig?.headers,
      fetchImpl,
      logger: scoped,
      modelInfo,
    };
    if (seed.kind === "anthropic") return createAnthropicProvider(shared);
    if (seed.kind === "gemini") return createGeminiProvider(shared);
    return createOpenAIProvider({
      ...shared,
      // Only true OpenAI-compatible vendors accept the usage extension.
      streamUsage: seed.info.id === "deepseek" || seed.info.id === "openrouter",
    });
  }

  /**
   * Wraps a keyed provider so the credential is re-resolved before each call.
   * The delegate is rebuilt only when a credential actually exists, which keeps
   * tests (and keyless local servers) on the plain implementation.
   */
  function withCredential(seed: ProviderSeed, info: ProviderInfo): Provider {
    return {
      info,
      async chat(request): Promise<void> {
        const credential = await resolveCredential(info.id);
        const delegate = credential.apiKey
          ? rawProvider(seed, info, credential.apiKey, credential.baseURL)
          : rawProvider(seed, info);
        await delegate.chat(request);
      },
    };
  }

  for (const seed of PROVIDER_SEEDS) {
    const info = resolveProviderInfo(seed.info, config.providers?.[seed.info.id]);
    entries.push(info);
    providers.set(info.id, withCredential(seed, info));
  }

  // Providers a user added in config that we do not ship a protocol for are
  // treated as OpenAI-compatible, which is the de-facto standard.
  for (const [id, providerConfig] of Object.entries(config.providers ?? {})) {
    if (providers.has(id)) continue;
    const info = resolveProviderInfo(
      { id, name: id, env: envFor(id), baseURL: providerConfig.baseURL ?? "https://api.openai.com/v1", models: [] },
      providerConfig,
    );
    entries.push(info);
    providers.set(info.id, withCredential({ kind: "openai", info }, info));
  }

  const byId = new Map(entries.map((info) => [info.id, info]));

  return {
    list(): ProviderInfo[] {
      return entries.map((info) => info);
    },

    get(id: string): Provider | undefined {
      return providers.get(id);
    },

    models(providerId: string): ModelInfo[] {
      return byId.get(providerId)?.models ?? [];
    },

    resolveModel(key: string): ModelRef | undefined {
      const trimmed = key.trim();
      if (!trimmed) return undefined;

      const slash = trimmed.indexOf("/");
      if (slash > 0) {
        const providerId = trimmed.slice(0, slash);
        const modelId = trimmed.slice(slash + 1);
        const info = byId.get(providerId);
        // A multi-slash id (`openrouter/anthropic/claude-...`) keeps its slashes.
        if (!info || !modelId || !findModel(info.models, modelId)) return undefined;
        return { provider: info.id, model: modelId };
      }

      // A bare id resolves against the catalog, in catalog order.
      for (const info of entries) {
        if (findModel(info.models, trimmed)) return { provider: info.id, model: trimmed };
      }
      return undefined;
    },

    async hasCredential(providerId: string): Promise<boolean> {
      const info = byId.get(providerId);
      if (!info) return false;
      if (info.keyless) return true;
      const credential = await resolveCredential(info.id);
      return Boolean(credential.apiKey);
    },

    async available(): Promise<ProviderInfo[]> {
      const out: ProviderInfo[] = [];
      for (const info of entries) {
        if (info.keyless) {
          out.push(info);
          continue;
        }
        const credential = await resolveCredential(info.id);
        if (credential.apiKey) out.push(info);
      }
      return out;
    },
  };
}

export { DEFAULT_PROVIDER_ID };
