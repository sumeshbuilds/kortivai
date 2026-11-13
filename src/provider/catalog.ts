/**
 * Built-in provider + model catalog.
 *
 * This is static data only: the effective catalog a caller sees is this table
 * after `config.providers[id].models` overrides are merged (see registry.ts).
 * Cost figures are USD per 1M tokens and are best-effort published list prices —
 * `cost` on a {@link Usage} is always an estimate.
 */
import type { ModelInfo, ProviderInfo } from "../core/types.ts";

/** The wire protocols the provider layer speaks. */
export type ProviderKind = "openai" | "anthropic" | "gemini";

export interface ProviderSeed {
  info: ProviderInfo;
  kind: ProviderKind;
}

function model(init: ModelInfo): ModelInfo {
  return init;
}

/* ------------------------------------------------------------------ *
 * deepseek — the default provider (OpenAI-compatible)
 * ------------------------------------------------------------------ */

const DEEPSEEK_BASE_URL = "https://api.deepseek.com";

const deepseekModels: ModelInfo[] = [
  model({
    id: "deepseek-chat",
    name: "DeepSeek Chat",
    contextWindow: 128_000,
    maxOutput: 8_192,
    supportsTools: true,
    supportsReasoning: false,
    cost: { input: 0.27, output: 1.1, cacheRead: 0.07 },
  }),
  model({
    id: "deepseek-reasoner",
    name: "DeepSeek Reasoner",
    contextWindow: 128_000,
    maxOutput: 65_536,
    supportsTools: true,
    supportsReasoning: true,
    cost: { input: 0.55, output: 2.19, cacheRead: 0.14 },
  }),
];

/* ------------------------------------------------------------------ *
 * Ollama — keyless local server
 * ------------------------------------------------------------------ */

const OLLAMA_BASE_URL = "http://127.0.0.1:11434/v1";

const ollamaModels: ModelInfo[] = [
  model({
    id: "qwen2.5-coder:7b",
    name: "Qwen2.5 Coder 7B (local)",
    contextWindow: 32_768,
    maxOutput: 8_192,
    supportsTools: true,
    supportsReasoning: false,
    cost: { input: 0, output: 0 },
  }),
  model({
    id: "llama3.1:8b",
    name: "Llama 3.1 8B (local)",
    contextWindow: 131_072,
    maxOutput: 8_192,
    supportsTools: true,
    supportsReasoning: false,
    cost: { input: 0, output: 0 },
  }),
  model({
    id: "deepseek-r1:8b",
    name: "DeepSeek R1 8B (local)",
    contextWindow: 65_536,
    maxOutput: 32_768,
    supportsTools: false,
    supportsReasoning: true,
    cost: { input: 0, output: 0 },
  }),
];

/* ------------------------------------------------------------------ *
 * OpenRouter — the richest openai-compatible catalog we ship
 * ------------------------------------------------------------------ */

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

const openrouterModels: ModelInfo[] = [
  model({
    id: "anthropic/claude-sonnet-4.5",
    name: "Claude Sonnet 4.5",
    contextWindow: 200_000,
    maxOutput: 64_000,
    supportsTools: true,
    supportsReasoning: true,
    supportsImages: true,
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  }),
  model({
    id: "openai/gpt-4o-mini",
    name: "GPT-4o mini",
    contextWindow: 128_000,
    maxOutput: 16_384,
    supportsTools: true,
    supportsReasoning: false,
    supportsImages: true,
    cost: { input: 0.15, output: 0.6, cacheRead: 0.075 },
  }),
  model({
    id: "google/gemini-2.5-flash",
    name: "Gemini 2.5 Flash",
    contextWindow: 1_048_576,
    maxOutput: 65_536,
    supportsTools: true,
    supportsReasoning: true,
    supportsImages: true,
    cost: { input: 0.3, output: 2.5 },
  }),
  model({
    id: "deepseek/deepseek-chat",
    name: "DeepSeek V3",
    contextWindow: 128_000,
    maxOutput: 8_192,
    supportsTools: true,
    supportsReasoning: false,
    cost: { input: 0.27, output: 1.1 },
  }),
  model({
    id: "qwen/qwen3-coder",
    name: "Qwen3 Coder",
    contextWindow: 262_144,
    maxOutput: 32_768,
    supportsTools: true,
    supportsReasoning: true,
    cost: { input: 0.2, output: 0.8 },
  }),
  model({
    id: "meta-llama/llama-3.3-70b-instruct",
    name: "Llama 3.3 70B Instruct",
    contextWindow: 131_072,
    maxOutput: 16_384,
    supportsTools: true,
    supportsReasoning: false,
    cost: { input: 0.23, output: 0.4 },
  }),
];

/* ------------------------------------------------------------------ *
 * Other OpenAI-compatible gateways
 * ------------------------------------------------------------------ */

const groqModels: ModelInfo[] = [
  model({
    id: "llama-3.3-70b-versatile",
    name: "Llama 3.3 70B Versatile",
    contextWindow: 131_072,
    maxOutput: 32_768,
    supportsTools: true,
    supportsReasoning: false,
    cost: { input: 0.59, output: 0.79 },
  }),
  model({
    id: "moonshotai/kimi-k2-instruct",
    name: "Kimi K2 Instruct",
    contextWindow: 262_144,
    maxOutput: 16_384,
    supportsTools: true,
    supportsReasoning: false,
    cost: { input: 1, output: 3 },
  }),
];

const nvidiaModels: ModelInfo[] = [
  model({
    id: "deepseek-ai/deepseek-v3.1",
    name: "DeepSeek V3.1 (NIM)",
    contextWindow: 128_000,
    maxOutput: 16_384,
    supportsTools: true,
    supportsReasoning: false,
    cost: { input: 0, output: 0 },
  }),
  model({
    id: "qwen/qwen3-coder-480b-a35b-instruct",
    name: "Qwen3 Coder 480B (NIM)",
    contextWindow: 262_144,
    maxOutput: 32_768,
    supportsTools: true,
    supportsReasoning: true,
    cost: { input: 0, output: 0 },
  }),
];

const togetherModels: ModelInfo[] = [
  model({
    id: "Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8",
    name: "Qwen3 Coder 480B (Together)",
    contextWindow: 262_144,
    maxOutput: 32_768,
    supportsTools: true,
    supportsReasoning: true,
    cost: { input: 2, output: 2 },
  }),
  model({
    id: "deepseek-ai/DeepSeek-V3",
    name: "DeepSeek V3 (Together)",
    contextWindow: 128_000,
    maxOutput: 8_192,
    supportsTools: true,
    supportsReasoning: false,
    cost: { input: 1.25, output: 1.25 },
  }),
];

const zenModels: ModelInfo[] = [
  model({
    id: "claude-sonnet-4-5",
    name: "Claude Sonnet 4.5 (Zen)",
    contextWindow: 200_000,
    maxOutput: 64_000,
    supportsTools: true,
    supportsReasoning: true,
    supportsImages: true,
    cost: { input: 3, output: 15 },
  }),
  model({
    id: "grok-code",
    name: "Grok Code (Zen)",
    contextWindow: 256_000,
    maxOutput: 32_768,
    supportsTools: true,
    supportsReasoning: true,
    cost: { input: 0, output: 0 },
  }),
  model({
    id: "qwen3-coder",
    name: "Qwen3 Coder (Zen)",
    contextWindow: 262_144,
    maxOutput: 32_768,
    supportsTools: true,
    supportsReasoning: false,
    cost: { input: 0, output: 0 },
  }),
];

const tokenharborModels: ModelInfo[] = [
  model({
    id: "deepseek-chat",
    name: "DeepSeek Chat (TokenHarbor)",
    contextWindow: 128_000,
    maxOutput: 8_192,
    supportsTools: true,
    supportsReasoning: false,
    cost: { input: 0.27, output: 1.1 },
  }),
  model({
    id: "gpt-4o-mini",
    name: "GPT-4o mini (TokenHarbor)",
    contextWindow: 128_000,
    maxOutput: 16_384,
    supportsTools: true,
    supportsReasoning: false,
    supportsImages: true,
    cost: { input: 0.15, output: 0.6 },
  }),
];

/* ------------------------------------------------------------------ *
 * First-party protocols
 * ------------------------------------------------------------------ */

const ANTHROPIC_BASE_URL = "https://api.anthropic.com";

const anthropicModels: ModelInfo[] = [
  model({
    id: "claude-sonnet-4-5",
    name: "Claude Sonnet 4.5",
    contextWindow: 200_000,
    maxOutput: 64_000,
    supportsTools: true,
    supportsReasoning: true,
    supportsImages: true,
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  }),
  model({
    id: "claude-haiku-4-5",
    name: "Claude Haiku 4.5",
    contextWindow: 200_000,
    maxOutput: 64_000,
    supportsTools: true,
    supportsReasoning: true,
    supportsImages: true,
    cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  }),
  model({
    id: "claude-opus-4-1",
    name: "Claude Opus 4.1",
    contextWindow: 200_000,
    maxOutput: 32_000,
    supportsTools: true,
    supportsReasoning: true,
    supportsImages: true,
    cost: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  }),
];

const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

const geminiModels: ModelInfo[] = [
  model({
    id: "gemini-2.5-pro",
    name: "Gemini 2.5 Pro",
    contextWindow: 1_048_576,
    maxOutput: 65_536,
    supportsTools: true,
    supportsReasoning: true,
    supportsImages: true,
    cost: { input: 1.25, output: 10 },
  }),
  model({
    id: "gemini-2.5-flash",
    name: "Gemini 2.5 Flash",
    contextWindow: 1_048_576,
    maxOutput: 65_536,
    supportsTools: true,
    supportsReasoning: true,
    supportsImages: true,
    cost: { input: 0.3, output: 2.5 },
  }),
  model({
    id: "gemini-2.5-flash-lite",
    name: "Gemini 2.5 Flash Lite",
    contextWindow: 1_048_576,
    maxOutput: 65_536,
    supportsTools: true,
    supportsReasoning: true,
    supportsImages: true,
    cost: { input: 0.1, output: 0.4 },
  }),
];

/* ------------------------------------------------------------------ *
 * The table
 * ------------------------------------------------------------------ */

/** Static catalog, in list order. `deepseek` is the default provider. */
export const PROVIDER_SEEDS: ProviderSeed[] = [
  {
    kind: "openai",
    info: {
      id: "deepseek",
      name: "DeepSeek",
      env: ["DEEPSEEK_API_KEY"],
      baseURL: DEEPSEEK_BASE_URL,
      models: deepseekModels,
    },
  },
  {
    kind: "openai",
    info: {
      id: "openrouter",
      name: "OpenRouter",
      env: ["OPENROUTER_API_KEY"],
      baseURL: OPENROUTER_BASE_URL,
      models: openrouterModels,
    },
  },
  {
    kind: "anthropic",
    info: {
      id: "anthropic",
      name: "Anthropic",
      env: ["ANTHROPIC_API_KEY"],
      baseURL: ANTHROPIC_BASE_URL,
      models: anthropicModels,
    },
  },
  {
    kind: "gemini",
    info: {
      id: "google",
      name: "Google Gemini",
      env: ["GEMINI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "GOOGLE_API_KEY"],
      baseURL: GEMINI_BASE_URL,
      models: geminiModels,
    },
  },
  {
    kind: "openai",
    info: {
      id: "ollama",
      name: "Ollama (local)",
      env: [],
      baseURL: OLLAMA_BASE_URL,
      keyless: true,
      models: ollamaModels,
    },
  },
  {
    kind: "openai",
    info: {
      id: "groq",
      name: "Groq",
      env: ["GROQ_API_KEY"],
      baseURL: "https://api.groq.com/openai/v1",
      models: groqModels,
    },
  },
  {
    kind: "openai",
    info: {
      id: "nvidia",
      name: "NVIDIA NIM",
      env: ["NVIDIA_API_KEY", "NVIDIA_NIM_API_KEY"],
      baseURL: "https://integrate.api.nvidia.com/v1",
      models: nvidiaModels,
    },
  },
  {
    kind: "openai",
    info: {
      id: "together",
      name: "Together AI",
      env: ["TOGETHER_API_KEY"],
      baseURL: "https://api.together.xyz/v1",
      models: togetherModels,
    },
  },
  {
    kind: "openai",
    info: {
      id: "zen",
      name: "opencode zen",
      env: ["OPENCODE_API_KEY", "OPENCODE_ZEN_API_KEY"],
      baseURL: "https://opencode.ai/zen/v1",
      models: zenModels,
    },
  },
  {
    kind: "openai",
    info: {
      id: "tokenharbor",
      name: "TokenHarbor",
      env: ["TOKENHARBOR_API_KEY"],
      baseURL: "https://api.tokenharbor.ai/v1",
      models: tokenharborModels,
    },
  },
];

/** The provider assumed when no `model` is configured. */
export const DEFAULT_PROVIDER_ID = "deepseek";
