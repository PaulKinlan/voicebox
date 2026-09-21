// Rate negotiation follows the settings used to create the session, not LIVE_PROVIDER.
// Real server/upgrade, synthetic missing keys, no vendor connection or fixed port.
import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { startServer } from "./lib/server.mjs";

async function serverWith(t, env) {
  const scratch = mkdtempSync(path.join(os.tmpdir(), "vb-rate-frame-"));
  const server = await startServer({ extensionsDir: scratch, env: {
    ...env, GEMINI_API_KEY: "", OPENAI_API_KEY: "", VOICEBOX_WORKSPACE: undefined,
  } });
  t.after(async () => {
    const exited = once(server.child, "exit");
    await server.stop(); await exited;
    rmSync(scratch, { recursive: true, force: true });
  });
  return server;
}

async function firstFrame(server) {
  const ws = new WebSocket(`${server.base.replace("http:", "ws:")}/live`, { headers: { origin: server.base } });
  const first = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no rate frame within 5000ms")), 5000);
    ws.addEventListener("message", e => { clearTimeout(timer); resolve(JSON.parse(e.data)); }, { once: true });
    ws.addEventListener("error", e => { clearTimeout(timer); reject(e); }, { once: true });
  }).finally(() => ws.close());
  return first;
}

test("rate frame: selected OpenAI wins over Gemini environment before any vendor connection", async t => {
  const server = await serverWith(t, { LIVE_PROVIDER: "gemini" });
  const response = await fetch(server.base + "/api/agent-settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: "openai" }) });
  assert.equal(response.status, 200);
  assert.deepEqual(await firstFrame(server), { type: "rate", inputRate: 24000, provider: "openai" });
});

test("rate frame: invalid settings refuse at admission; environment cannot override valid settings", async t => {
  const server = await serverWith(t, { LIVE_PROVIDER: "no-such-provider" });
  const response = await fetch(server.base + "/api/agent-settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: "no-such-provider" }) });
  assert.equal(response.status, 400);
  assert.deepEqual(await firstFrame(server), { type: "rate", inputRate: 16000, provider: "gemini" });
});
