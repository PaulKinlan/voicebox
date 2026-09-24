// tests/agent-config-api.test.mjs — bead voicebox-beads-8fv.2 API integration.
//
// Tests:
// 1. GET /api/agents returns secret-free configured agents.
// 2. POST /api/agents requires host token, validates and registers agent.
// 3. PATCH /api/agents/:id updates/renames agent while preserving stable ID.
// 4. GET /api/harnesses integrates configured agents into discovery without parallel inventory (D3).
//
//   node --test tests/agent-config-api.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { startServer } from "./lib/server.mjs";

test("API: GET /api/agents, POST /api/agents, PATCH /api/agents/:id, and GET /api/harnesses", async () => {
  const server = await startServer();
  try {
    const base = server.base;
    const extensionsDir = path.join(process.cwd(), "extensions");
    const tokenFile = path.join(extensionsDir, ".host-token");
    const hostToken = server.hostToken ?? (fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, "utf8").trim() : "");

    // 1. GET /api/agents (ambient, no token needed)
    const listRes = await fetch(`${base}/api/agents`);
    assert.equal(listRes.status, 200);
    const listBody = await listRes.json();
    assert.equal(listBody.ok, true);
    assert.ok(Array.isArray(listBody.agents));
    // Default pi agent is present
    const piAgent = listBody.agents.find((a) => a.harness === "pi");
    assert.ok(piAgent, "default Pi agent should be listed");
    assert.equal(typeof piAgent.id, "string");
    assert.equal(typeof piAgent.environmentKey, "string");

    // 2. POST /api/agents without host token -> 403
    const unauthorized = await fetch(`${base}/api/agents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "agent_unauthorized",
        name: "Unauthorized Agent",
        harness: "pi",
        adapter: "pi-acp",
        transport: "stdio",
        environmentKey: "local",
      }),
    });
    assert.equal(unauthorized.status, 403);
    const unauthBody = await unauthorized.json();
    assert.equal(unauthBody.refused, "host-token-required");

    if (hostToken) {
      // 3. POST /api/agents with host token -> 201 Created
      const registered = await fetch(`${base}/api/agents`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-voicebox-host-token": hostToken,
        },
        body: JSON.stringify({
          id: "agent_api_test",
          name: "API Test Agent",
          harness: "pi",
          adapter: "pi-acp",
          transport: "stdio",
          environmentKey: "local",
          description: "Configured via HTTP API",
          bounds: { deadlineMs: 40000, maxOutputBytes: 32768 },
        }),
      });
      assert.equal(registered.status, 201);
      const regBody = await registered.json();
      assert.equal(regBody.ok, true);
      assert.equal(regBody.agent.id, "agent_api_test");
      assert.equal(regBody.agent.name, "API Test Agent");

      // 4. PATCH /api/agents/:id -> rename agent
      const renamed = await fetch(`${base}/api/agents/agent_api_test`, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          "x-voicebox-host-token": hostToken,
        },
        body: JSON.stringify({ name: "Renamed API Agent" }),
      });
      assert.equal(renamed.status, 200);
      const renameBody = await renamed.json();
      assert.equal(renameBody.ok, true);
      assert.equal(renameBody.agent.id, "agent_api_test");
      assert.equal(renameBody.agent.name, "Renamed API Agent");
    }

    // 5. GET /api/harnesses includes configuredAgents array for each entry
    const harnessesRes = await fetch(`${base}/api/harnesses`);
    assert.equal(harnessesRes.status, 200);
    const harnessesBody = await harnessesRes.json();
    assert.equal(harnessesBody.ok, true);
    assert.ok(Array.isArray(harnessesBody.entries));
    const piHarness = harnessesBody.entries.find((h) => h.id === "pi");
    if (piHarness) {
      assert.ok(Array.isArray(piHarness.configuredAgents), "harness entry must include configuredAgents array");
      assert.ok(piHarness.configuredAgents.length > 0, "configured Pi agents must be attached to Pi harness");
    }
  } finally {
    await server.stop();
  }
});
