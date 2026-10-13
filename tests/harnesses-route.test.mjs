// tests/harnesses-route.test.mjs — Scoped unit tests for lib/routes/harnesses.mjs
// (voicebox-beads-r9hv.1)

import test from "node:test";
import assert from "node:assert/strict";
import {
  createHarnessRoutes,
  createHarnessesRoutes,
  SUPPORTED_HARNESS_NAMES,
  DEFAULT_SUPPORTED_HARNESS_DEFAULTS,
  defaultNormalizeHarnessId,
} from "../lib/routes/harnesses.mjs";

test("createHarnessRoutes exports expected constants and alias", () => {
  assert.equal(typeof createHarnessRoutes, "function");
  assert.equal(createHarnessesRoutes, createHarnessRoutes);
  assert.ok(SUPPORTED_HARNESS_NAMES.includes("pi"));
  assert.ok(SUPPORTED_HARNESS_NAMES.includes("claude"));
  assert.ok(SUPPORTED_HARNESS_NAMES.includes("antigravity"));
  assert.ok(DEFAULT_SUPPORTED_HARNESS_DEFAULTS.pi);
  assert.equal(defaultNormalizeHarnessId("pi-acp"), "pi");
  assert.equal(defaultNormalizeHarnessId("claude-code"), "claude");
  assert.equal(defaultNormalizeHarnessId("agentapi"), "antigravity");
});

test("GET /api/harnesses returns combined inventory and active harness state", async () => {
  const activeHarnesses = new Set(["pi"]);
  let activeHarness = "pi";

  const harnessRoutes = createHarnessRoutes({
    harnessInventory: async () => [{ id: "pi", available: true }, { id: "claude", available: true }],
    listHarnessesWithConfiguredAgents: async (inv) => ({ harnesses: inv, configuredCount: 2 }),
    agentRegistry: {},
    getActiveHarness: () => activeHarness,
    setActiveHarness: (h) => { activeHarness = h; },
    activeHarnesses,
    json: (_res, status, payload) => ({ status, payload }),
    readJsonBody: async () => ({}),
  });

  assert.ok(harnessRoutes["GET /api/harnesses"]);
  assert.ok(harnessRoutes["POST /api/harnesses/configure"]);

  const res = {};
  const response = await harnessRoutes["GET /api/harnesses"]({}, res);
  assert.equal(response.status, 200);
  assert.equal(response.payload.activeHarness, "pi");
  assert.deepEqual(response.payload.activeHarnesses, ["pi"]);
  assert.equal(response.payload.configuredCount, 2);
  assert.equal(response.payload.harnesses.length, 2);
});

test("POST /api/harnesses/configure handles non-JSON or invalid bodies", async () => {
  const harnessRoutes = createHarnessRoutes({
    json: (_res, status, payload) => ({ status, payload }),
    readJsonBody: async () => null,
  });

  const response = await harnessRoutes["POST /api/harnesses/configure"]({}, {});
  assert.equal(response.status, 400);
  assert.equal(response.payload.ok, false);
  assert.equal(response.payload.refused, "bad-request");
});

test("POST /api/harnesses/configure refuses unsupported single harness", async () => {
  const harnessRoutes = createHarnessRoutes({
    json: (_res, status, payload) => ({ status, payload }),
    readJsonBody: async () => ({ harness: "unsupported-tool" }),
  });

  const response = await harnessRoutes["POST /api/harnesses/configure"]({}, {});
  assert.equal(response.status, 400);
  assert.equal(response.payload.ok, false);
  assert.equal(response.payload.refused, "bad-request");
  assert.match(response.payload.why, /harness must be one of:/);
});

test("POST /api/harnesses/configure configures and activates single harness", async () => {
  const activeHarnesses = new Set();
  let activeHarness = null;
  const activated = [];
  const persisted = [];
  const activities = [];

  const harnessRoutes = createHarnessRoutes({
    harnessInventory: async () => [{ id: "claude", available: true }],
    listHarnessesWithConfiguredAgents: async (inv) => ({ harnesses: inv }),
    getActiveHarness: () => activeHarness,
    setActiveHarness: (h) => { activeHarness = h; },
    activeHarnesses,
    activateHarnessInProcess: (h) => {
      activated.push(h);
      activeHarnesses.add(h);
      activeHarness = h;
    },
    deactivateHarnessInProcess: (h) => {
      activeHarnesses.delete(h);
      if (activeHarness === h) activeHarness = null;
    },
    writePersistedHarnessSettings: (act, set) => persisted.push({ act, set: [...set] }),
    recordWorkActivity: (act) => activities.push(act),
    json: (_res, status, payload) => ({ status, payload }),
    readJsonBody: async () => ({ harness: "claude" }),
  });

  const response = await harnessRoutes["POST /api/harnesses/configure"]({}, {});
  assert.equal(response.status, 200);
  assert.equal(response.payload.ok, true);
  assert.deepEqual(activated, ["claude"]);
  assert.equal(activeHarness, "claude");
  assert.ok(activeHarnesses.has("claude"));
  assert.equal(persisted.length, 1);
  assert.equal(activities.length, 1);
  assert.equal(activities[0].status, "ok");

  // Now deactivate
  const deactHarnessRoutes = createHarnessRoutes({
    harnessInventory: async () => [{ id: "claude", available: true }],
    listHarnessesWithConfiguredAgents: async (inv) => ({ harnesses: inv }),
    getActiveHarness: () => activeHarness,
    setActiveHarness: (h) => { activeHarness = h; },
    activeHarnesses,
    deactivateHarnessInProcess: (h) => {
      activeHarnesses.delete(h);
      if (activeHarness === h) activeHarness = null;
    },
    writePersistedHarnessSettings: (act, set) => persisted.push({ act, set: [...set] }),
    recordWorkActivity: (act) => activities.push(act),
    json: (_res, status, payload) => ({ status, payload }),
    readJsonBody: async () => ({ harness: "claude", active: false }),
  });

  const deactRes = await deactHarnessRoutes["POST /api/harnesses/configure"]({}, {});
  assert.equal(deactRes.status, 200);
  assert.equal(activeHarness, null);
  assert.equal(activeHarnesses.size, 0);
  assert.equal(activities[1].status, "info");
});

test("POST /api/harnesses/configure configures batch of harnesses", async () => {
  const activeHarnesses = new Set(["pi"]);
  let activeHarness = "pi";
  const activated = [];
  const persisted = [];

  const harnessRoutes = createHarnessRoutes({
    harnessInventory: async () => [],
    listHarnessesWithConfiguredAgents: async () => ({ harnesses: [] }),
    getActiveHarness: () => activeHarness,
    setActiveHarness: (h) => { activeHarness = h; },
    activeHarnesses,
    activateHarnessInProcess: (h) => {
      activated.push(h);
      activeHarnesses.add(h);
    },
    writePersistedHarnessSettings: (act, set) => persisted.push({ act, set: [...set] }),
    json: (_res, status, payload) => ({ status, payload }),
    readJsonBody: async () => ({ harnesses: ["claude", "antigravity"], harness: "claude" }),
  });

  const response = await harnessRoutes["POST /api/harnesses/configure"]({}, {});
  assert.equal(response.status, 200);
  assert.equal(response.payload.ok, true);
  assert.deepEqual(activated, ["claude", "antigravity"]);
  assert.equal(activeHarness, "claude");
  assert.deepEqual([...activeHarnesses], ["claude", "antigravity"]);
});

test("POST /api/harnesses/configure refuses batch with any invalid harness", async () => {
  const harnessRoutes = createHarnessRoutes({
    json: (_res, status, payload) => ({ status, payload }),
    readJsonBody: async () => ({ harnesses: ["claude", "invalid-one"] }),
  });

  const response = await harnessRoutes["POST /api/harnesses/configure"]({}, {});
  assert.equal(response.status, 400);
  assert.equal(response.payload.ok, false);
  assert.equal(response.payload.refused, "bad-request");
});
