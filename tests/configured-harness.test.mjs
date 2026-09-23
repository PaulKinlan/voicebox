// tests/configured-harness.test.mjs — End-to-end configured harness execution (voicebox-beads-f1b)
//
// Acceptance: configure a harness and reach it through the product's own path:
//   delegate_task -> admitted task host -> ACP client -> pi-acp adapter -> pi coding agent -> answer back.
//
// Also proves boundary: unconfigured harnesses (Claude) refuse by name (adapter-not-configured),
// and an unconfigured server refuses with executor-unavailable.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { startServer } from "./lib/server.mjs";
import { freshExecute, taskFixture } from "./lib/task-fixture.mjs";

const DEFAULT_ADAPTER = path.join(os.homedir(), ".pi/agent/npm/node_modules/pi-acp");
const DEFAULT_PI = "/home/paulkinlan/.local/share/mise/installs/pi/latest/pi/pi";
const adapterDir = process.env.VOICEBOX_ACP_ADAPTER ?? DEFAULT_ADAPTER;
const piBinary = process.env.VOICEBOX_ACP_PI ?? DEFAULT_PI;

const hasAdapter = fs.existsSync(path.join(adapterDir, "dist", "index.js"));
const hasPi = fs.existsSync(piBinary);
const skipRealPi = !hasAdapter || !hasPi ? "pi-acp or pi binary absent on this machine" : false;

async function pollStatus(base, owner, address, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await freshExecute(base, owner, "task_status", { address }, "status-poll");
    if (last.body?.task && ["completed", "failed", "cancelled", "interrupted"].includes(last.body.task.state)) {
      return last.body.task;
    }
    await delay(250);
  }
  throw new Error(`task ${address} did not reach terminal state within ${timeoutMs}ms; last: ${JSON.stringify(last?.body)}`);
}

test("configured harness: end-to-end delegate_task reaches Pi via pi-acp adapter and returns answer", { skip: skipRealPi, timeout: 90000 }, async (t) => {
  const f = await taskFixture(t, {
    runtime: false,
    env: {
      VOICEBOX_HARNESS: "pi",
      VOICEBOX_ACP_ADAPTER: adapterDir,
      VOICEBOX_ACP_PI: piBinary,
    },
  });

  const owner = await f.pair("configured-pi-owner");
  const base = f.server.base;

  // 1. Delegate a computation task to Pi
  const admitted = await freshExecute(base, owner, "delegate_task", {
    agent: "pi",
    task: "Compute 13 * 17. Return only the final number.",
  }, "pi-calc-call");

  assert.equal(admitted.status, 200);
  assert.equal(admitted.body.ok, true, `admission failed: ${JSON.stringify(admitted.body)}`);
  assert.equal(admitted.body.task.state, "queued");
  assert.equal(admitted.body.task.agent, "pi");
  const address = admitted.body.task.address;
  assert.ok(address.startsWith("task_"));

  // 2. Poll status until completed
  const terminal = await pollStatus(base, owner, address);
  assert.equal(terminal.state, "completed");
  assert.match(terminal.answer, /221/, `expected '221' in answer, got: ${terminal.answer}`);

  // 3. Durable audit record exists in the workspace
  const auditDir = path.join(f.workspace, ".audit");
  assert.ok(fs.existsSync(auditDir), "audit directory must exist");
  const auditFiles = fs.readdirSync(auditDir).filter((f) => f.endsWith(".jsonl"));
  assert.ok(auditFiles.length > 0, "audit entries must be persisted");
  const entries = auditFiles.flatMap((f) => fs.readFileSync(path.join(auditDir, f), "utf8").trim().split("\n").map(JSON.parse));
  const completedEntry = entries.find((e) => e.task?.address === address && e.task?.state === "completed");
  assert.ok(completedEntry, "terminal completed state must be durably recorded in audit");
  assert.match(completedEntry.task.answer, /221/);
  const queuedEntry = entries.find((e) => e.task?.address === address && e.task?.created?.mechanism);
  assert.ok(queuedEntry, "created task record must record execution mechanism");
  assert.match(queuedEntry.task.created.mechanism, /stdio-acp-client: pi-acp adapter/);
});

test("boundary: unconfigured harness (Claude) refuses by name as adapter-not-configured", { timeout: 20000 }, async (t) => {
  const f = await taskFixture(t, {
    runtime: false,
    env: {
      VOICEBOX_HARNESS: "pi",
      VOICEBOX_ACP_ADAPTER: adapterDir,
      VOICEBOX_ACP_PI: piBinary,
    },
  });

  const owner = await f.pair("claude-boundary-owner");
  const base = f.server.base;

  const refused = await freshExecute(base, owner, "delegate_task", {
    agent: "claude",
    task: "do something",
  }, "claude-call");

  assert.equal(refused.status, 403);
  assert.equal(refused.body.ok, false);
  assert.equal(refused.body.refused, "adapter-not-configured");
  assert.match(refused.body.why, /No Voicebox task adapter is configured for this CLI/);
});

test("boundary: unconfigured server (VOICEBOX_HARNESS unset) refuses with executor-unavailable", { timeout: 20000 }, async (t) => {
  const f = await taskFixture(t, { runtime: false });
  const owner = await f.pair("unconfigured-owner");
  const base = f.server.base;

  const refused = await freshExecute(base, owner, "delegate_task", {
    agent: "pi",
    task: "do something",
  }, "unconfigured-pi-call");

  assert.equal(refused.status, 403);
  assert.equal(refused.body.ok, false);
  assert.equal(refused.body.refused, "executor-unavailable");
  assert.match(refused.body.why, /no admitted task executor/);
});

test("cancellation honesty: cancel_task aborts in-flight task and records cancelled", { skip: skipRealPi, timeout: 30000 }, async (t) => {
  const f = await taskFixture(t, {
    runtime: false,
    env: {
      VOICEBOX_HARNESS: "pi",
      VOICEBOX_ACP_ADAPTER: adapterDir,
      VOICEBOX_ACP_PI: piBinary,
    },
  });

  const owner = await f.pair("cancel-owner");
  const base = f.server.base;

  const admitted = await freshExecute(base, owner, "delegate_task", {
    agent: "pi",
    task: "Write a 50000-word detailed essay covering the history of every computing device ever invented.",
  }, "long-task-call");

  assert.equal(admitted.status, 200);
  assert.equal(admitted.body.ok, true);
  const address = admitted.body.task.address;

  // Wait briefly for task to start initializing / running
  await delay(200);

  // Send cancel_task
  const cancel = await freshExecute(base, owner, "cancel_task", { address }, "cancel-call");
  assert.equal(cancel.status, 200);
  assert.equal(cancel.body.ok, true);

  // Verify terminal state settles to cancelled
  const terminal = await pollStatus(base, owner, address, 15000);
  assert.equal(terminal.state, "cancelled");
  assert.equal(terminal.reason, "task-cancelled");
});

