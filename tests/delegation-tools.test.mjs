// tests/delegation-tools.test.mjs — Verify list_agents and delegate_task (ask) through commands and resolver (voicebox-beads-8fv.4 & voicebox-beads-gfg)
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { startServer } from "./lib/server.mjs";

const DEFAULT_ADAPTER = path.join(os.homedir(), ".pi/agent/npm/node_modules/pi-acp");
const DEFAULT_PI = "/home/paulkinlan/.local/share/mise/installs/pi/latest/pi/pi";
const adapterDir = process.env.VOICEBOX_ACP_ADAPTER ?? DEFAULT_ADAPTER;
const piBinary = process.env.VOICEBOX_ACP_PI ?? DEFAULT_PI;
const hasAdapter = fs.existsSync(path.join(adapterDir, "dist", "index.js"));
const hasPi = fs.existsSync(piBinary);
const skipRealPi = !hasAdapter || !hasPi ? "pi-acp or pi binary absent on this machine" : false;

async function pollTaskStatus(base, address, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(`${base}/api/task?address=${encodeURIComponent(address)}`);
    if (res.ok) {
      const body = await res.json();
      if (body.task && ["completed", "failed", "cancelled", "interrupted"].includes(body.task.state)) {
        return body.task;
      }
    }
    await delay(250);
  }
  throw new Error(`task ${address} did not settle within ${timeoutMs}ms`);
}

test("list_agents tool and conversational turn return configured agents (D3)", async (t) => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "vb-delegation-list-"));
  const workspace = path.join(scratch, "project");
  fs.mkdirSync(workspace, { recursive: true });

  const server = await startServer({
    env: {
      VOICEBOX_WORKSPACE: workspace,
      VOICEBOX_RESOLVER: "script",
      VOICEBOX_HARNESS: "pi",
    },
  });
  t.after(async () => {
    await server.stop();
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  const base = server.base;

  // 1. Direct GET /api/agents
  const apiRes = await fetch(`${base}/api/agents`);
  assert.equal(apiRes.status, 200);
  const apiBody = await apiRes.json();
  assert.equal(apiBody.ok, true);
  assert.ok(Array.isArray(apiBody.agents));
  assert.ok(apiBody.agents.some((a) => a.id === "pi"));

  // 2. Conversational turn "list agents" via script resolver
  const turnRes = await fetch(`${base}/api/turn`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ transcript: "list agents" }),
  });
  assert.equal(turnRes.status, 200);
  const turnBody = await turnRes.json();
  assert.equal(turnBody.action.verb, "list_agents");
  assert.equal(turnBody.result.ok, true);
  assert.ok(Array.isArray(turnBody.result.agents));
  assert.ok(turnBody.result.agents.some((a) => a.id === "pi"));
  assert.match(turnBody.result.action, /listed \d+ agent\(s\)/);
});

test("delegate_task (ask) via turn: returns handle immediately and executes in background", { skip: skipRealPi, timeout: 90000 }, async (t) => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "vb-delegation-run-"));
  const workspace = path.join(scratch, "project");
  fs.mkdirSync(workspace, { recursive: true });

  const server = await startServer({
    env: {
      VOICEBOX_WORKSPACE: workspace,
      VOICEBOX_RESOLVER: "script",
      VOICEBOX_HARNESS: "pi",
      VOICEBOX_ACP_ADAPTER: adapterDir,
      VOICEBOX_ACP_PI: piBinary,
    },
  });
  t.after(async () => {
    await server.stop();
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  const base = server.base;

  // 1. Send conversational delegation turn: "ask pi to Compute 13 * 17"
  const startT = Date.now();
  const turnRes = await fetch(`${base}/api/turn`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ transcript: "ask pi to Compute 13 * 17. Return only the final number." }),
  });
  const elapsedMs = Date.now() - startT;

  assert.equal(turnRes.status, 200);
  const turnBody = await turnRes.json();
  assert.equal(turnBody.action.verb, "delegate_task");
  assert.equal(turnBody.result.ok, true);
  assert.equal(turnBody.result.task.state, "queued");
  assert.equal(turnBody.result.task.agent, "pi");
  const address = turnBody.result.task.address;
  assert.ok(address.startsWith("task_"));

  // Crucial check: the turn MUST return promptly (within 2 seconds), not block on model completion!
  assert.ok(elapsedMs < 3000, `turn must return handle immediately, took ${elapsedMs}ms`);

  // 2. Poll task status via GET /api/task until completed
  const settled = await pollTaskStatus(base, address);
  assert.equal(settled.state, "completed");
  assert.match(settled.answer, /221/);

  // 3. Delegation to unconfigured agent refuses explicitly before execution
  const unconfiguredTurn = await fetch(`${base}/api/turn`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ transcript: "ask claude to do research" }),
  });
  assert.equal(unconfiguredTurn.status, 200);
  const unconfiguredBody = await unconfiguredTurn.json();
  assert.equal(unconfiguredBody.result.ok, false);
  assert.equal(unconfiguredBody.result.refused, "adapter-not-configured");
  assert.match(unconfiguredBody.result.why, /No Voicebox task adapter is configured for this CLI/);
});
