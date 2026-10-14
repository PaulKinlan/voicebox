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
import { TIER_WORKERS, recordOf, runOneTier, testCounts, tierFiles, tierVerdict } from "../scripts/gate-tier.mjs";
import { classify } from "../scripts/test-lanes.mjs";

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
  assert.equal(TIER_WORKERS.unit, Math.max(1, os.availableParallelism() - 1));
  assert.equal(TIER_WORKERS.server, 4);
  assert.equal(TIER_WORKERS.browser, 4);
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

function aggregateTiers(records, { out = null } = {}) {
  const dir = out ?? mkdtempSync(path.join(os.tmpdir(), "voicebox-artifacts-"));
  const recordDir = mkdtempSync(path.join(os.tmpdir(), "voicebox-tier-records-"));
  // `null` means "this tier wrote NOTHING", which is a different fact from an empty record.
  for (const tier of TIERS) if (records[tier] !== null) writeFileSync(tierRecordPath(recordDir, tier), `${JSON.stringify(records[tier] ?? tierRecord(tier), null, 2)}\n`);
  const { manifest, written, tierProblems } = aggregateTierRecords({ tierDir: recordDir, gate: "full", tree: MANIFEST_TREE, sha: "1234abc", classified: classifyOnce(), dir });
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
  rmSync(recordDir, { recursive: true, force: true });
  rmSync(out, { recursive: true, force: true });
});

test("the base is resolved before the changed-path map is asked, and only a commit counts", () => {
  assert.equal(baseNamesACommit("HEAD"), true, "HEAD is always a commit in this repository");
  assert.equal(baseNamesACommit("no/such/ref"), false, "a base that resolves to nothing is not a commit");
  assert.equal(baseNamesACommit("HEAD~999999"), false, "a base that walks off the history is not a commit");
  assert.equal(baseNamesACommit("tests"), false, "an existing PATH is not a commit, and `--verify` says so rather than guessing");
});
