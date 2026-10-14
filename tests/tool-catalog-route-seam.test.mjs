// tests/tool-catalog-route-seam.test.mjs — GET /api/tools is a module now (voicebox-beads-r9hv.2, the
// pilot slice of the voicebox-beads-r9hv ADR), and this file holds the ways that extraction can be wrong
// while the suite stays green.
//
// WHY THIS FILE EXISTS. tests/tool-index.test.mjs already drives GET /api/tools end to end over HTTP —
// the listing without a root declared, the `?q=` search path, and the room's own flows — so the BEHAVIOUR
// of this route is covered. What that cannot see is the SEAM, and the seam is where this slice can rot:
//
//   1. A MISSING OR MOVED SPREAD. The table entry has to stay exactly where it was (after the tasks block,
//      before `GET /api/keys`), and nothing may re-add an inline `"GET /api/tools"` next to the factory.
//      Neither shows up in a behaviour test — an inline duplicate simply shadows the factory, and both
//      answer 200.
//
//   2. THE ROOT READ BECOMING A SNAPSHOT. This is the one that matters. In server.mjs `active` is a
//      module-level `let`, reassigned when a machine root is declared or deleted, and this route lists from
//      whichever tree is active NOW. Hand `active` over as a value and the module answers from the root
//      that was active at boot for the rest of the process's life — silent, green, and wrong exactly when
//      someone declares a root and then lists tools (the voicebox-beads-w1f9 shape). The host must hand
//      over `getActiveRoot: () => active`, and the behaviour test below calls the route twice with the
//      accessor changing in between, which is what a snapshot fails.
//
//   3. THE HARNESS FALLBACK BEING DROPPED. The inline handler wrapped the harness inventory in try/catch and
//      listed tools with `harnesses: []` when it failed; a harness inventory that throws must not take the
//      whole listing down with it.
//
// The first arm asserts the wiring in server.mjs and then PROVES ITSELF against the three mutants above
// (a wiring check that cannot fail is worse than none). The second drives the factory with injected fakes,
// which is also the only way to see the live-root behaviour without a second server.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createToolCatalogRoutes } from "../lib/routes/tool-catalog.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function wiringCall(source) {
  const start = source.indexOf("createToolCatalogRoutes({");
  assert.ok(start > -1, "server.mjs must build the tool catalogue routes");
  const end = source.indexOf("\n});", start);
  assert.ok(end > start, "the factory call must be closed");
  return source.slice(start, end);
}

function assertToolCatalogWiring(source) {
  const call = wiringCall(source);
  for (const dep of [
    "json",
    "searchTools",
    "listTools",
    "getActiveRoot: () => active",
    "rootDir: ROOT",
    "activeMiniAppRegistry",
    "harnessInventory",
    "listHarnessesWithConfiguredAgents",
    "agentRegistry",
  ]) {
    assert.ok(call.includes(dep), `the host must hand over ${dep}`);
  }
  assert.doesNotMatch(source, /"GET \/api\/tools":/, "no inline GET /api/tools may shadow the factory");

  const spread = source.indexOf("  ...toolCatalogRoutes,");
  const tasks = source.indexOf('"POST /api/tasks/delegate"');
  const keys = source.indexOf('"GET /api/keys"');
  assert.ok(spread > -1, "the route table must spread ...toolCatalogRoutes");
  assert.ok(
    tasks > -1 && keys > -1 && spread > tasks && spread < keys,
    "the catalogue spread must sit at its original table position — after the tasks block and before GET /api/keys",
  );
}

test("the host wires the catalogue at its original table position and hands over a LIVE root accessor", () => {
  const source = readFileSync(path.join(ROOT, "server.mjs"), "utf8");
  assertToolCatalogWiring(source);

  // SELF-PROVING MUTANTS. Each way this slice rots must make the guard above throw, so the guard cannot
  // quietly become a no-op — the pattern tests/agents-read-route-seam.test.mjs established.
  const missingSpread = source.replace("  ...toolCatalogRoutes,\n", "");
  assert.notEqual(missingSpread, source, "the missing-spread mutant must actually change the source");
  assert.throws(() => assertToolCatalogWiring(missingSpread), { name: "AssertionError" });

  const shadowed = source.replace("  ...toolCatalogRoutes,\n", '  "GET /api/tools": () => null,\n');
  assert.notEqual(shadowed, source, "the shadowing mutant must actually change the source");
  assert.throws(() => assertToolCatalogWiring(shadowed), { name: "AssertionError" });

  const snapshot = source.replace("getActiveRoot: () => active,", "getActiveRoot: active,");
  assert.notEqual(snapshot, source, "the snapshot mutant must actually change the source");
  assert.throws(
    () => assertToolCatalogWiring(snapshot),
    { name: "AssertionError" },
    "handing over the binding instead of an accessor must be refused — that is the stale-root defect",
  );
});

test("the route reads the active root on every request, lists or searches, and still lists when the harness inventory is unavailable", async () => {
  const seen = { list: [], search: [] };
  // The caller's mutable binding, exactly as server.mjs holds it: the accessor closes over this, so the
  // route sees whatever it is NOW.
  let active = null;
  const respond = (res, status, payload) => {
    res.status = status;
    res.payload = payload;
    return res;
  };
  const routes = createToolCatalogRoutes({
    json: respond,
    searchTools: async (q, opts) => {
      seen.search.push({ q, opts });
      return { query: q };
    },
    listTools: async (opts) => {
      seen.list.push(opts);
      return { tools: [] };
    },
    getActiveRoot: () => active,
    rootDir: "/fallback-root",
    activeMiniAppRegistry: { getAllTools: () => [{ name: "mini-tool" }] },
    harnessInventory: async () => {
      throw new Error("inventory unavailable in this test");
    },
    listHarnessesWithConfiguredAgents: async () => ({ harnesses: [{ id: "pi" }] }),
    agentRegistry: { marker: "registry" },
  });

  // NEGATIVE CONTROL AT THE SEAM: the factory claims exactly one route. An unknown sibling spelling is not
  // this module's to answer — the host's own 404 for it was measured separately (GET /api/toolsX -> 404
  // {"error":"not found"}) and must stay that way, which is why nothing here may invent keys.
  assert.deepEqual(Object.keys(routes), ["GET /api/tools"], "the factory must claim exactly GET /api/tools");
  assert.equal(routes["GET /api/toolsX"], undefined, "a sibling spelling must not be swallowed");
  assert.equal(routes["POST /api/tools"], undefined, "only GET is claimed");

  // 1. Listing with no root declared: the fallback root, the mini-app tools, and — because the harness
  //    inventory threw — an empty harness list rather than a failed request.
  const first = await routes["GET /api/tools"]({}, {}, new URL("http://x/api/tools"));
  assert.equal(first.status, 200, "a failing harness inventory must not fail the listing");
  assert.equal(seen.list.length, 1);
  assert.equal(seen.list[0].rootPath, "/fallback-root");
  assert.deepEqual(seen.list[0].miniAppTools, [{ name: "mini-tool" }]);
  assert.deepEqual(seen.list[0].harnesses, [], "the inline fallback was harnesses: [] — a throwing inventory must not propagate");
  assert.equal(seen.list[0].kind, undefined);
  assert.equal(seen.list[0].limit, undefined);

  // 2. A machine root declared AFTER the module was built. This is the live-read assertion: a snapshot of
  //    `active` keeps answering /fallback-root here and this line goes red.
  active = { root: { kind: "machine", path: "/tmp/declared-machine-root" } };
  await routes["GET /api/tools"]({}, {}, new URL("http://x/api/tools"));
  assert.equal(seen.list.length, 2);
  assert.equal(
    seen.list[1].rootPath,
    "/tmp/declared-machine-root",
    "the route must read the active root at request time — a captured snapshot keeps the boot-time root",
  );

  // 3. The search path, and the query parameters passing through unchanged (kind/limit included).
  await routes["GET /api/tools"]({}, {}, new URL("http://x/api/tools?q=room&kind=files&limit=7"));
  assert.equal(seen.search.length, 1);
  assert.equal(seen.search[0].q, "room");
  assert.equal(seen.search[0].opts.rootPath, "/tmp/declared-machine-root", "the search path uses the same live root");
  assert.equal(seen.search[0].opts.kind, "files");
  assert.equal(seen.search[0].opts.limit, 7);
  assert.deepEqual(seen.search[0].opts.miniAppTools, [{ name: "mini-tool" }]);
  assert.deepEqual(seen.search[0].opts.harnesses, []);
});

test("a working harness inventory reaches the catalogue, combined with the configured agents", async () => {
  const seen = [];
  const registry = { registryMarker: true };
  const routes = createToolCatalogRoutes({
    json: (res, status, payload) => {
      res.status = status;
      res.payload = payload;
      return res;
    },
    searchTools: async () => ({}),
    listTools: async (opts) => {
      seen.push(opts);
      return { tools: [] };
    },
    getActiveRoot: () => ({ root: { kind: "machine", path: "/tmp/root" } }),
    rootDir: "/fallback-root",
    activeMiniAppRegistry: { getAllTools: () => [] },
    harnessInventory: async () => [{ id: "pi" }],
    listHarnessesWithConfiguredAgents: async (inv, agentRegistry) => {
      assert.deepEqual(inv, [{ id: "pi" }], "the inventory result is what gets combined");
      assert.equal(agentRegistry, registry, "the configured-agent registry is handed through, not re-created");
      return { harnesses: [{ id: "pi", agents: 1 }] };
    },
    agentRegistry: registry,
  });

  const res = await routes["GET /api/tools"]({}, {}, new URL("http://x/api/tools"));
  assert.equal(res.status, 200);
  assert.deepEqual(seen[0].harnesses, [{ id: "pi", agents: 1 }], "the combined harnesses are what the catalogue receives");
  assert.equal(seen[0].rootPath, "/tmp/root");
});
