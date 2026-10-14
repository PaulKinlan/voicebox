import test from "node:test";
import assert from "node:assert/strict";
import { createPresenceRoutes } from "../lib/routes/presence.mjs";
import { createRoomPresenceCoordinator } from "../lib/room-presence.mjs";
import { assertRouteGroupWiring } from "./lib/route-table.mjs";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function assertPresenceWiring(source) {
  assert.match(source, /const presenceRoutes = createPresenceRoutes\(\{ roomPresence, json, readJsonBody, answerOnce, broadcastChannel \}\)/);
  const members = assertRouteGroupWiring(source, {
    group: "...presenceRoutes",
    shadow: ["GET /api/presence", "POST /api/presence"],
  });
  assert.deepEqual(members.slice(0, 2), ["...presenceRoutes", "...agentsReadRoutes"],
    "presence owns the first table position; the agents group follows it without shadowing");
}

test("the host wires presence once at the first table position, without shadowing or neighbour coupling", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const server = readFileSync(path.join(root, "server.mjs"), "utf8");
  assertPresenceWiring(server);

  // Both versions of the REAL table (before and after extracting its fleet neighbour) must satisfy
  // the presence guard. Only the retired adjacency check should disagree. This proof can itself run
  // on either version of the host, instead of assuming fleet GET was already extracted.
  const inlineRoute = /  "GET \/api\/fleet": async \(req, res, url\) => \{\n(?:.*\n)*?  \},\n/;
  const extractedFleet = server.includes("  ...fleetRoutes,\n")
    ? server
    : server.replace(inlineRoute, "  ...fleetRoutes,\n");
  const inlineFleet = server.includes("  ...fleetRoutes,\n")
    ? server.replace("  ...fleetRoutes,\n", '  "GET /api/fleet": () => null,\n')
    : server;
  assert.notEqual(extractedFleet, inlineFleet, "the neighbour-extraction control must actually alter the source");
  assertPresenceWiring(inlineFleet);
  assertPresenceWiring(extractedFleet);
  const oldAdjacency = /const routes = \{\s*\.\.\.presenceRoutes,\s*\.\.\.agentsReadRoutes,\s*"GET \/api\/fleet":/;
  assert.match(inlineFleet, oldAdjacency, "the old guard accepted the inline fleet neighbour");
  assert.throws(() => assert.match(extractedFleet, oldAdjacency), { name: "AssertionError" },
    "the old guard wrongly refused only the neighbour extraction, not a presence route change");

  const mutants = [
    server.replace("  ...presenceRoutes,\n", ""),
    server.replace("  ...presenceRoutes,\n", "  ...presenceRoutes,\n  ...presenceRoutes,\n"),
    server.replace("  ...presenceRoutes,\n  ...agentsReadRoutes,", "  ...agentsReadRoutes,\n  ...presenceRoutes,"),
    server.replace("  ...presenceRoutes,\n", '  ...presenceRoutes,\n  "GET /api/presence": () => null,\n'),
    server.replace("  ...presenceRoutes,\n", '  ...presenceRoutes,\n  "POST /api/presence": () => null,\n'),
  ];
  for (const [index, mutant] of mutants.entries()) {
    assert.notEqual(mutant, server, `mutant ${index} must alter the real source`);
    assert.throws(() => assertPresenceWiring(mutant), { name: "AssertionError" },
      `mutant ${index} must refuse a missing, duplicated, reordered or shadowed presence group`);
  }
});

function harness() {
  const roomPresence = createRoomPresenceCoordinator();
  const events = [];
  const bodyRefusal = new Error("host-owned BodyRefusal");
  const routes = createPresenceRoutes({
    roomPresence,
    json: (res, code, payload) => { events.push(["response", code]); res.code = code; res.payload = payload; return res; },
    readJsonBody: async (req) => { if (req.refused) throw bodyRefusal; return req.body; },
    answerOnce: (_res, fn) => fn(),
    broadcastChannel: (payload) => { events.push(["broadcast", payload]); },
  });
  return { routes, roomPresence, events, bodyRefusal };
}

test("presence seam owns exactly two method/path keys and preserves broadcast order and refusal pass-through", async () => {
  const h = harness();
  assert.deepEqual(Object.keys(h.routes).sort(), ["GET /api/presence", "POST /api/presence"]);
  const get = h.routes["GET /api/presence"];
  const post = h.routes["POST /api/presence"];
  const initial = {};
  get(null, initial);
  assert.equal(initial.code, 200);
  assert.equal(initial.payload.count, 0);

  h.events.length = 0;
  const joined = {};
  await post({ body: { action: "joinParticipant", participantId: "peer-a" } }, joined);
  assert.equal(joined.code, 200);
  assert.equal(joined.payload.participant.participantId, "peer-a");
  assert.equal(h.events.length, 2);
  assert.equal(h.events[0][0], "broadcast", "publish AFTER action but BEFORE response");
  assert.equal(h.events[0][1].count, 1);
  assert.deepEqual(h.events[1], ["response", 200]);

  h.events.length = 0;
  const denied = {};
  await post({ body: { action: "request_floor" } }, denied);
  assert.equal(denied.code, 409);
  assert.equal(denied.payload.refused, "invalid-participant");
  assert.equal(h.events.length, 2, "coordinator refusal still broadcasts one snapshot");
  assert.deepEqual(h.events.map((event) => event[0]), ["broadcast", "response"]);

  h.events.length = 0;
  const malformed = {};
  await post({ body: "not an object" }, malformed);
  assert.equal(malformed.code, 400);
  assert.equal(malformed.payload.refused, "bad-request");
  assert.deepEqual(h.events, [["response", 400]], "malformed body is never broadcast");

  h.events.length = 0;
  await assert.rejects(post({ refused: true }, {}), (error) => error === h.bodyRefusal);
  assert.deepEqual(h.events, [], "host 413/415 refusal propagates with no second response or broadcast");
});
