// tests/gate-manifest.test.mjs — the gate's coverage record, driven until it refuses
// (voicebox-beads-zjpm.3).
//
// The failure this file exists to make impossible is a gate that reports a verdict for a tree it did
// not measure: PASS in 56s over 3 of 221 classified files, or ALL CLEAR with the shared front never
// observed. So the assertions here are about the REFUSALS as much as the happy path — a manifest with a
// dropped file, a silent duplicate, a lost child exit or an empty passing run must not reconcile, and
// each one is driven by name. The roster cases run against the REAL classifier, because a synthetic
// roster would prove only that the test agrees with itself.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  GATES,
  HUB_MARKER_PATTERNS,
  MANIFEST_VERSION,
  ManifestRefusal,
  STATUS,
  TIERS,
  createManifest,
  emitMarker,
  finalizeManifest,
  manifestFromTierRecords,
  manifestPath,
  readManifest,
  reconcile,
  recordFile,
  recordTier,
  rosterCounts,
  rosterHash,
  rosterOf,
  tapCounts,
  testChildEnv,
  verdictOf,
  writeManifest,
} from "../scripts/gate-manifest.mjs";
import { classify } from "../scripts/test-lanes.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const classified = classify();
const roster = rosterOf(classified);

const fresh = (overrides = {}) =>
  createManifest({ gate: "fast", tree: "a".repeat(40), sha: "abc1234", classified, ...overrides });

/** A record that reconciles: dispatched, passed, with real counts. */
const passed = (entry) => ({ dispatch: "ran", status: "passed", counts: { tests: 3, pass: 3, fail: 0, skipped: 0 }, secs: 1.5, selection: "changed", ...entry });
const omitted = (entry) => ({ dispatch: "omitted", status: "omitted", reason: "fast-only: not selected by the changed-path map", selection: "not-selected", ...entry });

/** Record every classified file: the given tier dispatched, everything else omitted by name. */
function recordAll(manifest, { dispatchTiers = ["unit"], file = passed } = {}) {
  for (const entry of roster) {
    if (dispatchTiers.includes(entry.tier)) recordFile(manifest, file({ path: entry.path }));
    else recordFile(manifest, omitted({ path: entry.path }));
  }
  return manifest;
}

test("the roster is the classifier's own output, one entry per file, and it partitions the tree", () => {
  assert.equal(roster.length, rosterCounts(roster).total);
  const counts = rosterCounts(roster);
  assert.equal(counts.unit + counts.server + counts.browser, roster.length);
  assert.ok(counts.total > 200, `the real roster is over 200 files; measured ${counts.total}`);
  for (const entry of roster) {
    assert.ok(TIERS.includes(entry.tier), `${entry.path} carries a tier`);
    assert.ok(entry.path.startsWith("tests/"), `${entry.path} is named as the gate names it`);
  }
});

test("the roster hash is an identity: same roster, same hash; a moved file or a changed reason is a different gate", () => {
  const base = rosterHash(roster);
  assert.equal(rosterHash(rosterOf(classify())), base, "re-classifying the same tree is the same roster");

  const moved = roster.map((r) => (r.tier === "unit" ? { ...r, tier: "server" } : r));
  assert.notEqual(rosterHash(moved), base, "a file that changes lane changes the roster identity");

  const relabelled = roster.map((r) => (r.path === roster[0].path ? { ...r, why: "something else" } : r));
  assert.notEqual(rosterHash(relabelled), base, "the reason a file is live is part of what the gate runs beside");
});

test("a fast gate reconciles when every classified file is dispatched once or omitted BY NAME with a reason", () => {
  const manifest = recordAll(fresh(), { dispatchTiers: ["unit", "server"] });
  finalizeManifest(manifest);
  assert.equal(manifest.reconciled, true);
  assert.deepEqual(manifest.problems, []);
  const s = manifest.summary;
  assert.equal(s.classified, roster.length);
  assert.equal(s.recorded, roster.length);
  assert.equal(s.dispatched + s.omitted, roster.length, "dispatched + omitted reconciles the roster");
  assert.equal(s.dispatched, rosterCounts(roster).unit + rosterCounts(roster).server);
  assert.equal(s.omitted, rosterCounts(roster).browser);
  assert.equal(s.problems, 0);
  assert.equal(typeof manifest.secs, "number");
});

test("a file classified but never recorded is MISSING, and it is refused by name", () => {
  const manifest = recordAll(fresh());
  const dropped = manifest.files.pop();
  const { ok, problems } = reconcile(manifest);
  assert.equal(ok, false);
  assert.ok(problems.some((p) => p.includes(dropped.path) && /missing/.test(p)), problems.join(" | "));
});

test("a recorded file that is not in the roster is UNCLASSIFIED, and recordFile refuses to write it", () => {
  const manifest = fresh();
  assert.throws(
    () => recordFile(manifest, passed({ path: "tests/not-a-real-file.test.mjs" })),
    (e) => e instanceof ManifestRefusal && /not in this classifier's roster/.test(e.message),
  );
});

test("the same file twice is a DUPLICATE", () => {
  const manifest = recordAll(fresh());
  assert.throws(() => recordFile(manifest, passed({ path: roster[0].path })), (e) => /recorded twice/.test(e.message));
});

test("a file recorded in the other lane's tier is a malformed tier", () => {
  const entry = roster.find((r) => r.tier === "unit");
  const other = roster.find((r) => r.tier === "browser");
  const manifest = fresh();
  assert.throws(() => recordFile(manifest, passed({ path: entry.path, tier: "browser" })), (e) => /classifier says/.test(e.message));
  recordFile(manifest, passed({ path: entry.path, tier: "unit" }));
  recordFile(manifest, passed({ path: other.path, tier: "browser" }));
  assert.equal(manifest.files.filter((f) => f.path === entry.path).length, 1);
});

test("a dispatched file with no terminal status or no duration is a lost child, not a pass", () => {
  const manifest = recordAll(fresh());
  manifest.files.find((f) => f.dispatch === "ran").secs = null;
  const { ok, problems } = reconcile(manifest);
  assert.equal(ok, false);
  assert.ok(problems.some((p) => /exit was lost/.test(p)), problems.join(" | "));

  assert.throws(() => recordFile(fresh(), { path: roster[0].path, dispatch: "ran", status: "running", selection: "changed" }), (e) => /terminal status/.test(e.message));
  assert.throws(() => recordFile(fresh(), { path: roster[0].path, dispatch: "ran", status: "passed", selection: "changed" }), (e) => /lost child/.test(e.message));
});

test("a passing run that reported ZERO tests is refused — an empty run demonstrates nothing", () => {
  const manifest = recordAll(fresh(), { file: (entry) => passed({ ...entry, counts: { tests: 0, pass: 0, fail: 0, skipped: 0 } }) });
  const { ok, problems } = reconcile(manifest);
  assert.equal(ok, false);
  assert.equal(problems.filter((p) => /ZERO tests/.test(p)).length, rosterCounts(roster).unit, "every dispatched file is named");
});

test("a passed file whose own counts carry failures, or whose counts are missing, is malformed", () => {
  const withFailures = recordAll(fresh(), { dispatchTiers: ["unit"] });
  const target = withFailures.files.find((f) => f.dispatch === "ran");
  target.counts = { tests: 3, pass: 2, fail: 1, skipped: 0 };
  const { problems } = reconcile(withFailures);
  assert.ok(problems.some((p) => /contradictory counts/.test(p)), problems.join(" | "));

  const noCounts = recordAll(fresh(), { dispatchTiers: ["unit"] });
  noCounts.files.find((f) => f.dispatch === "ran").counts = null;
  assert.ok(reconcile(noCounts).problems.some((p) => /malformed marker/.test(p)));
});

test("an omitted or skipped file without a reason is refused: no unexplained gaps", () => {
  const manifest = recordAll(fresh());
  manifest.files.find((f) => f.dispatch === "omitted").reason = null;
  const { ok, problems } = reconcile(manifest);
  assert.equal(ok, false);
  assert.ok(problems.some((p) => /no reason/.test(p)), problems.join(" | "));

  assert.throws(() => recordFile(fresh(), { path: roster[0].path, dispatch: "skipped", selection: "changed" }), (e) => /needs a reason/.test(e.message));
});

test("a record with NO selection reason is refused, and an unknown one is named: the aggregator never invents 'changed'", () => {
  // `entry.selection ?? "changed"` was the fail-open: in a fast gate almost the whole roster is omitted, so
  // a missing reason silently asserted that every classified file had been changed directly — a scope claim
  // the manifest's own `changed` list contradicted. There is no default now; there is a refusal.
  assert.throws(
    () => recordFile(fresh(), passed({ path: roster[0].path, selection: undefined })),
    (e) => e instanceof ManifestRefusal && /no selection reason/.test(e.message),
  );
  assert.throws(() => recordFile(fresh(), passed({ path: roster[0].path, selection: "because" })), (e) => /unknown selection 'because'/.test(e.message));
  // …and the fourth reason exists precisely so an omitted file has an honest value: not selected at all.
  const manifest = fresh();
  recordFile(manifest, omitted({ path: roster[0].path }));
  recordFile(manifest, passed({ path: roster[1].path, selection: "dependency" }));
  assert.deepEqual(
    manifest.files.map((f) => f.selection),
    ["not-selected", "dependency"],
    "omitted is not-selected; a dependency-selected dispatch is dependency; neither is called changed",
  );
});

test("a SKIPPED file reconciles when it carries its reason, and is counted as skipped rather than passed", () => {
  // The schema has three dispatch states for a reason: `skipped` is a decision by a caller (a tier that
  // chose not to run a file), and it is only legitimate WITH its reason. It must not be folded into
  // `passed`, and it must not be counted as coverage a reader could quote.
  const manifest = fresh();
  const skippedPath = roster.find((r) => r.tier === "server").path;
  for (const entry of roster) {
    if (entry.tier === "unit") recordFile(manifest, passed({ path: entry.path }));
    else if (entry.path === skippedPath) recordFile(manifest, { path: entry.path, dispatch: "skipped", reason: "skipped by the caller: the tier is holding the box for a measured reason", selection: "not-selected" });
    else recordFile(manifest, omitted({ path: entry.path }));
  }
  finalizeManifest(manifest);
  assert.equal(manifest.reconciled, true);
  assert.equal(manifest.summary.skipped, 1);
  assert.equal(manifest.summary.passed, rosterCounts(roster).unit);
  assert.equal(manifest.summary.dispatched + manifest.summary.omitted + manifest.summary.skipped, roster.length);
  assert.equal(manifest.files.find((f) => f.path === skippedPath).status, "skipped", "a skipped file is never counted as passed");
});

test("finalizeManifest stamps the summary and REFUSES (throws) when anything is unaccounted for", () => {
  const manifest = recordAll(fresh());
  manifest.files.pop();
  assert.throws(() => finalizeManifest(manifest), (e) => e instanceof ManifestRefusal && e.problems.length > 0);
  assert.equal(manifest.reconciled, false);
  assert.ok(manifest.problems.length > 0);
  assert.ok(manifest.summary.problems > 0);

  const ok = recordAll(fresh());
  finalizeManifest(ok);
  assert.equal(ok.reconciled, true);
  assert.equal(ok.summary.problems, 0);
});

test("a FULL gate may not omit a classified file: the omission is the scope claim it cannot make", () => {
  const manifest = recordAll(createManifest({ gate: "full", tree: "c".repeat(40), classified }));
  const { ok, problems } = reconcile(manifest);
  assert.equal(ok, false);
  assert.ok(problems.some((p) => /no omitted scope/.test(p)), problems.join(" | "));
  assert.throws(() => finalizeManifest(manifest), (e) => e instanceof ManifestRefusal);
});

test("a changed source that maps to no test is refused as an unmapped path, in the artifact too", () => {
  const manifest = recordAll(fresh({ unmapped: ["lib/ghost.mjs"] }));
  const { ok, problems, summary } = reconcile(manifest);
  assert.equal(ok, false);
  assert.ok(problems.some((p) => /lib\/ghost\.mjs changed and maps to no test file/.test(p)));
  assert.equal(summary.unmapped, 1);
});

test("the artifact is keyed by tree SHA and gate kind, and written atomically", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "voicebox-manifest-"));
  try {
    const manifest = finalizeManifest(recordAll(fresh()));
    const written = writeManifest(manifest, dir);
    assert.equal(written, manifestPath(dir, manifest.tree, manifest.gate));
    assert.match(written, /\.fast\.manifest\.json$/);
    const read = readManifest(written);
    assert.equal(read.classifier.roster, manifest.classifier.roster, "the classifier identity survives the round trip");
    assert.equal(read.summary.classified, manifest.summary.classified);

    // A FULL gate dispatches the whole roster: it has no omitted scope, which is why the reconciler
    // refuses an omission here at all (see the case below).
    const full = finalizeManifest(
      recordAll(createManifest({ gate: "full", tree: manifest.tree, classified }), { dispatchTiers: ["unit", "server", "browser"] }),
    );
    const fullPath = writeManifest(full, dir);
    assert.notEqual(fullPath, written, "a full gate's manifest is not the fast gate's, even on one tree");
    assert.match(fullPath, /\.full\.manifest\.json$/);
    assert.ok(GATES.every((g) => readFileSync(manifestPath(dir, manifest.tree, g), "utf8").length > 0));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the emitted markers are the hub's vocabulary, matched with the hub's own patterns", () => {
  // The patterns are quoted from remote/check-coverage.py (the extractor fleet-check uses). They are
  // anchored at line start and the prefix is REQUIRED: a nearly-right marker reads as no marker.
  const dispatch = ["tests/a.test.mjs", "tests/b.test.mjs"];
  const running = emitMarker("running", dispatch);
  const passedLines = dispatch.map((f) => emitMarker("passed", [f]));
  const failed = emitMarker("failed", ["tests/c.test.mjs"]);
  const unmapped = emitMarker("unmapped", ["lib/thing.mjs"]);
  const unknown = emitMarker("unknown", ["3 file(s) had no terminal status"]);

  assert.equal(HUB_MARKER_PATTERNS.suites.exec(running)[1], dispatch.join(" "));
  for (const line of passedLines) assert.ok(HUB_MARKER_PATTERNS.suites.test(line), line);
  assert.equal(HUB_MARKER_PATTERNS.suites.exec(failed)[1], "tests/c.test.mjs");
  assert.equal(HUB_MARKER_PATTERNS.unmapped.exec(unmapped)[1], "lib/thing.mjs");
  assert.equal(HUB_MARKER_PATTERNS.unknown.test(unknown), true);

  // A marker must be at line start with nothing in front of it, and must carry its prefix.
  for (const line of [running, ...passedLines, failed, unmapped, unknown]) {
    assert.ok(line.startsWith("fast-gate: "), `${line} carries the prefix`);
    assert.ok(HUB_MARKER_PATTERNS.suites.test(line) || HUB_MARKER_PATTERNS.unmapped.test(line) || HUB_MARKER_PATTERNS.unknown.test(line));
  }
  assert.equal(HUB_MARKER_PATTERNS.suites.test("[gate] fast-gate: passed: x"), false, "a prefixed line is not a marker");

  // Every terminal status the manifest can record is spellable as a marker, so the log and the artifact
  // cannot drift: an extractor that only ever hears `passed` would over-claim a skipped file.
  for (const status of STATUS) assert.ok(emitMarker(status, ["tests/x.test.mjs"]).length > 0);
  assert.ok(HUB_MARKER_PATTERNS.suites.test(emitMarker("completed", ["tests/x.test.mjs"])));
});

test("a gate child is a TOP-LEVEL test run: NODE_TEST_CONTEXT is dropped and nothing else is touched", () => {
  // A nested `node --test` child is skipped by the runtime ("node:test run() is being called recursively
  // within a test file"), exits 0 and prints no summary — a file that never ran, reported as unknown.
  const env = testChildEnv({ NODE_TEST_CONTEXT: "child-v8", PATH: "/usr/bin", VOICEBOX_INSTANCE: "x" });
  assert.equal("NODE_TEST_CONTEXT" in env, false);
  assert.equal(env.PATH, "/usr/bin", "no other variable is dropped");
  assert.equal(env.VOICEBOX_INSTANCE, "x", "the fixtures' own instance env still reaches the child");
  assert.equal("NODE_TEST_CONTEXT" in process.env, "NODE_TEST_CONTEXT" in process.env, "the parent env object is not mutated");
});

test("TAP counts are read from the reporter's own summary, and an absent summary is -1, not 0", () => {
  const tap = "TAP version 13\nok 1 - thing\n1..1\n# tests 1\n# pass 1\n# fail 0\n# skipped 0\n";
  assert.deepEqual(tapCounts(tap), { tests: 1, pass: 1, fail: 0, skipped: 0 });
  assert.deepEqual(tapCounts("TAP version 13\n"), { tests: -1, pass: -1, fail: -1, skipped: -1 });
  // A file that printed only its own test names (a reporter that never ended) is not a zero-test run:
  // -1 stays -1 so the manifest can tell "reported nothing" from "reported zero".
  assert.equal(tapCounts("# Subtest: x\nok 1 - x\n").tests, -1);
});

test("a tier record folds into the one manifest: a tier never writes a manifest of its own", () => {
  const manifest = createManifest({ gate: "fast", tree: "d".repeat(40), classified });
  const unit = roster.filter((r) => r.tier === "unit");
  const record = {
    tier: "browser",
    files: unit.map((r, i) => ({ path: r.path, status: i === 0 ? "failed" : "passed", counts: { tests: 1, pass: i === 0 ? 0 : 1, fail: i === 0 ? 1 : 0, skipped: 0 }, secs: 0.25, timeout_ms: 300000 })),
  };
  recordTier(manifest, record);
  assert.equal(manifest.files.length, unit.length);
  assert.equal(manifest.files[0].selection, "full-roster", "a tier record does not claim a changed-path selection");
  for (const entry of roster.filter((r) => r.tier !== "unit")) recordFile(manifest, omitted({ path: entry.path }));
  const { ok, problems } = reconcile(manifest);
  assert.equal(ok, true, problems.join(" | "));
  assert.equal(manifest.files.find((f) => f.status === "failed").counts.fail, 1, "a failure WITH counts is a well-formed record");
  // The tier's own status vocabulary lands in the manifest unchanged, so a killed browser file is
  // `unknown` in the artifact and not a quiet pass.
  const second = createManifest({ gate: "fast", tree: "d".repeat(40), classified });
  recordTier(second, { tier: "browser", files: [{ path: roster[0].path, status: "unknown", counts: null, secs: 0.1 }] });
  const unknownRecord = second.files[0];
  assert.equal(unknownRecord.status, "unknown");
  assert.equal(unknownRecord.counts, null);
});

// ═══════════ the full gate's receipt: many tier records, ONE manifest ═══════════
// The tiers are separate processes (a unit tier, a server pool, and the browser runner phased into its
// parallel and isolated invocations), so no single runner can assert the lane. This fold is what can, and
// the cases below are the ones that matter to a landing: a dropped file, a file claimed twice, and the
// omission rule for a gate that is deliberately narrower than the roster.

/** Two tier records whose union is the whole roster, split the way the live tier is actually phased. */
function tierRecordsFor(roster) {
  const unit = [], server = [], parallel = [], isolated = [];
  for (const entry of roster) {
    const line = { path: entry.path, status: "passed", counts: { tests: 4, pass: 4, fail: 0, skipped: 0 }, timeout_ms: 300000, secs: 1.2 };
    if (entry.tier === "unit") unit.push(line);
    else if (entry.tier === "server") server.push(line);
    else (ISOLATED_NAMES.has(entry.path) ? isolated : parallel).push(line);
  }
  return [
    { tier: "unit", files: unit },
    { tier: "server", files: server },
    { tier: "browser", phase: "parallel", files: parallel },
    { tier: "browser", phase: "isolated", files: isolated },
  ];
}
const ISOLATED_NAMES = new Set(["tests/pre-push.test.mjs", "tests/ldxa-barge-in-browser.test.mjs"]);

test("aggregate: the tier records fold into one reconciled manifest over the whole roster", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "voicebox-aggregate-"));
  try {
    const records = tierRecordsFor(roster);
    const dirOf = path.join(dir, "records");
    mkdirSync(dirOf, { recursive: true });
    const paths = records.map((r, i) => {
      const p = path.join(dirOf, `tier-${i}.json`);
      writeFileSync(p, JSON.stringify(r));
      return p;
    });
    const out = path.join(dir, "out");
    const res = spawnSync(
      process.execPath,
      [path.join(root, "scripts/gate-manifest.mjs"), "aggregate", "--gate", "full", "--tree", "f".repeat(40), "--out", out, ...paths.flatMap((p) => ["--record", p])],
      { cwd: root, encoding: "utf8" },
    );
    assert.equal(res.status, 0, res.stdout + res.stderr);
    const manifest = JSON.parse(readFileSync(path.join(out, `${"f".repeat(40)}.full.manifest.json`), "utf8"));
    assert.equal(manifest.reconciled, true);
    assert.equal(manifest.verdict, "pass");
    assert.equal(manifest.summary.classified, roster.length);
    assert.equal(manifest.summary.dispatched, roster.length);
    assert.equal(manifest.summary.omitted, 0, "a full gate omits nothing");
    assert.equal(manifest.problems.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("aggregate: a tier that drops a file is refused as MISSING, and one claimed twice as DUPLICATE", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "voicebox-aggregate-bad-"));
  try {
    const write = (records, name) => {
      const p = path.join(dir, name);
      writeFileSync(p, JSON.stringify(records));
      return p;
    };
    const dropped = tierRecordsFor(roster);
    const victim = dropped.find((r) => r.tier === "browser" && r.phase === "parallel").files.pop();
    const { manifest, written } = manifestFromTierRecords({
      gate: "full",
      tree: "0".repeat(40),
      classified,
      records: dropped,
      dir: path.join(dir, "out-dropped"),
    });
    assert.equal(manifest.reconciled, false);
    assert.ok(manifest.problems.some((p) => p.includes(victim.path) && /missing/.test(p)), manifest.problems.join(" | "));
    assert.equal(manifest.verdict, "refused");
    assert.ok(written, "a refused aggregate still writes its evidence");

    const twice = tierRecordsFor(roster);
    twice.push({ tier: "browser", phase: "parallel", files: [twice[2].files[0]] });
    const duplicate = manifestFromTierRecords({ gate: "full", tree: "0".repeat(40), classified, records: twice, dir: null });
    assert.equal(duplicate.manifest.reconciled, false);
    assert.ok(duplicate.manifest.problems.some((p) => /recorded twice|duplicate/.test(p)), duplicate.manifest.problems.join(" | "));
    assert.equal(duplicate.manifest.verdict, "refused");

    // And the CLI turns a non-reconciling aggregate into a non-zero exit, not a warning.
    const p2 = write(twice, "twice.json");
    const res = spawnSync(process.execPath, [path.join(root, "scripts/gate-manifest.mjs"), "aggregate", "--gate", "full", "--tree", "0".repeat(40), "--out", path.join(dir, "out-twice"), "--record", p2], { cwd: root, encoding: "utf8" });
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /REFUSED/);
    rmSync(p2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("aggregate: a narrower gate may account for what it did not run, BY NAME, and never by silence", () => {
  const records = tierRecordsFor(roster).filter((r) => r.tier === "unit");
  const silent = manifestFromTierRecords({ gate: "fast", tree: "1".repeat(40), classified, records, dir: null });
  assert.equal(silent.manifest.reconciled, false, "silence about the rest of the roster is not a receipt");

  const named = manifestFromTierRecords({ gate: "fast", tree: "1".repeat(40), classified, records, omittedReason: "fast-only: not selected by the changed-path map", dir: null });
  assert.equal(named.manifest.reconciled, true, named.manifest.problems.join(" | "));
  assert.equal(named.manifest.summary.omitted, roster.length - records[0].files.length);
  assert.ok(named.manifest.files.filter((f) => f.dispatch === "omitted").every((f) => /fast-only/.test(f.reason)));
});

test("verdictOf is the ONE answer to 'what does this manifest mean' — an unfinished file is never a pass", () => {
  const pass = recordAll(fresh());
  pass.summary = reconcile(pass).summary;
  pass.reconciled = true;
  assert.equal(verdictOf(pass), "pass");

  for (const status of ["failed", "timeout", "unknown"]) {
    const m = fresh();
    const victim = roster.find((r) => r.tier === "unit");
    for (const entry of roster) {
      if (entry.path === victim.path) recordFile(m, { path: entry.path, dispatch: "ran", status, counts: status === "unknown" ? null : { tests: 1, pass: 0, fail: 1, skipped: 0 }, secs: 0.4, selection: "changed" });
      else if (entry.tier === "unit") recordFile(m, passed({ path: entry.path }));
      else recordFile(m, omitted({ path: entry.path }));
    }
    m.summary = reconcile(m).summary;
    m.reconciled = true;
    assert.equal(verdictOf(m), "fail", `${status} must not read as a pass`);

    const unfinished = { ...m, reconciled: false };
    assert.equal(verdictOf(unfinished), "refused", "a manifest that does not reconcile is refused, not failed");
  }

  const empty = fresh();
  for (const entry of roster) recordFile(empty, omitted({ path: entry.path }));
  empty.summary = reconcile(empty).summary;
  empty.reconciled = true;
  assert.equal(verdictOf(empty), "empty", "nothing dispatched is never a pass");
});

// ── THE BOX THE GATE RAN ON (voicebox-beads-zjpm.6) ──────────────────────────────────────────────
// Before this, a manifest held per-file durations and nothing about the machine they were measured on, so
// "this file is flaky" and "this box was at loadavg 27" were the same artifact — and the only way to tell
// them apart was to re-run the suite, which docs/12-pre-gate refuses. These arms are about the ABSENCE and
// the MALFORMED case as much as the happy one: a missing block on a v2 artifact, a reading that is a string,
// and a per-file window with one end missing must each be refused by name.
test("a manifest says which box it measured: cores, load, and the moment it was read", () => {
  const manifest = fresh();
  assert.equal(MANIFEST_VERSION, 3, "v3 is the shape that carries the host block AND the condition arms — bump this deliberately, never by accident");
  assert.ok(Number.isInteger(manifest.host.cpus) && manifest.host.cpus > 0, "the box's CPUs are recorded");
  assert.ok(Number.isInteger(manifest.host.available_parallelism) && manifest.host.available_parallelism > 0, "and how many a runner may use");
  assert.ok(Number.isFinite(Date.parse(manifest.host.sampled_at)), "and when it was read");
  assert.ok(manifest.host.loadavg_1m.before === null || manifest.host.loadavg_1m.before >= 0, "the reading at the start is a reading or an honest null");
  assert.equal(manifest.host.loadavg_1m.max, null, "a run that has not finished has not been measured — null, not zero");
  assert.equal(manifest.host.loadavg_1m.after, null, "the closing reading does not exist until the run closes");

  const sealed = recordAll(fresh());
  finalizeManifest(sealed, { finishedAt: new Date().toISOString() });
  const load = sealed.host.loadavg_1m;
  assert.ok(load.after === null || load.after >= 0, "the closing reading is taken when the manifest is sealed");
  const readings = [load.before, load.after].filter((n) => Number.isFinite(n));
  assert.equal(load.max, readings.length ? Math.max(...readings) : null, "max is the highest reading kept, and null when nothing was measured");
});

test("max keeps a spike that happened mid-run, and an unmeasured box stays null rather than 0", () => {
  const manifest = fresh();
  const browser = roster.find((r) => r.tier === "browser");
  for (const entry of roster) {
    if (entry.path === browser.path) recordFile(manifest, passed({ path: entry.path, loadavg_1m: { start: 27.82, end: 3.1 } }));
    else recordFile(manifest, omitted({ path: entry.path }));
  }
  finalizeManifest(manifest);
  assert.equal(manifest.files.find((f) => f.path === browser.path).loadavg_1m.start, 27.82, "the file's own window survives into the manifest");
  assert.equal(manifest.host.loadavg_1m.max, 27.82, "a spike inside one file is not averaged away by the run's own ends");

  // A unit-tier file carries no window at all: `null` says it was not measured there, which is a different
  // fact from a box that was idle — and a reader must be able to tell them apart.
  const unit = roster.find((r) => r.tier === "unit");
  assert.equal(manifest.files.find((f) => f.path === unit.path).loadavg_1m, null, "a tier that publishes no window records an absence, not a zero");
});

test("the host block is refused when it is missing on a v2 artifact or malformed, and read as its own shape on v1", () => {
  const missing = recordAll(fresh());
  delete missing.host;
  const problems = reconcile(missing).problems;
  assert.ok(
    problems.some((p) => p.includes("carries no host block")),
    `a v2 manifest with no host block is refused by name: ${problems.join(" | ")}`,
  );

  // v1 artifacts predate the field: `verify` reads the checks directory's history, so an old manifest is
  // audited as the shape it declared rather than turned into a refusal by a field it never claimed.
  const older = recordAll(fresh());
  older.version = 1;
  delete older.host;
  assert.equal(reconcile(older).ok, true, "a v1 manifest is still reconciled as v1");

  const malformed = recordAll(fresh());
  malformed.host.loadavg_1m.before = "27";
  assert.ok(
    reconcile(malformed).problems.some((p) => p.includes("host.loadavg_1m.before")),
    "a reading that is a string is refused, because it looks like evidence and is not",
  );

  assert.throws(
    () => recordFile(fresh(), passed({ path: roster.find((r) => r.tier === "browser").path, loadavg_1m: { start: "12.4" } })),
    (error) => error instanceof ManifestRefusal && /loadavg_1m\.start/.test(error.message),
    "a per-file window with a string reading is refused at the moment it is recorded",
  );
  assert.throws(
    () => recordFile(fresh(), passed({ path: roster.find((r) => r.tier === "browser").path, loadavg_1m: { start: 1 } })),
    (error) => error instanceof ManifestRefusal && /missing 'end'/.test(error.message),
    "and a window with one end is refused: both ends are the evidence",
  );
});

// ── THE THREE ARMS A BROWSER FILE CAN BE RUN UNDER (voicebox-beads-zjpm.5.2) ─────────────────────
// Before this, a file that failed only under load left a timeout and nothing else, so the question "does it
// fail ALONE?" was answered by re-running it on a quiet box — the thing docs/12 refuses. These arms hold the
// check itself: what each arm must carry, what the sealer derives from the arms together, and the states that
// must be REFUSED rather than printed, above all a stated `disagreement: false` beside an arm nobody measured.
const arm = (condition, over = {}) => ({
  condition,
  status: "passed",
  secs: 12.5,
  loadavg_1m: { start: 1.2, end: 1.4 },
  worker_count: 4,
  command: `node --test tests/measured.test.mjs #${condition}`,
  ...over,
});
const browserOf = () => roster.find((r) => r.tier === "browser").path;
/** A fast gate in which the one browser file was condition-checked and everything else is accounted for. */
function conditioned(arms, over = {}) {
  const manifest = fresh();
  for (const entry of roster) {
    if (entry.path === browserOf()) recordFile(manifest, passed({ path: entry.path, conditions: arms, ...over }));
    else if (entry.tier === "browser") recordFile(manifest, omitted({ path: entry.path }));
    else recordFile(manifest, passed({ path: entry.path }));
  }
  return manifest;
}
const verdictOfArms = (arms, over = {}) => {
  const manifest = conditioned(arms, over);
  finalizeManifest(manifest);
  const record = manifest.files.find((f) => f.path === browserOf());
  return { manifest, record, problems: reconcile(manifest).problems };
};

test("the sealer derives what the three arms say, and the arms DESCRIBE rather than decide", () => {
  const allPass = verdictOfArms([arm("standalone"), arm("heavy_slot", { holder: "gate:merger" }), arm("shard_concurrency")]);
  assert.deepEqual(allPass.record.condition_verdict, { pattern: "all_agree", disagreement: false, agrees_with_shard: true }, "three passing arms agree");
  assert.equal(verdictOf(allPass.manifest), "pass", "and the arms never turn a passing file red — the file's own status decides");

  const aloneOnly = verdictOfArms([arm("standalone", { status: "failed", counts: { tests: 3, pass: 2, fail: 1, skipped: 0 } }), arm("heavy_slot", { holder: "gate:merger" }), arm("shard_concurrency")]);
  assert.deepEqual(aloneOnly.record.condition_verdict, { pattern: "standalone_only_fails", disagreement: true, agrees_with_shard: false }, "a file that fails alone and passes under concurrency says so, and does NOT agree with the shard arm");

  const shardOnly = verdictOfArms([arm("standalone"), arm("heavy_slot", { holder: "gate:merger" }), arm("shard_concurrency", { status: "failed", counts: { tests: 3, pass: 2, fail: 1, skipped: 0 } })]);
  assert.deepEqual(shardOnly.record.condition_verdict, { pattern: "concurrency_only_fails", disagreement: true, agrees_with_shard: false }, "the shard arm failing alone is the load-sensitive case, and it names itself");

  const slotOnly = verdictOfArms([arm("standalone"), arm("heavy_slot", { holder: "gate:merger", status: "failed", counts: { tests: 3, pass: 2, fail: 1, skipped: 0 } }), arm("shard_concurrency")]);
  assert.equal(slotOnly.record.condition_verdict.pattern, "heavy_slot_only_fails", "and the heavy-slot arm failing alone is its own answer, not a shard verdict");
  assert.equal(slotOnly.record.condition_verdict.agrees_with_shard, true, "standalone and shard still agree with each other there, which is the fact that separates the two load stories");

  const twoFail = verdictOfArms([arm("standalone", { status: "failed", counts: { tests: 3, pass: 2, fail: 1, skipped: 0 } }), arm("heavy_slot", { holder: "gate:merger", status: "failed", counts: { tests: 3, pass: 2, fail: 1, skipped: 0 } }), arm("shard_concurrency")]);
  assert.equal(twoFail.record.condition_verdict.pattern, "mixed", "two arms failing is not a load story, it is a mixed one, and it is not flattened into either");

  // AN UNMEASURED ARM IS NOT AGREEMENT: `incomplete` with both other fields null, so nothing downstream can
  // read a comparison that was never made. It is also not a FAILURE — the file's own status is still the
  // verdict, which is why this is a shape and not a red.
  const unmeasured = verdictOfArms([arm("standalone"), arm("heavy_slot", { holder: "gate:merger" }), arm("shard_concurrency", { status: "unknown", secs: null, reason: "the shard child was lost with its exit" })]);
  assert.deepEqual(unmeasured.record.condition_verdict, { pattern: "incomplete", disagreement: null, agrees_with_shard: null }, "an arm that could not be measured leaves an incomplete answer with nulls, never `all_agree` and never `disagreement: false`");
  assert.equal(verdictOf(unmeasured.manifest), "pass", "and an incomplete comparison does not by itself fail a file whose own run passed");
});

test("the arms are refused by name when they could not support a comparison, and a STATED verdict is checked against them", () => {
  const refuse = (arms, why, over = {}) => assert.throws(
    () => conditioned(arms, over),
    (error) => error instanceof ManifestRefusal && (Array.isArray(why) ? why : [why]).every((w) => error.message.includes(w)),
    `expected a refusal naming ${JSON.stringify(why)}`,
  );
  const three = () => [arm("standalone"), arm("heavy_slot", { holder: "gate:merger" }), arm("shard_concurrency")];

  refuse([arm("standalone"), arm("heavy_slot", { holder: "gate:merger" }), arm("rolling_shard")], "unknown condition", "rolling_shard");
  refuse([arm("standalone"), arm("standalone"), arm("shard_concurrency")], ["named twice", "missing the 'heavy_slot' arm"], "standalone");
  refuse([arm("standalone"), arm("heavy_slot", { holder: "gate:merger" })], "is not a check", "2 arm(s)");
  refuse([arm("standalone"), arm("heavy_slot", { holder: "gate:merger" }), arm("shard_concurrency", { burners: 6 })], "unexpected burners", "burners");
  refuse([arm("standalone"), arm("heavy_slot"), arm("shard_concurrency")], "must name the holder", "heavy_slot");
  refuse([arm("standalone"), arm("heavy_slot", { holder: "gate:merger" }), arm("shard_concurrency", { status: "skipped", secs: null, reason: undefined })], "with no reason", "skipped");
  refuse([arm("standalone"), arm("heavy_slot", { holder: "gate:merger" }), arm("shard_concurrency", { status: "unknown", secs: null, reason: undefined })], "with no reason", "unknown");
  refuse([arm("standalone"), arm("heavy_slot", { holder: "gate:merger" }), arm("shard_concurrency", { loadavg_1m: { start: "1.2", end: 1.4 } })], "loadavg_1m.start", "1.2");
  refuse([arm("standalone"), arm("heavy_slot", { holder: "gate:merger" }), arm("shard_concurrency", { worker_count: 0 })], "worker_count", "positive integer");
  refuse([arm("standalone"), arm("heavy_slot", { holder: "gate:merger" }), arm("shard_concurrency", { command: "  " })], "must carry the command", "command");
  // A skipped arm needs NO duration — it did not run, so there is nothing to time — but it does need its reason.
  const skipped = verdictOfArms([arm("standalone"), arm("heavy_slot", { holder: "gate:merger" }), arm("shard_concurrency", { status: "skipped", secs: null, reason: "the heavy slot was held by another landing" })]);
  assert.equal(skipped.record.condition_verdict.pattern, "incomplete", "a skipped arm with a reason is recorded and makes the answer incomplete, not refused");

  // ARMS ARE DISPATCHED WORK: a file that was omitted cannot have been run under any condition.
  assert.throws(
    () => recordFile(fresh(), { ...omitted({ path: browserOf() }), conditions: three() }),
    (error) => error instanceof ManifestRefusal && /cannot carry a condition check/.test(error.message),
    "conditions on a record that did not run are refused",
  );
  // And the same fact is caught again when a manifest arrives by another route, because recordFile is not the
  // only door into a record.
  const smuggled = conditioned(three());
  smuggled.files.find((f) => f.path === browserOf()).dispatch = "omitted";
  assert.ok(
    reconcile(smuggled).problems.some((p) => p.includes("conditions on a non-ran record")),
    "reconcile refuses arms on a record that did not run, whatever path built it",
  );

  // THE ONE THE WHOLE FIELD EXISTS FOR: a runner may not assert agreement it did not measure. The derived
  // answer beside an unmeasured arm is `incomplete` with nulls, so anything stated must match THAT.
  assert.throws(
    () => conditioned(
      [arm("standalone"), arm("heavy_slot", { holder: "gate:merger" }), arm("shard_concurrency", { status: "unknown", secs: null, reason: "lost child" })],
      { condition_verdict: { pattern: "all_agree", disagreement: false, agrees_with_shard: true } },
    ),
    (error) => error instanceof ManifestRefusal && /the sealer derives this block, nobody states it/.test(error.message),
    "a stated disagreement:false beside an arm nobody measured is refused by name",
  );
  // A stated verdict that MATCHES the arms is accepted, so a producer that computes it correctly is not punished.
  const statedRight = verdictOfArms(three(), { condition_verdict: { pattern: "all_agree", disagreement: false, agrees_with_shard: true } });
  assert.equal(statedRight.record.condition_verdict.pattern, "all_agree", "a stated verdict that agrees with the arms is carried through");
});

// ── THE FAILING ARM MUST BE NAMED (voicebox-beads-a8a2) ──────────────────────────────────────────
// The unit tier now records which arm failed; this is the half that REFUSES to let a failed file arrive
// without it, so the next lane reads the arm's name instead of paying for a re-run on a box it no longer has.
// Deliberately narrow, and each of the narrowings below is an arm: version-gated on the evidence's own shape,
// required only for a real assertion failure, and never for a crash or a kill, which have no arm to name.
test("a failed file whose evidence names no arm is refused, and the narrowings are each held", () => {
  const evidence = (over = {}) => ({ version: 2, test: null, excerpts: ["    not ok 1 - the arm that failed\n"] , ...over });
  const failed = (over = {}) => ({ path: roster.find((r) => r.tier === "unit").path, dispatch: "ran", status: "failed", counts: { tests: 3, pass: 2, fail: 1, skipped: 0 }, secs: 1.5, selection: "changed", failure_evidence: evidence(), ...over });
  const refuses = (over, why) => assert.throws(
    () => recordFile(fresh(), failed(over)),
    (error) => error instanceof ManifestRefusal && error.message.includes(why),
    `expected a refusal naming ${why}`,
  );

  refuses({}, "names no failing arm");
  refuses({ failure_evidence: { version: 2, excerpts: [] } }, "carries no 'test' key");
  refuses({ failure_evidence: evidence({ test: "   " }) }, "names no failing arm");

  // HELD: a named arm is accepted, and the name survives into the sealed manifest.
  const named = fresh();
  for (const entry of roster) {
    if (entry.path === roster.find((r) => r.tier === "unit").path) recordFile(named, failed({ failure_evidence: evidence({ test: "the arm that failed" }) }));
    else recordFile(named, passed({ path: entry.path }));
  }
  finalizeManifest(named);
  assert.equal(named.files.find((f) => f.status === "failed").failure_evidence.test, "the arm that failed", "the arm's name is in the artifact");

  // v1 evidence predates the field: audited as the shape it declared rather than refused for not claiming it.
  const legacy = fresh();
  recordFile(legacy, failed({ failure_evidence: { version: 1, excerpts: ["not ok 1 - old shape"] } }));
  assert.equal(reconcile(legacy).problems.some((p) => p.includes("names no failing arm")), false, "a v1 evidence record is not refused for a field its shape never had");

  // A CRASH OR A KILL HAS NO ARM TO NAME — its bounded tail is the name, and requiring one would make an
  // honest crash look malformed.
  for (const status of ["timeout", "unknown"]) {
    const crash = fresh();
    recordFile(crash, failed({ status, counts: status === "timeout" ? { tests: -1, pass: -1, fail: -1, skipped: -1 } : null, failure_evidence: evidence() }));
    assert.equal(reconcile(crash).problems.some((p) => p.includes("names no failing arm")), false, `a ${status} record is not required to name an arm`);
  }

  // AND NOT WHERE NO FAILURE WAS COUNTED (coord's third guard): contradictory counts are already refused as
  // contradictory, and this refusal must not be the second voice saying so about a file with fail: 0.
  const zeroFail = fresh();
  recordFile(zeroFail, failed({ failure_evidence: evidence(), counts: { tests: 3, pass: 3, fail: 0, skipped: 0 } }));
  assert.equal(reconcile(zeroFail).problems.some((p) => p.includes("names no failing arm")), false, "fail: 0 is not a counted failure, so no arm name is demanded");

  // A PASSING file carries no such requirement either: the field only ever had to answer for a failure.
  const green = fresh();
  recordFile(green, passed({ path: roster.find((r) => r.tier === "unit").path, failure_evidence: evidence() }));
  assert.equal(reconcile(green).problems.some((p) => p.includes("names no failing arm")), false, "a passed record with evidence is not asked to name an arm");
});


test("a browser tier record's load windows survive the fold into a manifest", () => {
  const manifest = fresh();
  const browser = roster.filter((r) => r.tier === "browser").slice(0, 2);
  for (const entry of roster) {
    if (browser.some((b) => b.path === entry.path)) continue;
    recordFile(manifest, omitted({ path: entry.path }));
  }
  recordTier(manifest, {
    tier: "browser",
    files: browser.map((entry, i) => ({ path: entry.path, status: "passed", counts: { tests: 1, pass: 1, fail: 0, skipped: 0 }, secs: 2 + i, loadavg_1m: { start: 4.5 + i, end: 9.5 + i } })),
  });
  const folded = manifest.files.filter((f) => browser.some((b) => b.path === f.path));
  assert.deepEqual(folded.map((f) => f.loadavg_1m), browser.map((_, i) => ({ start: 4.5 + i, end: 9.5 + i })), "what the runner read is what the manifest holds");
  finalizeManifest(manifest);
  // THE ASSERTION IS A RELATIONSHIP, NEVER A NUMBER: what the box's own load was while this test ran is not
  // something a test may assert (docs/speed.md names machine-state assertions as a defect that turns someone
  // else's change red), so the peak is checked against the manifest's OWN readings plus the injected window.
  const load = manifest.host.loadavg_1m;
  const expected = Math.max(...[load.before, load.after, 10.5].filter((n) => Number.isFinite(n)));
  assert.equal(load.max, expected, "the peak includes the per-file windows as well as the run's own ends");
  assert.ok(load.max >= 10.5, "a window read mid-file is never averaged away by ends taken on an idle box");
});
