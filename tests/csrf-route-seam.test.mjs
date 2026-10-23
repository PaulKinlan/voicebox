// voicebox-beads-deo7 — catch a new browser-simple POST before it bypasses the HTTP CSRF decision.
// This is a source seam, not a JavaScript parser: it covers the host's literal table keys and
// conventional inline POST branches. Unrecognised method comparisons fail instead of disappearing.
// Keep the host filename assembled: the lane classifier must keep this source-only test in UNIT.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tableMembers } from "./lib/route-table.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(path.join(root, ["server", "mjs"].join(".")), "utf8");

// A new POST needs an explicit decision here, even if it plans to use the JSON door: the
// reviewer must see the reason. The four csrf keys are also asserted against the host guard.
const decisions = new Map([
  ["POST /api/fleet/contact", "json"],
  ["POST /api/tasks/delegate", "json"],
  ["POST /api/root", "json"],
  ["POST /api/undo", "csrf"],
  ["POST /api/mini-apps", "json"],
  ["POST /api/mini-app/tools", "csrf"],
  ["POST /api/delegate", "json"],
  ["POST /api/exec", "json"],
  ["POST /api/transport/import", "json"],
  ["POST /api/probe", "csrf"],
  ["POST /api/environments", "json"],
  ["POST /api/turn", "json"],
  ["POST /api/agents", "json"],
  ["POST /api/permissions/resolve", "json"],
  ["POST /api/pair", "json"],
  ["POST /api/pair/complete", "json"],
  ["POST /api/bootstrap", "host-token"],
  ["POST /api/call", "json"],
  ["POST /api/execute", "json"],
]);

function postSites(host) {
  const sites = tableMembers(host)
    .filter((member) => /^"POST \/api\//.test(member))
    .map((member) => ({ key: member.slice(1, -1), at: host.indexOf(`  ${member}:`) }));
  const start = host.indexOf("async function handle(req, res) {");
  assert.ok(start !== -1, "host's request dispatcher must exist");
  const lines = host.slice(start).split("\n");
  const offsets = [];
  for (let i = 0, at = start; i < lines.length; at += lines[i++].length + 1) offsets.push(at);
  const guard = lines.findIndex((line) => line.includes("if (browserSensitive && browserMutationRefused(req))"));
  assert.ok(guard !== -1, "browser guard must precede all inline handlers");
  // Only inspect the dispatcher below the browser guard; the opt-in wall above it has its
  // own bootstrap exemption, not a route declaration. The extra method-reference check below
  // makes an unknown nested/multiline POST condition fail loudly rather than evade the scan.
  const accounted = new Set();
  for (let i = guard + 1; i < lines.length; i++) {
    if (!/^  if\s*\(/.test(lines[i])) continue;
    const header = lines[i];
    if (!header.includes('req.method === "POST"') || !header.includes("{")) continue;
    const match = header.match(/url\.pathname === "(\/api\/[^"\s]+)"/);
    if (!match) continue;
    accounted.add(i);
    sites.push({ key: `POST ${match[1]}`, at: offsets[i] });
  }
  // These are not new route declarations: a force decision within /api/probe and three
  // privileged environment surface branches under the existing hasExtensionAuthority gate.
  const internalPostUses = [
    /^    const force = req\.method === "POST" \|\|/,
    /^    if \(surface === "exec" && req\.method === "POST"\)/,
    /^    if \(surface === "git\/config" && \(req\.method === "GET" \|\| req\.method === "POST"\)\)/,
    /^      const body = req\.method === "POST" \? await readJson\(/,
    /^    if \(surface === "git\/init" && req\.method === "POST"\)/,
  ];
  for (let i = guard + 1; i < lines.length; i++) {
    if (!lines[i].includes('req.method === "POST"') || accounted.has(i)) continue;
    assert.ok(internalPostUses.some((pattern) => pattern.test(lines[i])),
      `unclassified POST comparison after browser guard: ${lines[i].trim()}`);
  }
  return sites;
}

function assertPostBoundary(host) {
  const sites = postSites(host);
  const guardStart = host.indexOf("  const browserSensitive =");
  const guardEnd = host.indexOf("  if (browserSensitive && browserMutationRefused(req))", guardStart);
  assert.ok(guardStart !== -1 && guardEnd > guardStart, "browser-sensitive decision must still exist");
  const guard = host.slice(guardStart, guardEnd);
  for (const { key, at } of sites) {
    const decision = decisions.get(key);
    assert.ok(decision, `${key}: new POST route needs a JSON-door, CSRF, or host-authority decision`);
    if (decision === "csrf") {
      assert.ok(guard.includes(`key === "${key}"`), `${key}: missing browser CSRF guard`);
    } else {
      // For conventional handlers the JSON reader or the host token must occur in the handler,
      // not merely somewhere else in the file. The next top-level handler/table member ends it.
      const tail = host.slice(at);
      const next = tail.slice(1).search(/^  (?:if\s*\(|"[A-Z]+ \/|\.\.\.[A-Za-z]+Routes,|};)/m);
      const handler = next === -1 ? tail : tail.slice(0, next + 1);
      const mechanism = decision === "host-token" ? /hostTokenOk\(/ : /\breadJson(?:Body)?\(/;
      assert.match(handler, mechanism, `${key}: declared ${decision} but handler no longer calls its boundary`);
    }
  }
  for (const [key, decision] of decisions) {
    assert.ok(sites.some((site) => site.key === key), `${key}: obsolete ${decision} decision`);
  }
  assert.ok(guard.includes('key === "GET /api/probe"'), "cache-filling GET must retain browser guard");
}

test("every host POST has a reviewed browser-CSRF, JSON-door, or host-token decision", () => {
  assertPostBoundary(source);
});

test("new bodyless POSTs cannot silently enter either host routing shape", () => {
  const inline = source.replace("  // Fall through to public/ for any other path the page requests.",
    '  if (req.method === "POST" && url.pathname === "/api/newthing") { return json(res, 200, { ok: true }); }\n  // Fall through to public/ for any other path the page requests.');
  assert.notEqual(inline, source, "the inline mutation must be applied");
  assert.throws(() => assertPostBoundary(inline), /POST \/api\/newthing: new POST route/);
  const table = source.replace('  "POST /api/fleet/contact":',
    '  "POST /api/newthing": (req, res) => json(res, 200, { ok: true }),\n  "POST /api/fleet/contact":');
  assert.notEqual(table, source, "the table mutation must be applied");
  assert.throws(() => assertPostBoundary(table), /POST \/api\/newthing: new POST route/);
  const nested = source.replace("  // Fall through to public/ for any other path the page requests.",
    '    if (req.method === "POST" && url.pathname === "/api/newthing") return json(res, 200, {});\n  // Fall through to public/ for any other path the page requests.');
  assert.throws(() => assertPostBoundary(nested), /unclassified POST comparison/);
});

test("lost guard or JSON door fails, while a harmless GET does not change the POST inventory", () => {
  const unguarded = source.replace('key === "POST /api/undo"', 'key === "POST /api/unused"');
  assert.notEqual(unguarded, source, "the guard mutation must be applied");
  assert.throws(() => assertPostBoundary(unguarded), /POST \/api\/undo: missing browser CSRF guard/);
  const noDoor = source.replace('if (req.method === "POST" && url.pathname === "/api/delegate") {\n    const body = await readJson();',
    'if (req.method === "POST" && url.pathname === "/api/delegate") {\n    const body = {};');
  assert.notEqual(noDoor, source, "the JSON-door mutation must be applied");
  assert.throws(() => assertPostBoundary(noDoor), /POST \/api\/delegate: declared json but handler no longer calls its boundary/);
  const read = source.replace("  // Fall through to public/ for any other path the page requests.",
    '  if (req.method === "GET" && url.pathname === "/api/readonly") return json(res, 200, {});\n  // Fall through to public/ for any other path the page requests.');
  assertPostBoundary(read);
});
