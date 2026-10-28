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
// voicebox-beads-cegk — and it counts every MUTATING VERB, not the string POST.
//
// The defect it is named for is "a new bodyless MUTATION route inherits no protection and nothing fails", and a
// scan keyed on POST only answers that one verb: a bodyless `PUT`, `PATCH` or `DELETE` — inline or as a table key —
// was not inventoried, was never asked for a decision, and nothing failed. So the seam now classifies by METHOD
// (GET/HEAD/OPTIONS are reads; every other verb is a mutation needing a decision), and it follows the host's two
// `const m = url.pathname.match(/^\/api\/…$/)` routes (`PATCH /api/agents/<param>`,
// `DELETE /api/environments/<param>`), which name their path in a variable and so disappeared from a literal scan.
// What it still does NOT cover, and never did: route groups extracted to their own tables (lib/routes/*.mjs,
// `extensionRoutes`). Those are other files with other seams.
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

// A new mutating route of ANY verb needs an explicit decision here, even if it plans to use the JSON door: the
// reviewer must see the reason. The four csrf keys are also asserted against the host guard, and `authority` keys
// (`PATCH /api/agents/<param>`, `DELETE /api/environments/<param>`) are the routes that match their path into a
// variable and gate on hasExtensionAuthority instead of on a body read.
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
  // voicebox-beads-cegk: the eight non-POST mutating routes that existed when the seam learned the other verbs.
  // Six were invisible because the scan looked for POST; two more name their path in a `url.pathname.match`
  // variable. All eight are gated today (readJson/readJsonBody, hostTokenOk or hasExtensionAuthority) — the
  // decisions are here so that a NEW one cannot arrive without one.
  ["PUT /api/keys", "json"],
  ["PUT /api/agent-settings", "json"],
  ["DELETE /api/root", "host-token"],
  ["PUT /api/mini-apps", "json"],
  ["DELETE /api/mini-apps", "json"],
  ["DELETE /api/pair", "host-token"],
  ["PATCH /api/agents/<param>", "authority"],
  ["DELETE /api/environments/<param>", "authority"],
]);

// ── the seam's own vocabulary ────────────────────────────────────────────────────────────────────────────

const Q = `["']`;
/** The verbs that answer a READ. Everything else the host compares `req.method` against is a mutation. */
const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
/** The mutating verbs this host uses. A verb outside this list still fails loudly below, it just cannot be `===`-named. */
const MUTATING_METHODS = ["POST", "PUT", "PATCH", "DELETE"];
/** The key label for a clause that admits every mutating verb at once (`req.method !== "GET"`) without naming one. */
const ANY_MUTATION = "MUTATION";
/** `req.method`, `req["method"]`, `req['method']` — every spelling the host could use to read the method. */
const METHOD_REF = new RegExp(`req(?:\\[\\s*${Q}method${Q}\\s*\\]|\\.method)`, "g");
/** `url.pathname === "/api/…"` in either quote style. */
const PATH_EQ = new RegExp(`url\\.pathname\\s*===\\s*${Q}(/api/[^"'\\s]+)${Q}`, "g");
/**
 * A method claim that NAMES its verb (`req.method === "PUT"`, and the `req["method"].toUpperCase()` spelling),
 * capturing the verb so the caller can tell a read from a mutation. `!==` is deliberately excluded: it is the
 * NOT_READ shape below, which names no verb.
 */
const METHOD_EQ = new RegExp(
  `(?:${METHOD_REF.source})(?:\\.toUpperCase\\(\\))?\\s*===?\\s*${Q}([A-Z]+)${Q}`,
  "g",
);
/**
 * A non-read guard (`req.method !== "GET"`): it admits every mutating verb without naming one, so it is a mutation
 * claim whose key labels the whole set (`MUTATION /api/…`) rather than inventing a single verb.
 */
const NOT_READ = new RegExp(`!==?\\s*${Q}(?:GET|HEAD|OPTIONS)${Q}`);
const ALIAS_DEF = /^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=([\s\S]*)$/;
/** A variable whose WHOLE value is a method test — the M5 shape. A ternary or an `||` is not one of these. */
const PURE_METHOD_PREDICATE = new RegExp(
  `^\\s*req(?:\\[\\s*${Q}method${Q}\\s*\\]|\\.method)(?:\\.toUpperCase\\(\\))?\\s*===?\\s*${Q}([A-Z]+)${Q}\\s*;?\\s*$`,
);
/**
 * `const envDelete = url.pathname.match(/^\/api\/environments\/([^/]+)$/)` — a route that names its PATH in a
 * variable and then tests `req.method && envDelete`. A literal-only scan cannot see it (`cegk`), so the seam reads
 * the pattern out of the definition and derives `/api/environments/<param>`.
 */
const MATCH_DEF =
  /^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*url\.pathname\.match\(\s*\/((?:\\.|\[[^\]]*\]|[^\/\\\n])+)\/[gimsuy]*\s*\)/;

/** A pathname-matching regex literal as a route key the seam can name: `/^\/api\/agents\/([a-z]+)$/` → `/api/agents/<param>`. */
function pathPattern(body) {
  return body
    .replace(/^\^/, "")
    .replace(/\$$/, "")
    .replace(/\\(.)/g, "$1")
    .replace(/\([^()]*\)/g, "<param>");
}

/** Every verb one clause tests for, mutating or read, plus `ANY_MUTATION` for a `!== "GET"` clause. */
function clauseMethods(clause, predicateAliases) {
  const methods = new Set();
  for (const match of clause.matchAll(METHOD_EQ)) methods.add(match[1].toUpperCase());
  if (NOT_READ.test(clause)) methods.add(ANY_MUTATION);
  for (const [name, verb] of predicateAliases) {
    if (new RegExp(`\\b${name}\\b`).test(clause)) methods.add(verb);
  }
  return methods;
}

// The opt-in wall's grant expression (`const exempt = …` in server.mjs) decides whether the wall lets a request
// THROUGH to the routes below. Its health clause is a read grant, not a route declaration; its bootstrap clause is
// the `POST /api/bootstrap` decision, which the seam checks like any other. Named here rather than skipped with a
// `guard + 1` offset, because an offset above the guard is exactly what let M3 through.
const WALL_GRANT = new RegExp(`^const exempt\\s*=\\s*url\\.pathname\\s*===\\s*${Q}/api/health${Q}$`);

// These are not new route declarations: a force decision within /api/probe and four privileged environment surface
// branches under the existing hasExtensionAuthority gate. Anything else that claims a mutating verb without naming a
// route fails loudly, which is the property this list trades on — adding a route here would hide it.
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
 * Every MUTATING route the host declares (any verb that is not a read), from BOTH shapes, plus every complaint
 * about a mutation claim it could not classify. `complaints` is the loud half: a caller asserts it is empty.
 */
function postScan(host) {
  const handleStart = host.indexOf("async function handle(req, res) {");
  assert.ok(handleStart !== -1, "host's request dispatcher must exist");
  const dispatcher = host.slice(handleStart);
  const stmts = statements(dispatcher.split("\n"), handleStart);

  // Variable-held method tests (M5). Only a variable whose whole value is the comparison is followed; its verb is
  // carried with it, so `const isTouch = req.method === "PUT"` is inventoried as a PUT route and not as a POST.
  const predicateAliases = new Map();
  // Path-name variables (`cegk`): `const envDelete = url.pathname.match(/^\/api\/environments\/([^/]+)$/)`.
  const matchRoutes = new Map();
  for (const stmt of stmts) {
    const definition = stmt.text.match(ALIAS_DEF);
    const held = definition && definition[2].trim().match(PURE_METHOD_PREDICATE);
    if (held && !READ_METHODS.has(held[1].toUpperCase())) predicateAliases.set(definition[1], held[1].toUpperCase());
    const matched = stmt.text.match(MATCH_DEF);
    if (matched) matchRoutes.set(matched[1], pathPattern(matched[2]));
  }

  const inline = [];
  const complaints = [];
  for (const stmt of stmts) {
    const isAliasDefinition = Boolean(stmt.text.match(ALIAS_DEF)) && !/^\s*if\b/.test(stmt.text.trim());
    for (const clause of clauses(stmt.text)) {
      PATH_EQ.lastIndex = 0;
      const literalPaths = [...clause.matchAll(PATH_EQ)].map((match) => match[1]);
      METHOD_REF.lastIndex = 0;
      const hasMethodTest = METHOD_REF.test(clause);
      // A route that matched its path into a variable names it there; the literal wins when both are present. Only a
      // clause that also tests the METHOD declares a route — otherwise `const m = url.pathname.match(…)` and its uses
      // (`agentMatch[1]`) would each look like a method-less route.
      const heldPaths = hasMethodTest
        ? [...matchRoutes].filter(([name]) => new RegExp(`\\b${name}\\b`).test(clause)).map(([, routePath]) => routePath)
        : [];
      const paths = literalPaths.length ? literalPaths : heldPaths;
      const methods = clauseMethods(clause, predicateAliases);
      const mutations = [...methods].filter((verb) => !READ_METHODS.has(verb));

      if (paths.length && mutations.length) {
        for (const routePath of paths) {
          for (const verb of mutations) inline.push({ key: `${verb} ${routePath}`, at: stmt.at });
        }
        continue;
      }
      if (paths.length && !methods.size) {
        if (WALL_GRANT.test(flat(clause)) || INTERNAL_POST_USES.some((pattern) => pattern.test(flat(clause)))) continue;
        complaints.push(
          hasMethodTest
            ? `route clause that reads req.method but names no verb this seam can classify, so it may admit every mutating verb: ${flat(clause)}`
            : `route clause that names no method test, so it admits every method including POST, PUT, PATCH and DELETE: ${flat(clause)}`,
        );
        continue;
      }
      if (mutations.length && !isAliasDefinition) {
        if (INTERNAL_POST_USES.some((pattern) => pattern.test(flat(clause)))) continue;
        complaints.push(
          `${mutations.join("/")} claim that declares no route (add it here as a named internal use, or give the route a decision): ${flat(clause)}`,
        );
      }
    }
  }

  // The table shape, quote-agnostic (M4). Every KEYED method is read and the read verbs are dropped, so a verb this
  // seam has never seen is still inventoried instead of being invisible for being unfamiliar (`cegk`).
  const table = [...host.matchAll(new RegExp(`${Q}([A-Z]+ \\/api\\/[^"'\`]+)${Q}\\s*:`, "g"))]
    .filter((match) => !READ_METHODS.has(match[1].split(" ")[0]))
    .map((match) => ({ key: match[1], at: match.index }));

  // The shared table parser (`tests/lib/route-table.mjs`) must agree with this seam's quote-agnostic scan on the
  // double-quoted members: if the parser's shape moves, this seam's regex must move with it rather than drifting.
  const shared = tableMembers(host)
    .filter((member) => member.startsWith('"') && !READ_METHODS.has(member.slice(1, -1).split(" ")[0]))
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
  assert.deepEqual(complaints, [], `unclassifiable mutation claims:\n  ${complaints.join("\n  ")}`);

  const guardStart = host.indexOf("  const browserSensitive =");
  const guardEnd = host.indexOf("  if (browserSensitive && browserMutationRefused(req))", guardStart);
  assert.ok(guardStart !== -1 && guardEnd > guardStart, "browser-sensitive decision must still exist");
  const guard = host.slice(guardStart, guardEnd);
  // What each decision BUYS. A decision is a claim about the handler, so the seam checks the handler still makes it.
  const MECHANISMS = {
    "host-token": /hostTokenOk\(/,
    authority: /hasExtensionAuthority\(/,
    json: /\breadJson(?:Body)?\(/,
  };
  for (const { key, at } of sites) {
    const decision = decisions.get(key);
    assert.ok(
      decision,
      `${key}: new ${key.split(" ")[0]} route needs a JSON-door, CSRF, host-authority, or extension-authority decision`,
    );
    if (decision === "csrf") {
      assert.ok(guard.includes(`key === "${key}"`), `${key}: missing browser CSRF guard`);
    } else {
      const mechanism = MECHANISMS[decision];
      assert.ok(mechanism, `${key}: unknown decision kind ${decision}`);
      // For conventional handlers the JSON reader or the host token must occur in the handler,
      // not merely somewhere else in the file. The next top-level handler/table member ends it.
      const tail = host.slice(at);
      const next = tail.slice(1).search(/^  (?:if\s*\(|"[A-Z]+ \/|'[A-Z]+ \/|\.\.\.[A-Za-z]+Routes,|};)/m);
      const handler = next === -1 ? tail : tail.slice(0, next + 1);
      assert.match(handler, mechanism, `${key}: declared ${decision} but handler no longer calls its boundary`);
    }
  }
  for (const [key, decision] of decisions) {
    assert.ok(sites.some((site) => site.key === key), `${key}: obsolete ${decision} decision`);
  }
  // The inventory floor is LAST on purpose: a route that disappears is reported as an obsolete decision above, and
  // this catches the other failure — a scan that silently stops seeing routes it can still name.
  assert.ok(
    sites.length >= decisions.size,
    `the scan must see every mutating route the decisions name, found ${sites.length} of ${decisions.size} (${sites.map((site) => site.key).join(", ")})`,
  );
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
    reason: /MUTATION \/api\/newthing: new MUTATION route/,
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
    reason: /admits every method including POST, PUT, PATCH and DELETE/,
  },
  // voicebox-beads-cegk: the same bodyless route one verb over. Each of these was GREEN before the seam counted
  // mutating verbs, because the inventory, the alias table and the table-key filter all said "POST".
  {
    name: "M7 a bodyless inline PUT with no body read and no authority check",
    mutant: (host) =>
      host.replace(
        "  // Fall through to public/ for any other path the page requests.",
        `  if (req.method === "PUT" && url.pathname === "/api/newthing") { return json(res, 200, { ok: true }); }\n  // Fall through to public/ for any other path the page requests.`,
      ),
    reason: /PUT \/api\/newthing: new PUT route/,
  },
  {
    name: "M8 a bodyless inline PATCH",
    mutant: (host) =>
      host.replace(
        "  // Fall through to public/ for any other path the page requests.",
        `  if (req.method === "PATCH" && url.pathname === "/api/newthing") { return json(res, 200, { ok: true }); }\n  // Fall through to public/ for any other path the page requests.`,
      ),
    reason: /PATCH \/api\/newthing: new PATCH route/,
  },
  {
    name: "M9 a bodyless inline DELETE",
    mutant: (host) =>
      host.replace(
        "  // Fall through to public/ for any other path the page requests.",
        `  if (req.method === "DELETE" && url.pathname === "/api/newthing") { return json(res, 200, { ok: true }); }\n  // Fall through to public/ for any other path the page requests.`,
      ),
    reason: /DELETE \/api\/newthing: new DELETE route/,
  },
  {
    name: "M10 a bodyless non-POST TABLE key",
    mutant: (host) =>
      host.replace(
        '  "POST /api/fleet/contact":',
        `  "DELETE /api/newthing": async (req, res) => json(res, 200, { ok: true }),\n  "POST /api/fleet/contact":`,
      ),
    reason: /DELETE \/api\/newthing: new DELETE route/,
  },
  {
    name: "M11 a path matched into a variable and then mutated",
    mutant: (host) =>
      host.replace(
        "  // Fall through to public/ for any other path the page requests.",
        `  const newThing = url.pathname.match(/^\\/api\\/newthing\\/([^/]+)$/);\n  if (req.method === "PATCH" && newThing) { return json(res, 200, { ok: true }); }\n  // Fall through to public/ for any other path the page requests.`,
      ),
    reason: /PATCH \/api\/newthing\/<param>: new PATCH route/,
  },
];

test("every host mutation has a reviewed browser-CSRF, JSON-door, or authority decision", () => {
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

// voicebox-beads-cegk: the non-POST decisions must be REAL — a decision that a handler no longer honours, and a
// decision for a route that no longer exists, are the two ways this widened inventory could rot into decoration.
test("a non-POST decision is checked against its handler, and an unused one is reported", () => {
  const noAuthority = source.replace(
    'if (req.method === "PATCH" && agentMatch) {\n    if (!hasExtensionAuthority(req)) {',
    'if (req.method === "PATCH" && agentMatch) {\n    if (false) {',
  );
  assert.notEqual(noAuthority, source, "the PATCH /api/agents authority check must still be where this test removes it");
  assert.throws(
    () => assertPostBoundary(noAuthority),
    /PATCH \/api\/agents\/<param>: declared authority but handler no longer calls its boundary/,
  );

  const goneDelete = source.replace('if (req.method === "DELETE" && url.pathname === "/api/mini-apps") {', 'if (false) {');
  assert.notEqual(goneDelete, source, "the DELETE /api/mini-apps handler must still be where this test removes it");
  assert.throws(() => assertPostBoundary(goneDelete), /DELETE \/api\/mini-apps: obsolete json decision/);

  // The other control arm: a new READ verb stays out of the mutation inventory, so the widening did not turn every
  // route into a decision.
  const head = source.replace(
    '  "POST /api/fleet/contact":',
    '  "HEAD /api/newthing": (req, res) => res.end(),\n  "POST /api/fleet/contact":',
  );
  assert.notEqual(head, source, "the HEAD control must be applied");
  assertPostBoundary(head);
});
