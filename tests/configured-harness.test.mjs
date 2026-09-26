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

test("admission: a claude agent with a VERIFIED adapter install is ADMITTED, visible in the live table (a74y)", { timeout: 20000 }, async (t) => {
  // The boot/register path for VOICEBOX_HARNESS=claude registers the agent with adapter
  // 'claude-code'; the admission must come from the CLAUDE adapter's own describe — never
  // from the pi adapter's health. The fixture package only needs to LOOK installed (the
  // admission describes, it never spawns).
  const fakeAdapter = fs.mkdtempSync(path.join(os.tmpdir(), "claude-acp-admit-"));
  t.after(() => fs.rmSync(fakeAdapter, { recursive: true, force: true }));
  fs.writeFileSync(path.join(fakeAdapter, "package.json"), JSON.stringify({ name: "@agentclientprotocol/claude-agent-acp", version: "0.78.0" }));
  fs.mkdirSync(path.join(fakeAdapter, "dist"), { recursive: true });
  fs.writeFileSync(path.join(fakeAdapter, "dist", "index.js"), "// fixture\n");

  const f = await taskFixture(t, {
    runtime: false,
    env: {
      VOICEBOX_HARNESS: "claude",
      VOICEBOX_CLAUDE_ACP_ADAPTER: fakeAdapter,
    },
  });
  const base = f.server.base;
  const res = await fetch(`${base}/api/agents`);
  assert.equal(res.status, 200);
  const body = await res.json();
  const claude = (body.agents ?? []).find((a) => a.harness === "claude");
  assert.ok(claude, "the claude agent is registered when VOICEBOX_HARNESS=claude");
  assert.equal(claude.admission.admitted, true, `a verified claude adapter admits the agent: ${JSON.stringify(claude.admission)}`);
  assert.equal(claude.admission.installedVersion, "0.78.0");
});

test("boundary: claude with a broken adapter install refuses by name as adapter-unavailable (a74y)", { timeout: 20000 }, async (t) => {
  // voicebox-beads-a74y: claude HAS an adapter now, so the old 'adapter-not-configured' boundary
  // moved: the refusal that must never regress is a configured-but-missing install failing closed.
  // An explicit VOICEBOX_CLAUDE_ACP_ADAPTER that does not exist refuses adapter-unavailable and
  // NEVER falls through to npx or a real run.
  const f = await taskFixture(t, {
    runtime: false,
    env: {
      VOICEBOX_HARNESS: "pi",
      VOICEBOX_ACP_ADAPTER: adapterDir,
      VOICEBOX_ACP_PI: piBinary,
      VOICEBOX_CLAUDE_ACP_ADAPTER: "/nonexistent/voicebox-a74y-no-such-adapter",
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
  assert.equal(refused.body.refused, "adapter-unavailable");
  assert.match(refused.body.why, /voicebox-a74y-no-such-adapter/);
});

test("boundary: an UNIMPLEMENTED harness (codex) still refuses by name as adapter-not-configured", { timeout: 20000 }, async (t) => {
  const f = await taskFixture(t, {
    runtime: false,
    env: {
      VOICEBOX_HARNESS: "pi",
      VOICEBOX_ACP_ADAPTER: adapterDir,
      VOICEBOX_ACP_PI: piBinary,
    },
  });

  const owner = await f.pair("codex-boundary-owner");
  const base = f.server.base;

  const refused = await freshExecute(base, owner, "delegate_task", {
    agent: "codex",
    task: "do something",
  }, "codex-call");

  assert.equal(refused.status, 403);
  assert.equal(refused.body.ok, false);
  assert.equal(refused.body.refused, "adapter-not-configured");
  assert.match(refused.body.why, /No Voicebox task adapter is implemented for 'codex'/);
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


test("multi-harness coexistence: pi selected, a claude-adapter agent configured — each answered by its own adapter's name (voicebox-beads-aaj, a74y)", { skip: skipRealPi, timeout: 90000 }, async (t) => {
  const f = await taskFixture(t, {
    runtime: false,
    env: {
      VOICEBOX_HARNESS: "pi",
      VOICEBOX_ACP_ADAPTER: adapterDir,
      VOICEBOX_ACP_PI: piBinary,
      // a74y: claude is implemented now, so its verdict comes from ITS adapter's install —
      // pinned broken here so the test never reaches a real CLI/npx download.
      VOICEBOX_CLAUDE_ACP_ADAPTER: "/nonexistent/voicebox-a74y-no-such-adapter",
    },
  });

  const owner = await f.pair("coexistence-owner");
  const base = f.server.base;

  // The machine's own environment key is minted per host — read it from the product's own
  // API: the server registers its own pi agent under the SELF environment at boot.
  const listedBefore = await (await fetch(`${base}/api/agents`)).json();
  const piExisting = listedBefore.agents.find((a) => a.id === "pi");
  assert.ok(piExisting, `the server's own pi agent should be listed: ${JSON.stringify(listedBefore.agents.map((a) => [a.id, a.environmentKey]))}`);
  const selfEnvironment = piExisting.environmentKey;

  // Register a second agent whose adapter has no implementation on this host.
  // Configuring an agent is the HOST's act (x-voicebox-host-token; the page cannot hold it).
  const registered = await fetch(`${base}/api/agents`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-voicebox-host-token": f.server.hostToken },
    body: JSON.stringify({
      id: "agent_claude_reviewer",
      name: "Claude Reviewer",
      harness: "claude",
      adapter: "claude-code",
      transport: "stdio",
      environmentKey: selfEnvironment,
      model: { provider: "anthropic", model: "claude-3-5-haiku" },
    }),
  });
  assert.equal(registered.status, 201, `registering the claude agent failed: ${JSON.stringify(await registered.json())}`);

  // /api/agents carries the startup admission verdict per agent.
  const listed = await fetch(`${base}/api/agents`);
  const listedBody = await listed.json();
  const byId = Object.fromEntries(listedBody.agents.map((a) => [a.id, a]));
  const piRow = byId["pi"];
  assert.ok(piRow, `the pi agent should be listed: ${JSON.stringify(Object.keys(byId))}`);
  assert.equal(piRow.admission.admitted, true, `pi should be admitted: ${JSON.stringify(piRow.admission)}`);
  const claudeRow = byId["agent_claude_reviewer"];
  assert.ok(claudeRow, "the claude agent should be listed");
  assert.equal(claudeRow.admission.admitted, false);
  // a74y: the refusal is the CLAUDE adapter's own verdict (adapter-unavailable naming the
  // claude path), never the generic 'not-configured' of a harness with no executor.
  assert.equal(claudeRow.admission.refused, "adapter-unavailable");

  // Delegating to the claude agent refuses BY NAME at admission — the pi path is untouched.
  const refused = await freshExecute(base, owner, "delegate_task", {
    agent: "agent_claude_reviewer",
    task: "review something",
  }, "claude-agent-call");
  assert.equal(refused.status, 403);
  assert.equal(refused.body.refused, "adapter-unavailable");
  assert.match(refused.body.why, /voicebox-a74y-no-such-adapter/);

  // The selected harness still executes for real through its own adapter.
  const admitted = await freshExecute(base, owner, "delegate_task", {
    agent: "pi",
    task: "Compute 2 * 3. Return only the final number.",
  }, "pi-coexistence-call");
  assert.equal(admitted.status, 200, `pi delegation should be admitted: ${JSON.stringify(admitted.body)}`);
  const terminal = await pollStatus(base, owner, admitted.body.task.address);
  assert.equal(terminal.state, "completed");
  assert.match(terminal.answer, /6/, `expected '6' in answer, got: ${terminal.answer}`);
});
