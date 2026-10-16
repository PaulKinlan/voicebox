// tests/infra-affected.test.mjs — selection for a shared-infra change (voicebox-beads-55wl).
//
//   node --test tests/infra-affected.test.mjs
//
// The selector is pure, and this file is unit-tier on purpose: the machinery that verifies shared-infra edits
// should itself be something the fast gate can actually verify.
//
// THE FIXTURES DELIBERATELY USE INVENTED, NEUTRAL NAMES: no quoted path here may end in a harness
// filename (the two the classifier knows are the CDP helper and the server helper), or this pure unit test is
// filed in the serial browser lane and hidden from the unit fast gate. Both traps were hit while writing it.
// `scripts/test-lanes.mjs` classifies a test file by matching
// signals in its TEXT, and one of those signals is a quoted path to the browser harness — so naming a real
// helper path or a real browser test here would file this pure unit test in the serial browser lane, where it
// would cost minutes and, worse, be invisible to the unit fast gate. The first draft did exactly that and was
// caught by asking the classifier where the file landed. Keep these names synthetic.
//
// WHY THERE IS NO IMPORT OF scripts/test-changed.mjs HERE. Measured: importing that module costs 4.3s by itself
// (it builds the test inventory at import time) while scripts/infra-affected.mjs costs 1ms. This file drives the
// selector with partitions built to the mapper's documented shape and costs the fast gate nothing. The check
// that the gate's REAL partition feeds the selector belongs in the gate's own tests, where that 4.3s is already
// paid — asked for on the bead, and it is one assertion there.
//
// Assertions are PROPERTIES (run ⊆ affected, run + skipped = affected, the cap holds) rather than counts, so
// adding tests tomorrow does not make this file lie about the selector.
import test from "node:test";
import assert from "node:assert/strict";
import { INFRA_BUDGET_MS, INFRA_CAP, infraAffected, sharedInfraFiles, isExclusiveRouteChanges, routeAffected, ROUTE_SERVER_SMOKE } from "../scripts/infra-affected.mjs";

const HELPER = "tests/lib/alpha.mjs";

/** What partitionTests() returns for `HELPER`: four tier keys of BARE filenames. `aaa-first` sorts before every
 *  `alpha-` name, so the own-test-first ranking is genuinely driven rather than assumed. */
const alphaLike = () => ({
  unit: ["settings-seam.test.mjs"],
  server: [],
  browser: ["aaa-first.test.mjs", "mango.test.mjs", "alpha-core.test.mjs", "alpha-work.test.mjs", "zebra.test.mjs"],
  unclassified: [],
});

test("a change that does not touch shared infra pays nothing", () => {
  const result = infraAffected({ changedFiles: ["public/app.js", "lib/util.mjs"], partitioned: { browser: ["a.test.mjs", "b.test.mjs"] } });
  assert.equal(result.applies, false, "the selector must not fire for an ordinary change");
  assert.deepEqual(result.run, [], "and must select nothing");
  assert.deepEqual(result.affectedUnrun.browser, { files: [], count: 0 }, "and must not claim anything was left unrun — nothing was selected, so nothing was withheld");
  assert.deepEqual(result.helpers, []);
});

test("a shared helper selects a hard-capped subset, reports the remainder, and names its own tests first", () => {
  const partitioned = alphaLike();
  const result = infraAffected({ changedFiles: [HELPER], partitioned });

  assert.equal(result.applies, true);
  assert.deepEqual(result.helpers, [HELPER]);
  assert.equal(result.run.length, INFRA_CAP, "the subset is exactly the hard cap when more are affected");
  assert.equal(result.budgetMs, INFRA_BUDGET_MS);
  for (const file of result.run) {
    assert.match(file, /^tests\/[\w.-]+\.test\.mjs$/, `run entries are in the shard runner's own form: ${file}`);
  }
  // THE PROPERTY THAT MAKES A SUBSET HONEST, and it is now the ruled record shape: what it ran plus what it
  // deliberately left is exactly the blast radius, and the left-over is NAMED, not just counted.
  assert.deepEqual(
    [...result.run.map((f) => f.replace(/^tests\//, "")), ...result.affectedUnrun.browser.files].sort(),
    [...partitioned.browser].sort(),
    "run and affectedUnrun must partition the affected browser tests",
  );
  assert.equal(result.affectedUnrun.browser.count, result.affectedUnrun.browser.files.length, "the count and the names must agree");
  assert.ok(result.affectedUnrun.browser.count > 0, "a helper with this much reach must report what it left");
  assert.equal(result.tierCounts.browser, partitioned.browser.length, "the whole blast radius is stated");
  // Own tests lead, even though `aaa-first` sorts before them.
  assert.deepEqual(result.run.slice(0, 2), ["tests/alpha-core.test.mjs", "tests/alpha-work.test.mjs"]);
});

test("the subset is reproducible: the caller's iteration order cannot change it", () => {
  const partitioned = {
    browser: ["zebra.test.mjs", "mango.test.mjs", "alpha-work.test.mjs", "kiwi.test.mjs", "alpha-core.test.mjs"],
    unit: ["u2.test.mjs", "u1.test.mjs"],
    server: ["s1.test.mjs"],
  };
  const straight = infraAffected({ changedFiles: [HELPER], partitioned });
  const shuffled = structuredClone(partitioned);
  shuffled.browser.reverse();
  shuffled.unit.reverse();
  const other = infraAffected({ changedFiles: [HELPER], partitioned: shuffled });
  assert.deepEqual(other.run, straight.run, "the same change must select the same subset whatever order the input arrived in");
  assert.deepEqual(other.affectedUnrun, straight.affectedUnrun);
  assert.deepEqual(other.tierCounts, straight.tierCounts);
});

test("a branch under test cannot enlarge the subset that verifies it", () => {
  const raised = infraAffected({ changedFiles: [HELPER], partitioned: alphaLike(), cap: 99, INFRA_CAP: 99 });
  assert.equal(raised.run.length, INFRA_CAP, "the cap is not an option: no caller can raise it");
  assert.equal(raised.cap, INFRA_CAP);
});

test("the class is the shared helpers, and the selector is narrow about it", () => {
  assert.deepEqual(sharedInfraFiles([HELPER, "tests/lib/sub/nested.mjs", "tests/not-lib/x.mjs", "lib/alpha.mjs"]), [HELPER]);
  const result = infraAffected({
    changedFiles: [HELPER, "tests/lib/beta.mjs"],
    partitioned: { browser: ["alpha-a.test.mjs", "beta-b.test.mjs", "zz.test.mjs"], unit: [], server: [] },
  });
  assert.equal(result.run.length, 3, "both helpers' own tests, then the cap");
  assert.deepEqual(result.helpers, [HELPER, "tests/lib/beta.mjs"]);
});

test("a helper whose tests are not name-prefixed still yields a bounded, sorted subset", () => {
  const partitioned = { browser: ["zebra.test.mjs", "mango.test.mjs", "kiwi.test.mjs", "fig.test.mjs", "alpha-of-course.test.mjs"], unit: [], server: [] };
  const result = infraAffected({ changedFiles: ["tests/lib/gamma.mjs"], partitioned });
  assert.equal(result.applies, true);
  assert.deepEqual(result.run, ["tests/alpha-of-course.test.mjs", "tests/fig.test.mjs", "tests/kiwi.test.mjs", "tests/mango.test.mjs"]);
  assert.deepEqual(result.affectedUnrun.browser, { files: ["zebra.test.mjs"], count: 1 });
});

test("when everything affected fits the cap, the unrun record is empty rather than absent", () => {
  const result = infraAffected({ changedFiles: [HELPER], partitioned: { browser: ["alpha-one.test.mjs", "alpha-two.test.mjs"], unit: [], server: [] } });
  assert.equal(result.run.length, 2);
  assert.deepEqual(result.affectedUnrun.browser, { files: [], count: 0 }, "nothing was left, so nothing is reported as left — but the record exists, because absence must never read as covered");
});

test("the selector does not mutate the partition it was handed", () => {
  const partitioned = { browser: ["b.test.mjs", "a.test.mjs"], unit: ["u.test.mjs"], server: [] };
  const before = structuredClone(partitioned);
  infraAffected({ changedFiles: [HELPER], partitioned });
  assert.deepEqual(partitioned, before, "the gate hands in its own partition; selection must not touch it");
});

test("isExclusiveRouteChanges: identifies route-exclusive changes vs shared/server changes (voicebox-beads-ybwq)", () => {
  assert.equal(isExclusiveRouteChanges(["lib/routes/doctor.mjs"]), true);
  assert.equal(isExclusiveRouteChanges(["lib/routes/doctor.mjs", "tests/doctor-route.test.mjs", "docs/07-architecture.md"]), true);
  assert.equal(isExclusiveRouteChanges(["lib/routes/doctor.mjs", "server.mjs"]), false);
  assert.equal(isExclusiveRouteChanges(["lib/routes/doctor.mjs", "lib/commands.mjs"]), false);
  assert.equal(isExclusiveRouteChanges([]), false);
});

test("routeAffected: bounds route edits, reports smoke subset and bypassed server importers (voicebox-beads-ybwq)", () => {
  const result = routeAffected({
    changedFiles: ["lib/routes/custom.mjs"],
    allServerImporters: ["s1.test.mjs", "s2.test.mjs", "s3.test.mjs", "custom-route.test.mjs"],
    directTests: ["custom-route.test.mjs"],
  });

  assert.equal(result.applies, true);
  assert.deepEqual(result.routes, ["lib/routes/custom.mjs"]);
  assert.deepEqual(result.smoke, [...ROUTE_SERVER_SMOKE]);
  assert.equal(result.unrunTransitiveImporters.count, 3);
  assert.deepEqual(result.unrunTransitiveImporters.files, ["s1.test.mjs", "s2.test.mjs", "s3.test.mjs"]);
});

test("routeAffected: does not apply when server.mjs or shared lib changes alongside routes (voicebox-beads-ybwq)", () => {
  const result = routeAffected({
    changedFiles: ["lib/routes/custom.mjs", "server.mjs"],
    allServerImporters: ["s1.test.mjs"],
  });
  assert.equal(result.applies, false);
  assert.equal(result.unrunTransitiveImporters.count, 0);
});
