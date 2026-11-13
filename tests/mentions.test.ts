/** Tests for `@path` mention attachment in the interactive UI. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectAttachments,
  extractMentions,
  renderAttachments,
  withAttachments,
} from "../src/cli/mentions.ts";

async function withTempRepo(run: (cwd: string) => Promise<void>): Promise<void> {
  const cwd = await mkdtemp(join(tmpdir(), "kortivai-mentions-"));
  try {
    await run(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

test("extractMentions finds bare and embedded paths, de-duplicated and in order", () => {
  const prompt = "compare @src/a.ts with @src/b.ts and again @src/a.ts please";
  assert.deepEqual(extractMentions(prompt), ["src/a.ts", "src/b.ts"]);
});

test("extractMentions strips trailing punctuation and ignores emails", () => {
  assert.deepEqual(extractMentions("look at @README.md."), ["README.md"]);
  assert.deepEqual(extractMentions("see (@src/x.ts), then stop"), ["src/x.ts"]);
  assert.deepEqual(extractMentions("what is in @secret.txt?"), ["secret.txt"]);
  assert.deepEqual(extractMentions("is @src/a.ts:12 the bug?"), ["src/a.ts:12"]);
  assert.deepEqual(extractMentions("write to me@example.com"), [], "an email is not a mention");
  assert.deepEqual(extractMentions("no mentions here"), []);
});

test("collectAttachments reads real files inside the working directory", async () => {
  await withTempRepo(async (cwd) => {
    await mkdir(join(cwd, "src"), { recursive: true });
    await writeFile(join(cwd, "src", "a.ts"), "export const a = 1;\n");
    await writeFile(join(cwd, "README.md"), "# title\n");

    const attachments = await collectAttachments("look at @src/a.ts and @README.md", cwd);
    assert.equal(attachments.length, 2);
    assert.equal(attachments[0]?.path, "src/a.ts");
    assert.equal(attachments[0]?.content, "export const a = 1;\n");
    assert.equal(attachments[1]?.path, "README.md");
    assert.equal(attachments[0]?.truncated, false);
  });
});

test("collectAttachments skips missing paths, directories and escapes", async () => {
  await withTempRepo(async (cwd) => {
    await mkdir(join(cwd, "src"), { recursive: true });
    const attachments = await collectAttachments(
      "check @src @missing.ts @../../etc/passwd @/etc/hosts",
      cwd,
    );
    assert.deepEqual(attachments, [], "nothing outside cwd and no non-files are attached");
  });
});

test("a long file is truncated and flagged rather than blowing the context", async () => {
  await withTempRepo(async (cwd) => {
    await writeFile(join(cwd, "big.txt"), "x".repeat(70_000));
    const [attachment] = await collectAttachments("read @big.txt", cwd);
    assert.ok(attachment);
    assert.equal(attachment.truncated, true);
    assert.equal(attachment.content.length, 60_000);
    assert.equal(attachment.bytes, 70_000);
  });
});

test("renderAttachments produces a fenced block and withAttachments appends it", () => {
  const attachments = [{ path: "a.ts", content: "const a = 1;", bytes: 12, truncated: false }];
  const rendered = renderAttachments(attachments);
  assert.match(rendered, /<file path="a\.ts">/);
  assert.match(rendered, /const a = 1;/);
  assert.match(rendered, /<\/attached-files>/);

  const prompt = withAttachments("fix @a.ts", attachments);
  assert.ok(prompt.startsWith("fix @a.ts"));
  assert.ok(prompt.includes("<file path=\"a.ts\">"));
});

test("withAttachments leaves the prompt byte-identical when nothing attached", () => {
  assert.equal(withAttachments("just text", []), "just text");
  assert.equal(renderAttachments([]), "");
});
