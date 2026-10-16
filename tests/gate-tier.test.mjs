// tests/gate-tier.test.mjs — the full gate's per-file dispatch, and the manifest it feeds (voicebox-beads-wiby).
//
// `voicebox-beads-zjpm.3` made the FAST gate say what it measured; the merger's static preflight found that
// the FULL gate still sealed nothing — `npm run gate` could print ALL GATES GREEN and leave no
// `<tree>.full.manifest.json` for any later reader. These assertions are about the two halves of that fix:
// the tier runner (one record per file, a terminal status and a duration for each, refusals BY NAME for the
// shapes that make a record look complete while saying nothing) and the aggregate CLI that folds three tier
// records into the full manifest.
//
// The roster cases run against the REAL classifier, because a synthetic roster would only prove that the
// test agrees with itself; the record cases run against a synthetic RUNNER, because a fixture that watched
// real files would prove that node works.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TIERS, aggregateTierRecords, baseNamesACommit, tierRecordPath } from "../scripts/gate-manifest.mjs";
import { failureEvidence, recordOf, runOneTier, testCounts, tierFiles, tierFileTimeoutMs, tierVerdict } from "../scripts/gate-tier.mjs";
import { classify } from "../scripts/test-lanes.mjs";
import { TIER_FILE_MS, TIER_WORKERS } from "../scripts/test-shards.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const lane = (name) => classifyOnce()[name].map(({ file }) => `tests/${file}`);
// ONE classification for the whole file: `classify()` lexes every test file in the tree, so asking it per
// assertion would make this file's cost the classifier's cost multiplied by the number of cases.
let classifiedCache = null;
const classifyOnce = () => (classifiedCache ??= classify());
const cleanEnv = { ...process.env };
delete cleanEnv.VOICEBOX_GATE_TIER_DIR;
delete cleanEnv.VOICEBOX_GATE_FILE_SECS;

const passedRecord = (file) => ({ path: file, status: "passed", counts: { tests: 2, pass: 2, fail: 0, skipped: 0 }, timeout_ms: 240_000, secs: 0.4 });
const tierRecord = (tier) => ({ tier, files: lane(tier).map(passedRecord) });

// ── the roster ───────────────────────────────────────────────────────────────────────────────────

test("the tier roster IS the classifier's lanes — every classified file, in the gate's own naming", () => {
  const classified = classifyOnce();
  const all = [];
  for (const tier of TIERS) {
    const files = tierFiles(tier, classified);
    assert.deepEqual(files, classified[tier].map(({ file }) => `tests/${file}`), `${tier} must be the classifier's own lane`);
    assert.ok(files.length > 0, `the ${tier} lane must not be empty — an empty tier would make the manifest vacuous`);
    all.push(...files);
  }
  assert.equal(new Set(all).size, all.length, "a file must be in exactly one tier");
  assert.ok(all.length > 200, `the real roster is over 200 files; measured ${all.length}`);
});

test("the workers are the concurrency the gate already ran at, so per-file dispatch is not a speed claim", () => {
  // `npm run test:unit` is one `node --test` over the unit lane (node's default file concurrency is
  // availableParallelism - 1) and `npm run test:live` passes --test-concurrency=4 to the server lane.
  // ONE OWNER (scripts/test-shards.mjs): the fast gate reads this same value, so a scoped run cannot be
  // more serial than the tier it is a strict subset of (voicebox-beads-buy8).
  assert.equal(TIER_WORKERS.unit, Math.max(1, os.availableParallelism() - 1));
  assert.equal(TIER_WORKERS.server, 4);
  // THREE, NOT TWO OR FOUR (voicebox-beads-q4j6.1, measured 2026-10-15): at four shards two full-gate unions went red
  // on DIFFERENT sets of browser files; at two shards the gate was green but took 750.1s browser-tier wall time.
  // At three shards, all 92 browser test files pass cleanly with zero timeouts and zero flakes,
  // reducing browser-tier wall time from 750.1s to 184.2s (a 4.07x browser-tier speedup saving 565.9s / ~9.4 minutes).
  assert.equal(TIER_WORKERS.browser, 3);
});

// ── a file's counts, including the empty run ─────────────────────────────────────────────────────

test("a file with NO tests is counted as ZERO tests, and a file whose import throws keeps its real failure", () => {
  // Measured on node 24.21: a file that runs no tests still reports ONE top-level result named after the
  // file itself. Counting it is how a file that demonstrates nothing looks like a one-test pass — the
  // empty run `reconcile` refuses by name.
  const zeroRelative = "TAP version 13\nok 1 - tests/zero.test.mjs\n1..1\n# tests 1\n# pass 1\n# fail 0\n# skipped 0\n";
  // A caller that hands node an ABSOLUTE path gets the file back as a `file://` URL: same entry, same file.
  const zeroFileUrl = `TAP version 13\nok 1 - file://${path.resolve(root, "tests/zero.test.mjs")}\n1..1\n# tests 1\n# pass 1\n# fail 0\n# skipped 0\n`;
  const oneTest = "TAP version 13\n# Subtest: a real test\nok 1 - a real test\n1..1\n# tests 1\n# pass 1\n# fail 0\n# skipped 0\n";
  const crash = "TAP version 13\nnot ok 1 - tests/boom.test.mjs\n  ---\n  exitCode: 1\n  ...\n1..1\n# tests 1\n# pass 0\n# fail 1\n# skipped 0\n";

  assert.deepEqual(testCounts("tests/zero.test.mjs", zeroRelative), { tests: 0, pass: 0, fail: 0, skipped: 0 });
  assert.deepEqual(testCounts("tests/zero.test.mjs", zeroFileUrl), { tests: 0, pass: 0, fail: 0, skipped: 0 });
  // The negative controls: a file with a real test, and the same file-named entry reported as a FAILURE —
  // a file whose import threw is a real failure and must not be rewritten into an empty run.
  assert.equal(testCounts("tests/one.test.mjs", oneTest).tests, 1);
  assert.equal(testCounts("tests/boom.test.mjs", crash).fail, 1);
});

test("a record's status comes from the child's own exit, counts and timeout — unknown is not a pass", () => {
  const green = recordOf("tests/x.test.mjs", { code: 0, signal: null, timedOut: false, secs: 1, out: "1..1\n# tests 3\n# pass 3\n# fail 0\n# skipped 0\n" }, 240_000);
  assert.equal(green.status, "passed");
  assert.deepEqual(green.counts, { tests: 3, pass: 3, fail: 0, skipped: 0 });
  assert.equal(green.timeout_ms, 240_000);

  const killed = recordOf("tests/x.test.mjs", { code: null, signal: "SIGTERM", timedOut: true, secs: 240, out: "" }, 240_000);
  assert.equal(killed.status, "timeout", "a file killed at its own budget is a timeout, and a timeout is never a pass");
  assert.equal(killed.counts, null, "a killed child reported no counts, and null is the honest answer");

  const lostExit = recordOf("tests/x.test.mjs", { code: 0, signal: null, timedOut: false, secs: 1, out: "no summary at all\n" }, 240_000);
  assert.equal(lostExit.status, "unknown", "exit 0 with no TAP summary is 'nobody said how this ended'");
});

// ── the tier runner, against a synthetic runner ──────────────────────────────────────────────────

test("every file in the lane gets exactly one terminal record with a duration", async () => {
  const files = ["tests/a.test.mjs", "tests/b.test.mjs", "tests/c.test.mjs"];
  const seen = [];
  const record = await runOneTier({
    tier: "unit",
    files,
    workers: 2,
    runner: async (file) => {
      seen.push(file);
      return { file, code: 0, signal: null, timedOut: false, secs: 0.1, out: "1..1\n# tests 1\n# pass 1\n# fail 0\n# skipped 0\n" };
    },
    log: { log() {}, error() {} },
  });
  assert.deepEqual(seen.sort(), files, "every file is dispatched exactly once");
  assert.deepEqual(record.files.map((f) => f.path), files, "the record is in the lane's order, so two runs are comparable");
  for (const entry of record.files) {
    assert.equal(entry.status, "passed");
    assert.ok(Number.isFinite(entry.secs), `${entry.path} must carry a duration — a record without one is a lost child`);
  }
  assert.deepEqual(tierVerdict(record, files).ok, true, "a complete, green tier reconciles against its own lane");
});

test("a tier failure retains bounded TAP diagnostics before the last 40 lines; a green tier stays quiet", async () => {
  const early = "not ok 1 - watchdog startup under load\n  ---\n  error: child hung past watchdog deadline\n  stack: first useful line\n  ...";
  const trailing = Array.from({ length: 80 }, (_, n) => `# later passing diagnostic ${n}`).join("\n");
  const red = `${early}\nok 2 - later pass\n${trailing}\n1..2\n# tests 2\n# pass 1\n# fail 1\n# skipped 0\n`;
  const green = "ok 1 - green\n1..1\n# tests 1\n# pass 1\n# fail 0\n# skipped 0\n";
  const logged = [];
  const record = await runOneTier({
    tier: "unit", files: ["tests/red.test.mjs", "tests/green.test.mjs"], workers: 1,
    runner: async (file) => ({ code: file.includes("red") ? 1 : 0, signal: null, timedOut: false, secs: 0.1, out: file.includes("red") ? red : green }),
    log: { log(message) { logged.push(message); }, error() {} },
  });
  const redEntry = record.files.find((entry) => entry.path === "tests/red.test.mjs");
  const greenEntry = record.files.find((entry) => entry.path === "tests/green.test.mjs");
  assert.equal(tierVerdict(record, record.files.map((entry) => entry.path)).ok, false, "diagnostics must never turn a failed tier green");
  assert.equal(redEntry.failure_evidence.version, 2, "the additive evidence field has its own version, bumped when it gained the failing arm's NAME");
  assert.equal(redEntry.failure_evidence.test, "watchdog startup under load", "and the arm that failed is a FIELD, not just text inside the excerpt");
  assert.match(redEntry.failure_evidence.excerpts[0], /not ok 1 - watchdog startup under load[\s\S]*child hung past watchdog deadline/);
  assert.ok(redEntry.failure_evidence.excerpts[0].length < 5000, "a noisy test cannot make an unbounded record");
  assert.doesNotMatch(redEntry.failure_evidence.excerpts[0], /later passing diagnostic/);
  assert.equal(Object.hasOwn(greenEntry, "failure_evidence"), false, "green files add no evidence payload");
  const noisy = Array.from({ length: 5 }, (_, n) => `not ok ${n + 1} - failing test ${n}\n${("  " + "x".repeat(1000) + "\n").repeat(40)}`).join("");
  const bounded = failureEvidence(noisy);
  assert.equal(bounded.excerpts.length, 3, "only the first three failures are retained");
  assert.ok(bounded.excerpts.every((excerpt) => excerpt.split("\n").length <= 20 && excerpt.split("\n").every((line) => line.length <= 240)), "every section and line has a hard bound");
  assert.match(failureEvidence("uncaught crash before TAP").excerpts[0], /uncaught crash before TAP/, "a crash without a test name is still diagnosable");
  const nestedTap = `# Subtest: suite\n    not ok 1 - failing subtest\n      ---\n      error: Expected true, got false\n      ...\n    1..1\nnot ok 1 - suite\n  ---\n  error: 1 subtest failed\n  ...\n${trailing}\n1..1\n# tests 2\n# pass 0\n# fail 2\n# skipped 0\n`;
  const nestedLog = [];
  const nested = await runOneTier({
    tier: "unit", files: ["tests/nested.test.mjs"], workers: 1,
    runner: async () => ({ code: 1, signal: null, timedOut: false, secs: 0.1, out: nestedTap }),
    log: { log(message) { nestedLog.push(message); }, error() {} },
  });
  assert.equal(nested.files[0].status, "failed");
  assert.match(nested.files[0].failure_evidence.excerpts[0], /failing subtest[\s\S]*Expected true, got false/);
  assert.match(nestedLog.join("\n"), /failing subtest[\s\S]*Expected true, got false/, "nested assertion survives in cached log");
  assert.doesNotMatch(nestedLog.join("\n"), /later passing diagnostic/, "the nested section is bounded too");
  const output = logged.join("\n");
  assert.match(output, /not ok 1 - watchdog startup under load[\s\S]*child hung past watchdog deadline/);
  assert.doesNotMatch(output, /later passing diagnostic|output of tests\/green/, "the log prints only the red section");

  const unit = tierRecord("unit");
  const at = unit.files.findIndex((entry) => entry.path === "tests/gate-tier.test.mjs");
  assert.ok(at >= 0);
  unit.files[at] = { ...redEntry, path: unit.files[at].path };
  const { manifest } = aggregateTiers({ unit, server: tierRecord("server"), browser: tierRecord("browser") });
  assert.equal(manifest.verdict, "fail", "retaining evidence does not change a red manifest verdict");
  assert.deepEqual(manifest.files.find((entry) => entry.path === unit.files[at].path).failure_evidence, redEntry.failure_evidence, "the sealed manifest carries the bounded diagnostic too");
});

test("the unit tier records WHICH ARM failed and WHAT THE BOX WAS DOING around that child (voicebox-beads-a8a2)", async () => {
  // WHY. Three unit-tier failures on 2026-10-15 could not be attributed from the artifact: this tier
  // recorded counts and no box context, and the failing arm's name existed only inside a log a lane had
  // already lost. Both halves are now in the record, per child, because every file here is its own process.
  const leaf = `# Subtest: suite
    # Subtest: failing subtest
    not ok 1 - failing subtest
      ---
      error: Expected true, got false
      ...
    1..1
not ok 1 - suite
  ---
  error: 1 subtest failed
  ...
`;
  const logged = [];
  const record = await runOneTier({
    tier: "unit", files: ["tests/leaf.test.mjs", "tests/green.test.mjs"], workers: 2,
    runner: async (file) => ({
      code: file.includes("green") ? 0 : 1, signal: null, timedOut: false, secs: 0.2,
      out: file.includes("green") ? "ok 1 - green\n1..1\n# tests 1\n# pass 1\n# fail 0\n# skipped 0\n" : `${leaf}1..2\n# tests 2\n# pass 0\n# fail 2\n# skipped 0\n`,
    }),
    log: { log(message) { logged.push(message); }, error() {} },
  });
  const red = record.files.find((entry) => entry.path === "tests/leaf.test.mjs");
  const green = record.files.find((entry) => entry.path === "tests/green.test.mjs");
  assert.equal(red.failure_evidence.test, "failing subtest", "the ARM is named, not the suite that contains it (node prints the nested failure first, and that is the one a person needs)");
  assert.equal(green.failure_evidence, undefined, "a green file still carries no evidence payload");
  // THE BOX, per child: both ends, each a finite load reading from runOneTier - and it is recorded for a PASSING child
  // too, because the point is what the box was doing when this file ran, not only when it went red (voicebox-beads-q1g7).
  for (const entry of [red, green]) {
    assert.deepEqual(Object.keys(entry.loadavg_1m), ["start", "end"], "both ends of the child's own window");
    for (const end of ["start", "end"]) {
      assert.ok(Number.isFinite(entry.loadavg_1m[end]), `${entry.path} ${end} must be a finite reading, got ${entry.loadavg_1m[end]}`);
    }
  }
  assert.match(logged.join("\n"), /arm="failing subtest" tests\/leaf\.test\.mjs/, "the line a person reads names the arm, with the path still last");

  // AND IT REACHES THE ARTIFACT, not just the tier record: the unit tier's readings fold through the same
  // `recordTier` the browser tier uses, which is the whole point of the schema being additive.
  const unit = tierRecord("unit");
  const at = unit.files.findIndex((entry) => entry.path === "tests/gate-tier.test.mjs");
  unit.files[at] = { ...red, path: unit.files[at].path };
  const { manifest } = aggregateTiers({ unit, server: tierRecord("server"), browser: tierRecord("browser") });
  const folded = manifest.files.find((entry) => entry.path === unit.files[at].path);
  assert.deepEqual(folded.loadavg_1m, red.loadavg_1m, "a unit-tier file's box window survives into the manifest");
  assert.equal(folded.failure_evidence?.test, "failing subtest", "and so does the name of the arm that failed");

  // A FAILURE THAT CANNOT BE NAMED IS SAID OUT LOUD. A TAP summary with failures and no `not ok` line is the
  // shape where the arm is genuinely unavailable, and it must not read like a named failure afterwards.
  const unnamed = [];
  const nameless = await runOneTier({
    tier: "unit", files: ["tests/nameless.test.mjs"], workers: 1,
    runner: async () => ({ code: 1, signal: null, timedOut: false, secs: 0.1, out: "1..1\n# tests 1\n# pass 0\n# fail 1\n# skipped 0\n" }),
    log: { log(message) { unnamed.push(message); }, error() {} },
  });
  assert.equal(nameless.files[0].status, "failed");
  assert.equal(nameless.files[0].failure_evidence.test, null, "no name was available and the record says so instead of inventing one");
  assert.match(unnamed.join("\n"), /WARNING: tests\/nameless\.test\.mjs failed and no failing arm could be named/, "the gap is announced where it is created");

  // A crash before TAP is the same field, null, with the bounded tail - a failure nobody can name is still
  // diagnosable, and `recordOf`'s default says "not measured here" rather than zero.
  assert.equal(failureEvidence("uncaught crash before TAP").test, null, "a crash names no arm and claims none");
  const direct = recordOf("tests/x.test.mjs", { code: null, signal: "SIGTERM", timedOut: true, secs: 240, out: "" }, 240_000);
  assert.deepEqual(direct.loadavg_1m, { start: null, end: null }, "a caller that measured nothing records an absence, never a zero");
});

test("a dropped file, a duplicate and a file with no duration are each refused BY NAME", () => {
  const files = ["tests/a.test.mjs", "tests/b.test.mjs"];
  const ok = { tier: "unit", files: [passedRecord("tests/a.test.mjs")] };

  const dropped = tierVerdict(ok, files);
  assert.equal(dropped.ok, false);
  assert.match(dropped.problems.join(" "), /tests\/b\.test\.mjs is in the unit lane but appears in no record \(missing\)/);

  const twice = tierVerdict({ tier: "unit", files: [passedRecord("tests/a.test.mjs"), passedRecord("tests/a.test.mjs"), passedRecord("tests/b.test.mjs")] }, files);
  assert.equal(twice.ok, false);
  assert.match(twice.problems.join(" "), /tests\/a\.test\.mjs was recorded twice \(duplicate\)/);

  const noDuration = tierVerdict({ tier: "unit", files: [{ ...passedRecord("tests/a.test.mjs"), secs: null }, passedRecord("tests/b.test.mjs")] }, files);
  assert.equal(noDuration.ok, false);
  assert.match(noDuration.problems.join(" "), /the child's exit was lost/);

  const notTerminal = tierVerdict({ tier: "unit", files: [{ ...passedRecord("tests/a.test.mjs"), status: undefined }, passedRecord("tests/b.test.mjs")] }, files);
  assert.equal(notTerminal.ok, false);
  assert.match(notTerminal.problems.join(" "), /no terminal status/);

  const unexpected = tierVerdict({ tier: "unit", files: [passedRecord("tests/a.test.mjs"), passedRecord("tests/b.test.mjs"), passedRecord("tests/elsewhere.test.mjs")] }, files);
  assert.equal(unexpected.ok, false);
  assert.match(unexpected.problems.join(" "), /tests\/elsewhere\.test\.mjs was recorded but is not in the unit tier/);
});

test("a tier with a failed or a zero-test file is NOT green — the aggregate is where a red run is answered", async () => {
  const files = ["tests/a.test.mjs", "tests/b.test.mjs"];
  const record = await runOneTier({
    tier: "unit",
    files,
    workers: 1,
    runner: async (file) => (file.endsWith("a.test.mjs")
      ? { file, code: 1, signal: null, timedOut: false, secs: 0.2, out: "not ok 1 - a\n1..1\n# tests 1\n# pass 0\n# fail 1\n# skipped 0\n" }
      : { file, code: 0, signal: null, timedOut: false, secs: 0.2, out: `1..1\n# tests 1\n# pass 1\n# fail 0\n# skipped 0\n` }),
    log: { log() {}, error() {} },
  });
  const verdict = tierVerdict(record, files);
  assert.equal(verdict.ok, false, "a red file means the tier is not green");
  assert.deepEqual(verdict.notPassed.map((f) => f.path), ["tests/a.test.mjs"]);
  assert.equal(verdict.notPassed[0].condition_request, "pending", "a red gate requests a diagnostic without running under its own heavy slot");
  assert.equal(Object.hasOwn(verdict.notPassed[0], "conditions"), false, "a pending request is never fabricated measurement");
  assert.equal(Object.hasOwn(record.files[1], "conditions"), false, "a green tier record remains quiet");
  assert.deepEqual(verdict.problems, [], "the tier is COMPLETE — the failure is a verdict, not a gap, and the aggregate owns verdicts");

  const zeroTest = await runOneTier({
    tier: "unit",
    files: ["tests/a.test.mjs"],
    workers: 1,
    runner: async (file) => ({ file, code: 0, signal: null, timedOut: false, secs: 0.2, out: `ok 1 - ${file}\n1..1\n# tests 1\n# pass 1\n# fail 0\n# skipped 0\n` }),
    log: { log() {}, error() {} },
  });
  assert.equal(zeroTest.files[0].counts.tests, 0, "a file that ran no tests is recorded as zero, not as one");
});

// ── the aggregate: three tier records, one manifest ─────────────────────────────────────────────

function aggregateTiers(records, { out = null, gate = "full", treeDirty = null } = {}) {
  const dir = out ?? mkdtempSync(path.join(os.tmpdir(), "voicebox-artifacts-"));
  const recordDir = mkdtempSync(path.join(os.tmpdir(), "voicebox-tier-records-"));
  // `null` means "this tier wrote NOTHING", which is a different fact from an empty record.
  for (const tier of TIERS) if (records[tier] !== null) writeFileSync(tierRecordPath(recordDir, tier), `${JSON.stringify(records[tier] ?? tierRecord(tier), null, 2)}\n`);
  const { manifest, written, tierProblems } = aggregateTierRecords({ tierDir: recordDir, gate, tree: MANIFEST_TREE, sha: "1234abc", classified: classifyOnce(), treeDirty, dir });
  rmSync(recordDir, { recursive: true, force: true });
  if (out === null) rmSync(dir, { recursive: true, force: true });
  return { manifest, written, tierProblems };
}

const MANIFEST_TREE = "b".repeat(40);

test("three tier records fold into ONE sealed full manifest that accounts for every classified file", () => {
  const out = mkdtempSync(path.join(os.tmpdir(), "voicebox-artifacts-"));
  const roster = TIERS.flatMap((tier) => lane(tier));
  const { manifest, written, tierProblems } = aggregateTiers({ unit: tierRecord("unit"), server: tierRecord("server"), browser: tierRecord("browser") }, { out });
  assert.equal(written, path.join(out, `${MANIFEST_TREE}.full.manifest.json`), "the artifact is keyed by the tree it measured");
  assert.deepEqual(JSON.parse(readFileSync(written, "utf8")), manifest, "the sealed file is the manifest that was decided");
  assert.deepEqual(tierProblems, []);
  assert.equal(manifest.gate, "full");
  assert.equal(manifest.tree, MANIFEST_TREE);
  assert.equal(manifest.reconciled, true);
  assert.deepEqual(manifest.problems, []);
  assert.equal(manifest.verdict, "pass");
  assert.equal(manifest.summary.classified, roster.length);
  assert.equal(manifest.summary.dispatched, roster.length, "a full gate dispatches the whole roster");
  assert.equal(manifest.summary.omitted, 0);
  assert.equal(manifest.summary.unknown, 0);
  assert.equal(manifest.summary.unmapped, 0);
  assert.deepEqual([...new Set(manifest.files.map((f) => f.tier))].sort(), ["browser", "server", "unit"]);
  rmSync(out, { recursive: true, force: true });
});

test("the aggregate REFUSES a dropped file, a zero-test pass, a failed file and a tier that wrote no record", () => {
  const dropped = tierRecord("browser");
  dropped.files = dropped.files.slice(1);
  dropped.files[0] = { ...dropped.files[0], counts: { tests: 0, pass: 0, fail: 0, skipped: 0 } };
  const unit = tierRecord("unit");
  unit.files[0] = { ...unit.files[0], status: "failed", counts: { tests: 1, pass: 0, fail: 1, skipped: 0 } };

  const brokenOut = mkdtempSync(path.join(os.tmpdir(), "voicebox-artifacts-"));
  const broken = aggregateTiers({ unit, server: tierRecord("server"), browser: dropped }, { out: brokenOut });
  const problems = broken.manifest.problems.join("\n");
  assert.equal(broken.manifest.reconciled, false, "a manifest with a hole in it never reconciles");
  assert.equal(broken.manifest.verdict, "refused");
  assert.ok(broken.written, "the artifact is still written — the run a reader has to audit");
  assert.match(problems, /is in the classifier roster but appears in no record \(missing/, "a dropped file is refused by name");
  assert.match(problems, /passed with ZERO tests/, "a pass with zero tests demonstrates nothing");
  assert.equal(broken.manifest.summary.failed, 1, "a failed file is a failed gate, and the summary is where a red run is counted");
  rmSync(brokenOut, { recursive: true, force: true });

  const noTier = aggregateTiers({ unit: tierRecord("unit"), server: tierRecord("server"), browser: null });
  assert.equal(noTier.manifest.reconciled, false, "a tier that wrote no record is not an empty tier");
  assert.match(noTier.tierProblems.join("\n"), /the browser tier wrote no record at .*browser\.json/, "the missing TIER is named, not left as a roster-sized list of missing files");
});

test("a DIRTY tree seals no landing receipt, and the artifact says which fact refused it", () => {
  // The tiers run over the WORKING TREE and the receipt is keyed by the COMMITTED tree: when those two
  // differ the artifact is a claim about bytes nobody measured. The fast gate MAY run over uncommitted work
  // (that is its job) and only records the fact — the asymmetry is deliberate, and it is asserted here so
  // neither half is changed by accident.
  const all = () => ({ unit: tierRecord("unit"), server: tierRecord("server"), browser: tierRecord("browser") });
  const cleanFull = aggregateTiers(all(), { out: null });
  assert.equal(cleanFull.manifest.verdict, "pass", "a clean full run is the case that seals a receipt");
  assert.equal(cleanFull.manifest.tree_dirty, null, "a run that never asked about the worktree does not claim it was clean");

  const dirty = aggregateTiers(all(), { treeDirty: true });
  assert.equal(dirty.manifest.tree_dirty, true, "the artifact records the worktree's state");
  assert.equal(dirty.manifest.reconciled, false, "a dirty full run does not reconcile");
  assert.equal(dirty.manifest.verdict, "refused");
  assert.match(dirty.manifest.problems.join("\n"), /working tree was DIRTY/);

  const dirtyFast = aggregateTiers(all(), { gate: "fast", treeDirty: true });
  assert.equal(dirtyFast.manifest.tree_dirty, true);
  assert.equal(dirtyFast.manifest.verdict, "pass", "a fast gate may run over uncommitted work; it records the fact instead of refusing");
});

test("the aggregate CLI is the same decision, keyed by tree, and answers with the verdict's exit code", () => {
  // ONE CLI run, because the flags -> manifest -> exit-code wiring is the only thing the in-process cases
  // above cannot see (they drive `aggregateTierRecords`, so there is no node startup per case).
  const out = mkdtempSync(path.join(os.tmpdir(), "voicebox-artifacts-"));
  const recordDir = mkdtempSync(path.join(os.tmpdir(), "voicebox-tier-records-"));
  for (const tier of TIERS) writeFileSync(tierRecordPath(recordDir, tier), `${JSON.stringify(tierRecord(tier), null, 2)}\n`);
  const tree = "c".repeat(40);
  const result = spawnSync(process.execPath, ["scripts/gate-manifest.mjs", "aggregate", "--gate", "full", "--tree", tree, "--sha", "1234abc", "--tier-dir", recordDir, "--out", out], {
    cwd: root,
    encoding: "utf8",
    env: cleanEnv,
  });
  assert.equal(result.status, 0, `a complete gate must exit 0: ${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /verdict pass, reconciled true/);
  assert.match(readFileSync(path.join(out, `${tree}.full.manifest.json`), "utf8"), /"reconciled": true/);

  // A BASE THAT DOES NOT RESOLVE IS AN UNKNOWN SCOPE, NOT AN EMPTY ONE. The changed-path map's `--json`
  // developer path answers a base it cannot resolve with `{"changed":[],"unmapped":[]}` and exit 0 (git's
  // "ambiguous argument" goes to stderr), so asking it and believing the answer would skip the
  // unmapped-source refusal for a typo'd or unfetched base — the artifact would say `pass` about a scope
  // nobody read. Measured before the fix: this gate sealed a manifest for a tree it could not describe.
  const bogus = spawnSync(process.execPath, ["scripts/gate-manifest.mjs", "aggregate", "--gate", "full", "--tree", tree, "--tier-dir", recordDir, "--out", out, "--changed-base", "no/such/ref"], {
    cwd: root,
    encoding: "utf8",
    env: cleanEnv,
  });
  assert.notEqual(bogus.status, 0, `a base that names no commit must refuse this gate: ${bogus.stdout}`);
  assert.match(bogus.stderr, /--changed-base 'no\/such\/ref' does not name a commit/);
  assert.match(bogus.stderr, /UNKNOWN/);
  assert.match(readFileSync(path.join(out, `${tree}.full.manifest.json`), "utf8"), /"reconciled": false/);

  // A DIRTY WORKTREE SEALS NO LANDING RECEIPT. The fact lives with the caller that can see the worktree
  // (scripts/pre-push.sh checks `git status --porcelain`), and the flag is how it reaches the fold.
  const dirty = spawnSync(process.execPath, ["scripts/gate-manifest.mjs", "aggregate", "--gate", "full", "--tree", tree, "--tier-dir", recordDir, "--out", out, "--tree-dirty"], {
    cwd: root,
    encoding: "utf8",
    env: cleanEnv,
  });
  assert.notEqual(dirty.status, 0, `a dirty run must refuse a LANDING receipt: ${dirty.stdout}`);
  assert.match(dirty.stderr, /working tree was DIRTY/);
  const dirtyArtifact = JSON.parse(readFileSync(path.join(out, `${tree}.full.manifest.json`), "utf8"));
  assert.equal(dirtyArtifact.tree_dirty, true, "the artifact records the worktree state it refused for");
  assert.equal(dirtyArtifact.reconciled, false);
  assert.equal(dirtyArtifact.verdict, "refused");
  rmSync(recordDir, { recursive: true, force: true });
  rmSync(out, { recursive: true, force: true });
});

test("the base is resolved before the changed-path map is asked, and only a commit counts", () => {
  assert.equal(baseNamesACommit("HEAD"), true, "HEAD is always a commit in this repository");
  assert.equal(baseNamesACommit("no/such/ref"), false, "a base that resolves to nothing is not a commit");
  assert.equal(baseNamesACommit("HEAD~999999"), false, "a base that walks off the history is not a commit");
  assert.equal(baseNamesACommit("tests"), false, "an existing PATH is not a commit, and `--verify` says so rather than guessing");
});

test("the per-tier file budget is derived from measured headroom and sits UNDER each tier's stage bound (voicebox-beads-ak9h)", () => {
  // A wedged unit file must be recorded timeout by name rather than the 180s stage bound killing the lane.
  // Read stage bounds directly from scripts/pre-push.sh:
  const prepush = readFileSync(path.join(root, "scripts/pre-push.sh"), "utf8");
  const unitMatch = prepush.match(/_unit_secs="\$\{VOICEBOX_GATE_UNIT_SECS:-\$\{VOICEBOX_GATE_TESTS_SECS:-(\d+)\}\}"/);
  const liveMatch = prepush.match(/_live_secs="\$\{VOICEBOX_GATE_LIVE_SECS:-(\d+)\}"/);
  assert.ok(unitMatch, "scripts/pre-push.sh must declare default _unit_secs");
  assert.ok(liveMatch, "scripts/pre-push.sh must declare default _live_secs");
  const unitStageBoundMs = Number(unitMatch[1]) * 1000;
  const liveStageBoundMs = Number(liveMatch[1]) * 1000;

  assert.ok(
    TIER_FILE_MS.unit < unitStageBoundMs,
    `unit per-file budget (${TIER_FILE_MS.unit}ms) must sit under unit stage bound (${unitStageBoundMs}ms)`,
  );
  assert.ok(
    TIER_FILE_MS.server < liveStageBoundMs,
    `server per-file budget (${TIER_FILE_MS.server}ms) must sit under live stage bound (${liveStageBoundMs}ms)`,
  );
  assert.ok(
    TIER_FILE_MS.browser < liveStageBoundMs,
    `browser per-file budget (${TIER_FILE_MS.browser}ms) must sit under live stage bound (${liveStageBoundMs}ms)`,
  );

  // Default tier resolution matches TIER_FILE_MS
  assert.equal(tierFileTimeoutMs("unit"), TIER_FILE_MS.unit);
  assert.equal(tierFileTimeoutMs("server"), TIER_FILE_MS.server);
  assert.equal(tierFileTimeoutMs("browser"), TIER_FILE_MS.browser);
  assert.equal(tierFileTimeoutMs("live"), TIER_FILE_MS.live);

  // Overrides: CLI --file-secs and env.VOICEBOX_GATE_FILE_SECS take precedence over defaults
  assert.equal(tierFileTimeoutMs("unit", { fileSecs: 45 }), 45_000);
  assert.equal(tierFileTimeoutMs("unit", { env: { VOICEBOX_GATE_FILE_SECS: "60" } }), 60_000);
  assert.equal(tierFileTimeoutMs("unit", { fileSecs: 45, env: { VOICEBOX_GATE_FILE_SECS: "60" } }), 45_000);
});
