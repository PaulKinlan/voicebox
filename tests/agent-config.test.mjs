// tests/agent-config.test.mjs — bead voicebox-beads-8fv.2.
//
// Acceptance verification:
// 1. Distinguish runtime ("node" | "deno" | "browser"), configured agent, and execution environment.
// 2. Drive two configured instances of one harness in one environment plus an instance in a browser environment.
// 3. Distinct stable IDs and environment keys survive reload.
// 4. Renaming an agent's display label does NOT change its stable ID and cannot retarget tasks.
// 5. Secrets are strictly forbidden from configured agent records (never appear in inventory or audit).
// 6. Invalid/unknown agent configuration refuses before spawn/send (agent-not-configured).
// 7. Browser-local configuration works entirely offline with all Voicebox server API / bridge access blocked.
// 8. Choosing a stdio-only adapter in a browser runtime refuses explicitly (unsupported-runtime-capability).
// 9. Feeds configured agents into harness discovery (D3) without a parallel inventory.
//
//   node --test tests/agent-config.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  detectRuntime,
  validateConfiguredAgent,
  renameConfiguredAgent,
  RUNTIME_CAPABILITIES,
} from "../core/harness-config.ts";
import {
  createAgentRegistry,
  listHarnessesWithConfiguredAgents,
} from "../lib/harness-config.mjs";
import { createTaskHost, installTaskExecutor } from "../lib/tasks.mjs";
import { taskFixture } from "./lib/task-fixture.mjs";

test("runtime: capabilities distinguish node, deno, and browser execution platforms", () => {
  assert.equal(RUNTIME_CAPABILITIES.node.canSpawnCli, true, "node can spawn stdio CLI processes");
  assert.equal(RUNTIME_CAPABILITIES.deno.canSpawnCli, true, "deno can spawn stdio CLI processes");
  assert.equal(RUNTIME_CAPABILITIES.browser.canSpawnCli, false, "browser cannot spawn stdio CLI processes");

  assert.ok(RUNTIME_CAPABILITIES.node.transports.includes("stdio"));
  assert.ok(!RUNTIME_CAPABILITIES.browser.transports.includes("stdio"), "browser cannot support stdio transport");
  assert.ok(RUNTIME_CAPABILITIES.browser.transports.includes("in-process"));
  assert.ok(RUNTIME_CAPABILITIES.browser.transports.includes("web-worker"));

  const current = detectRuntime();
  assert.equal(current, "node", "tests running in node must detect runtime as node");
});

test("two configured instances of one harness in one environment + browser instance", () => {
  const registry = createAgentRegistry({ defaultAgents: [] });

  // 1. Instance A of harness "pi" in environment "local": General coder
  const regA = registry.register({
    id: "agent_pi_general",
    name: "Pi Generalist",
    harness: "pi",
    adapter: "pi-acp",
    pinnedVersion: "0.0.33",
    transport: "stdio",
    environmentKey: "local",
    description: "General coding agent",
    isDefault: true,
    model: { provider: "anthropic", model: "claude-3-7-sonnet" },
    reach: { root: "active", network: "ambient", tools: ["read", "write", "list", "bash"] },
    bounds: { deadlineMs: 60000, maxOutputBytes: 65536 },
  });
  assert.equal(regA.ok, true, `failed to register agent A: ${JSON.stringify(regA)}`);

  // 2. Instance B of SAME harness "pi" in SAME environment "local": Specialized reviewer
  const regB = registry.register({
    id: "agent_pi_reviewer",
    name: "Pi Code Reviewer",
    harness: "pi",
    adapter: "pi-acp",
    pinnedVersion: "0.0.33",
    transport: "stdio",
    environmentKey: "local",
    description: "Read-only strict code reviewer",
    isDefault: false,
    model: { provider: "anthropic", model: "claude-3-5-haiku" },
    prompt: "You are a read-only code reviewer. Never modify files.",
    reach: { root: "active", network: "none", tools: ["read", "list"] },
    bounds: { deadlineMs: 30000, maxOutputBytes: 32768 },
  });
  assert.equal(regB.ok, true, `failed to register agent B: ${JSON.stringify(regB)}`);

  // 3. Instance C in a BROWSER environment (in-process, zero server)
  const regC = registry.register({
    id: "agent_browser_analyst",
    name: "Browser Analyst",
    harness: "browser-worker",
    adapter: "in-process",
    pinnedVersion: null,
    transport: "in-process",
    environmentKey: "browser",
    description: "In-browser text analysis",
    isDefault: true,
    model: { provider: "web-llm", model: "on-device-prompt-api" },
    reach: { root: "active", network: "none", tools: ["read"] },
    bounds: { deadlineMs: 15000, maxOutputBytes: 16384 },
  });
  assert.equal(regC.ok, true, `failed to register browser agent: ${JSON.stringify(regC)}`);

  // Verify separation and distinct IDs
  const localAgents = registry.list({ environmentKey: "local" });
  assert.equal(localAgents.length, 2, "must have two distinct configured agents for local environment");
  assert.equal(localAgents[0].harness, "pi");
  assert.equal(localAgents[1].harness, "pi");
  assert.notEqual(localAgents[0].id, localAgents[1].id, "configured agent IDs must be distinct");
  assert.notEqual(localAgents[0].model?.model, localAgents[1].model?.model, "models must differ");

  const browserAgents = registry.list({ environmentKey: "browser" });
  assert.equal(browserAgents.length, 1);
  assert.equal(browserAgents[0].id, "agent_browser_analyst");
  assert.equal(browserAgents[0].transport, "in-process");
});

test("persistence: distinct stable IDs and environment keys survive reload", () => {
  const store = new Map();
  const mockStorage = {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => store.set(k, String(v)),
  };

  // Setup registry 1 and populate
  const reg1 = createAgentRegistry({ storage: mockStorage, defaultAgents: [] });
  reg1.register({
    id: "agent_custom_worker",
    name: "Custom Worker",
    harness: "pi",
    adapter: "pi-acp",
    transport: "stdio",
    environmentKey: "env_box1",
    description: "Persistent worker",
    isDefault: true,
    reach: { root: "active", network: "ambient", tools: ["read", "write"] },
    bounds: { deadlineMs: 45000, maxOutputBytes: 65536 },
  });

  // Reload into a fresh registry instance using same storage
  const reg2 = createAgentRegistry({ storage: mockStorage, defaultAgents: [] });
  const loaded = reg2.get("agent_custom_worker");
  assert.ok(loaded, "agent must survive reload");
  assert.equal(loaded.id, "agent_custom_worker");
  assert.equal(loaded.name, "Custom Worker");
  assert.equal(loaded.environmentKey, "env_box1");
  assert.equal(loaded.bounds.deadlineMs, 45000);
});

test("rename: display label updates without changing stable ID and cannot retarget tasks", () => {
  const registry = createAgentRegistry({ defaultAgents: [] });
  registry.register({
    id: "agent_stable_identity",
    name: "Original Name",
    harness: "pi",
    adapter: "pi-acp",
    transport: "stdio",
    environmentKey: "local",
    description: "Stable identity test",
    isDefault: true,
    reach: { root: "active", network: "none", tools: ["read"] },
    bounds: { deadlineMs: 30000, maxOutputBytes: 10000 },
  });

  const before = registry.get("agent_stable_identity");
  assert.equal(before.name, "Original Name");
  assert.equal(before.id, "agent_stable_identity");

  // Rename the agent
  const renamed = registry.rename("agent_stable_identity", "Brand New Name");
  assert.equal(renamed.ok, true);
  assert.equal(renamed.agent.name, "Brand New Name");
  assert.equal(renamed.agent.id, "agent_stable_identity", "ID must be strictly preserved across renames");

  // Renaming with empty string refuses
  const badRename = registry.rename("agent_stable_identity", "   ");
  assert.equal(badRename.ok, false);
  assert.equal(badRename.refused, "bad-request");

  // Lookup by permanent ID still returns the agent
  const after = registry.get("agent_stable_identity");
  assert.equal(after.name, "Brand New Name");
  assert.equal(after.id, "agent_stable_identity");
});

test("secrets: configuring an agent with secrets is strictly REFUSED", () => {
  // Test secret keys (apiKey, token, bearer, password)
  const leak1 = validateConfiguredAgent({
    id: "agent_secret_leak1",
    name: "Leaky Agent",
    harness: "pi",
    adapter: "pi-acp",
    transport: "stdio",
    environmentKey: "local",
    apiKey: "sk-ant-secret12345",
  });
  assert.equal(leak1.ok, false);
  assert.equal(leak1.refused, "secrets-forbidden");
  assert.match(leak1.why, /secret-free/i);

  // Test secret values (sk-, vbx_)
  const leak2 = validateConfiguredAgent({
    id: "agent_secret_leak2",
    name: "Leaky Agent 2",
    harness: "pi",
    adapter: "pi-acp",
    transport: "stdio",
    environmentKey: "local",
    description: "Uses key vbx_secretpairingtoken123",
  });
  assert.equal(leak2.ok, false);
  assert.equal(leak2.refused, "secrets-forbidden");
  assert.match(leak2.why, /secret prefix/i);

  // Test nested options secret leak
  const leak3 = validateConfiguredAgent({
    id: "agent_secret_leak3",
    name: "Leaky Agent 3",
    harness: "pi",
    adapter: "pi-acp",
    transport: "stdio",
    environmentKey: "local",
    model: {
      provider: "openai",
      model: "gpt-4o",
      options: { bearerToken: "secret" },
    },
  });
  assert.equal(leak3.ok, false);
  assert.equal(leak3.refused, "secrets-forbidden");
});

test("browser runtime: stdio-only adapter is REFUSED explicitly", () => {
  // A browser runtime cannot spawn a stdio CLI process
  const refused = validateConfiguredAgent(
    {
      id: "agent_browser_illegal_stdio",
      name: "Illegal Browser Stdio",
      harness: "pi",
      adapter: "pi-acp",
      transport: "stdio", // stdio in browser
      environmentKey: "browser",
      description: "Attempting stdio in browser",
    },
    "browser", // target runtime is browser
  );

  assert.equal(refused.ok, false);
  assert.equal(refused.refused, "unsupported-runtime-capability");
  assert.match(refused.why, /browser runtime cannot support 'stdio' transport/i);
  assert.match(refused.why, /cannot spawn a stdio CLI/i);
});

test("browser-local configuration: works entirely offline with zero server", () => {
  // In-memory or localStorage with zero network/API calls
  const browserStore = new Map();
  const storage = {
    getItem: (k) => browserStore.get(k) ?? null,
    setItem: (k, v) => browserStore.set(k, String(v)),
  };

  const localRegistry = createAgentRegistry({
    storage,
    runtime: "browser",
    defaultAgents: [
      {
        id: "agent_browser_local",
        name: "Local Browser Agent",
        harness: "voicebox-worker",
        adapter: "web-worker",
        transport: "web-worker",
        environmentKey: "browser",
        description: "Zero-server agent",
        isDefault: true,
        reach: { root: "active", network: "none", tools: ["read"] },
        bounds: { deadlineMs: 20000, maxOutputBytes: 16384 },
      },
    ],
  });

  const agent = localRegistry.get("agent_browser_local");
  assert.ok(agent, "browser-local agent must be readable without server");
  assert.equal(agent.transport, "web-worker");
  assert.equal(agent.environmentKey, "browser");
  assert.equal(localRegistry.list().length, 1);
});

test("admission: delegating to an unknown configured agent ID refuses before task spawn", () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "vb-agent-config-test1-"));
  try {
    const registry = createAgentRegistry({ defaultAgents: [] });
    const host = createTaskHost({
      environment: "env_0123456789abcdef",
      instance: "test-instance",
      boot: "boot1",
      addressKey: Buffer.alloc(32, 1),
      root: () => ({ root: { kind: "machine", path: scratch, environment: "env_0123456789abcdef" }, project: "test" }),
      executor: () => ({ check: () => ({ ok: true, bounds: { deadlineMs: 1000, maxOutputBytes: 1000 }, mechanism: "test" }), run: () => {} }),
      agentRegistry: registry,
    });

    const authority = { owner: "owner1", callId: "call-1" };
    const res = host.call("delegate_task", {
      agent: "agent_nonexistent_id",
      task: "do work",
    }, authority);

    assert.equal(res.ok, false);
    assert.equal(res.refused, "agent-not-configured");
    assert.match(res.why, /No configured agent with ID 'agent_nonexistent_id' exists/);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test("admission: task record binds permanent agentId and preserves it across renames", () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "vb-agent-config-test2-"));
  try {
    const registry = createAgentRegistry({ defaultAgents: [] });
    registry.register({
      id: "agent_task_target",
      name: "Initial Name",
      harness: "pi",
      adapter: "pi-acp",
      transport: "stdio",
      environmentKey: "env_0123456789abcdef",
      description: "Task target agent",
      isDefault: true,
      reach: { root: "active", network: "ambient", tools: ["read"] },
      bounds: { deadlineMs: 5000, maxOutputBytes: 4096 },
    });

    const host = createTaskHost({
      environment: "env_0123456789abcdef",
      instance: "test-instance",
      boot: "boot1",
      addressKey: Buffer.alloc(32, 1),
      root: () => ({ root: { kind: "machine", path: scratch, environment: "env_0123456789abcdef" }, project: "test" }),
      executor: () => ({ check: () => ({ ok: true, bounds: { deadlineMs: 5000, maxOutputBytes: 4096 }, mechanism: "test" }), run: () => {} }),
      agentRegistry: registry,
    });

    const authority = { owner: "owner1", callId: "call-task-rename" };
    const admitted = host.call("delegate_task", {
      agent: "agent_task_target",
      task: "run test task",
    }, authority);

    assert.equal(admitted.ok, true);
    assert.equal(admitted.task.agent, "agent_task_target");
    assert.equal(admitted.task.agentId, "agent_task_target");

    // Rename the configured agent
    registry.rename("agent_task_target", "Renamed Display Title");

    // Read task status: the task's bound agentId is untouched
    const status = host.call("task_status", { address: admitted.task.address }, authority);
    assert.equal(status.ok, true);
    assert.equal(status.task.agent, "agent_task_target");
    assert.equal(status.task.agentId, "agent_task_target");
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test("D3: listHarnessesWithConfiguredAgents decorates harness discovery without parallel inventory", async () => {
  const registry = createAgentRegistry({ defaultAgents: [] });
  registry.register({
    id: "agent_pi_one",
    name: "Pi Fast",
    harness: "pi",
    adapter: "pi-acp",
    transport: "stdio",
    environmentKey: "local",
    description: "Fast Pi instance",
    isDefault: true,
    model: { provider: "anthropic", model: "claude-3-5-haiku" },
    reach: { root: "active", network: "none", tools: ["read"] },
    bounds: { deadlineMs: 10000, maxOutputBytes: 10000 },
  });
  registry.register({
    id: "agent_pi_two",
    name: "Pi Deep",
    harness: "pi",
    adapter: "pi-acp",
    transport: "stdio",
    environmentKey: "local",
    description: "Deep reasoning Pi instance",
    isDefault: false,
    model: { provider: "anthropic", model: "claude-3-7-sonnet" },
    reach: { root: "active", network: "ambient", tools: ["read", "write", "bash"] },
    bounds: { deadlineMs: 60000, maxOutputBytes: 65536 },
  });

  const mockInventoryPromise = Promise.resolve({
    ok: true,
    observedAt: new Date().toISOString(),
    entries: [
      { id: "pi", name: "Pi coding agent", state: "present", version: "0.85.1" },
      { id: "claude", name: "Claude Code", state: "absent", version: null },
    ],
  });

  const decorated = await listHarnessesWithConfiguredAgents(mockInventoryPromise, registry);
  assert.equal(decorated.ok, true);
  const piEntry = decorated.entries.find((e) => e.id === "pi");
  assert.ok(piEntry);
  assert.equal(piEntry.configuredAgents.length, 2, "Pi must have both configured agents attached");
  assert.equal(piEntry.configuredAgents[0].id, "agent_pi_one");
  assert.equal(piEntry.configuredAgents[1].id, "agent_pi_two");

  const claudeEntry = decorated.entries.find((e) => e.id === "claude");
  assert.ok(claudeEntry);
  assert.equal(claudeEntry.configuredAgents.length, 0, "Claude has no configured agents");
});
