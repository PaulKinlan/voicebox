// tests/lib/route-table.mjs — one computing site for "where is a routed group in the host's table?"
//
// WHY THIS EXISTS (voicebox-beads-r9hv.5, the 91tp recurrence). Several seam tests proved that an extracted
// route group was still wired where it belonged by naming the entry that happened to sit NEXT to it —
// `\.\.\.activityRoutes,\s*"GET /api/gemini/capabilities":` and friends. When the neighbouring group was in
// turn extracted, the literal collapsed into a spread, and the guard failed while routing was perfectly
// intact: that cost a full gate on bf8a9be (voicebox-beads-91tp). Neighbour identity is incidental, so every
// extraction of a neighbour cost another gate.
//
// What can ACTUALLY dispatch wrongly in an object literal is narrow, and these helpers check exactly that:
//
//   1. a group spread TWICE — the last duplicate key wins silently, so a second spread is a behaviour
//      change no behaviour test would see;
//   2. the table's ORDER drifting — the order is the table's documented dispatch structure, and a
//      duplicated key's winner depends on it;
//   3. an inline handler SHADOWING a group's keys.
//
// And nothing here mentions adjacency, so extracting a neighbour cannot red a guard again. Anchors should be
// SPREAD GROUPS (`...fooRoutes`) rather than literal keys wherever possible: a spread survives its
// neighbours being extracted, a literal does not.
import assert from "node:assert/strict";

const TABLE_HEADER = "const routes = {";

/** The table's members in source order: `...nameRoutes` spreads and `"METHOD /path"` keys. */
export function tableMembers(source) {
  assert.equal(typeof source, "string", "tableMembers needs the source text");
  const start = source.indexOf(TABLE_HEADER);
  assert.ok(start > -1, `server.mjs must still build a routes table (looking for \`${TABLE_HEADER}\`)`);
  const end = source.indexOf("\n};", start);
  assert.ok(end > start, "the routes table must be closed");
  const members = [];
  for (const line of source.slice(start, end).split("\n")) {
    const spread = line.match(/^\s*\.\.\.(\w+),/);
    if (spread) {
      members.push(`...${spread[1]}`);
      continue;
    }
    const key = line.match(/^\s*"([A-Z]+ \/[^"]*)"\s*:/);
    if (key) members.push(`"${key[1]}"`);
  }
  return members;
}

function escapeForRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Assert a routed group's wiring: spread exactly once, in the expected order relative to `order`'s anchors,
 * with none of `shadow`'s route keys handled inline.
 *
 * @param {string} source the host source (server.mjs)
 * @param {{ group: string, order?: string[], shadow?: string[] }} spec
 *   group  — the spread to guard, e.g. "...agentsReadRoutes"
 *   order  — anchors expected BEFORE the group, in table order, e.g. ["...presenceRoutes"]
 *   shadow — route keys that must not exist inline, e.g. ["GET /api/agents"]
 * @returns {string[]} the table's members, so callers can assert further structure without re-parsing
 */
export function assertRouteGroupWiring(source, { group, order = [], shadow = [] }) {
  const members = tableMembers(source);

  for (const anchor of [group, ...order]) {
    assert.equal(
      members.filter((m) => m === anchor).length,
      1,
      `${anchor} must appear exactly once in the routes table — an object literal lets the last duplicate key win, so a second occurrence is a silent dispatch change`,
    );
  }

  const expected = [...order, group];
  const positions = expected.map((a) => members.indexOf(a));
  assert.ok(
    positions.every((p) => p > -1),
    `every guarded member must still be in the table: ${JSON.stringify(expected.map((a, i) => [a, positions[i]]))}`,
  );
  assert.deepEqual(
    positions,
    [...positions].sort((a, b) => a - b),
    `the routes table's order must be preserved: ${expected.map((a, i) => `${a}@${positions[i]}`).join(" < ")}`,
  );

  for (const key of shadow) {
    assert.doesNotMatch(
      source,
      new RegExp(`^\\s*"${escapeForRegExp(key)}"\\s*:`, "m"),
      `no inline ${key} may shadow the factory`,
    );
  }

  return members;
}
