import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createFleetRoutes } from "../lib/routes/fleet.mjs";
import { assertRouteGroupWiring, tableMembers } from "./lib/route-table.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function assertFleetWiring(source) {
  assert.match(source, /import \{ createFleetRoutes \} from "\.\/lib\/routes\/fleet\.mjs";/);
  assert.match(source, /const fleetRoutes = createFleetRoutes\(\{ fleetManager, publicFleetProjection, json \}\);/);
  const members = assertRouteGroupWiring(source, {
    group: "...fleetRoutes",
    order: ["...presenceRoutes", "...agentsReadRoutes"],
    shadow: ["GET /api/fleet"],
  });
  const fleet = members.indexOf("...fleetRoutes");
  assert.deepEqual(members.slice(fleet, fleet + 3), ["...fleetRoutes", '"POST /api/fleet/contact"', "...harnessRoutes"],
    "GET moves into the factory at the same table position; the privileged POST stays host-owned before harness routes");
  // Keep the authority-bearing adapter in server.mjs. These are independently load-bearing facts,
  // not a second implementation: a source guard catches moving only half the POST across the seam.
  const contact = source.slice(source.indexOf('  "POST /api/fleet/contact":'), source.indexOf('  ...harnessRoutes,', source.indexOf('  "POST /api/fleet/contact":')));
  assert.match(contact, /readJsonBody\(req, res\)/);
  assert.match(contact, /answerOnce\(res, async \(\) =>/);
  assert.match(contact, /createHash\("sha256"\)\.update\(`voicebox-fleet-contact\\0\$\{SELF_ENVIRONMENT\}`\)\.digest\("hex"\)/);
  assert.match(contact, /auth: \{ bearer: req\.headers\["authorization"\]\?\.replace\(\/\^Bearer\\s\+\/i, ""\) \}/);
  assert.match(contact, /\["cross-environment-unauthorized", "environment-not-paired"\]/);
}

test("GET fleet is wired once before host-owned POST, preserving the authority boundary (negative mutants)", () => {
  const source = readFileSync(path.join(root, "server.mjs"), "utf8");
  assertFleetWiring(source);
  const mutations = [
    source.replace("  ...fleetRoutes,\n", ""),
    source.replace("  ...fleetRoutes,\n", "  ...fleetRoutes,\n  ...fleetRoutes,\n"),
    source.replace("  ...fleetRoutes,\n", '  ...fleetRoutes,\n  "GET /api/fleet": () => null,\n'),
    source.replace("  ...agentsReadRoutes,\n  ...fleetRoutes,", "  ...fleetRoutes,\n  ...agentsReadRoutes,"),
    source.replace("  ...fleetRoutes,\n  \"POST /api/fleet/contact\":", "  \"POST /api/fleet/contact\":"),
    source.replace('  "POST /api/fleet/contact":', '  "POST /api/fleet/contact-removed":'),
    source.replace('auth: { bearer: req.headers["authorization"]?.replace(/^Bearer\\s+/i, "") }', 'auth: { bearer: undefined }'),
    source.replace('        owner: createHash("sha256").update(`voicebox-fleet-contact\\0${SELF_ENVIRONMENT}`)', '        owner: createHash("sha1").update(`voicebox-fleet-contact\\0${SELF_ENVIRONMENT}`)'),
  ];
  for (const [index, mutant] of mutations.entries()) {
    assert.notEqual(mutant, source, `mutant ${index} must actually change its targeted source`);
    assert.throws(() => assertFleetWiring(mutant), { name: "AssertionError" }, `mutant ${index} must fail the guard`);
  }
  assert.equal(tableMembers(source).filter(m => m === '"POST /api/fleet/contact"').length, 1);
});

test("GET filters at request time and projects public fields only; no POST or near-prefix route is exported", async () => {
  const calls = [];
  const secret = "private-fleet-token";
  const routes = createFleetRoutes({
    fleetManager: { listAgents: async options => { calls.push(options); return [{ id: "agent-1", secret }]; } },
    publicFleetProjection: agent => ({ id: agent.id }),
    json: (res, status, body) => { res.status = status; res.body = body; return res; },
  });
  assert.deepEqual(Object.keys(routes), ["GET /api/fleet"]);
  for (const [query, expected] of [
    ["", { environmentKey: undefined, harness: undefined }],
    ["?environment=remote&harness=claude", { environmentKey: "remote", harness: "claude" }],
    ["?environment=&harness=", { environmentKey: undefined, harness: undefined }],
  ]) {
    const res = {};
    assert.strictEqual(await routes["GET /api/fleet"](null, res, new URL(`http://localhost/api/fleet${query}`)), res);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { ok: true, fleet: [{ id: "agent-1" }] });
    assert.doesNotMatch(JSON.stringify(res.body), /private-fleet-token/);
    assert.deepEqual(calls.at(-1), expected);
  }
  assert.equal(routes["GET /api/fleetX"], undefined);
  assert.equal(routes["POST /api/fleet/contact"], undefined);
});
