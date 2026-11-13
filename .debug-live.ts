import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createKortivRuntime } from "./src/core/wiring.ts";

process.env.KORTIVAI_HOME = await mkdtemp(join(tmpdir(), "dbg-home-"));
const cwd = await mkdtemp(join(tmpdir(), "dbg-cwd-"));
await writeFile(join(cwd, "math.js"), "export function add(a, b) {\n  return a - b;\n}\n\nexport function mul(a, b) {\n  return a * b;\n}\n");

const rt = await createKortivRuntime({ cwd, autoApprove: true, skipMcp: true, overrides: { model: "deepseek/deepseek-chat", maxSteps: 12 } });
console.log("providers:", rt.providers.list().map(p => p.id).join(","));
console.log("credential deepseek:", await rt.providers.hasCredential("deepseek"));
rt.events.subscribe((e) => {
  if (e.type === "part.update") {
    const p = e.part;
    if (p.type === "text") console.log("  [text]", JSON.stringify(p.text.slice(-60)));
    if (p.type === "tool") console.log("  [tool]", p.name, p.status, JSON.stringify(p.input).slice(0,160), p.error ? "ERR="+p.error : "");
    if (p.type === "reasoning") console.log("  [reason]", JSON.stringify(p.text.slice(-60)));
  } else if (e.type === "status") console.log("  [status]", e.status, e.detail ?? "");
  else if (e.type === "agent.error") console.log("  [agent.error]", e.error);
  else if (e.type === "permission.resolved") console.log("  [perm]", e.decision, e.request.tool);
  else console.log("  [evt]", e.type);
});
const s = await rt.agents.createSession();
const msg = await rt.agents.run({ sessionId: s.id, prompt: "The exported `add` function in math.js is wrong. Fix it so that add(2, 3) returns 5, and change nothing else in the file." });
console.log("=== message.error:", msg.error);
console.log("=== parts:", msg.parts.map(p => p.type + (p.type === "tool" ? ":" + p.name + ":" + p.status : "")).join(", "));
console.log("=== FILE AFTER ===");
console.log(await readFile(join(cwd, "math.js"), "utf8"));
await rt.close();
