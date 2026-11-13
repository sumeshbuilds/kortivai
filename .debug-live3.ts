import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createKortivRuntime } from "./src/core/wiring.ts";

process.env.KORTIVAI_HOME = await mkdtemp(join(tmpdir(), "dbg3-home-"));
const cwd = await mkdtemp(join(tmpdir(), "dbg3-cwd-"));
await writeFile(join(cwd, "math.js"), "export function add(a, b) {\n  return a - b;\n}\n\nexport function mul(a, b) {\n  return a * b;\n}\n");

const rt = await createKortivRuntime({ cwd, autoApprove: true, skipMcp: true, overrides: { model: "deepseek/deepseek-chat", maxSteps: 10 } });
rt.events.subscribe((e) => {
  if (e.type === "part.update" && e.part.type === "tool") console.log("  [tool]", e.part.name, e.part.status, JSON.stringify(e.part.input).slice(0,140), e.part.error ? "ERR="+String(e.part.error).slice(0,200) : "", e.part.status==="completed" ? "OUT="+String(e.part.output).slice(0,120) : "");
  if (e.type === "agent.error") console.log("  [agent.error]", e.error);
});
const s = await rt.agents.createSession();
const msg = await rt.agents.run({ sessionId: s.id, prompt: "The exported `add` function in math.js is wrong. Fix it so that add(2, 3) returns 5, and change nothing else in the file." });
console.log("=== parts:", msg.parts.map(p => p.type + (p.type === "tool" ? ":" + p.name + ":" + p.status : "")).join(", "));
console.log("=== TEXT:", msg.parts.filter(p=>p.type==="text").map(p=>p.text).join("").slice(0,400));
console.log("=== FILE AFTER ==="); console.log(await readFile(join(cwd, "math.js"), "utf8"));
await rt.close();
