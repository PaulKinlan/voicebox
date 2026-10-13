// tests/test-shards.test.mjs — the browser tier's queue, and the two coverage claims the
// speed work has to keep true (voicebox-beads-hhkg, ADR voicebox-beads-g9jf).
//
// The browser tier is 63 files and the whole cost of the gate's live stage. Making it run four
// files at a time is worth ~2.2x, and it is exactly the kind of change that can also run FEWER
// tests and look faster. So the two things a shard change can quietly break are pinned here, as
// executable assertions rather than as prose in a comment:
//
//   1. EVERY browser-lane file is queued exactly once — the runner REFUSES a queue that drops,
//      repeats or invents a file, and this holds that refusal, including on the real lane.
//   2. THE FAST GATE'S FILE SET IS AN EXECUTABLE SUBSET OF THE FULL GATE'S. The fleet's per-commit
//      fast gate is `npm run test:unit` (CHECK_FAST_CMD), the full gate is scripts/pre-push.sh, and
//      this reads the wiring the two ACTUALLY run instead of restating the classifier on both
//      sides — a fast gate that quietly stopped being a subset would be invisible otherwise.
//
// This file launches nothing, so it belongs in the concurrent unit lane: every helper name it uses
// is a path it reads or a module it imports, and neither is a launch.
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { classify } from "../scripts/test-lanes.mjs";
import { assertExactCoverage, buildQueue, isFailed, splitQueue } from "../scripts/test-shards.mjs";
import { ISOLATED } from "../scripts/test-shards.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (...parts) => readFileSync(path.join(root, ...parts), "utf8");
const lane = (name) => classify()[name].map(({ file }) => `tests/${file}`);

test("the browser tier's queue is the browser lane, each file exactly once", () => {
  const browserLane = lane("browser");
  const queue = assertExactCoverage(browserLane, buildQueue(browserLane));
  assert.ok(browserLane.length > 0, "the browser lane must not be empty — an empty tier would make every assertion below vacuous");
  assert.equal(queue.length, browserLane.length, "the queue must not change the tier's file count");
  assert.deepEqual([...queue].sort(), [...browserLane].sort(), "the queue must be the lane, reordered at most");
  assert.equal(new Set(queue).size, queue.length, "no file may be queued twice");
});

test("a queue that drops, repeats or invents a file is REFUSED, and the problem is named", () => {
  const small = ["tests/a.test.mjs", "tests/b.test.mjs", "tests/c.test.mjs"];
  assert.throws(
    () => assertExactCoverage(small, ["tests/a.test.mjs", "tests/b.test.mjs"]),
    /not queued: tests\/c\.test\.mjs/,
    "a dropped file must be refused by name",
  );
  assert.throws(
    () => assertExactCoverage(small, ["tests/a.test.mjs", "tests/a.test.mjs", "tests/b.test.mjs", "tests/c.test.mjs"]),
    /queued more than once: tests\/a\.test\.mjs/,
    "a repeated file must be refused by name",
  );
  assert.throws(
    () => assertExactCoverage(small, [...small, "tests/d.test.mjs"]),
    /queued but not in the browser lane: tests\/d\.test\.mjs/,
    "a file that is not in the lane must be refused by name",
  );
  // The refusals are the point; an exact queue is returned so a caller can chain.
  assert.deepEqual(assertExactCoverage(small, [...small]), small);
});

test("the queue is ordered longest-first, so the TAIL of the run is short", () => {
  const queue = buildQueue(["tests/light.test.mjs", "tests/heavy.test.mjs", "tests/mid.test.mjs"], {
    cwd: root,
    weights: { "tests/light.test.mjs": 1, "tests/heavy.test.mjs": 300, "tests/mid.test.mjs": 100 },
  });
  assert.deepEqual(queue, ["tests/heavy.test.mjs", "tests/mid.test.mjs", "tests/light.test.mjs"]);
  // With no cost model the order is best-effort, but it is still an ORDER, not a partition: the
  // runner steals work, so a wrong guess costs a tail, never a dropped file.
  assert.equal(buildQueue(["tests/a.test.mjs", "tests/b.test.mjs"]).length, 2);
  // An unreadable file sorts last rather than failing the tier — the runner reports it as a failure
  // when it runs, which is where a failure belongs.
  assert.deepEqual(buildQueue(["tests/gone.test.mjs", "tests/a.test.mjs"], { cwd: root }), ["tests/a.test.mjs", "tests/gone.test.mjs"]);
});

test("a file counts as failed when its exit code, its counts OR its reporter disagree with green", () => {
  const green = { code: 0, tests: 8, fail: 0, notOk: [] };
  assert.equal(isFailed(green), false, "the negative control: a green file must not be failed");
  assert.equal(isFailed({ ...green, code: 1 }), true, "a non-zero exit code is a failure");
  assert.equal(isFailed({ ...green, code: null }), true, "a child killed by a signal reports no code and must not be trusted as green");
  assert.equal(isFailed({ ...green, fail: 2 }), true, "TAP's own failing count is a failure even when the exit code says otherwise");
  assert.equal(isFailed({ ...green, notOk: ["a test"] }), true, "a `not ok` line is a failure even when the exit code says otherwise");
  // The one that would let this tier buy speed by running less: a file whose reporter summary was
  // never seen at all — a spawn that errored, a run cut short — must never be recorded as a pass.
  assert.equal(isFailed({ ...green, tests: -1 }), true, "a file that reported NO test counts is not a pass");
  // A skipped-only file is still a pass: tests/wasm-room-ui.test.mjs is one on this box.
  assert.equal(isFailed({ code: 0, tests: 1, fail: 0, skipped: 1, notOk: [] }), false, "a skipped test is not a failure");
});

test("the two phases are a PARTITION of the queue, and every isolated name is a real browser-lane file", () => {
  const browserLane = lane("browser");
  const queue = assertExactCoverage(browserLane, buildQueue(browserLane));
  const { parallel, isolated } = splitQueue(queue);

  // A partition, not a filter: nothing is dropped from both sides, nothing appears in both, and the
  // parallel phase is not empty (an isolation list that swallowed the tier would still "pass" a
  // coverage check while running the whole thing serially at 10x the wall clock).
  assert.deepEqual([...parallel, ...isolated].sort(), [...queue].sort(), "the two phases must together be exactly the queue");
  assert.equal(parallel.length + isolated.length, queue.length, "no file may be lost between the phases");
  for (const file of isolated) {
    assert.equal(parallel.includes(file), false, `${file} is in both phases: it would run twice`);
  }
  assert.ok(parallel.length > 0, "the parallel phase must not be empty");

  // EVERY isolated name must be a file the lane really has. A renamed test would otherwise rejoin the
  // parallel run silently — bringing back the CPU-contention flake the isolation exists to remove —
  // and nothing else in the gate would notice.
  for (const file of ISOLATED) {
    assert.ok(browserLane.includes(file), `${file} is listed as isolated but is not in the browser lane — a renamed or deleted test leaves the isolation silently unapplied`);
    assert.equal(isolated.includes(file), true, `${file} is listed as isolated and must actually be isolated in the queue`);
  }

  // SPLIT QUEUE IS PURE: a caller handing in its own set gets that set honoured, so the tests are not
  // merely re-asserting the module's own constant.
  const custom = splitQueue(["tests/a.test.mjs", "tests/b.test.mjs"], new Set(["tests/b.test.mjs"]));
  assert.deepEqual(custom, { parallel: ["tests/a.test.mjs"], isolated: ["tests/b.test.mjs"] });
});

// ── the two gate wiring claims ────────────────────────────────────────────────────────────

test("the full gate runs every test file exactly once, and the fast gate's set is a subset of it", () => {
  const pkg = JSON.parse(read("package.json"));
  const prePush = read("scripts", "pre-push.sh");

  // The full gate's test stages, read from the gate itself: if either stage stopped running, the
  // "subset" claim below would be about a gate that no longer exists.
  //
  // THE STAGES RUN THE TIER RUNNER (voicebox-beads-wiby): each tier dispatches its lane file by file and
  // writes one tier record, which the last stage folds into <tree>.full.manifest.json. The npm scripts stay
  // as the FALLBACK a repository without the runner takes — the disposable repos in tests/pre-push.test.mjs
  // supply their own test:unit/test:live, and this file has always kept its stages pluggable.
  assert.match(prePush, /run_tier_stage unit [^\n]*gate-tier\.mjs --tier unit/, "the full gate's unit stage must run the unit tier through the tier runner");
  assert.match(prePush, /run_tier_stage live [^\n]*gate-tier\.mjs --tier live/, "the full gate's live stage must run the live tiers through the tier runner");
  assert.match(prePush, /run_stage unit [^\n]*npm run test:unit/, "a repo with no tier runner keeps the package.json fallback");
  assert.match(prePush, /run_stage live [^\n]*npm run test:live/, "a repo with no tier runner keeps the package.json fallback");
  assert.match(prePush, /gate-manifest\.mjs aggregate[^\n]*--tier-dir/, "the full gate must fold the tier records into the full manifest");
  // The tier runner takes its files from the ONE classifier — no hand-kept list that can rot.
  assert.match(read("scripts", "gate-tier.mjs"), /classify\(\)/, "the tier runner must take its lanes from the classifier");

  // Both stages take their file list from the ONE classifier — no hand-kept list that can rot, and
  // no second definition of "the fast gate's files" that merely happens to agree today.
  assert.match(pkg.scripts["test:unit"], /test-lanes\.mjs --lane unit/, "the fast gate must take its files from the unit lane");
  assert.match(pkg.scripts["test:live"], /test-lanes\.mjs --lane server/, "the live stage must take its server files from the server lane");
  assert.match(pkg.scripts["test:live"], /browser-shard-runner\.mjs/, "the live stage must run the browser tier through its shard runner");

  // The browser tier's own argument list — the thing that decides which files it runs — is the
  // browser lane, with no duplicate and no survivor of a name nobody noticed.
  const browserTier = lane("browser");
  assert.equal(new Set(browserTier).size, browserTier.length, "the browser lane names a file twice");

  // Every test file on disk, exactly once, across the full gate's two stages.
  const onDisk = readdirSync(path.join(root, "tests"))
    .filter((file) => file.endsWith(".test.mjs"))
    .map((file) => `tests/${file}`);
  const full = [...lane("unit"), ...lane("live")];
  assert.deepEqual([...full].sort(), [...onDisk].sort(), "the full gate's file set must be every tests/*.test.mjs, exactly once");

  // EXECUTABLE SUBSET: every file the fast gate runs, the full gate also runs.
  const fullSet = new Set(full);
  const fast = lane("unit");
  assert.ok(fast.length > 0, "the fast gate's file set must not be empty");
  for (const file of fast) {
    assert.ok(fullSet.has(file), `${file} is in the fast gate's file set but the full gate does not run it`);
  }
  // And the fast gate is a PROPER subset today: the live tier is the part it deliberately skips.
  assert.ok(lane("live").length > 0, "the full gate must still have a live tier, or 'fast runs less' has stopped meaning anything");
});
