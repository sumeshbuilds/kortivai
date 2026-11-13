import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createKortivRuntime } from "./src/core/wiring.ts";

process.env.KORTIVAI_HOME = await mkdtemp(join(tmpdir(), "dbg2-home-"));
const cwd = await mkdtemp(join(tmpdir(), "dbg2-cwd-"));
await writeFile(join(cwd, "math.js"), "export function add(a, b) {\n  return a - b;\n}\n");

let captured = "";
const spy = async (url, init) => {
  const body = init?.body ? JSON.parse(String(init.body)) : {};
  captured = body;
  console.log(">>> URL:", String(url));
  console.log(">>> body keys:", Object.keys(body).join(","));
  console.log(">>> model:", body.model);
  console.log(">>> tools count:", Array.isArray(body.tools) ? body.tools.length : "NONE");
  console.log(">>> tools[0]:", JSON.stringify(body.tools?.[0])?.slice(0, 300));
  console.log(">>> system chars:", body.messages?.[0]?.content?.length ?? 0);
  console.log(">>> headers:", Object.keys(init?.headers ?? {}).join(","));
  return fetch(url, init);
};

const rt = await createKortivRuntime({ cwd, autoApprove: true, skipMcp: true, fetchImpl: spy, overrides: { model: "deepseek/deepseek-chat", maxSteps: 6 } });
const s = await rt.agents.createSession();
await rt.agents.run({ sessionId: s.id, prompt: "Fix the add function in math.js so add(2,3) is 5." });
console.log("=== tool_choice:", captured.tool_choice);
await rt.close();
