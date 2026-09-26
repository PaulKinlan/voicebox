// tests/harness-startup.test.mjs — the boot-time admission table answers, per configured agent,
// what a delegation would do TODAY (voicebox-beads-aaj). Pure module: the adapter probe is
// injected, so these tests need no installed adapter and no browser.
import test from "node:test";
import assert from "node:assert/strict";
import { validateHarnessAgents, renderHarnessTable } from "../lib/harness-startup.mjs";
import { createAgentRegistry } from "../lib/harness-config.mjs";

function registryWith(agents) {
  return createAgentRegistry({ defaultAgents: agents, storage: null });
}

const piAgent = {
  id: "agent_pi_test",
  name: "Pi Test",
  harness: "pi",
  adapter: "pi-acp",
  transport: "stdio",
  environmentKey: "local",
  isDefault: true,
  model: { provider: "anthropic", model: "claude-3-7-sonnet" },
};

const claudeAgent = {
  id: "agent_claude_test",
  name: "Claude Test",
  harness: "claude",
  adapter: "claude-code",
  transport: "stdio",
  environmentKey: "local",
  isDefault: false,
  model: { provider: "anthropic", model: "claude-3-5-haiku" },
};

test("an adapter that verifies is ADMITTED, with the installed version named", () => {
  const registry = registryWith([piAgent]);
  const result = validateHarnessAgents({
    registry,
    environment: "local",
    describeAdapter: () => ({ ok: true, installedVersion: "0.0.34" }),
  });
  assert.equal(result.admitted, 1);
  assert.equal(result.rows[0].admitted, true);
  assert.equal(result.rows[0].installedVersion, "0.0.34");
  assert.equal(result.rows[0].refused, null);
});

test("a version-mismatched adapter is refused BY NAME with the executor's own refusal", () => {
  const registry = registryWith([piAgent]);
  const result = validateHarnessAgents({
    registry,
    environment: "local",
    describeAdapter: () => ({ ok: false, refused: "adapter-version-unsupported", why: "requires installed pi-acp 0.0.34" }),
  });
  assert.equal(result.admitted, 0);
  assert.equal(result.rows[0].admitted, false);
  assert.equal(result.rows[0].refused, "adapter-version-unsupported");
  assert.match(result.rows[0].why, /requires installed pi-acp/);
});

test("an adapter nobody implements refuses adapter-not-configured — configured, visible, honest", () => {
  const registry = registryWith([claudeAgent]);
  const result = validateHarnessAgents({
    registry,
    environment: "local",
    describeAdapter: () => ({ ok: true }),
    implementedAdapters: new Set(["pi-acp"]),
  });
  assert.equal(result.rows[0].admitted, false);
  assert.equal(result.rows[0].refused, "adapter-not-configured");
  assert.match(result.rows[0].why, /configured but cannot run/);
});

test("no harness selected at boot: EVERY row refuses executor-unavailable, even a healthy adapter", () => {
  const registry = registryWith([piAgent, claudeAgent]);
  const result = validateHarnessAgents({
    registry,
    environment: "local",
    describeAdapter: () => ({ ok: true }),
    executorSelected: false,
  });
  assert.equal(result.admitted, 0);
  for (const row of result.rows) {
    assert.equal(row.refused, "executor-unavailable", `${row.agent.id} must refuse executor-unavailable`);
    assert.match(row.why, /VOICEBOX_HARNESS=pi/);
  }
});

test("agents of OTHER environments are not this table's business", () => {
  const registry = registryWith([{ ...piAgent, id: "agent_remote", environmentKey: "other-box" }, piAgent]);
  const result = validateHarnessAgents({
    registry,
    environment: "local",
    describeAdapter: () => ({ ok: true }),
  });
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].agent.id, "agent_pi_test");
});

test("the table renders admission and refusal in the server's plain style", () => {
  const registry = registryWith([piAgent, claudeAgent]);
  const { rows } = validateHarnessAgents({
    registry,
    environment: "local",
    describeAdapter: (agent) => agent.adapter === "pi-acp" ? { ok: true, installedVersion: "0.0.34" } : { ok: true },
    implementedAdapters: new Set(["pi-acp"]),
  });
  const lines = renderHarnessTable(rows, { environment: "local" });
  const text = lines.join("\n");
  assert.match(text, /configured agents for environment 'local'/);
  assert.match(text, /ADMITTED  Pi Test \(agent_pi_test\) — pi-acp @ 0\.0\.34/);
  assert.match(text, /REFUSED   Claude Test \(agent_claude_test\) — claude-code: adapter-not-configured/);
  assert.match(text, /configured but cannot run/);
});

test("the table says what an EMPTY configuration means for delegation", () => {
  const lines = renderHarnessTable([], { environment: "local" });
  assert.match(lines.join("\n"), /delegate_task will refuse executor-unavailable/);
});

test("rows carry the secret-free projection only — no raw config escapes", () => {
  const registry = registryWith([piAgent]);
  const result = validateHarnessAgents({
    registry,
    environment: "local",
    describeAdapter: () => ({ ok: true }),
  });
  const keys = Object.keys(result.rows[0].projection);
  for (const forbidden of ["token", "apiKey", "api_key", "secret", "password"]) {
    assert.equal(keys.some((k) => k.toLowerCase().includes(forbidden)), false, `projection must not carry ${forbidden}`);
  }
});
