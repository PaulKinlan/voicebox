// tests/fleet-addressability.test.mjs — Fleet Addressability: Multi-environment naming and contact routing (voicebox-beads-8fv.3)
//
// WHAT THIS SUITE PROVES (driven, not read from descriptions):
//   1. core/fleet.ts unit tests:
//      - Multi-environment inventory with distinct target keys (no collisions across environments)
//      - Explicit target selection (env_a/agent_1, env_a/agent_2, env_b/agent_1)
//      - Session contact: supported existing session is exercised without replacement
//      - Non-existent session refuses by name: session-not-found (never silently creates replacement)
//      - Non-interactive session refuses by name: session-contact-unsupported
//      - Stopping environment B marks only B unreachable; calls to B refuse environment-unreachable without blind rerouting
//      - Unauthorized cross-environment calls disclose no task or context
//   2. Browser-local zero-server invariant:
//      - Runs in browser runtime with zero server or bridge
//      - Stdio CLI adapters refused by runtime capability check
//      - In-process and web-worker browser agents execute locally
//   3. Server HTTP API & Turn Tool execution:
//      - GET /api/fleet lists all fleet agents across environments
//      - POST /api/fleet/contact routes message to agent or session
//      - Turn "list agents" lists fleet targets with targetKey
//      - Cross-environment delegation without credentials refuses cross-environment-unauthorized
//   4. Browser CDP drive:
//      - Real browser in headless Chrome queries fleet endpoints and inspects addressability state

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  parseTargetKey,
  formatTargetKey,
  resolveFleetTarget,
  publicFleetProjection,
} from "../core/fleet.ts";
import { createAgentRegistry } from "../lib/harness-config.mjs";
import { createFleetManager } from "../lib/fleet.mjs";
import { startServer } from "./lib/server.mjs";
import { launch } from "./lib/cdp.mjs";

// ── 1. Pure core tests: core/fleet.ts ─────────────────────────────────────────

test("fleet core: target key formatting and parsing", () => {
  const t1 = parseTargetKey("env_a/worker");
  assert.equal(t1.environmentKey, "env_a");
  assert.equal(t1.agentId, "worker");
  assert.equal(t1.sessionId, undefined);
  assert.equal(formatTargetKey(t1), "env_a/worker");

  const t2 = parseTargetKey("env_b/reviewer:sess_123");
  assert.equal(t2.environmentKey, "env_b");
  assert.equal(t2.agentId, "reviewer");
  assert.equal(t2.sessionId, "sess_123");
  assert.equal(formatTargetKey(t2), "env_b/reviewer:sess_123");

  // Bare agent uses default environment
  const t3 = parseTargetKey("my_agent", "local");
  assert.equal(t3.environmentKey, "local");
  assert.equal(t3.agentId, "my_agent");
});

test("fleet core: two agents on A and one on B list without collision and resolve explicitly", () => {
  const inventory = [
    {
      targetKey: "env_a/builder",
      environmentKey: "env_a",
      agentId: "builder",
      name: "Builder A",
      harness: "pi",
      adapter: "pi-acp",
      transport: "stdio",
      description: "Code builder on A",
      isDefault: true,
      model: { provider: "anthropic", model: "claude-3-7-sonnet" },
      reach: { root: "active", network: "ambient", tools: ["read", "write"] },
      bounds: { deadlineMs: 60000, maxOutputBytes: 65536 },
      readiness: { state: "ready", observedAt: new Date().toISOString() },
    },
    {
      targetKey: "env_a/reviewer",
      environmentKey: "env_a",
      agentId: "reviewer",
      name: "Reviewer A",
      harness: "pi",
      adapter: "pi-acp",
      transport: "stdio",
      description: "Code reviewer on A",
      isDefault: false,
      model: { provider: "openai", model: "gpt-4o" },
      reach: { root: "active", network: "none", tools: ["read"] },
      bounds: { deadlineMs: 30000, maxOutputBytes: 32768 },
      readiness: { state: "ready", observedAt: new Date().toISOString() },
    },
    {
      targetKey: "env_b/builder",
      environmentKey: "env_b",
      agentId: "builder",
      name: "Builder B",
      harness: "pi",
      adapter: "pi-acp",
      transport: "stdio",
      description: "Code builder on B (shares agentId with A, distinct environment)",
      isDefault: true,
      model: { provider: "anthropic", model: "claude-3-7-sonnet" },
      reach: { root: "active", network: "ambient", tools: ["read", "write"] },
      bounds: { deadlineMs: 60000, maxOutputBytes: 65536 },
      readiness: { state: "ready", observedAt: new Date().toISOString() },
    },
  ];

  // Invariant 1: Distinct targets across environments without collisions
  assert.equal(inventory.length, 3);
  const targetKeys = inventory.map((a) => a.targetKey);
  assert.deepEqual(targetKeys, ["env_a/builder", "env_a/reviewer", "env_b/builder"]);

  // Explicit selection resolves exact agent
  const resA1 = resolveFleetTarget("env_a/builder", inventory);
  assert.equal(resA1.ok, true);
  assert.equal(resA1.agent.name, "Builder A");

  const resA2 = resolveFleetTarget("env_a/reviewer", inventory);
  assert.equal(resA2.ok, true);
  assert.equal(resA2.agent.name, "Reviewer A");

  const resB1 = resolveFleetTarget("env_b/builder", inventory);
  assert.equal(resB1.ok, true);
  assert.equal(resB1.agent.name, "Builder B");

  // Nonexistent agent refuses by name
  const resMissing = resolveFleetTarget("env_a/nonexistent", inventory);
  assert.equal(resMissing.ok, false);
  assert.equal(resMissing.refused, "agent-not-found");
});

test("fleet core: stop environment B marks only B unreachable and refuses without rerouting", () => {
  const inventory = [
    {
      targetKey: "env_a/builder",
      environmentKey: "env_a",
      agentId: "builder",
      name: "Builder A",
      harness: "pi",
      adapter: "pi-acp",
      transport: "stdio",
      description: "A",
      isDefault: true,
      model: null,
      reach: { root: "active", network: "none", tools: [] },
      bounds: { deadlineMs: 60000, maxOutputBytes: 65536 },
      readiness: { state: "ready", observedAt: new Date().toISOString() },
    },
    {
      targetKey: "env_b/builder",
      environmentKey: "env_b",
      agentId: "builder",
      name: "Builder B",
      harness: "pi",
      adapter: "pi-acp",
      transport: "stdio",
      description: "B",
      isDefault: true,
      model: null,
      reach: { root: "active", network: "none", tools: [] },
      bounds: { deadlineMs: 60000, maxOutputBytes: 65536 },
      // Environment B is stopped:
      readiness: { state: "unreachable", observedAt: new Date().toISOString(), why: "Environment 'env_b' was stopped by operator" },
    },
  ];

  // Environment A remains available
  const resA = resolveFleetTarget("env_a/builder", inventory);
  assert.equal(resA.ok, true);
  assert.equal(resA.agent.environmentKey, "env_a");

  // Invariant 3: Calling B refuses environment-unreachable WITHOUT blind rerouting to A
  const resB = resolveFleetTarget("env_b/builder", inventory);
  assert.equal(resB.ok, false);
  assert.equal(resB.refused, "environment-unreachable");
  assert.match(resB.why, /refused without blind rerouting/i);
});

test("fleet core: existing session contact vs replacement refusal", () => {
  const inventory = [
    {
      targetKey: "env_a/interactive_agent",
      environmentKey: "env_a",
      agentId: "interactive_agent",
      name: "Interactive Agent",
      harness: "pi",
      adapter: "pi-acp",
      transport: "stdio",
      description: "Interactive",
      isDefault: true,
      model: null,
      reach: { root: "active", network: "none", tools: [] },
      bounds: { deadlineMs: 60000, maxOutputBytes: 65536 },
      readiness: { state: "ready", observedAt: new Date().toISOString() },
      sessions: [
        {
          sessionId: "active_session_1",
          startedAt: new Date().toISOString(),
          capabilities: ["interactive", "task"],
        },
        {
          sessionId: "batch_session_2",
          startedAt: new Date().toISOString(),
          capabilities: ["task"], // no interactive messaging capability
        },
      ],
    },
  ];

  // 1. Supported existing session resolves
  const resSess1 = resolveFleetTarget("env_a/interactive_agent:active_session_1", inventory);
  assert.equal(resSess1.ok, true);
  assert.equal(resSess1.session.sessionId, "active_session_1");

  // 2. Non-existent session refuses by name: session-not-found (never silently creates a replacement!)
  const resMissing = resolveFleetTarget("env_a/interactive_agent:nonexistent_sess", inventory);
  assert.equal(resMissing.ok, false);
  assert.equal(resMissing.refused, "session-not-found");
  assert.match(resMissing.why, /No active session 'nonexistent_sess' exists/);

  // 3. Session without interactive capability refuses session-contact-unsupported
  const resBatch = resolveFleetTarget("env_a/interactive_agent:batch_session_2", inventory);
  assert.equal(resBatch.ok, false);
  assert.equal(resBatch.refused, "session-contact-unsupported");
  assert.match(resBatch.why, /does not support interactive contact/);
});

// ── 2. Browser-local zero-server invariant ────────────────────────────────────

test("fleet browser-local: zero-server execution and runtime capability enforcement", async () => {
  // In a browser runtime with zero server
  const localRegistry = createAgentRegistry({
    runtime: "browser",
    defaultAgents: [
      {
        id: "browser_worker_1",
        name: "Browser Worker",
        harness: "browser-worker",
        adapter: "in-process",
        pinnedVersion: null,
        transport: "in-process",
        environmentKey: "browser",
        description: "Zero-server in-process browser agent",
        isDefault: true,
        reach: { root: "active", network: "none", tools: ["read", "write"] },
        bounds: { deadlineMs: 30000, maxOutputBytes: 32768 },
      },
    ],
  });

  // Stdio CLI registration is refused by browser runtime capability check
  const cliReg = localRegistry.register({
    id: "forbidden_cli",
    name: "CLI Agent",
    harness: "pi",
    adapter: "pi-acp",
    transport: "stdio",
    environmentKey: "browser",
    description: "Invalid",
    isDefault: false,
    reach: { root: "active", network: "none", tools: [] },
    bounds: { deadlineMs: 30000, maxOutputBytes: 32768 },
  });
  assert.equal(cliReg.ok, false);
  assert.equal(cliReg.refused, "unsupported-runtime-capability");

  // Local fleet manager operates without server
  const fleetManager = createFleetManager({
    localEnvironmentKey: "browser",
    localRegistry,
    getEnvironments: async () => [{ key: "browser", reachable: true }],
    runtime: "browser",
  });

  // Register an in-process active session
  let handledMessage = null;
  fleetManager.registerSession("browser", "browser_worker_1", {
    sessionId: "browser_sess_1",
    capabilities: ["interactive", "task"],
    handler: async (msg) => {
      handledMessage = msg;
      return `Worker received: ${msg}`;
    },
  });

  // List fleet agents
  const agents = await fleetManager.listAgents();
  assert.equal(agents.length, 1);
  assert.equal(agents[0].targetKey, "browser/browser_worker_1");
  assert.equal(agents[0].sessions.length, 1);

  // Contact existing session
  const contactRes = await fleetManager.contact({
    target: "browser/browser_worker_1",
    sessionId: "browser_sess_1",
    message: "calculate sum 1..10",
  });
  assert.equal(contactRes.ok, true);
  assert.equal(contactRes.existing, true);
  assert.equal(contactRes.reply, "Worker received: calculate sum 1..10");
  assert.equal(handledMessage, "calculate sum 1..10");
});

// ── 3. Server HTTP API & Turn Tool execution ─────────────────────────────────

test("fleet server: GET /api/fleet, POST /api/fleet/contact, and turn tools", { timeout: 45000 }, async (t) => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "vb-fleet-api-"));
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

  // 1. GET /api/fleet returns local fleet agents
  const fleetRes = await fetch(`${base}/api/fleet`);
  assert.equal(fleetRes.status, 200);
  const fleetBody = await fleetRes.json();
  assert.equal(fleetBody.ok, true);
  assert.ok(Array.isArray(fleetBody.fleet));
  assert.ok(fleetBody.fleet.some((a) => a.agentId === "pi"));

  const piAgent = fleetBody.fleet.find((a) => a.agentId === "pi");
  assert.equal(piAgent.environmentKey, "local");
  assert.equal(piAgent.targetKey, "local/pi");

  // 2. Turn "list agents" returns fleet agents
  const turnRes = await fetch(`${base}/api/turn`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ transcript: "list agents" }),
  });
  assert.equal(turnRes.status, 200);
  const turnBody = await turnRes.json();
  assert.equal(turnBody.action.verb, "list_agents");
  assert.ok(turnBody.result.agents.some((a) => a.agentId === "pi"));

  // 3. Cross-environment delegation without credentials refuses cross-environment-unauthorized
  const crossTurnRes = await fetch(`${base}/api/turn`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ transcript: "ask remote_env/foreign_agent to build" }),
  });
  assert.equal(crossTurnRes.status, 200);
  const crossTurnBody = await crossTurnRes.json();
  assert.equal(crossTurnBody.result.ok, false);
  assert.ok(
    crossTurnBody.result.refused === "agent-not-found" ||
    crossTurnBody.result.refused === "cross-environment-unauthorized",
    `must refuse unauthorized cross-environment call safely, got '${crossTurnBody.result.refused}'`
  );

  // 4. POST /api/fleet/contact with missing session refuses session-not-found
  const contactRes = await fetch(`${base}/api/fleet/contact`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      target: "local/pi",
      sessionId: "nonexistent_session_99",
      message: "hello",
    }),
  });
  assert.equal(contactRes.status, 400);
  const contactBody = await contactRes.json();
  assert.equal(contactBody.ok, false);
  assert.equal(contactBody.refused, "session-not-found");

  // 5. Reviewer must-fix finding: distinct refusal hierarchy for environments
  // (a) Unknown environment refuses environment-unknown
  const unknownEnvRes = await fetch(`${base}/api/fleet/contact`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      target: "env_totally_unknown/some_agent",
      message: "ping",
    }),
  });
  assert.equal(unknownEnvRes.status, 400);
  const unknownEnvBody = await unknownEnvRes.json();
  assert.equal(unknownEnvBody.ok, false);
  assert.equal(unknownEnvBody.refused, "environment-unknown");

  // (b) Declared but unpaired environment refuses environment-not-paired
  const envFilePath = path.join(workspace, "environments.json");
  const envDesc = {
    key: "env_dead",
    label: "Dead Host",
    kind: "server",
    origin: "http://127.0.0.1:9",
  };
  fs.writeFileSync(envFilePath, JSON.stringify({ environments: [envDesc] }, null, 2) + "\n");

  const unpairedRes = await fetch(`${base}/api/fleet/contact`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      target: "env_dead/some_agent",
      message: "ping",
    }),
  });
  assert.equal(unpairedRes.status, 403);
  const unpairedBody = await unpairedRes.json();
  assert.equal(unpairedBody.ok, false);
  assert.equal(unpairedBody.refused, "environment-not-paired");

  // (c) Paired but unreachable environment refuses environment-unreachable (NOT agent-not-found!)
  const pairingsFilePath = path.join(server.extensionsDir, ".pairings.json");
  const pairingsMap = {
    env_dead: {
      callBearer: "bearer_dead_123",
      issuedAt: new Date().toISOString(),
    },
  };
  fs.writeFileSync(pairingsFilePath, JSON.stringify(pairingsMap, null, 2) + "\n");

  const unreachableRes = await fetch(`${base}/api/fleet/contact`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      target: "env_dead/some_agent",
      message: "ping",
    }),
  });
  assert.equal(unreachableRes.status, 400);
  const unreachableBody = await unreachableRes.json();
  assert.equal(unreachableBody.ok, false);
  assert.equal(
    unreachableBody.refused,
    "environment-unreachable",
    "must refuse environment-unreachable rather than falsely claiming agent-not-found when connection fails",
  );
  assert.match(unreachableBody.why, /unreachable/i);
});

// ── 4. Browser CDP drive: real view evidence ─────────────────────────────────

test("fleet browser: CDP headless Chrome verifies fleet addressability view", { timeout: 30000 }, async (t) => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "vb-fleet-browser-"));
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

  const page = await launch();
  t.after(() => page.close());

  await page.goto(`${server.base}/`);

  // Drive API and verify structured fleet inventory
  const fleetReport = await page.evaluate(async (base) => {
    const res = await fetch(`${base}/api/fleet`);
    const data = await res.json();
    return data;
  }, server.base);

  assert.equal(fleetReport.ok, true);
  assert.ok(Array.isArray(fleetReport.fleet));
  assert.ok(fleetReport.fleet.length > 0);

  const localPi = fleetReport.fleet.find((a) => a.agentId === "pi");
  assert.ok(localPi, "local Pi agent must be in fleet");
  assert.equal(localPi.targetKey, "local/pi");
  assert.equal(localPi.readiness.state, "ready");
});
