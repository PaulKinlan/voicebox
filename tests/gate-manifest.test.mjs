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
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  GATES,
  HUB_MARKER_PATTERNS,
  ManifestRefusal,
  STATUS,
  TIERS,
  createManifest,
  emitMarker,
  finalizeManifest,
  manifestPath,
  readManifest,
  reconcile,
  recordFile,
  recordTier,
  rosterCounts,
  rosterHash,
  rosterOf,
  tapCounts,
  writeManifest,
} from "../scripts/gate-manifest.mjs";
import { classify } from "../scripts/test-lanes.mjs";

const classified = classify();
const roster = rosterOf(classified);

const fresh = (overrides = {}) =>
  createManifest({ gate: "fast", tree: "a".repeat(40), sha: "abc1234", classified, ...overrides });

/** A record that reconciles: dispatched, passed, with real counts. */
const passed = (entry) => ({ dispatch: "ran", status: "passed", counts: { tests: 3, pass: 3, fail: 0, skipped: 0 }, secs: 1.5, ...entry });
const omitted = (entry) => ({ dispatch: "omitted", status: "omitted", reason: "fast-only: not selected by the changed-path map", ...entry });

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

  assert.throws(() => recordFile(fresh(), { path: roster[0].path, dispatch: "ran", status: "running" }), (e) => /terminal status/.test(e.message));
  assert.throws(() => recordFile(fresh(), { path: roster[0].path, dispatch: "ran", status: "passed" }), (e) => /lost child/.test(e.message));
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

  assert.throws(() => recordFile(fresh(), { path: roster[0].path, dispatch: "skipped" }), (e) => /needs a reason/.test(e.message));
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
