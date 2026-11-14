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
// `const m = url.pathname.match(/^\/api\/…$/)` routes (such as `DELETE /api/environments/<param>`), which name
// their path in a variable and so disappeared from a literal scan.
//
// voicebox-beads-zfrh — and the verb is read as a verb, not as an upper-case token.
//
// The bead was filed as "`POST_EQ` uses strict `===` while the other patterns allow loose `==`/`!=`", and on this
// branch that literal repro is already refused (cegk's `METHOD_EQ` is `===?`). What survived was the same family one
// step over: `=== "post"`, `req.method.toLowerCase() === "post"`, and `!= "get"` all stayed GREEN, because the
// patterns captured `[A-Z]+`. A reader who spells the verb the way the header carries it, or normalises it before
// comparing, was writing a route this seam could not see. Verbs are now captured as letters and upper-cased for
// classification, both `.toUpperCase()` and `.toLowerCase()` are accepted, and a not-read guard only counts when the
// verb it excludes is actually a READ — so any method comparison left unclassifiable is named as a complaint rather
// than silently skipped (Z1–Z7 below).
// What it still does NOT cover, and never did: route groups extracted to their own tables (lib/routes/*.mjs,
// `extensionRoutes`). Those are other files with other seams.
//
// The host is read as TEXT: no server, no browser, no process. The lane classifier files this in the unit tier
// because reading a launch target is not launching it (voicebox-beads-wkdp) — the filename needs no assembly.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tableMembers } from "./lib/route-table.mjs";
import { stripComments } from "../scripts/docs-check.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(path.join(root, "server.mjs"), "utf8");

// A JSON-only decision lets any browser caller write keys into process.env. Pin the
// stronger authority at the route seam, not only in an integration test.
test("PUT /api/keys requires host authority before reading or writing keys", () => {
  const start = source.indexOf('"PUT /api/keys":');
  const end = source.indexOf('"GET /api/agent-settings":', start);
  assert.ok(start > -1 && end > start, "key route must remain in the host table");
  const handler = source.slice(start, end);
  assert.match(handler, /hostTokenOk\(req\.headers\["x-voicebox-host-token"\]\)/);
  assert.ok(handler.indexOf("hostTokenOk(") < handler.indexOf("readJsonBody("), "reject unauthorised bodies before parsing");
});

// A new mutating route of ANY verb needs an explicit decision here, even if it plans to use the JSON door: the
// reviewer must see the reason. The csrf keys are also asserted against the host guard, and `authority` keys
// (`DELETE /api/environments/<param>`) are the routes that match their path into a
// variable and gate on hasExtensionAuthority instead of on a body read.
const decisions = new Map([
  ["POST /api/fleet/contact", "json"],
  ["POST /api/tasks/delegate", "json"],
  ["POST /api/root", "json"],
  // voicebox-beads-lscn: resolving a pending permission request is the host's act - the page cannot hold the
  // host token - so the door carries a decision like every other mutating route.
  ["POST /api/permissions/resolve", "host-token"],
  ["POST /api/probe", "csrf"],
  ["POST /api/environments", "json"],
  ["POST /api/turn", "json"],
  ["POST /api/bootstrap", "host-token"],
  ["POST /api/call", "json"],
  ["POST /api/execute", "json"],
  // voicebox-beads-cegk: the eight non-POST mutating routes that existed when the seam learned the other verbs.
  // Six were invisible because the scan looked for POST; two more name their path in a `url.pathname.match`
  // variable. All eight need an explicit decision (readJson/readJsonBody, hostTokenOk or hasExtensionAuthority) — the
  // decisions are here so that a NEW one cannot arrive without one.
  ["PUT /api/keys", "host-token"],
  ["PUT /api/agent-settings", "json"],
  ["DELETE /api/root", "host-token"],
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
  `(?:${METHOD_REF.source})(?:\\.to(?:Upper|Lower)Case\\(\\))?\\s*===?\\s*${Q}([A-Za-z]+)${Q}`,
  "g",
);
/**
 * A non-read guard (`req.method !== "GET"`): it admits every mutating verb without naming one, so it is a mutation
 * claim whose key labels the whole set (`MUTATION /api/…`) rather than inventing a single verb.
 */
const NOT_READ = new RegExp(`!==?\\s*${Q}([A-Za-z]+)${Q}`, "g");
const ALIAS_DEF = /^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=([\s\S]*)$/;
/** A variable whose WHOLE value is a method test — the M5 shape. A ternary or an `||` is not one of these. */
const PURE_METHOD_PREDICATE = new RegExp(
  `^\\s*req(?:\\[\\s*${Q}method${Q}\\s*\\]|\\.method)(?:\\.to(?:Upper|Lower)Case\\(\\))?\\s*===?\\s*${Q}([A-Za-z]+)${Q}\\s*;?\\s*$`,
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
  // These regexes are GLOBAL and shared. `String.prototype.matchAll` starts at the regex's current lastIndex rather
  // than at 0, so a stale index from an earlier clause silently stops a later clause from seeing its own verb — which
  // is how the module scan first missed the inline `if (req.method === "POST" && url.pathname === …)` declarations and
  // reported their routes as decision-less. Reset before every read (voicebox-beads-wfpb).
  METHOD_EQ.lastIndex = 0;
  NOT_READ.lastIndex = 0;
  // A verb is a verb whatever case the comparison spells it in: `=== "post"`, `.toLowerCase() === "post"` and
  // `.toUpperCase() === "POST"` are the same test, and reader code will write whichever it finds natural (voicebox-beads-zfrh).
  for (const match of clause.matchAll(METHOD_EQ)) methods.add(match[1].toUpperCase());
  for (const match of clause.matchAll(NOT_READ)) {
    if (READ_METHODS.has(match[1].toUpperCase())) methods.add(ANY_MUTATION);
  }
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
  {
    name: "Z1 the same route written with loose equality (`== \"POST\"`)",
    mutant: (host) =>
      host.replace(
        "  // Fall through to public/ for any other path the page requests.",
        `  if (req.method == "POST" && url.pathname === "/api/newthing") { return json(res, 200, {}); }\n  // Fall through to public/ for any other path the page requests.`,
      ),
    reason: /new POST route/,
  },
  {
    name: "Z2 the same route written with loose inequality (`!= \"GET\"`)",
    mutant: (host) =>
      host.replace(
        "  // Fall through to public/ for any other path the page requests.",
        `  if (req.method != "GET" && url.pathname === "/api/newthing") { return json(res, 200, {}); }\n  // Fall through to public/ for any other path the page requests.`,
      ),
    reason: /new MUTATION route/,
  },
  {
    name: "Z3 loose equality and single quotes together",
    mutant: (host) =>
      host.replace(
        "  // Fall through to public/ for any other path the page requests.",
        `  if (req.method == 'POST' && url.pathname === "/api/newthing") { return json(res, 200, {}); }\n  // Fall through to public/ for any other path the page requests.`,
      ),
    reason: /new POST route/,
  },
  {
    name: "Z4 a lowercase verb literal (`=== \"post\"`)",
      // The seam read verbs as `[A-Z]+`, so a reader who spells the verb the way the header carries it was invisible.
    mutant: (host) =>
      host.replace(
        "  // Fall through to public/ for any other path the page requests.",
        `  if (req.method === "post" && url.pathname === "/api/newthing") { return json(res, 200, {}); }\n  // Fall through to public/ for any other path the page requests.`,
      ),
    reason: /new POST route/,
  },
  {
    name: "Z5 `.toLowerCase()` normalisation before the comparison",
    mutant: (host) =>
      host.replace(
        "  // Fall through to public/ for any other path the page requests.",
        `  if (req.method.toLowerCase() === "post" && url.pathname === "/api/newthing") { return json(res, 200, {}); }\n  // Fall through to public/ for any other path the page requests.`,
      ),
    reason: /new POST route/,
  },
  {
    name: "Z6 a lowercase read verb in a not-read guard (`!= \"get\"`)",
    mutant: (host) =>
      host.replace(
        "  // Fall through to public/ for any other path the page requests.",
        `  if (req.method != "get" && url.pathname === "/api/newthing") { return json(res, 200, {}); }\n  // Fall through to public/ for any other path the page requests.`,
      ),
    reason: /new MUTATION route/,
  },
  {
    name: "Z7 a method test this seam cannot read at all",
    mutant: (host) =>
      host.replace(
        "  // Fall through to public/ for any other path the page requests.",
        `  if (req.method.length === 3 && url.pathname === "/api/newthing") { return json(res, 200, {}); }\n  // Fall through to public/ for any other path the page requests.`,
      ),
    reason: /names no verb this seam can classify/,
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
  // Anchored on routes that are STILL inline in the host; the ones that moved into lib/routes declare their guard
  // as data and are covered by tests/guarded-routes.test.mjs.
  const unguarded = source.replace('key === "POST /api/probe"', 'key === "POST /api/unused"');
  assert.notEqual(unguarded, source, "the guard mutation must be applied");
  assert.throws(() => assertPostBoundary(unguarded), /POST \/api\/probe: missing browser CSRF guard/);

  const noDoor = source.replace(
    "const body = await readJson(CONTENT_JSON_BODY_MAX_BYTES);\n    const envKey = typeof body?.envKey",
    "const body = {};\n    const envKey = typeof body?.envKey",
  );
  assert.notEqual(noDoor, source, "the JSON-door mutation must be applied");
  assert.throws(() => assertPostBoundary(noDoor), /POST \/api\/call: declared json but handler no longer calls its boundary/);

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
  // DELETE /api/environments/<param> stands in for PATCH /api/agents/<param>, which moved to
  // lib/routes/agents.mjs and declares its guard there (voicebox-beads-cwx5.1).
  const noAuthority = source.replace(
    'if (req.method === "DELETE" && envDelete) {\n    if (!hasExtensionAuthority(req)) {',
    'if (req.method === "DELETE" && envDelete) {\n    if (false) {',
  );
  assert.notEqual(noAuthority, source, "the DELETE /api/environments authority check must still be where this test removes it");
  assert.throws(
    () => assertPostBoundary(noAuthority),
    /DELETE \/api\/environments\/<param>: declared authority but handler no longer calls its boundary/,
  );

  // DELETE /api/root stands in for DELETE /api/pair, which moved to lib/routes/pairing.mjs (voicebox-beads-cwx5.1).
  const goneDelete = source.replace('  "DELETE /api/root": (req, res, url) => {', '  "GET /api/root-gone": (req, res, url) => {');
  assert.notEqual(goneDelete, source, "the DELETE /api/root handler must still be where this test removes it");
  assert.throws(() => assertPostBoundary(goneDelete), /DELETE \/api\/root: obsolete host-token decision/);

  // The other control arm: a new READ verb stays out of the mutation inventory, so the widening did not turn every
  // route into a decision.
  const head = source.replace(
    '  "POST /api/fleet/contact":',
    '  "HEAD /api/newthing": (req, res) => res.end(),\n  "POST /api/fleet/contact":',
  );
  assert.notEqual(head, source, "the HEAD control must be applied");
  assertPostBoundary(head);
});

// ── THE EXTRACTED ROUTE MODULES (voicebox-beads-wfpb) ────────────────────────────────────────────────────────
//
// The sentence this seam used to end with — "what it still does NOT cover, and never did: route groups extracted to
// their own tables (lib/routes/*.mjs, extensionRoutes). Those are other files with other seams" — was true and was
// also the hole. voicebox-beads-pdr6 and voicebox-beads-93kz both changed how a MUTATING route is guarded inside
// lib/routes/extensions.mjs, and this inventory could not see either: `POST /api/extensions/revoke` was outside it,
// so nothing here would have failed if its authority check had been dropped. The modules are small, they declare
// their mutating keys as literals (`"POST /api/branches/merge": async (req, res) => {`), and the host still
// dispatches them — so they can be inventoried here, with a decision each, rather than left to a sentence.
//
// SCOPE, stated the same way the rest of this file states it: a mutating route that names its path in a VARIABLE
// (`const extDelete = url.pathname.match(/^\/api\/extensions\/([a-z0-9_-]+)$/)`, which
// `lib/routes/extensions.mjs` has) is still not covered here — it is invisible to a literal scan, and pretending
// otherwise would be the false confidence this file exists to avoid. Literal keys and inline `req.method === "…" &&
// url.pathname === "/api/…"` clauses are covered, which is every mutating route the modules declare that way.
const MODULE_DECISIONS = new Map([
  // A "wall" decision means: this route adds NO boundary of its own and is reachable only because the host
  // dispatches the table behind its auth wall. It is a decision, and it is the one that deserves the reader's
  // attention — `DELETE /api/activity` empties the work-activity log.
  ["DELETE /api/activity", "wall"],
  ["POST /api/branches/merge", "authority"],
  ["POST /api/branches/keep-separate", "json"],
  ["POST /api/gemini/image", "json"],
  ["POST /api/gemini/video", "json"],
  ["POST /api/gemini/embed", "json"],
  ["POST /api/harnesses/configure", "json"],
  ["POST /api/presence", "json"],
  ["DELETE /api/file", "json"],
  ["PUT /api/file", "json"],
  ["PATCH /api/file", "json"],
  ["POST /api/file/diff", "json"],
  ["POST /api/extensions/proposals", "json"],
  ["POST /api/extensions/local", "json"],
  ["POST /api/extensions/create", "json"],
  ["POST /api/extensions/sideload", "json"],
  ["POST /api/extensions/approval-request", "json"],
  // Admission INSTALLS an extension: the in-room branch asks for authority (the host token or the room's own
  // session token — voicebox-beads-93kz), never a bare Origin claim.
  ["POST /api/extensions/approve", "authority"],
  ["POST /api/extensions/admit", "host-token"],
  ["POST /api/extensions/revoke", "authority"],
  ["POST /api/extensions/refuse", "authority"],
  ["POST /api/extensions/reconfigure", "authority"],
]);

/** What each decision kind must still be true of the handler that carries it. */
const MODULE_MECHANISMS = {
  json: /\breadJson(?:Body)?\(/,
  authority: /has(?:ExplicitRoom|Extension)Authority\(/,
  "host-token": /hostTokenOk\(/,
  wall: null,
};

/**
 * A module that builds its routes with defineRoutes() (lib/routes/guarded.mjs) DECLARES each guard as data and the
 * guarded dispatcher enforces it before the handler runs — a mutating route with no guard cannot even be imported.
 * Those modules are not text-scanned here: tests/guarded-routes.test.mjs checks the table and the dispatcher, and
 * the test at the end of this file checks that every such module is actually wired into the host's dispatcher.
 */
const DECLARES_GUARDS = /import\s*\{[^}]*\bdefineRoutes\b[^}]*\}\s*from\s*["']\.\/guarded\.mjs["']/;
const GUARDED_INFRASTRUCTURE = "guarded.mjs";

/**
 * Every MUTATING route the extracted modules DECLARE AS A KEY, read as text with comments stripped:
 * `"POST /api/branches/merge": async (req, res) => {` in a route table, and `new Set(["POST /api/x", …])` in a
 * module's own ROUTES/DECISIONS list. That is the shape the finding named — `POST /api/extensions/revoke` lived in
 * lib/routes/extensions.mjs with no entry here, so this seam would not have failed if its authority check had been
 * deleted.
 *
 * WHAT IT DOES NOT COVER, stated rather than implied: a mutating route that names its path in a VARIABLE
 * (`const extDelete = url.pathname.match(/^\/api\/extensions\/([a-z0-9_-]+)$/)`) is not inventoried here; the modules
 * declare their literal routes as keys, and a variable route is the same blind spot this file has always had one
 * directory over. The mechanism check below is per MODULE, not per handler: a module is small and single-domain, and
 * the claim it makes is "this module still contains the boundary the decision names" — weaker than the host's
 * handler-bounded check, and deliberately not described as more than it is.
 */
function moduleSites(overrides = {}) {
  const dir = path.join(root, "lib", "routes");
  const sites = [];
  for (const name of readdirSync(dir).filter((entry) => entry.endsWith(".mjs")).sort()) {
    const file = `lib/routes/${name}`;
    const text = stripComments(overrides[file] ?? readFileSync(path.join(dir, name), "utf8"));
    if (name === GUARDED_INFRASTRUCTURE || DECLARES_GUARDS.test(text)) continue;
    const seen = new Set();
    for (const match of text.matchAll(new RegExp(`${Q}([A-Z]+ \\/api\\/[^"'\`]+)${Q}`, "g"))) {
      const key = match[1];
      if (READ_METHODS.has(key.split(" ")[0]) || seen.has(key)) continue;
      seen.add(key);
      sites.push({ key, file });
    }
  }
  return sites;
}

function assertModuleBoundary(overrides = {}) {
  const sites = moduleSites(overrides);
  for (const { key, file } of sites) {
    const decision = MODULE_DECISIONS.get(key);
    assert.ok(decision, `${key} (${file}): a new mutating route declared in an extracted module needs a decision here — json, csrf, host-token, authority or wall`);
    const mechanism = MODULE_MECHANISMS[decision];
    assert.ok(decision === "wall" || mechanism, `${key}: unknown decision kind ${decision}`);
    if (!mechanism) continue;
    const text = stripComments(overrides[file] ?? readFileSync(path.join(root, file), "utf8"));
    assert.match(text, mechanism, `${key} (${file}): declared ${decision} but the module no longer contains that boundary`);
  }
  for (const [key, decision] of MODULE_DECISIONS) {
    assert.ok(sites.some((site) => site.key === key), `${key}: obsolete ${decision} decision for an extracted route`);
  }
}

test("every mutating route an extracted module declares has a decision, and its module still makes it (voicebox-beads-wfpb)", () => {
  assertModuleBoundary();
  // The floor: the modules declare at least these, so a scan that silently stops seeing them fails here rather than
  // passing because it found nothing.
  const keys = moduleSites().map((site) => site.key);
  for (const key of ["POST /api/extensions/revoke", "POST /api/extensions/approve", "POST /api/extensions/admit", "POST /api/branches/merge", "DELETE /api/activity", "PUT /api/file", "POST /api/file/diff"]) {
    assert.ok(keys.includes(key), `${key} must be visible to the module scan`);
  }
});

test("the module scan refuses a new key, a deleted boundary, and a decision nobody declares (voicebox-beads-wfpb)", () => {
  const file = "lib/routes/extensions.mjs";
  const source = readFileSync(path.join(root, file), "utf8");

  // M1: a NEW mutating route declared as a key, with no decision here.
  const added = source.replace('  "POST /api/extensions/reconfigure",', '  "POST /api/extensions/reconfigure",\n  "DELETE /api/extensions/cache",');
  assert.notEqual(added, source, "the mutant must have been inserted");
  assert.throws(() => assertModuleBoundary({ [file]: added }), /DELETE \/api\/extensions\/cache \(lib\/routes\/extensions\.mjs\): a new mutating route/, "a new mutating module route must fail the inventory");

  // M2: the boundary the decisions name leaves the module — every authority decision is now a claim about nothing.
  const dropped = source.replace("    if (!hasExtensionAuthority(req)) {\n      return json(res, 403,", "    if (false) {\n      return json(res, 403,");
  assert.notEqual(dropped, source, "the mutant must have been inserted");
  // BOTH authority mechanisms, because lib/routes/extensions.mjs now legitimately carries two: hasExtensionAuthority
  // on the extension routes, and hasExplicitRoomAuthority on in-room admission (voicebox-beads-93kz). Removing only
  // one kind leaves a boundary the module still makes, so the mutant that means "the authority boundary is gone" has
  // to remove every one of them - otherwise this arm passes while nothing was actually deleted (the state that made
  // it red when 93kz and wfpb landed in the same batch).
  const withoutAuthority = source.replace(/has(?:ExplicitRoom|Extension)Authority\(req\)/g, "false");
  assert.throws(() => assertModuleBoundary({ [file]: withoutAuthority }), /declared authority but the module no longer contains that boundary/, "a deleted authority check must fail the inventory");

  // M3: a decision whose route nobody declares any more.
  const removed = source.replace('  "POST /api/extensions/reconfigure",', '');
  assert.notEqual(removed, source, "the mutant must have been inserted");
  assert.throws(() => assertModuleBoundary({ [file]: removed }), /POST \/api\/extensions\/reconfigure: obsolete authority decision/, "a decision with no route must fail the inventory");
});

test("every module that declares its guards as data is wired into the host's guarded dispatcher (voicebox-beads-cwx5.1)", () => {
  const dir = path.join(root, "lib", "routes");
  const declaring = readdirSync(dir)
    .filter((name) => name.endsWith(".mjs") && name !== GUARDED_INFRASTRUCTURE)
    .filter((name) => DECLARES_GUARDS.test(stripComments(readFileSync(path.join(dir, name), "utf8"))));
  assert.ok(declaring.includes("mini-apps.mjs"), "the scan must still see the Mini-App module, or it is passing by finding nothing");
  const host = stripComments(source);
  const dispatcher = host.match(/createGuardedDispatcher\(\{\s*routes:\s*\[([^\]]*)\]/);
  assert.ok(dispatcher, "server.mjs must build the guarded dispatcher from a literal list of route groups");
  assert.match(host, /if \(await guardedRoutes\(req, res, url\)\) return;/, "and handle() must dispatch through it");
  for (const name of declaring) {
    // `import { createFooRoutes } from "./lib/routes/foo.mjs"` → `const fooRoutes = createFooRoutes(` → `...fooRoutes`
    const imported = host.match(new RegExp(`import\\s*\\{\\s*(\\w+)\\s*\\}\\s*from\\s*["']\\./lib/routes/${name.replace(".", "\\.")}["']`));
    assert.ok(imported, `lib/routes/${name}: declares guards but server.mjs does not import its factory`);
    const built = host.match(new RegExp(`const\\s+(\\w+)\\s*=\\s*${imported[1]}\\(`));
    assert.ok(built, `lib/routes/${name}: ${imported[1]} is imported but never called`);
    assert.ok(
      dispatcher[1].includes(`...${built[1]}`),
      `lib/routes/${name}: its routes (${built[1]}) are not in the guarded dispatcher, so their declared guards are never enforced`,
    );
  }
});
