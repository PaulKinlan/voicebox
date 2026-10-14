import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createActivityRoutes } from "../lib/routes/activity.mjs";

/**
 * The route table's members, in source order: `...nameRoutes` spreads and "METHOD /path" keys.
 * Built here rather than reaching for a shared helper so this test's guard is self-contained.
 */
function tableMembers(source) {
  const start = source.indexOf("const routes = {");
  assert.ok(start > -1, "server.mjs must still build a routes table");
  const end = source.indexOf("\n};", start);
  assert.ok(end > start, "the routes table must be closed");
  const members = [];
  for (const line of source.slice(start, end).split("\n")) {
    const spread = line.match(/^\s*\.\.\.(\w+),/);
    if (spread) { members.push(`...${spread[1]}`); continue; }
    const key = line.match(/^\s*"([A-Z]+ \/[^"]*)":/);
    if (key) members.push(`"${key[1]}"`);
  }
  return members;
}

/**
 * The guard that actually protects activity's dispatch (voicebox-beads-91tp).
 *
 * This replaced an assertion that pinned the entry WHICH HAPPENED TO FOLLOW `...activityRoutes` —
 * `"GET /api/gemini/capabilities"` — as proof that the group was still in its table position. That
 * neighbour moved into lib/routes/gemini-media.mjs (voicebox-beads-r9hv.4) and the guard failed while the
 * thing it was protecting was perfectly fine, which cost a full gate. Neighbour identity is incidental, and
 * the next extraction of any neighbour would break it again.
 *
 * What can actually dispatch wrongly in an object literal is: the group being spread twice (the LAST key
 * wins silently), an inline handler shadowing its keys, and the group drifting out of the order the table
 * was written in. So the guard checks EXACTLY those and nothing about who sits next to it.
 */
function assertActivityTablePosition(source) {
  const members = tableMembers(source);
  assert.equal(
    members.filter((m) => m === "...activityRoutes").length,
    1,
    "the activity group must be spread exactly once — an object literal lets the last duplicate key win, so a second spread is a silent behaviour change",
  );
  const anchors = ["...presenceRoutes", "...agentsReadRoutes", "...activityRoutes", '"DELETE /api/root"'];
  const positions = anchors.map((a) => members.indexOf(a));
  assert.ok(
    positions.every((p) => p > -1),
    `every anchor must still be a table member: ${JSON.stringify(anchors.map((a, i) => [a, positions[i]]))}`,
  );
  assert.deepEqual(
    positions,
    [...positions].sort((a, b) => a - b),
    "the activity group must keep its order relative to the table's other groups",
  );
  assert.doesNotMatch(source, /"(?:GET|DELETE) \/api\/activity":/, "no inline handler can shadow the factory");
}

test("activity factory is wired at its exact host table position without inline duplicates", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const source = readFileSync(path.join(root, "server.mjs"), "utf8");
  assert.match(source, /createActivityRoutes\(\{ workActivityLog, json \}\)/);
  assertActivityTablePosition(source);

  // SELF-PROVING MUTANTS: a guard that cannot fail is decoration, so each way this can actually go wrong
  // must make it throw. Note the mutants are the dispatch hazards, not "the neighbour changed".
  const duplicated = source.replace("  ...activityRoutes,\n", "  ...activityRoutes,\n  ...activityRoutes,\n");
  assert.notEqual(duplicated, source, "the duplicate-spread mutant must change the source");
  assert.throws(() => assertActivityTablePosition(duplicated), { name: "AssertionError" }, "a second spread must be refused: the last key wins silently");

  const moved = source.replace("  ...activityRoutes,\n", "").replace("const routes = {\n", "const routes = {\n  ...activityRoutes,\n");
  assert.notEqual(moved, source, "the moved-spread mutant must change the source");
  assert.throws(() => assertActivityTablePosition(moved), { name: "AssertionError" }, "drifting out of order must be refused");

  const shadowed = source.replace("  ...activityRoutes,\n", '  ...activityRoutes,\n  "GET /api/activity": () => null,\n');
  assert.notEqual(shadowed, source, "the shadowing mutant must change the source");
  assert.throws(() => assertActivityTablePosition(shadowed), { name: "AssertionError" }, "an inline duplicate must be refused");
});

test("GET and DELETE retain the host's single mutable log and all later producer writes", () => {
  const initial = { kind: "file", summary: "wrote a.txt" };
  const log = [initial];
  const json = (response, status, payload) => { response.status = status; response.payload = payload; return response; };
  const routes = createActivityRoutes({ workActivityLog: log, json });
  assert.deepEqual(Object.keys(routes).sort(), ["DELETE /api/activity", "GET /api/activity"]);
  const get = routes["GET /api/activity"];
  const del = routes["DELETE /api/activity"];
  const before = {};
  get(null, before);
  assert.equal(before.status, 200);
  assert.deepEqual(before.payload, { ok: true, entries: [initial] });
  assert.strictEqual(before.payload.entries, log, "GET observes the same array producers append to");

  const cleared = {};
  del(null, cleared);
  assert.equal(cleared.status, 200);
  assert.deepEqual(cleared.payload, { ok: true, entries: [] });
  assert.strictEqual(before.payload.entries, log, "DELETE must not replace the producer's array");
  assert.deepEqual(log, [], "DELETE empties it in place");
  const later = { kind: "command", summary: "later" };
  log.push(later); // the host's appendWorkActivity still holds this reference
  const after = {};
  get(null, after);
  assert.strictEqual(after.payload.entries, log);
  assert.deepEqual(after.payload.entries, [later]);
});
