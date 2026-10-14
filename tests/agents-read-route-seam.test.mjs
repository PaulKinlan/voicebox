import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentsReadRoutes } from "../lib/routes/agents-read.mjs";
import { assertRouteGroupWiring } from "./lib/route-table.mjs";

// THE OLD GUARD, kept here on purpose (voicebox-beads-r9hv.5): it proved the group's position by naming the
// entry that happened to FOLLOW it — `"GET /api/fleet"` — so extracting the fleet group would have failed
// this test while routing was intact. It is no longer used to guard anything; it is asserted to FAIL on the
// neighbour-extraction mutant below, which is what shows the new guard fixes a real recurrence rather than
// merely rephrasing it.
const theOldAdjacencyGuard = (source) =>
  assert.match(source, /const routes = \{\s*\.\.\.presenceRoutes,\s*\.\.\.agentsReadRoutes,\s*"GET \/api\/fleet":/,
    "agents GET follows presence and precedes fleet without a shadowing entry");

function assertAgentsWiring(source) {
  assert.match(source, /createAgentsReadRoutes\(\{ agentRegistry, json, publicAgentProjection, describeAgentAdmission, getAdmissionContext \}\)/);
  // ORDER, NOT ADJACENCY: pure spread anchors, so no neighbour extraction can red this. The group must be
  // spread once, keep its place after presence, and not be shadowed by an inline handler.
  const members = assertRouteGroupWiring(source, {
    group: "...agentsReadRoutes",
    order: ["...presenceRoutes"],
    shadow: ["GET /api/agents"],
  });
  // The intent the old assertion expressed — agents GET follows presence and comes before anything that could
  // shadow it — stated as a property of the table's first members rather than of one neighbour's identity.
  assert.deepEqual(
    members.slice(0, 2),
    ["...presenceRoutes", "...agentsReadRoutes"],
    "presence and then agents-read must open the table: nothing routable may be inserted before agents GET",
  );
  assert.match(source, /req\.method === "POST" && url\.pathname === "\/api\/agents"/, "host's separate privileged POST must remain valid");
}

test("the host wires only GET /api/agents at the exact table position, rejecting missing and duplicate handlers", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const source = readFileSync(path.join(root, "server.mjs"), "utf8");
  assertAgentsWiring(source);

  const withoutSpread = source.replace("  ...agentsReadRoutes,\n", "");
  assert.notEqual(withoutSpread, source, "the missing-spread mutant must actually change the source");
  assert.throws(() => assertAgentsWiring(withoutSpread), { name: "AssertionError" });

  const duplicatedSpread = source.replace("  ...agentsReadRoutes,\n", "  ...agentsReadRoutes,\n  ...agentsReadRoutes,\n");
  assert.notEqual(duplicatedSpread, source, "the duplicate-spread mutant must actually change the source");
  assert.throws(() => assertAgentsWiring(duplicatedSpread), { name: "AssertionError" },
    "a second spread must be refused: the last duplicate key wins silently");

  const swapped = source.replace("  ...presenceRoutes,\n  ...agentsReadRoutes,", "  ...agentsReadRoutes,\n  ...presenceRoutes,");
  assert.notEqual(swapped, source, "the swapped-order mutant must actually change the source");
  assert.throws(() => assertAgentsWiring(swapped), { name: "AssertionError" },
    "agents-read must follow presence, not merely exist somewhere in the table");

  const withDuplicate = source.replace("  ...agentsReadRoutes,\n", '  ...agentsReadRoutes,\n  "GET /api/agents": () => null,\n');
  assert.notEqual(withDuplicate, source, "the duplicate-inline mutant must actually change the source");
  assert.throws(() => assertAgentsWiring(withDuplicate), { name: "AssertionError" });

  // THE RECURRENCE, REPRODUCED: extract the neighbouring group the way voicebox-beads-r9hv.3 will, by
  // turning its literal key into a spread. The OLD guard must die on it (that is the defect) and the NEW guard
  // must pass — same source, so the pair is the evidence that the fix is about the shape and not the wording.
  //
  // CONDITIONAL ON PURPOSE, and it is not a skipped check: this mutation needs the literal to still exist. Once
  // r9hv.3 really does extract the fleet group, the LIVE source IS the extraction, the guard below is asserted
  // against it directly, and repeating the mutation would be redundant — whereas an unconditional `replace`
  // would silently no-op and red this test for a change that is exactly what it wants.
  if (source.includes('  "GET /api/fleet": ')) {
    const fleetExtracted = source.replace('  "GET /api/fleet": ', "  ...fleetRoutes, // ");
    assert.notEqual(fleetExtracted, source, "the neighbour-extraction mutant must actually change the source");
    assert.throws(() => theOldAdjacencyGuard(fleetExtracted), { name: "AssertionError" },
      "the old guard must fail on a neighbour extraction — that is voicebox-beads-91tp");
    assertAgentsWiring(fleetExtracted);
  }
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
