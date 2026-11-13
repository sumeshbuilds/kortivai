import { test } from "node:test";
import assert from "node:assert/strict";
import { createPermissionManager, createPromptAsker } from "../src/permission/index.ts";
import type { PermissionDecision, PermissionRequest } from "../src/core/types.ts";

function request(overrides: Partial<PermissionRequest> = {}): PermissionRequest {
  return {
    sessionId: "ses_test",
    tool: "bash",
    title: "Run shell command",
    detail: "ls -la",
    risk: "low",
    ...overrides,
  };
}

const write = request({ tool: "write", detail: "/proj/src/index.ts", title: "Write src/index.ts" });
const bash = request({ tool: "bash", detail: "ls -la" });
const read = request({ tool: "read", detail: "/proj/src/index.ts" });

test("read-only tools are allowed when no rule has an opinion", async () => {
  const manager = createPermissionManager();
  assert.equal(await manager.check(read), "allow");
});

test("a side-effecting tool with no rule and no asker is denied, never allowed", async () => {
  const manager = createPermissionManager();
  assert.equal(await manager.check(write), "deny");
});

test("autoApprove allows everything without consulting the asker", async () => {
  let asked = 0;
  const manager = createPermissionManager({
    autoApprove: true,
    asker: {
      async ask(): Promise<PermissionDecision> {
        asked += 1;
        return "deny";
      },
    },
  });
  assert.equal(await manager.check(write), "allow");
  assert.equal(asked, 0);
});

test("an explicit allow rule permits a non-read-only tool", async () => {
  const manager = createPermissionManager({ rules: [{ tool: "write", action: "allow" }] });
  assert.equal(await manager.check(write), "allow");
});

test("the most specific matching rule wins over a later tool-only rule", async () => {
  const manager = createPermissionManager({
    rules: [
      { tool: "bash", pattern: "rm -rf *", action: "deny" },
      { tool: "bash", action: "allow" },
    ],
  });
  assert.equal(await manager.check(request({ detail: "rm -rf /" })), "deny");
  assert.equal(await manager.check(bash), "allow");
});

test("bash patterns treat * as matching across /, path patterns stay strict", async () => {
  const bashManager = createPermissionManager({
    rules: [
      { tool: "bash", pattern: "git *", action: "deny" },
      { tool: "bash", action: "allow" },
    ],
  });
  assert.equal(await bashManager.check(request({ detail: "git push origin /tmp/x" })), "deny");
  assert.equal(await bashManager.check(request({ detail: "ls -la" })), "allow");

  const writeManager = createPermissionManager({
    rules: [
      { tool: "write", pattern: "src/*", action: "deny" },
      { tool: "write", action: "allow" },
    ],
  });
  assert.equal(await writeManager.check(request({ tool: "write", detail: "src/index.ts" })), "deny");
  assert.equal(await writeManager.check(request({ tool: "write", detail: "src/deep/a.ts" })), "allow");
});

test("a later rule wins between equally specific matches", async () => {
  const manager = createPermissionManager({
    rules: [
      { tool: "bash", action: "allow" },
      { tool: "bash", action: "deny" },
    ],
  });
  assert.equal(await manager.check(bash), "deny");
});

test("a tool-only rule is not overridden by an earlier pattern rule that does not match", async () => {
  const manager = createPermissionManager({
    rules: [
      { tool: "bash", pattern: "git push *", action: "allow" },
      { tool: "bash", action: "deny" },
    ],
  });
  assert.equal(await manager.check(bash), "deny");
  assert.equal(await manager.check(request({ detail: "git push origin main" })), "allow");
});

test("a wildcard tool rule matches every tool", async () => {
  const manager = createPermissionManager({ rules: [{ tool: "*", action: "deny" }] });
  for (const req of [read, write, bash]) {
    assert.equal(await manager.check(req), "deny");
  }
});

test("patterns are globs over the request detail (posix-normalised)", async () => {
  const manager = createPermissionManager({
    rules: [
      { tool: "read", action: "allow" },
      { tool: "read", pattern: "**/secret/**", action: "deny" },
    ],
  });
  assert.equal(await manager.check(request({ tool: "read", detail: "D:\\proj\\secret\\keys.txt" })), "deny");
  assert.equal(await manager.check(request({ tool: "read", detail: "D:\\proj\\src\\a.ts" })), "allow");
});

test("scope() layers higher-priority rules without mutating the base manager", async () => {
  const base = createPermissionManager({
    rules: [
      { tool: "write", action: "allow" },
      { tool: "bash", action: "allow" },
    ],
  });
  const plan = base.scope([
    { tool: "write", action: "deny" },
    { tool: "bash", action: "deny" },
  ]);

  assert.equal(await base.check(write), "allow");
  assert.equal(await plan.check(write), "deny");
  assert.equal(await plan.check(bash), "deny");
  // The base manager is untouched by the scoped copy.
  assert.equal(await base.check(bash), "allow");
  assert.deepEqual(base.rules(), [
    { tool: "write", action: "allow" },
    { tool: "bash", action: "allow" },
  ]);
});

test("scope() rules of the same specificity override the base rules", async () => {
  const base = createPermissionManager({ rules: [{ tool: "bash", action: "allow" }] });
  const plan = base.scope([{ tool: "bash", action: "ask" }]);
  const denial = base.scope([{ tool: "bash", action: "deny" }]);
  assert.equal(await plan.check(bash), "deny", "ask with no asker denies");
  assert.equal(await denial.check(bash), "deny");
});

test("an asker returning allow-always is remembered and not asked twice", async () => {
  let asked = 0;
  const manager = createPermissionManager({
    asker: {
      async ask(): Promise<PermissionDecision> {
        asked += 1;
        return "allow-always";
      },
    },
  });

  assert.equal(await manager.check(bash), "allow");
  assert.equal(asked, 1);
  assert.equal(await manager.check(bash), "allow");
  assert.equal(asked, 1, "the identical request must not be asked again");
  assert.equal(await manager.check(request({ detail: "ls -la" })), "allow");
});

test("learned answers are shared with scoped managers", async () => {
  let asked = 0;
  const manager = createPermissionManager({
    asker: {
      async ask(): Promise<PermissionDecision> {
        asked += 1;
        return "allow-always";
      },
    },
  });
  await manager.check(bash);
  const scoped = manager.scope([{ tool: "*", action: "deny" }]);
  assert.equal(await scoped.check(bash), "allow", "remembered answers beat the scoped deny");
  assert.equal(asked, 1);
});

test("an asker returning allow allows but is asked again next time", async () => {
  let asked = 0;
  const manager = createPermissionManager({
    asker: {
      async ask(): Promise<PermissionDecision> {
        asked += 1;
        return "allow";
      },
    },
  });
  assert.equal(await manager.check(bash), "allow");
  assert.equal(await manager.check(bash), "allow");
  assert.equal(asked, 2);
});

test("a deny answer from the asker denies the request", async () => {
  const manager = createPermissionManager({
    asker: {
      async ask(): Promise<PermissionDecision> {
        return "deny";
      },
    },
  });
  assert.equal(await manager.check(write), "deny");
});

test("an explicit ask rule with no asker denies instead of silently allowing", async () => {
  const manager = createPermissionManager({ rules: [{ tool: "write", action: "ask" }] });
  assert.equal(await manager.check(write), "deny");
});

test("remember() records an always-answer for an identical request", async () => {
  const manager = createPermissionManager();
  const target = request({ tool: "write", detail: "/proj/src/index.ts" });
  assert.equal(await manager.check(target), "deny");
  manager.remember(target, "project");
  assert.equal(await manager.check(target), "allow");
  // A different detail is still unresolved.
  assert.equal(await manager.check(request({ tool: "write", detail: "/proj/other.ts" })), "deny");
});

test("rules() reports config rules in order, then learned answers", async () => {
  const manager = createPermissionManager({
    rules: [
      { tool: "bash", action: "allow" },
      { tool: "write", action: "deny" },
    ],
  });
  assert.deepEqual(manager.rules(), [
    { tool: "bash", action: "allow" },
    { tool: "write", action: "deny" },
  ]);
  manager.remember(request({ tool: "edit", detail: "src/a.ts" }), "session");
  const rules = manager.rules();
  assert.equal(rules.length, 3);
  assert.deepEqual(rules[2], { tool: "edit", pattern: "src/a.ts", action: "allow" });
});

test("onResolved fires for rule decisions and asker decisions", async () => {
  const seen: string[] = [];
  const manager = createPermissionManager({
    rules: [{ tool: "bash", action: "allow" }],
    onResolved: (req, decision) => seen.push(`${req.tool}:${decision}`),
    asker: {
      async ask(): Promise<PermissionDecision> {
        return "deny";
      },
    },
  });
  await manager.check(bash);
  await manager.check(write);
  assert.deepEqual(seen, ["bash:allow", "write:deny"]);
});

test("createPromptAsker refuses immediately when stdin is not a TTY", async (t) => {
  if (process.stdin.isTTY) {
    t.skip("stdin is a TTY in this environment");
    return;
  }
  const asker = createPromptAsker();
  assert.equal(await asker.ask(request()), "deny");
});
