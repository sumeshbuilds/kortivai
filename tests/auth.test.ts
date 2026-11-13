/** Tests for `kortivai auth` — credential resolution and store edits (pure parts). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { credentialSource, normalizeKey, withEntry, withoutEntry } from "../src/cli/cmd/auth.ts";
import type { ProviderInfo } from "../src/core/types.ts";

function provider(overrides: Partial<ProviderInfo>): ProviderInfo {
  return {
    id: "deepseek",
    name: "DeepSeek",
    env: ["DEEPSEEK_API_KEY"],
    models: [],
    ...overrides,
  } as ProviderInfo;
}

test("a keyless provider never needs a credential", () => {
  const result = credentialSource(provider({ keyless: true }), {}, {});
  assert.equal(result.source, "not-needed");
});

test("an environment variable wins over the stored key", () => {
  const result = credentialSource(provider({}), { DEEPSEEK_API_KEY: "sk-env" }, {
    deepseek: { apiKey: "sk-stored" },
  });
  assert.equal(result.source, "env");
  assert.equal(result.detail, "DEEPSEEK_API_KEY");
});

test("a stored key is reported when no environment variable is set", () => {
  const result = credentialSource(provider({}), {}, { deepseek: { apiKey: "sk-stored" } });
  assert.equal(result.source, "stored");
});

test("no env and no store means the credential is missing", () => {
  assert.equal(credentialSource(provider({}), {}, {}).source, "missing");
  assert.equal(
    credentialSource(provider({}), { DEEPSEEK_API_KEY: "   " }, {}).source,
    "missing",
    "a blank variable does not count",
  );
});

test("any one of a provider's env names is enough", () => {
  const gemini = provider({ id: "google", env: ["GEMINI_API_KEY", "GOOGLE_API_KEY"] });
  assert.equal(credentialSource(gemini, { GOOGLE_API_KEY: "k-123456" }, {}).source, "env");
  assert.equal(credentialSource(gemini, {}, {}).source, "missing");
});

test("normalizeKey trims a pasted key", () => {
  assert.equal(normalizeKey("  sk-abcdef123456  \n"), "sk-abcdef123456");
});

test("normalizeKey rejects empty, whitespace-containing and short values", () => {
  assert.throws(() => normalizeKey("   "), /No API key/);
  assert.throws(() => normalizeKey("sk-abc def ghi"), /whitespace/);
  assert.throws(() => normalizeKey("short"), /too short/);
});

test("withEntry merges without mutating the original store", () => {
  const store = { deepseek: { apiKey: "old", label: "work" } };
  const next = withEntry(store, "deepseek", { apiKey: "new" });
  assert.equal(next.deepseek?.apiKey, "new");
  assert.equal(next.deepseek?.label, "work", "other fields survive");
  assert.equal(store.deepseek.apiKey, "old", "the input is untouched");

  const added = withEntry(store, "groq", { apiKey: "g" });
  assert.deepEqual(Object.keys(added).sort(), ["deepseek", "groq"]);
});

test("withoutEntry removes only the named provider", () => {
  const store = { deepseek: { apiKey: "a" }, groq: { apiKey: "b" } };
  const next = withoutEntry(store, "deepseek");
  assert.deepEqual(Object.keys(next), ["groq"]);
  assert.deepEqual(Object.keys(store), ["deepseek", "groq"], "the input is untouched");
  assert.deepEqual(withoutEntry({}, "deepseek"), {});
});
