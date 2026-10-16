// scripts/infra-affected.mjs — what must run when a change touches SHARED TEST INFRA (voicebox-beads-55wl).
//
// THE GAP THIS CLOSES. The fast gate proves almost nothing about an edit to a shared test helper, because the
// helpers are almost entirely exercised from the browser tier while the fast lane is the unit tier. Measured with
// the gate's own mapper: `tests/lib/cdp.mjs` is reachable from 89 tests, of which **1** is unit, and
// `tests/lib/server.mjs` from 171, of which **24** are unit — 14% of the harness every server test uses. So the
// gate says "tree is sound" about a change it cannot see, and a lane either ships unverified or hand-runs a
// browser subset on trust. Two lanes did the latter in one session, including this one.
//
// WHAT IT DOES, AND WHAT IT DELIBERATELY DOES NOT. It selects a BOUNDED, DETERMINISTIC subset of the affected
// browser tests for a higher tier to run, and reports the REMAINDER it did not select. It runs nothing, gates
// nothing, and cannot fail a build — selection only, so it is pure and unit-testable, and the three-condition
// runner that consumes it stays the owner of what a result means.
//
// THE REMAINDER IS THE POINT. A subset that did not say what it left out would be worse than the blind spot it
// replaces: the hub's coverage check reads per-file `fast-gate: passed:<file>` markers, so a capped run that
// emitted ordinary markers would count the files it ran as covered and stay silent about the rest, making
// coverage look BETTER than the truth. For the same reason this is selector-driven with a hard cap: a change
// that does not touch shared infra must pay nothing (the cap cannot be raised by the branch under test).
//
// HOW THE ACCOUNTING IS RECORDED, settled with gate-recover (2026-10-15) and in TWO parts - the earlier reading
// of this file said "no new field", which was half right and would have misled:
//
//  1. THE SKIPPED FILES NEED NO NEW FIELD. `scripts/gate-manifest.mjs`'s SELECTION already includes
//     `not-selected`, and `recordFile` REFUSES an omitted file with no reason, so recording every skipped
//     affected file as `not-selected` with a reason is both the honest accounting and a manifest-level
//     enforcement of it.
//  2. THE AGGREGATE RECORD IS NEW - a manifest v3 bump inside the one combined change coord wants, since v2 is
//     spent on the host block:
//       "tiers": [{"name":"browser","affected":89,"affected_not_run":88,
//                  "subset":{"files":["tests/x.test.mjs"],"cap_ms":120000,"wall_ms":41300}}]
//     and the count is CHECKABLE rather than decorative: it must equal
//     count(selection in changed|dependency AND dispatch !== ran) over the manifest's own file records, and a
//     stated count that disagrees with them is refused by name - one computing site, no parallel claim. So this
//     module's `affectedUnrun` is a *selection* (what to mark, and why), never the artifact's number.
//  3. THE COUNT MUST REACH THE READER, not only the artifact: `verdictOf` returns `pass` when every DISPATCHED
//     file passed and an omitted file is never dispatched, so five green out of sixty affected reconciles and
//     reads `pass`. The reader's own line must print what was left, and NO new marker kind is invented here:
//     the marker vocabulary belongs to the hub, and `unmapped:` already means a changed source with no test.

/** The narrow class this was measured on. Widening it (tools/, scripts/, a new tests/lib subdir) is a visible
 *  change to this line with its own measurement, not something a caller can do by passing more paths. */
const SHARED_INFRA = /^tests\/lib\/[^/]+\.mjs$/;

/** HARD cap. Deliberately not a flag and not an option of `infraAffected`: a branch under test must not be able
 *  to enlarge the subset that verifies it. Measured cost of one browser test-arm is ~4-6s, so this is ~20-30s
 *  of browser work against the ~150s of headroom under the fast gate's 180s bound. */
export const INFRA_CAP = 4;

/** The stated wall budget for the selected subset, recorded rather than enforced by silently truncating a suite
 *  mid-run: the cap keeps the subset small, and a subset that overruns its budget is a fact the artifact states. */
export const INFRA_BUDGET_MS = 60_000;

export const ROUTE_SERVER_SMOKE = Object.freeze(["server-lifecycle.test.mjs"]);

const SOURCE_PREFIXES = ["core/", "lib/", "public/", "tools/", "scripts/", "server.mjs"];
export const isSourcePath = (f) => SOURCE_PREFIXES.some((prefix) => f === prefix || f.startsWith(prefix));

/** Check if changes are exclusively under lib/routes/ (voicebox-beads-ybwq). */
export function isExclusiveRouteChanges(changedFiles = []) {
  const sourceFiles = changedFiles.filter((f) => isSourcePath(f));
  return sourceFiles.length > 0 && sourceFiles.every((f) => f.startsWith("lib/routes/"));
}

/**
 * Route-scoped change detection (voicebox-beads-ybwq).
 *
 * When changes are exclusively in lib/routes/*.mjs, compute targeted route tests, bounded server
 * smoke tests, and the unrun transitive server importers that were bypassed to avoid 150+ test fan-out.
 */
export function routeAffected({ changedFiles = [], allServerImporters = [], directTests = [] } = {}) {
  const applies = isExclusiveRouteChanges(changedFiles);
  const routes = changedFiles.filter((f) => isSourcePath(f) && f.startsWith("lib/routes/"));
  if (!applies) {
    return {
      applies: false,
      routes: [],
      smoke: [],
      unrunTransitiveImporters: { files: [], count: 0 },
    };
  }

  const smoke = [...ROUTE_SERVER_SMOKE];
  const selectedSet = new Set([...directTests, ...smoke]);
  const unrun = allServerImporters.filter((f) => !selectedSet.has(f)).sort();

  return {
    applies: true,
    routes,
    smoke,
    unrunTransitiveImporters: {
      files: unrun,
      count: unrun.length,
    },
  };
}

const TIERS = Object.freeze(["unit", "server", "browser"]);

const emptyCounts = () => Object.fromEntries(TIERS.map((tier) => [tier, 0]));

/** The changed paths that make this apply: the shared-infra helpers, in a stable order. */
export function sharedInfraFiles(changedFiles = []) {
  return [...new Set(changedFiles.filter((file) => SHARED_INFRA.test(file)))].sort();
}

/** `cdp.mjs` -> `cdp`: the stem a helper's own tests are named after (`cdp-process-cleanup.test.mjs`). */
const stemOf = (helper) => (helper.split("/").pop() ?? "").replace(/\.mjs$/, "");

/**
 * Is `test` one of the helper's own tests? Checked on the name, which is the only signal available: the mapper
 * says a file is reachable from a helper, not how it uses it.
 */
const isOwnTest = (test, stems) => stems.some((stem) => stem.length > 0 && (test === `${stem}.test.mjs` || test.startsWith(`${stem}-`)));

/**
 * Select the subset. Input is the gate's OWN partition, so nothing re-maps and no second selector exists:
 *   changedFiles  paths relative to the repo root, e.g. "tests/lib/cdp.mjs"
 *   partitioned   { unit, server, browser, unclassified } of BARE filenames, e.g. "acp-browser.test.mjs"
 *                 (this is what scripts/test-changed.mjs partitionTests returns, and what the browser shard
 *                 runner takes as `tests/${file}`).
 * Returns:
 *   applies         false for every change that is not shared infra — those pay nothing, by construction.
 *   helpers         the changed shared-infra paths that triggered it, stable order.
 *   run             the selected subset in the runner's own form, `tests/<file>`, at most INFRA_CAP entries.
 *   tierCounts      how many affected tests each tier holds, so a reader can see the whole blast radius.
 *   affectedUnrun   WHAT WILL DELIBERATELY NOT RUN, per tier, naming the files and the count remaining —
 *                   coord's ruling of 2026-10-15: a capped subset that stayed silent about what it skipped
 *                   would let coverage read BETTER than the truth, the same silence-reads-as-completeness trap
 *                   as a bare `coverage: UNKNOWN`. Only the browser tier appears, because that is the only tier
 *                   this module selects for: it runs nothing and withholds nothing from unit or server, whose
 *                   own rules decide what runs, so claiming them here would be a false statement in an artifact
 *                   whose whole purpose is to be believed. Their radius is still stated, in `tierCounts`.
 * The selection is sorted here rather than inherited: the same change must yield the same subset whatever order
 * the caller iterated its files in, or the artifact is not reproducible.
 */
export function infraAffected({ changedFiles = [], partitioned = {} } = {}) {
  const helpers = sharedInfraFiles(changedFiles);
  const browser = [...new Set(partitioned.browser ?? [])].sort();
  const result = {
    applies: helpers.length > 0,
    helpers,
    run: [],
    cap: INFRA_CAP,
    budgetMs: INFRA_BUDGET_MS,
    tierCounts: { ...emptyCounts(), ...Object.fromEntries(TIERS.map((tier) => [tier, (partitioned[tier] ?? []).length])) },
    // Empty when this does not apply, and that is deliberate: there is no remainder to report when nothing was
    // selected. A record claiming "2 left unrun" for a change the selector never fired on would read as a
    // subset that ran.
    affectedUnrun: { browser: { files: [], count: 0 } },
  };
  if (helpers.length === 0) return result;

  // The helper's own tests first — they are the ones written against it — then the rest by name. Both are
  // bounded by the hard cap, so the subset is deterministic, small and sayable in one line of an artifact.
  const stems = helpers.map(stemOf);
  const own = browser.filter((test) => isOwnTest(test, stems));
  const rest = browser.filter((test) => !own.includes(test));
  const selected = [...own, ...rest].slice(0, INFRA_CAP);
  result.run = selected.map((test) => `tests/${test}`);
  result.affectedUnrun = { browser: { files: browser.filter((test) => !selected.includes(test)), count: browser.length - selected.length } };
  return result;
}
