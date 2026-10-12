import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentsReadRoutes } from "../lib/routes/agents-read.mjs";

test("the host wires only GET /api/agents at the original table position", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const source = readFileSync(path.join(root, "server.mjs"), "utf8");
  assert.match(source, /createAgentsReadRoutes\(\{ agentRegistry, json, publicAgentProjection, describeAgentAdmission, getAdmissionContext \}\)/);
  assert.match(source, /\.\.\.agentsReadRoutes,\s*"GET \/api\/fleet":/);
  assert.doesNotMatch(source, /"GET \/api\/agents":/, "no old inline GET may shadow the factory");
  assert.match(source, /req\.method === "POST" && url\.pathname === "\/api\/agents"/, "host's separate privileged POST must remain valid");
});

test("GET reads fresh host admission on every request, filters the registry and never returns secrets", () => {
  const filters = [];
  const seenContexts = [];
  const secret = "never-expose-this-private-agent-token";
  const row = { id: "agent-1", name: "A", secret };
  let selected = false;
  let adapters = new Set(["pi"]);
  let contextReads = 0;
  const routes = createAgentsReadRoutes({
    agentRegistry: { list: (options) => { filters.push(options); return [row]; } },
    json: (response, status, payload) => { response.status = status; response.payload = payload; return response; },
    publicAgentProjection: (agent) => ({ id: agent.id, name: agent.name }),
    describeAgentAdmission: (agent, context) => {
      assert.strictEqual(agent, row);
      seenContexts.push(context);
      return { executorSelected: context.executorSelected, adapters: [...context.implementedAdapters] };
    },
    getAdmissionContext: () => { contextReads++; return { executorSelected: selected, implementedAdapters: adapters }; },
  });
  assert.deepEqual(Object.keys(routes), ["GET /api/agents"]);
  const get = routes["GET /api/agents"];
  const before = {};
  get(null, before, new URL("http://localhost/api/agents?environment=&harness="));
  assert.equal(before.status, 200);
  assert.deepEqual(filters[0], { environmentKey: undefined, harness: undefined });
  assert.deepEqual(before.payload, { ok: true, agents: [{ id: "agent-1", name: "A", admission: { executorSelected: false, adapters: ["pi"] } }] });
  assert.doesNotMatch(JSON.stringify(before.payload), /never-expose-this-private-agent-token/);

  // A boot-time snapshot or one cached admission verdict must fail this second request.
  selected = true;
  adapters = new Set(["pi", "claude"]);
  const after = {};
  get(null, after, new URL("http://localhost/api/agents?environment=remote&harness=claude"));
  assert.equal(after.status, 200);
  assert.deepEqual(filters[1], { environmentKey: "remote", harness: "claude" });
  assert.equal(contextReads, 2);
  assert.notStrictEqual(seenContexts[0], seenContexts[1]);
  assert.deepEqual(after.payload.agents[0].admission, { executorSelected: true, adapters: ["pi", "claude"] });
  assert.doesNotMatch(JSON.stringify(after.payload), /never-expose-this-private-agent-token/);
});
