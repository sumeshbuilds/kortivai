/**
 * Provider layer unit tests.
 *
 * Every test injects a fake `fetch` through `ProviderRegistryOptions.fetchImpl`
 * or the provider factory options — no test touches the network. `KORTIVAI_HOME`
 * is redirected to a temp directory so the auth store never sees the real one.
 */
import { test, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ChatRequest, Provider, ResolvedConfig, StreamEvent, Usage } from "../src/core/types.ts";
import { AuthError, ProviderError } from "../src/util/errors.ts";
import {
  builtinProviderInfos,
  createProviderRegistry,
  readAuth,
  resolveCredential,
  writeAuth,
} from "../src/provider/index.ts";
import { createOpenAIProvider } from "../src/provider/openai.ts";
import { createAnthropicProvider } from "../src/provider/anthropic.ts";
import { createGeminiProvider } from "../src/provider/gemini.ts";
import { iterateSse } from "../src/provider/sse.ts";
import { parseToolArguments } from "../src/provider/shared.ts";

/* ------------------------------------------------------------------ *
 * Harness
 * ------------------------------------------------------------------ */

const originalHome = process.env["KORTIVAI_HOME"];
let scratch = mkdtempSync(join(tmpdir(), "kortivai-provider-"));
process.env["KORTIVAI_HOME"] = scratch;

const KEY_VARS = [
  "DEEPSEEK_API_KEY",
  "OPENROUTER_API_KEY",
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "GOOGLE_API_KEY",
  "GROQ_API_KEY",
  "NVIDIA_API_KEY",
  "NVIDIA_NIM_API_KEY",
  "TOGETHER_API_KEY",
  "OPENCODE_API_KEY",
  "OPENCODE_ZEN_API_KEY",
  "TOKENHARBOR_API_KEY",
];
const savedKeys = new Map<string, string | undefined>(KEY_VARS.map((name) => [name, process.env[name]]));

function baseConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return { cwd: process.cwd(), sources: [], ...overrides };
}

function requestFor(
  provider: string,
  model: string,
  events: StreamEvent[],
  overrides: Partial<ChatRequest> = {},
): ChatRequest {
  return {
    model: { provider, model },
    system: "You are a test.",
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    tools: [],
    onEvent: (event) => events.push(event),
    signal: new AbortController().signal,
    ...overrides,
  };
}

/** A `Response` whose body is fed as discrete, deliberately misaligned chunks. */
function streamResponse(chunks: string[], init: ResponseInit = {}): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, { status: 200, ...init });
}

/** A `fetch` stub that records the requests it was given. */
function fakeFetch(response: Response): { impl: typeof fetch; calls: Array<{ url: string; init?: RequestInit }> } {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(input), init });
    return response;
  }) as typeof fetch;
  return { impl, calls };
}

function textOf(events: StreamEvent[]): string {
  return events
    .filter((event): event is Extract<StreamEvent, { type: "text-delta" }> => event.type === "text-delta")
    .map((event) => event.text)
    .join("");
}

function lastFinish(events: StreamEvent[]): Extract<StreamEvent, { type: "finish" }> | undefined {
  const finishes = events.filter(
    (event): event is Extract<StreamEvent, { type: "finish" }> => event.type === "finish",
  );
  return finishes[finishes.length - 1];
}

function usageOf(events: StreamEvent[]): Usage | undefined {
  const usages = events.filter((event): event is Extract<StreamEvent, { type: "usage" }> => event.type === "usage");
  return usages[usages.length - 1]?.usage;
}

beforeEach(() => {
  for (const name of KEY_VARS) delete process.env[name];
  scratch = mkdtempSync(join(tmpdir(), "kortivai-provider-"));
  process.env["KORTIVAI_HOME"] = scratch;
});

after(() => {
  if (originalHome === undefined) delete process.env["KORTIVAI_HOME"];
  else process.env["KORTIVAI_HOME"] = originalHome;
  for (const [name, value] of savedKeys) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(scratch, { recursive: true, force: true });
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ *
 * SSE parsing
 * ------------------------------------------------------------------ */

test("SSE parsing survives events split across chunk boundaries", async () => {
  const encoder = new TextEncoder();
  const chunks = [
    'data: {"choices":[{"delta":{"content":"He',
    'llo"}}]}\n\ndata: {"choices":[{"delta":{"content":" world"}}]}\n',
    "\n",
    'data: {"choice',
    's":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
  ];
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });

  const payloads: string[] = [];
  for await (const payload of iterateSse(body)) payloads.push(payload);

  assert.equal(payloads.length, 4);
  assert.deepEqual(JSON.parse(payloads[0]!), { choices: [{ delta: { content: "Hello" } }] });
  assert.deepEqual(JSON.parse(payloads[1]!), { choices: [{ delta: { content: " world" } }] });
  assert.deepEqual(JSON.parse(payloads[2]!), { choices: [{ delta: {}, finish_reason: "stop" }] });
  assert.equal(payloads[3], "[DONE]");
});

test("SSE parsing ignores comments and multi-byte characters split across chunks", async () => {
  const encoder = new TextEncoder();
  const payload = 'data: {"choices":[{"delta":{"content":"héllo 🌍"}}]}';
  const bytes = encoder.encode(`${payload}\n\n: keep-alive\n\n`);
  // Slice mid-codepoint on purpose: the decoder must reassemble it.
  const split = 30;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes.slice(0, split));
      controller.enqueue(bytes.slice(split));
      controller.close();
    },
  });

  const payloads: string[] = [];
  for await (const item of iterateSse(body)) payloads.push(item);
  assert.equal(payloads.length, 1);
  const parsed = JSON.parse(payloads[0]!) as { choices: Array<{ delta: { content: string } }> };
  assert.equal(parsed.choices[0]!.delta.content, "héllo 🌍");
});

test("iterateSse stops with an AbortError when the signal fires", async () => {
  const encoder = new TextEncoder();
  const controller = new AbortController();
  const body = new ReadableStream<Uint8Array>({
    start(stream) {
      stream.enqueue(encoder.encode('data: {"a":1}\n\n'));
      // Never closed: the reader must not hang after the abort.
    },
  });

  const iterator = iterateSse(body, controller.signal);
  const first = await iterator.next();
  assert.equal(first.value, '{"a":1}');
  controller.abort();
  await assert.rejects(iterator.next(), (error: unknown) => {
    assert.equal((error as Error).name, "AbortError");
    return true;
  });
});

/* ------------------------------------------------------------------ *
 * OpenAI-compatible streaming
 * ------------------------------------------------------------------ */

test("OpenAI-compatible stream maps text, reasoning, usage and finish", async () => {
  const chunks = [
    'data: {"choices":[{"delta":{"reasoning_content":"think',
    'ing"},"index":0}]}\n\n',
    'data: {"choices":[{"delta":{"content":"Hel',
    'lo"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":" world"},"finish_reason":null}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
    'data: {"choices":[],"usage":{"prompt_tokens":120,"completion_tokens":8,',
    '"prompt_tokens_details":{"cached_tokens":20},"completion_tokens_details":{"reasoning_tokens":3}}}\n\n',
    "data: [DONE]\n\n",
  ];
  const { impl, calls } = fakeFetch(streamResponse(chunks));
  const provider = createOpenAIProvider({
    info: { id: "deepseek", name: "DeepSeek", env: ["DEEPSEEK_API_KEY"], baseURL: "https://api.deepseek.com", models: [] },
    baseURL: "https://api.deepseek.com",
    apiKey: "test-key",
    fetchImpl: impl,
    streamUsage: true,
  });
  const events: StreamEvent[] = [];
  await provider.chat(requestFor("deepseek", "deepseek-chat", events));

  assert.equal(textOf(events), "Hello world");
  const reasoning = events.filter(
    (event): event is Extract<StreamEvent, { type: "reasoning-delta" }> => event.type === "reasoning-delta",
  );
  assert.equal(reasoning.map((event) => event.text).join(""), "thinking");
  assert.deepEqual(usageOf(events), { input: 120, output: 8, reasoning: 3, cacheRead: 20, cacheWrite: 0, cost: 0 });
  assert.equal(lastFinish(events)?.reason, "stop");

  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "https://api.deepseek.com/chat/completions");
  assert.equal(new Headers(calls[0]!.init?.headers).get("authorization"), "Bearer test-key");
  const body = JSON.parse(String(calls[0]!.init?.body)) as Record<string, unknown>;
  assert.equal(body["model"], "deepseek-chat");
  assert.equal(body["stream"], true);
  assert.deepEqual(body["stream_options"], { include_usage: true });
});

test("tool-call arguments accumulate across deltas and parse at flush", async () => {
  const chunks = [
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"read","arguments":"{\\"pa"}}]}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"th\\": \\"src/a.ts\\"}"}}]}}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
    "data: [DONE]\n\n",
  ];
  const { impl } = fakeFetch(streamResponse(chunks));
  const provider = createOpenAIProvider({
    info: { id: "deepseek", name: "DeepSeek", env: [], baseURL: "https://api.deepseek.com", models: [] },
    baseURL: "https://api.deepseek.com",
    apiKey: "k",
    fetchImpl: impl,
  });
  const events: StreamEvent[] = [];
  await provider.chat(requestFor("deepseek", "deepseek-chat", events));

  const calls = events.filter(
    (event): event is Extract<StreamEvent, { type: "tool-call" }> => event.type === "tool-call",
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.callId, "call_1");
  assert.equal(calls[0]!.name, "read");
  assert.deepEqual(calls[0]!.input, { path: "src/a.ts" });
  assert.equal(lastFinish(events)?.reason, "tool-calls");
});

test("a complete tool call with empty arguments is emitted exactly once", async () => {
  const chunks = [
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_9","function":{"name":"git_status","arguments":""}}]}}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
    "data: [DONE]\n\n",
  ];
  const { impl } = fakeFetch(streamResponse(chunks));
  const provider = createOpenAIProvider({
    info: { id: "deepseek", name: "DeepSeek", env: [], baseURL: "https://api.deepseek.com", models: [] },
    baseURL: "https://api.deepseek.com",
    apiKey: "k",
    fetchImpl: impl,
  });
  const events: StreamEvent[] = [];
  await provider.chat(requestFor("deepseek", "deepseek-chat", events));

  const calls = events.filter(
    (event): event is Extract<StreamEvent, { type: "tool-call" }> => event.type === "tool-call",
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.name, "git_status");
  assert.deepEqual(calls[0]!.input, {});
  assert.equal(lastFinish(events)?.reason, "tool-calls");
});

test("DeepSeek's final content chunk carries finish_reason and usage together", async () => {
  // Per DeepSeek's docs the last chunk before [DONE] holds both, with no
  // separate usage-only chunk, and reasoning lives on `reasoning_content`.
  const chunks = [
    'data: {"choices":[{"delta":{"reasoning_content":"pondering"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"answer"}}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":7,"completion_tokens":2,"prompt_cache_hit_tokens":3,"completion_tokens_details":{"reasoning_tokens":5}}}\n\n',
    "data: [DONE]\n\n",
  ];
  const { impl } = fakeFetch(streamResponse(chunks));
  const provider = createOpenAIProvider({
    info: { id: "deepseek", name: "DeepSeek", env: [], baseURL: "https://api.deepseek.com", models: [] },
    baseURL: "https://api.deepseek.com",
    apiKey: "k",
    fetchImpl: impl,
    streamUsage: true,
  });
  const events: StreamEvent[] = [];
  await provider.chat(requestFor("deepseek", "deepseek-reasoner", events));

  assert.equal(textOf(events), "answer");
  assert.equal(usageOf(events)?.input, 7);
  assert.equal(usageOf(events)?.output, 2);
  assert.equal(usageOf(events)?.reasoning, 5);
  assert.equal(usageOf(events)?.cacheRead, 3);
  assert.equal(lastFinish(events)?.reason, "stop");
});

test("usage cost is derived from the model catalog", async () => {  const chunks = [
    'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n',
    'data: {"choices":[],"usage":{"prompt_tokens":1000,"completion_tokens":500}}\n\n',
    "data: [DONE]\n\n",
  ];
  const { impl } = fakeFetch(streamResponse(chunks));
  const provider = createOpenAIProvider({
    info: {
      id: "deepseek",
      name: "DeepSeek",
      env: [],
      baseURL: "https://api.deepseek.com",
      models: [
        {
          id: "deepseek-chat",
          name: "DeepSeek Chat",
          contextWindow: 128_000,
          maxOutput: 8_192,
          supportsTools: true,
          supportsReasoning: false,
          cost: { input: 1, output: 2 },
        },
      ],
    },
    baseURL: "https://api.deepseek.com",
    apiKey: "k",
    fetchImpl: impl,
    modelInfo: (id) => (id === "deepseek-chat" ? undefined : undefined),
  });
  const events: StreamEvent[] = [];
  await provider.chat(requestFor("deepseek", "deepseek-chat", events));

  // 1000 input @ $1/1M + 500 output @ $2/1M
  assert.equal(usageOf(events)?.cost, 0.002);
});

/* ------------------------------------------------------------------ *
 * HTTP error mapping
 * ------------------------------------------------------------------ */

test("HTTP 401 becomes an AuthError carrying an actionable hint", async () => {
  const { impl } = fakeFetch(
    new Response(JSON.stringify({ error: { message: "Authentication Fails" } }), {
      status: 401,
      headers: { "content-type": "application/json" },
    }),
  );
  const provider = createOpenAIProvider({
    info: { id: "deepseek", name: "DeepSeek", env: ["DEEPSEEK_API_KEY"], baseURL: "https://api.deepseek.com", models: [] },
    baseURL: "https://api.deepseek.com",
    apiKey: "bad",
    fetchImpl: impl,
  });

  await assert.rejects(
    provider.chat(requestFor("deepseek", "deepseek-chat", [])),
    (error: unknown) => {
      assert.ok(error instanceof AuthError, `expected AuthError, got ${String(error)}`);
      assert.match(error.message, /Authentication Fails/);
      assert.match(error.hint ?? "", /DEEPSEEK_API_KEY/);
      assert.match(error.hint ?? "", /auth login deepseek/);
      assert.equal(error.retryable, false);
      return true;
    },
  );
});

test("HTTP 429 becomes a retryable ProviderError with status 429", async () => {
  const { impl } = fakeFetch(
    new Response(JSON.stringify({ error: { message: "rate limited" } }), { status: 429 }),
  );
  const provider = createOpenAIProvider({
    info: { id: "deepseek", name: "DeepSeek", env: [], baseURL: "https://api.deepseek.com", models: [] },
    baseURL: "https://api.deepseek.com",
    apiKey: "k",
    fetchImpl: impl,
  });

  await assert.rejects(
    provider.chat(requestFor("deepseek", "deepseek-chat", [])),
    (error: unknown) => {
      assert.ok(error instanceof ProviderError, `expected ProviderError, got ${String(error)}`);
      assert.equal(error.status, 429);
      assert.equal(error.retryable, true);
      assert.ok(error.hint);
      return true;
    },
  );
});

test("a transport failure becomes a retryable ProviderError", async () => {
  const impl = (async () => {
    throw new TypeError("fetch failed");
  }) as typeof fetch;
  const provider = createOpenAIProvider({
    info: { id: "deepseek", name: "DeepSeek", env: [], baseURL: "https://api.deepseek.com", models: [] },
    baseURL: "https://api.deepseek.com",
    apiKey: "k",
    fetchImpl: impl,
  });

  await assert.rejects(
    provider.chat(requestFor("deepseek", "deepseek-chat", [])),
    (error: unknown) => {
      assert.ok(error instanceof ProviderError);
      assert.equal(error.retryable, true);
      assert.match(error.message, /api\.deepseek\.com/);
      return true;
    },
  );
});

test("an already-aborted signal rejects without calling fetch", async () => {
  const { impl, calls } = fakeFetch(streamResponse([]));
  const provider = createOpenAIProvider({
    info: { id: "deepseek", name: "DeepSeek", env: [], baseURL: "https://api.deepseek.com", models: [] },
    baseURL: "https://api.deepseek.com",
    apiKey: "k",
    fetchImpl: impl,
  });
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    provider.chat(requestFor("deepseek", "deepseek-chat", [], { signal: controller.signal })),
    (error: unknown) => (error as Error).name === "AbortError",
  );
  assert.equal(calls.length, 0);
});

/* ------------------------------------------------------------------ *
 * Anthropic + Gemini mapping
 * ------------------------------------------------------------------ */

test("Anthropic stream maps thinking, text, tool input and message_delta usage", async () => {
  const chunks = [
    'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":2000,"cache_read_input_tokens":1000,"cache_creation_input_tokens":100}}}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi "}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"there"}}\n\n',
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"thinking","thinking":""}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"thinking_delta","thinking":"hmm"}}\n\n',
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"toolu_1","name":"bash","input":{}}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{\\"command\\":"}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":" \\"ls -la\\"}"}}\n\n',
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":2}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":140}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ];
  const { impl, calls } = fakeFetch(streamResponse(chunks));
  const provider = createAnthropicProvider({
    info: { id: "anthropic", name: "Anthropic", env: ["ANTHROPIC_API_KEY"], baseURL: "https://api.anthropic.com", models: [] },
    baseURL: "https://api.anthropic.com",
    apiKey: "anthropic-key",
    fetchImpl: impl,
  });
  const events: StreamEvent[] = [];
  await provider.chat(
    requestFor("anthropic", "claude-sonnet-4-5", events, {
      tools: [{ name: "bash", description: "run", parameters: { type: "object", properties: {} } }],
    }),
  );

  assert.equal(textOf(events), "Hi there");
  const reasoning = events
    .filter((event): event is Extract<StreamEvent, { type: "reasoning-delta" }> => event.type === "reasoning-delta")
    .map((event) => event.text)
    .join("");
  assert.equal(reasoning, "hmm");

  const toolCalls = events.filter(
    (event): event is Extract<StreamEvent, { type: "tool-call" }> => event.type === "tool-call",
  );
  assert.equal(toolCalls.length, 1);
  assert.equal(toolCalls[0]!.callId, "toolu_1");
  assert.equal(toolCalls[0]!.name, "bash");
  assert.deepEqual(toolCalls[0]!.input, { command: "ls -la" });

  const usage = usageOf(events);
  assert.equal(usage?.input, 2000);
  assert.equal(usage?.output, 140);
  assert.equal(usage?.cacheRead, 1000);
  assert.equal(usage?.cacheWrite, 100);
  assert.equal(lastFinish(events)?.reason, "tool-calls");

  assert.equal(calls[0]!.url, "https://api.anthropic.com/v1/messages");
  const headers = new Headers(calls[0]!.init?.headers);
  assert.equal(headers.get("x-api-key"), "anthropic-key");
  assert.equal(headers.get("anthropic-version"), "2023-06-01");
  const body = JSON.parse(String(calls[0]!.init?.body)) as { stream?: boolean; system?: string };
  assert.equal(body.stream, true);
  assert.equal(body.system, "You are a test.");
});

test("Gemini stream maps parts, functionCall and usageMetadata", async () => {
  const chunks = [
    'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"Hel"}]}}]}\n\n',
    'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"lo"}]}}]}\n\n',
    'data: {"candidates":[{"content":{"role":"model","parts":[{"functionCall":{"name":"read","args":{"path":"a.ts"}}}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":50,"candidatesTokenCount":9,"thoughtsTokenCount":4}}\n\n',
  ];
  const { impl, calls } = fakeFetch(streamResponse(chunks));
  const provider = createGeminiProvider({
    info: { id: "google", name: "Google Gemini", env: ["GEMINI_API_KEY"], baseURL: "https://generativelanguage.googleapis.com/v1beta", models: [] },
    baseURL: "https://generativelanguage.googleapis.com/v1beta",
    apiKey: "gemini-key",
    fetchImpl: impl,
  });
  const events: StreamEvent[] = [];
  await provider.chat(requestFor("google", "gemini-2.5-flash", events));

  assert.equal(textOf(events), "Hello");
  const toolCalls = events.filter(
    (event): event is Extract<StreamEvent, { type: "tool-call" }> => event.type === "tool-call",
  );
  assert.equal(toolCalls.length, 1);
  assert.equal(toolCalls[0]!.name, "read");
  assert.deepEqual(toolCalls[0]!.input, { path: "a.ts" });
  assert.equal(usageOf(events)?.input, 50);
  assert.equal(usageOf(events)?.output, 13);
  assert.equal(usageOf(events)?.reasoning, 4);
  assert.equal(lastFinish(events)?.reason, "tool-calls");

  assert.match(calls[0]!.url, /models\/gemini-2\.5-flash:streamGenerateContent\?alt=sse$/);
  assert.equal(new Headers(calls[0]!.init?.headers).get("x-goog-api-key"), "gemini-key");
});

test("tolerant tool-argument parsing never throws", () => {
  assert.deepEqual(parseToolArguments("", "call"), {});
  assert.deepEqual(parseToolArguments('{"a":1}', "call"), { a: 1 });
  assert.deepEqual(parseToolArguments('{"a":1', "call"), { a: 1 });
  assert.deepEqual(parseToolArguments('{"inputs":{"b":true}}', "call"), { b: true });
  assert.equal(parseToolArguments("not json at all", "call"), "not json at all");
});

/* ------------------------------------------------------------------ *
 * Registry
 * ------------------------------------------------------------------ */

test("resolveModel accepts provider/model and bare ids, rejecting unknowns", async () => {
  const registry = await createProviderRegistry({ config: baseConfig() });

  assert.deepEqual(registry.resolveModel("deepseek/deepseek-chat"), {
    provider: "deepseek",
    model: "deepseek-chat",
  });
  assert.deepEqual(registry.resolveModel("deepseek-chat"), { provider: "deepseek", model: "deepseek-chat" });
  assert.deepEqual(registry.resolveModel("ollama/qwen2.5-coder:7b"), {
    provider: "ollama",
    model: "qwen2.5-coder:7b",
  });
  assert.deepEqual(registry.resolveModel("openrouter/anthropic/claude-sonnet-4.5"), {
    provider: "openrouter",
    model: "anthropic/claude-sonnet-4.5",
  });
  assert.equal(registry.resolveModel("deepseek/does-not-exist"), undefined);
  assert.equal(registry.resolveModel("nope/nope"), undefined);
  assert.equal(registry.resolveModel(""), undefined);
});

test("config model overrides merge into the catalog and resolve", async () => {
  const registry = await createProviderRegistry({
    config: baseConfig({
      providers: {
        deepseek: {
          models: {
            "deepseek-chat": { contextWindow: 64_000, maxOutput: 4_096 },
            "deepseek-v3.2-exp": { name: "DeepSeek V3.2 Exp", contextWindow: 160_000, supportsReasoning: true },
          },
        },
      },
    }),
  });

  const models = registry.models("deepseek");
  const patched = models.find((model) => model.id === "deepseek-chat");
  assert.equal(patched?.contextWindow, 64_000);
  assert.equal(patched?.maxOutput, 4_096);
  // Untouched fields survive the merge.
  assert.equal(patched?.cost?.input, 0.27);
  assert.equal(patched?.supportsTools, true);

  const added = models.find((model) => model.id === "deepseek-v3.2-exp");
  assert.equal(added?.name, "DeepSeek V3.2 Exp");
  assert.equal(added?.contextWindow, 160_000);
  assert.equal(added?.maxOutput, 8_192, "new models get the documented default maxOutput");
  assert.equal(added?.supportsReasoning, true);

  assert.deepEqual(registry.resolveModel("deepseek/deepseek-v3.2-exp"), {
    provider: "deepseek",
    model: "deepseek-v3.2-exp",
  });
  assert.deepEqual(registry.resolveModel("deepseek-v3.2-exp"), {
    provider: "deepseek",
    model: "deepseek-v3.2-exp",
  });
});

test("explicit config model overrides replace catalog values", async () => {
  const registry = await createProviderRegistry({
    config: baseConfig({
      providers: {
        ollama: { models: { "llama3.1:8b": { contextWindow: 8_192, name: "Tiny" } } },
      },
    }),
  });
  const patched = registry.models("ollama").find((model) => model.id === "llama3.1:8b");
  assert.equal(patched?.contextWindow, 8_192);
  assert.equal(patched?.name, "Tiny");
});

test("config baseURL overrides the built-in endpoint", async () => {
  const { impl, calls } = fakeFetch(streamResponse(['data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n']));
  const registry = await createProviderRegistry({
    config: baseConfig({ providers: { deepseek: { baseURL: "https://proxy.internal/v1" } } }),
    fetchImpl: impl,
  });
  const provider = registry.get("deepseek");
  assert.ok(provider);
  await provider.chat(requestFor("deepseek", "deepseek-chat", []));
  assert.equal(calls[0]!.url, "https://proxy.internal/v1/chat/completions");
});

test("builtinProviderInfos exposes deepseek as the default plus the gateway set", () => {
  const infos = builtinProviderInfos();
  const ids = infos.map((info) => info.id);

  assert.equal(ids[0], "deepseek");
  assert.deepEqual(ids, [
    "deepseek",
    "openrouter",
    "anthropic",
    "google",
    "ollama",
    "groq",
    "nvidia",
    "together",
    "zen",
    "tokenharbor",
  ]);

  const deepseek = infos.find((info) => info.id === "deepseek");
  assert.equal(deepseek?.baseURL, "https://api.deepseek.com");
  assert.deepEqual(deepseek?.env, ["DEEPSEEK_API_KEY"]);
  const chat = deepseek?.models.find((model) => model.id === "deepseek-chat");
  assert.equal(chat?.contextWindow, 128_000);
  assert.equal(chat?.maxOutput, 8_192);
  assert.equal(chat?.cost?.input, 0.27);

  const ollama = infos.find((info) => info.id === "ollama");
  assert.equal(ollama?.keyless, true);
  assert.equal(ollama?.baseURL, "http://127.0.0.1:11434/v1");
  assert.ok((ollama?.models.length ?? 0) > 0);
  assert.ok(ollama?.models.every((model) => (model.cost?.input ?? -1) === 0));

  const openrouter = infos.find((info) => info.id === "openrouter");
  assert.ok(openrouter?.models.every((model) => model.contextWindow > 0 && model.maxOutput > 0));
  assert.ok(openrouter?.models.some((model) => (model.cost?.input ?? 0) > 0));

  const nvidia = infos.find((info) => info.id === "nvidia");
  assert.equal(nvidia?.baseURL, "https://integrate.api.nvidia.com/v1");
  assert.ok((nvidia?.env.length ?? 0) > 0);
});

test("keyless providers are always credential-ready; keyed ones follow env then the store", async () => {
  const config = baseConfig();
  const registry = await createProviderRegistry({ config });

  assert.equal(await registry.hasCredential("ollama"), true);
  assert.equal(await registry.available().then((list) => list.some((info) => info.id === "ollama")), true);
  assert.equal(await registry.hasCredential("deepseek"), false);
  assert.equal(await registry.hasCredential("does-not-exist"), false);

  process.env["DEEPSEEK_API_KEY"] = "env-deepseek";
  assert.equal(await registry.hasCredential("deepseek"), true);
  assert.equal(await resolveCredential("deepseek", config).then((entry) => entry?.apiKey), "env-deepseek");
  delete process.env["DEEPSEEK_API_KEY"];

  await writeAuth({ deepseek: { apiKey: "stored-deepseek", label: "personal" } });
  const stored = await readAuth();
  assert.equal(stored["deepseek"]?.apiKey, "stored-deepseek");
  assert.equal(await registry.hasCredential("deepseek"), true);
  assert.equal(
    await resolveCredential("deepseek", config).then((entry) => entry?.apiKey),
    "stored-deepseek",
  );

  // A literal config key wins over the store.
  const withKey = baseConfig({ providers: { deepseek: { apiKey: "config-key" } } });
  assert.equal(await resolveCredential("deepseek", withKey).then((entry) => entry?.apiKey), "config-key");
});

test("a custom provider id configured in kortivai.json is usable", async () => {
  const { impl, calls } = fakeFetch(streamResponse(['data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n']));
  const registry = await createProviderRegistry({
    config: baseConfig({
      providers: { localgateway: { baseURL: "http://127.0.0.1:9999/v1", apiKey: "local", models: { "my-model": {} } } },
    }),
    fetchImpl: impl,
  });

  assert.deepEqual(registry.resolveModel("localgateway/my-model"), {
    provider: "localgateway",
    model: "my-model",
  });
  assert.equal(registry.models("localgateway")[0]?.id, "my-model");

  const provider = registry.get("localgateway");
  assert.ok(provider);
  const events: StreamEvent[] = [];
  await provider.chat(requestFor("localgateway", "my-model", events));
  assert.equal(calls[0]!.url, "http://127.0.0.1:9999/v1/chat/completions");
  assert.equal(textOf(events), "ok");
});

test("registry.list returns every catalog provider with merged models", async () => {
  const registry = await createProviderRegistry({
    config: baseConfig({ providers: { deepseek: { models: { "deepseek-chat": { maxOutput: 1_000 } } } } }),
  });
  const listed = registry.list();
  assert.equal(listed.length, builtinProviderInfos().length);
  const deepseek = listed.find((info) => info.id === "deepseek");
  assert.equal(deepseek?.models.find((model) => model.id === "deepseek-chat")?.maxOutput, 1_000);
  assert.equal(registry.get("nope"), undefined);
  assert.deepEqual(registry.models("nope"), []);
});

test("providers stream incrementally rather than buffering the response", async () => {
  const encoder = new TextEncoder();
  const seen: string[] = [];
  let release = (): void => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"first"}}]}\n\n'));
      await gate;
      controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"second"},"finish_reason":"stop"}]}\n\n'));
      controller.close();
    },
  });
  const impl = (async () => new Response(body, { status: 200 })) as typeof fetch;

  const provider = createOpenAIProvider({
    info: { id: "deepseek", name: "DeepSeek", env: [], baseURL: "https://api.deepseek.com", models: [] },
    baseURL: "https://api.deepseek.com",
    apiKey: "k",
    fetchImpl: impl,
  });

  const pending = provider.chat(
    requestFor("deepseek", "deepseek-chat", [], {
      onEvent: (event) => {
        if (event.type === "text-delta") seen.push(event.text);
      },
    }),
  );

  // The first delta must be observable while the body is still open.
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(seen, ["first"]);
  release();
  await pending;
  assert.deepEqual(seen, ["first", "second"]);
});
