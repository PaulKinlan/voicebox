// tests/infra-affected.test.mjs — selection for a shared-infra change (voicebox-beads-55wl).
//
//   node --test tests/infra-affected.test.mjs
//
// The selector is pure, and this file is unit-tier on purpose: the machinery that verifies shared-infra edits
// should itself be something the fast gate can actually verify.
//
// WHY THERE IS NO `import ... from "../scripts/test-changed.mjs"` HERE. Measured: importing that module costs
// **4.3s** by itself (it builds the test inventory at import time) while `scripts/infra-affected.mjs` costs
// **1ms**. This file therefore drives the selector with partitions built to the mapper's documented shape and
// costs the fast gate nothing. The check that the gate's REAL partition feeds the selector belongs in the
// gate's own tests, where that 4.3s is already paid — asked for on the bead, and it is one assertion there.
//
// Assertions are PROPERTIES (run ⊆ affected, run + skipped = affected, the cap holds) rather than counts, so
// adding tests tomorrow does not make this file lie about the selector.
import test from "node:test";
import assert from "node:assert/strict";
import { INFRA_BUDGET_MS, INFRA_CAP, infraAffected, sharedInfraFiles } from "../scripts/infra-affected.mjs";

/** What `scripts/test-changed.mjs` partitionTests() returns for `tests/lib/cdp.mjs`: four tier keys of BARE
 *  filenames. Names are representative of the real lanes, and `acp-browser` sorts before every `cdp-` name, so
 *  the own-test-first ranking is genuinely driven here rather than assumed. */
const cdpLike = () => ({
  unit: ["settings-open-paths-seam.test.mjs"],
  server: [],
  browser: [
    "acp-browser.test.mjs",
    "activity-log-extraction.test.mjs",
    "cdp-click-diagnostics.test.mjs",
    "cdp-process-cleanup.test.mjs",
    "environment-list-extraction.test.mjs",
    "ux-bubble-stage.test.mjs",
    "zz-last.test.mjs",
  ],
  unclassified: [],
});

test("a change that does not touch shared infra pays nothing", () => {
  const result = infraAffected({ changedFiles: ["public/fused.js", "server.mjs"], partitioned: { browser: ["a.test.mjs", "b.test.mjs"] } });
  assert.equal(result.applies, false, "the selector must not fire for an ordinary change");
  assert.deepEqual(result.run, [], "and must select nothing");
  assert.deepEqual(result.skippedBrowser, [], "and must not claim a remainder — the gate's own handling of those tests is not this mechanism's to describe");
  assert.deepEqual(result.helpers, []);
});

test("a shared helper selects a hard-capped subset, reports the remainder, and names its own tests first", () => {
  const partitioned = cdpLike();
  const result = infraAffected({ changedFiles: ["tests/lib/cdp.mjs"], partitioned });

  assert.equal(result.applies, true);
  assert.deepEqual(result.helpers, ["tests/lib/cdp.mjs"]);
  assert.equal(result.run.length, INFRA_CAP, "the subset is exactly the hard cap when more are affected");
  assert.equal(result.budgetMs, INFRA_BUDGET_MS);
  for (const file of result.run) {
    assert.match(file, /^tests\/[\w.-]+\.test\.mjs$/, `run entries are in the shard runner's own form: ${file}`);
  }
  // THE PROPERTY THAT MAKES A SUBSET HONEST: what it ran plus what it left is exactly the blast radius.
  assert.deepEqual(
    [...result.run.map((f) => f.replace(/^tests\//, "")), ...result.skippedBrowser].sort(),
    [...partitioned.browser].sort(),
    "run and skippedBrowser must partition the affected browser tests",
  );
  assert.ok(result.skippedBrowser.length > 0, "a helper with this much reach must report a remainder");
  assert.equal(result.tierCounts.browser, partitioned.browser.length, "the whole blast radius is stated");
  // Own tests lead, even though `acp-browser` sorts before them.
  assert.deepEqual(result.run.slice(0, 2), ["tests/cdp-click-diagnostics.test.mjs", "tests/cdp-process-cleanup.test.mjs"]);
});

test("the subset is reproducible: the caller's iteration order cannot change it", () => {
  const partitioned = {
    browser: ["zebra.test.mjs", "alpha.test.mjs", "server-held.test.mjs", "mango.test.mjs", "kiwi.test.mjs"],
    unit: ["u2.test.mjs", "u1.test.mjs"],
    server: ["s1.test.mjs"],
  };
  const straight = infraAffected({ changedFiles: ["tests/lib/server.mjs"], partitioned });
  const shuffled = structuredClone(partitioned);
  shuffled.browser.reverse();
  shuffled.unit.reverse();
  const other = infraAffected({ changedFiles: ["tests/lib/server.mjs"], partitioned: shuffled });
  assert.deepEqual(other.run, straight.run, "the same change must select the same subset whatever order the input arrived in");
  assert.deepEqual(other.skippedBrowser, straight.skippedBrowser);
  assert.deepEqual(other.tierCounts, straight.tierCounts);
});

test("a branch under test cannot enlarge the subset that verifies it", () => {
  const raised = infraAffected({ changedFiles: ["tests/lib/cdp.mjs"], partitioned: cdpLike(), cap: 99, INFRA_CAP: 99 });
  assert.equal(raised.run.length, INFRA_CAP, "the cap is not an option: no caller can raise it");
  assert.equal(raised.cap, INFRA_CAP);
});

test("the class is the shared helpers, and the selector is narrow about it", () => {
  assert.deepEqual(sharedInfraFiles(["tests/lib/cdp.mjs", "tests/lib/sub/nested.mjs", "tests/not-lib/x.mjs", "lib/cdp.mjs"]), [
    "tests/lib/cdp.mjs",
  ]);
  const result = infraAffected({
    changedFiles: ["tests/lib/cdp.mjs", "tests/lib/server.mjs"],
    partitioned: { browser: ["cdp-a.test.mjs", "server-b.test.mjs", "zz.test.mjs"], unit: [], server: [] },
  });
  assert.equal(result.run.length, 3, "both helpers' own tests, then the cap");
  assert.deepEqual(result.helpers, ["tests/lib/cdp.mjs", "tests/lib/server.mjs"]);
});

test("a helper whose tests are not name-prefixed still yields a bounded, sorted subset", () => {
  const partitioned = { browser: ["zebra.test.mjs", "alpha.test.mjs", "mango.test.mjs", "kiwi.test.mjs", "fig.test.mjs"], unit: [], server: [] };
  const result = infraAffected({ changedFiles: ["tests/lib/route-table.mjs"], partitioned });
  assert.equal(result.applies, true);
  assert.deepEqual(result.run, ["tests/alpha.test.mjs", "tests/fig.test.mjs", "tests/kiwi.test.mjs", "tests/mango.test.mjs"]);
  assert.deepEqual(result.skippedBrowser, ["zebra.test.mjs"]);
});

test("the selector does not mutate the partition it was handed", () => {
  const partitioned = { browser: ["b.test.mjs", "a.test.mjs"], unit: ["u.test.mjs"], server: [] };
  const before = structuredClone(partitioned);
  infraAffected({ changedFiles: ["tests/lib/cdp.mjs"], partitioned });
  assert.deepEqual(partitioned, before, "the gate hands in its own partition; selection must not touch it");
});
