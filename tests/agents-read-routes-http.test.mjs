import test from "node:test";
import assert from "node:assert/strict";
import { startServer } from "./lib/server.mjs";

test("agents GET stays live and filtered while the separate privileged POST and exact 404s remain host-owned", async () => {
  const server = await startServer({ env: { VOICEBOX_LOOPBACK_AUTH: undefined, VOICEBOX_HARNESS: undefined } });
  try {
    const get = async (query = "") => {
      const response = await fetch(server.base + "/api/agents" + query);
      assert.equal(response.status, 200);
      return response.json();
    };
    const baseline = await get();
    assert.equal(baseline.ok, true);
    assert.ok(Array.isArray(baseline.agents));
    assert.ok(baseline.agents.some((agent) => agent.harness === "pi"));
    const originalPi = baseline.agents.find((agent) => agent.id === "agent_pi_default");
    assert.equal(originalPi?.admission.refused, "executor-unavailable", "no harness selected yet");
    const registered = await fetch(server.base + "/api/agents", {
      method: "POST",
      headers: { "content-type": "application/json", "x-voicebox-host-token": server.hostToken },
      body: JSON.stringify({ id: "route_seam_pi", name: "Route Seam Pi", harness: "pi", adapter: "pi-acp", transport: "stdio", environmentKey: "local" }),
    });
    assert.equal(registered.status, 201, "the separate host-owned POST handler remains reachable");
    const row = (await get("?harness=pi")).agents.find((agent) => agent.id === "route_seam_pi");
    assert.equal(row?.name, "Route Seam Pi", "registration after boot is visible through the extracted GET");
    assert.equal(typeof row.admission.admitted, "boolean", "GET reports the live admission verdict");
    assert.equal((await get("?harness=nonexistent")).agents.some((agent) => agent.id === "route_seam_pi"), false);
    assert.equal((await get("?environment=not-this-host")).agents.some((agent) => agent.id === "route_seam_pi"), false);
    // Registration accepts the 'local' alias but projects this host's minted environment key.
    assert.ok((await get(`?environment=${encodeURIComponent(row.environmentKey)}&harness=pi`)).agents.some((agent) => agent.id === "route_seam_pi"));
    const activated = await fetch(server.base + "/api/harnesses/configure", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ harness: "pi", name: "Activated Pi" }),
    });
    assert.equal(activated.status, 200);
    const livePi = (await get()).agents.find((agent) => agent.id === "agent_pi_default");
    assert.notEqual(livePi.admission.refused, "executor-unavailable", "same agent must use fresh host harness selection after configure");
    for (const [method, route] of [["GET", "/api/agents-extra"], ["PUT", "/api/agents"]]) {
      assert.equal((await fetch(server.base + route, { method })).status, 404, `${method} ${route} must fall through`);
    }
    const unauthorizedPost = await fetch(server.base + "/api/agents", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(unauthorizedPost.status, 403, "POST /api/agents exists but requires host token, not 404");
    assert.equal((await unauthorizedPost.json()).refused, "host-token-required");
  } finally { await server.stop(); }
});

test("GET /api/agents is still behind the global opt-in loopback wall", async () => {
  const server = await startServer({ env: { VOICEBOX_LOOPBACK_AUTH: "1" } });
  try {
    const response = await fetch(server.base + "/api/agents?harness=pi");
    assert.equal(response.status, 401);
    assert.equal((await response.json()).refused, "loopback-unauthenticated");
  } finally { await server.stop(); }
});
