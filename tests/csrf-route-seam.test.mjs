// voicebox-beads-deo7 — catch a new browser-simple POST before it bypasses the HTTP CSRF decision.
// voicebox-beads-3zpy — and catch it whatever SPELLING the new route uses.
//
// This is a source seam, not a JavaScript parser: it covers the host's literal table keys and its inline POST
// branches. Unrecognised method comparisons fail instead of disappearing.
//
// WHAT THE 3zpy MUTANTS TAUGHT IT (each is a test below, and each was GREEN before this change):
//   M1 single-quoted `req.method === 'POST'`            — the scan matched only double quotes
//   M2 `url.pathname === "/api/newthing" && req.method !== "GET"` — no `=== "POST"` literal to find
//   M3 the same branch ABOVE the browser guard          — the scan started at `guard + 1`
//   M4 a single-quoted table key `'POST /api/newthing':` — the table filter matched only `"POST `
//   M5 `const isPost = req["method"].toUpperCase() === "POST"; if (isPost && url.pathname === …)`
//                                                       — the method test lived in a variable
// So the seam now reads the dispatcher as STATEMENTS and, inside each, as top-level `||` CLAUSES: a clause that
// names an `/api/…` path and claims POST derives a route key, and every derived key needs a decision. Quotes are
// matched as quotes, the whole dispatcher is scanned (the opt-in wall is named as a grant, not skipped by an
// offset), and a method test whose value is held in a pure-comparison variable is followed.
//
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

// ── the seam's own vocabulary ────────────────────────────────────────────────────────────────────────────

const Q = `["']`;
/** `req.method`, `req["method"]`, `req['method']` — every spelling the host could use to read the method. */
const METHOD_REF = new RegExp(`req(?:\\[\\s*${Q}method${Q}\\s*\\]|\\.method)`, "g");
/** `url.pathname === "/api/…"` in either quote style. */
const PATH_EQ = new RegExp(`url\\.pathname\\s*===\\s*${Q}(/api/[^"'\\s]+)${Q}`, "g");
/** A positive POST claim. `!==` is deliberately excluded: it is the NOT_GET shape below. */
const POST_EQ = new RegExp(`===\\s*${Q}POST${Q}`);
/** A non-read guard (`req.method !== "GET"`): it admits POST among others, so it CLAIMS nothing but admits POST. */
const NOT_GET = new RegExp(`!==?\\s*${Q}GET${Q}`);
const ALIAS_DEF = /^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=([\s\S]*)$/;
/** A variable whose WHOLE value is a method test — the M5 shape. A ternary or an `||` is not one of these. */
const PURE_POST_PREDICATE = new RegExp(
  `^\\s*req(?:\\[\\s*${Q}method${Q}\\s*\\]|\\.method)(?:\\.toUpperCase\\(\\))?\\s*===?\\s*${Q}POST${Q}\\s*;?\\s*$`,
);

// The opt-in wall's grant expression (`const exempt = …` in server.mjs) decides whether the wall lets a request
// THROUGH to the routes below. Its health clause is a read grant, not a route declaration; its bootstrap clause is
// the `POST /api/bootstrap` decision, which the seam checks like any other. Named here rather than skipped with a
// `guard + 1` offset, because an offset above the guard is exactly what let M3 through.
const WALL_GRANT = new RegExp(`^const exempt\\s*=\\s*url\\.pathname\\s*===\\s*${Q}/api/health${Q}$`);

// These are not new route declarations: a force decision within /api/probe and four privileged environment surface
// branches under the existing hasExtensionAuthority gate. Anything else that claims POST without naming a route
// fails loudly, which is the property this list trades on — adding a route here would hide it.
const INTERNAL_POST_USES = [
  /const force\s*=\s*req\.method\s*===\s*["']POST["']\s*\|\|/,
  /surface === "exec" && req\.method\s*===\s*["']POST["']/,
  /surface === "git\/config" && \(req\.method\s*===\s*["']GET["'] \|\| req\.method\s*===\s*["']POST["']\)/,
  /const body = req\.method\s*===\s*["']POST["']\s*\?/,
  /surface === "git\/init" && req\.method\s*===\s*["']POST["']/,
];

/**
 * The dispatcher as STATEMENTS, with the absolute offset of each. A statement continues while its expression is
 * visibly unfinished — open parentheses, or a trailing operator/`=`/`,`/`(`. A line ending in `{` closes the
 * statement at the header, so a handler body is not swallowed into its condition.
 *
 * Linear on purpose: the balance is per LINE, not re-counted over the accumulated buffer (the first draft re-walked
 * every statement for every line and cost this file 4.5s of unit gate per scan), and quoted strings are blanked
 * before the count so a parenthesis inside a message cannot swallow the rest of the dispatcher.
 */
function statements(lines, base) {
  const out = [];
  let buffer = null;
  let at = base;
  let depth = 0;
  let offset = base;
  const STRINGS = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g;
  for (const line of lines) {
    if (buffer === null) {
      buffer = line;
      at = offset;
    } else {
      buffer += "\n" + line;
    }
    for (const ch of line.replace(STRINGS, '""')) {
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
    }
    const unfinished = depth > 0 || /(?:[=+|&,(\[]|\|\||&&|=>)$/.test(line.trim());
    if (!unfinished) {
      out.push({ text: buffer, at });
      buffer = null;
      depth = 0;
    }
    offset += line.length + 1;
  }
  if (buffer !== null) out.push({ text: buffer, at });
  return out;
}

/**
 * Top-level `||` clauses of one statement. The opt-in wall lists independent grants this way, and each grant is a
 * separate decision: without this split, the wall's `/api/health` read grant would inherit the POST claim of the
 * bootstrap clause beside it and be reported as a bodyless POST route.
 */
function clauses(statement) {
  const out = [];
  let depth = 0;
  let buffer = "";
  for (let i = 0; i < statement.length; i++) {
    const ch = statement[i];
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth--;
    if (depth === 0 && statement.startsWith("||", i)) {
      out.push(buffer);
      buffer = "";
      i++;
      continue;
    }
    buffer += ch;
  }
  out.push(buffer);
  return out.map((part) => part.trim()).filter(Boolean);
}

/** The flat form of a clause, for matching the allowance list against a whole expression. */
const flat = (text) => text.replace(/\s+/g, " ").trim();

/**
 * Every POST route the host declares, from BOTH shapes, plus every complaint about a POST claim it could not
 * classify. `complaints` is the loud half: a caller asserts it is empty.
 */
function postScan(host) {
  const handleStart = host.indexOf("async function handle(req, res) {");
  assert.ok(handleStart !== -1, "host's request dispatcher must exist");
  const dispatcher = host.slice(handleStart);
  const stmts = statements(dispatcher.split("\n"), handleStart);

  // Variable-held method tests (M5). Only a variable whose whole value is the comparison is followed.
  const predicateAliases = new Set();
  for (const stmt of stmts) {
    const definition = stmt.text.match(ALIAS_DEF);
    if (definition && PURE_POST_PREDICATE.test(definition[2])) predicateAliases.add(definition[1]);
  }

  const inline = [];
  const complaints = [];
  for (const stmt of stmts) {
    const isAliasDefinition = Boolean(stmt.text.match(ALIAS_DEF)) && !/^\s*if\b/.test(stmt.text.trim());
    for (const clause of clauses(stmt.text)) {
      PATH_EQ.lastIndex = 0;
      const paths = [...clause.matchAll(PATH_EQ)].map((match) => match[1]);
      METHOD_REF.lastIndex = 0;
      const hasMethodTest = METHOD_REF.test(clause);
      const aliasClaim = [...predicateAliases].find((name) => new RegExp(`\\b${name}\\b`).test(clause));
      const claimsPost = POST_EQ.test(clause) || NOT_GET.test(clause) || Boolean(aliasClaim);

      if (paths.length && claimsPost) {
        for (const routePath of paths) inline.push({ key: `POST ${routePath}`, at: stmt.at });
        continue;
      }
      if (paths.length && !hasMethodTest) {
        if (WALL_GRANT.test(flat(clause)) || INTERNAL_POST_USES.some((pattern) => pattern.test(flat(clause)))) continue;
        complaints.push(`route clause that names no method test, so it admits every method including POST: ${flat(clause)}`);
        continue;
      }
      if (claimsPost && !isAliasDefinition) {
        if (INTERNAL_POST_USES.some((pattern) => pattern.test(flat(clause)))) continue;
        complaints.push(`POST claim that declares no route (add it here as a named internal use, or give the route a decision): ${flat(clause)}`);
      }
    }
  }

  // The table shape, quote-agnostic (M4).
  const table = [...host.matchAll(new RegExp(`${Q}(POST \\/api\\/[^"'\`]+)${Q}\\s*:`, "g"))].map((match) => ({
    key: match[1],
    at: match.index,
  }));

  // The shared table parser (`tests/lib/route-table.mjs`) must agree with this seam's quote-agnostic scan on the
  // double-quoted members: if the parser's shape moves, this seam's regex must move with it rather than drifting.
  const shared = tableMembers(host)
    .filter((member) => /^"POST \/api\//.test(member))
    .map((member) => member.slice(1, -1));
  for (const key of shared) {
    assert.ok(table.some((site) => site.key === key), `the seam's table scan must not miss ${key}, which tests/lib/route-table.mjs sees`);
  }

  return { inline, table, complaints };
}

/** Both shapes, deduplicated by key, keeping the earliest offset — the handler-boundary search starts there. */
function postSites(host) {
  const { inline, table, complaints } = postScan(host);
  const byKey = new Map();
  for (const site of [...inline, ...table]) {
    const seen = byKey.get(site.key);
    if (!seen || site.at < seen.at) byKey.set(site.key, site);
  }
  return { sites: [...byKey.values()], complaints };
}

function assertPostBoundary(host) {
  const { sites, complaints } = postSites(host);
  assert.ok(sites.length >= 19, `the scan must see the whole POST inventory, found ${sites.length} (${sites.map((site) => site.key).join(", ")})`);
  assert.deepEqual(complaints, [], `unclassifiable POST claims:\n  ${complaints.join("\n  ")}`);

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
      const next = tail.slice(1).search(/^  (?:if\s*\(|"[A-Z]+ \/|'[A-Z]+ \/|\.\.\.[A-Za-z]+Routes,|};)/m);
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

// A mutation the seam must refuse, and the reason it must give.
const MUTANTS = [
  {
    name: "M1 single-quoted method test",
    mutant: (host) =>
      host.replace(
        "  // Fall through to public/ for any other path the page requests.",
        `  if (req.method === 'POST' && url.pathname === "/api/newthing") { return json(res, 200, { ok: true }); }\n  // Fall through to public/ for any other path the page requests.`,
      ),
    reason: /POST \/api\/newthing: new POST route/,
  },
  {
    name: "M2 a route that admits POST by excluding only GET",
    mutant: (host) =>
      host.replace(
        "  // Fall through to public/ for any other path the page requests.",
        `  if (url.pathname === "/api/newthing" && req.method !== "GET") { return json(res, 200, { ok: true }); }\n  // Fall through to public/ for any other path the page requests.`,
      ),
    reason: /POST \/api\/newthing: new POST route/,
  },
  {
    name: "M3 the same branch inserted ABOVE the browser guard",
    mutant: (host) =>
      host.replace(
        "  if (browserSensitive && browserMutationRefused(req)) {",
        `  if (req.method === "POST" && url.pathname === "/api/newthing") { return json(res, 200, { ok: true }); }\n  if (browserSensitive && browserMutationRefused(req)) {`,
      ),
    reason: /POST \/api\/newthing: new POST route/,
  },
  {
    name: "M4 single-quoted table key",
    mutant: (host) =>
      host.replace(
        '  "POST /api/fleet/contact":',
        `  'POST /api/newthing': (req, res) => json(res, 200, { ok: true }),\n  "POST /api/fleet/contact":`,
      ),
    reason: /POST \/api\/newthing: new POST route/,
  },
  {
    name: "M5 the method test held in a variable",
    mutant: (host) =>
      host.replace(
        "  // Fall through to public/ for any other path the page requests.",
        `  const isNewPost = req["method"].toUpperCase() === "POST";\n  if (isNewPost && url.pathname === "/api/newthing") { return json(res, 200, { ok: true }); }\n  // Fall through to public/ for any other path the page requests.`,
      ),
    reason: /POST \/api\/newthing: new POST route/,
  },
  {
    name: "M6 a route with no method test at all, which admits POST and every other method",
    mutant: (host) =>
      host.replace(
        "  // Fall through to public/ for any other path the page requests.",
        `  if (url.pathname === "/api/newthing") { return json(res, 200, { ok: true }); }\n  // Fall through to public/ for any other path the page requests.`,
      ),
    reason: /admits every method including POST/,
  },
];

test("every host POST has a reviewed browser-CSRF, JSON-door, or host-token decision", () => {
  assertPostBoundary(source);
});

for (const { name, mutant, reason } of MUTANTS) {
  test(`${name} fails loudly instead of entering the host routing`, () => {
    const mutated = mutant(source);
    assert.notEqual(mutated, source, `${name}: the mutation must actually be applied — an anchor moved out from under this test proves nothing`);
    assert.throws(
      () => assertPostBoundary(mutated),
      reason,
      `${name}: the seam must refuse this shape. A GREEN result here means a new bodyless POST can enter the host with no browser-CSRF decision and no test failing.`,
    );
  });
}

test("lost guard or JSON door fails, while a harmless GET does not change the POST inventory", () => {
  const unguarded = source.replace('key === "POST /api/undo"', 'key === "POST /api/unused"');
  assert.notEqual(unguarded, source, "the guard mutation must be applied");
  assert.throws(() => assertPostBoundary(unguarded), /POST \/api\/undo: missing browser CSRF guard/);

  const noDoor = source.replace(
    'if (req.method === "POST" && url.pathname === "/api/delegate") {\n    const body = await readJson();\n    const result = await execute({ verb: "delegate_task"',
    'if (req.method === "POST" && url.pathname === "/api/delegate") {\n    const body = {};\n    const result = await execute({ verb: "delegate_task"',
  );
  assert.notEqual(noDoor, source, "the JSON-door mutation must be applied");
  assert.throws(() => assertPostBoundary(noDoor), /POST \/api\/delegate: declared json but handler no longer calls its boundary/);

  // The control arm: a READ route changes nothing, so the seam is not simply allergic to edits.
  const read = source.replace(
    "  // Fall through to public/ for any other path the page requests.",
    '  if (req.method === "GET" && url.pathname === "/api/readonly") return json(res, 200, {});\n  // Fall through to public/ for any other path the page requests.',
  );
  assert.notEqual(read, source, "the GET control must be applied");
  assertPostBoundary(read);
});
