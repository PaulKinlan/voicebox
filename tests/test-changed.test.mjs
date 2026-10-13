// tests/test-changed.test.mjs — verify scoped test runner for inner-loop development (voicebox-beads-p9bf)
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mapToTests, checkStaticRelevance, partitionTests, getBaseRef, runGate } from "../scripts/test-changed.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const SCRIPT = path.join(root, "scripts/test-changed.mjs");

test("mapToTests: direct test file changes map directly to themselves", () => {
  const mapped = mapToTests(["tests/commands.test.mjs"]);
  assert.deepEqual(mapped, ["commands.test.mjs"]);
});

test("mapToTests: library changes map to tests referencing the module or stem", () => {
  const mapped = mapToTests(["lib/commands.mjs"]);
  assert.ok(mapped.includes("commands.test.mjs"), "must include commands.test.mjs");
  assert.ok(mapped.length >= 1, "must map to at least one test");
});

test("mapToTests: wasm-shelf changes map to wasm shelf tests", () => {
  const mapped = mapToTests(["lib/wasm-shelf.mjs"]);
  assert.ok(mapped.includes("wasm-shelf.test.mjs"), "must include wasm-shelf.test.mjs");
});

test("mapToTests: maps internal module dependencies transitively (voicebox-beads-p9bf F1)", () => {
  const mappedWasmWorker = mapToTests(["lib/wasm-worker.mjs"]);
  assert.ok(mappedWasmWorker.includes("wasm-shelf.test.mjs"), "wasm-worker must map to wasm-shelf.test.mjs");

  const mappedMiniApp = mapToTests(["core/mini-app.ts"]);
  assert.ok(mappedMiniApp.includes("mini-app-architecture.test.mjs") || mappedMiniApp.includes("mini-app-ui.test.mjs"), "core/mini-app.ts must map to mini-app tests");
});

test("CLI: unmapped source files refuse with unmapped-source-file and exit 1 (voicebox-beads-p9bf F1)", () => {
  const unmappedName = "unmapped_" + "source_module.mjs";
  const unmappedPath = path.join("lib", unmappedName);
  assert.equal(mapToTests([unmappedPath]).length, 0, "unmapped file must map to zero tests");

  const res = spawnSync(process.execPath, [SCRIPT, unmappedPath], {
    cwd: root, encoding: "utf8",
  });
  assert.equal(res.status, 1, "must exit 1 on unmapped source file");
  assert.match(res.stderr, /\[test:changed\] REFUSED: unmapped-source-file/);
  assert.match(res.stderr, new RegExp(unmappedName));

  // Passing --allow-unmapped permits running despite unmapped source:
  const allowed = spawnSync(process.execPath, [SCRIPT, "--allow-unmapped", "--dry-run", unmappedPath], {
    cwd: root, encoding: "utf8",
  });
  assert.equal(allowed.status, 0);
  assert.match(allowed.stdout, /\[test:changed\] Detected 1 changed file\(s\):/);
});

test("checkStaticRelevance: flags state-dir changes for single-owner check", () => {
  const rel1 = checkStaticRelevance(["lib/state-dirs.mjs"]);
  assert.equal(rel1.singleOwner, true);
  assert.equal(rel1.docsCheck, false);

  const rel2 = checkStaticRelevance(["lib/commands.mjs"]);
  assert.equal(rel2.singleOwner, false);
  assert.equal(rel2.docsCheck, false);
});

test("checkStaticRelevance: flags markdown and docs changes for docs-check", () => {
  const rel = checkStaticRelevance(["README.md", "docs/07-architecture.md"]);
  assert.equal(rel.docsCheck, true);
  assert.equal(rel.docsTouched, true);
  assert.equal(rel.singleOwner, false);
});

test("partitionTests: partitions mapped tests into disjoint lanes", () => {
  const sampleTests = ["commands.test.mjs", "pre-push.test.mjs", "tasks-http.test.mjs"];
  const { unit, server, browser } = partitionTests(sampleTests);

  const all = [...unit, ...server, ...browser];
  assert.equal(new Set(all).size, all.length, "lanes must be disjoint");
  assert.ok(unit.includes("commands.test.mjs"), "commands.test.mjs is unit");
  assert.ok(browser.includes("pre-push.test.mjs"), "pre-push.test.mjs is browser");
});

test("CLI --dry-run: reports mapped tests and exits 0 without running suites", () => {
  const out = execFileSync(process.execPath, [SCRIPT, "--dry-run", "lib/commands.mjs"], {
    cwd: root, encoding: "utf8",
  });
  assert.match(out, /\[test:changed\] Detected 1 changed file\(s\):/);
  assert.match(out, /· lib\/commands\.mjs/);
  assert.match(out, /Mapped to \d+ test file\(s\) across lanes:/);
  assert.match(out, /commands\.test\.mjs/);
  assert.match(out, /--dry-run: skipping test execution\./);
});

test("CLI --json: outputs structured mapping payload", () => {
  const out = execFileSync(process.execPath, [SCRIPT, "--json", "lib/state-dirs.mjs"], {
    cwd: root, encoding: "utf8",
  });
  const data = JSON.parse(out);
  assert.deepEqual(data.changed, ["lib/state-dirs.mjs"]);
  assert.ok(data.tests.includes("single-owner.test.mjs"));
  assert.equal(data.static.singleOwner, true);
  assert.equal(data.static.docsCheck, false);
  assert.ok(Array.isArray(data.lanes.unit));
});

test("getBaseRef: resolves valid git base ref", () => {
  const base = getBaseRef();
  assert.ok(typeof base === "string" && base.length > 0);
});

// ═══════════════════ the GATE mode (voicebox-beads-zjpm.3) ═══════════════════
// The gate is driven in-process with a stubbed per-file runner, so these cases are about the gate's own
// accounting — what it refuses, what it records, what it emits — and never about a test file's behaviour.

/**
 * A two-entry synthetic roster: the gate's accounting is exercised without launching a real test file,
 * and the second entry is the file a run did NOT select — which is what a full gate must refuse to omit.
 */
const probeClassifier = { unit: [{ file: "probe.test.mjs", why: null }, { file: "unselected.test.mjs", why: null }], server: [], browser: [] };
const probePartition = { unit: ["probe.test.mjs"], server: [], browser: [], unclassified: [] };

const result = (status, extra = {}) => ({
  file: extra.file ?? "tests/probe.test.mjs",
  code: status === "passed" ? 0 : 1,
  signal: null,
  timedOut: status === "timeout",
  counts: status === "unknown" ? { tests: -1, pass: -1, fail: -1, skipped: -1 } : { tests: 2, pass: status === "passed" ? 2 : 1, fail: status === "failed" ? 1 : 0, skipped: 0 },
  secs: 0.5,
  out: status === "failed" ? "not ok 1 - something\n" : "",
  ...extra,
});

async function driveGate({ status = "passed", ...overrides } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "voicebox-gate-"));
  const lines = [];
  const realLog = console.log;
  const realErr = console.error;
  console.log = (...a) => lines.push(a.join(" "));
  console.error = (...a) => lines.push(a.join(" "));
  try {
    const outcome = await runGate({
      changedFiles: ["tests/probe.test.mjs"],
      matchedTests: ["probe.test.mjs"],
      partitioned: probePartition,
      classified: probeClassifier,
      gate: "fast",
      tree: "b".repeat(40),
      sha: "deadbee",
      dir,
      runner: async (file) => result(status, { file }),
      ...overrides,
    });
    return { outcome, lines, dir };
  } finally {
    console.log = realLog;
    console.error = realErr;
  }
}

test("gate: every dispatched file is recorded with its own status, counts and duration", async () => {
  const { outcome, dir } = await driveGate({ status: "passed" });
  assert.equal(outcome.code, 0);
  assert.equal(outcome.manifest.verdict, "pass");
  assert.equal(outcome.manifest.reconciled, true);
  const record = outcome.manifest.files.find((f) => f.path === "tests/probe.test.mjs");
  assert.equal(record.status, "passed");
  assert.equal(record.dispatch, "ran");
  assert.deepEqual(record.counts, { tests: 2, pass: 2, fail: 0, skipped: 0 });
  assert.equal(record.selection, "changed", "the changed file IS the test, so its selection is the change itself");
  assert.equal(outcome.manifest.tree, "b".repeat(40));
  assert.match(readFileSync(outcome.written, "utf8"), /"reconciled": true/);
  rmSync(dir, { recursive: true, force: true });
});

test("gate: a failing file refuses the gate, names it, and still writes the artifact", async () => {
  const { outcome, lines, dir } = await driveGate({ status: "failed" });
  assert.equal(outcome.code, 1);
  assert.equal(outcome.manifest.verdict, "fail");
  assert.equal(outcome.manifest.summary.failed, 1);
  assert.ok(lines.some((l) => /^fast-gate: failed: tests\/probe\.test\.mjs$/.test(l)), "the log names the failing file");
  assert.equal(lines.some((l) => /^fast-gate: running:/.test(l)), false, "no `running:` marker: the extractor reads it as coverage");
  assert.ok(!lines.some((l) => /ALL SCOPED TESTS GREEN/.test(l)), "a red run never prints the green line");
  assert.ok(readFileSync(outcome.written, "utf8").length > 0, "the artifact exists for the run that failed");
  rmSync(dir, { recursive: true, force: true });
});

test("gate: a file that never reported a terminal status is UNKNOWN, not a pass", async () => {
  const { outcome, lines, dir } = await driveGate({ status: "unknown" });
  assert.equal(outcome.code, 1);
  const record = outcome.manifest.files.find((f) => f.path === "tests/probe.test.mjs");
  assert.equal(record.status, "unknown");
  assert.equal(record.counts, null, "no summary means no counts, never a zero");
  assert.ok(lines.some((l) => /^fast-gate: unknown: tests\/probe\.test\.mjs/.test(l)), "the hub's coverage extraction must degrade to UNKNOWN");
  rmSync(dir, { recursive: true, force: true });
});

test("gate: a timeout is reported as a timeout, with the bound that killed it", async () => {
  const { outcome, dir } = await driveGate({ status: "timeout", timeoutMs: 5000 });
  assert.equal(outcome.code, 1);
  const record = outcome.manifest.files.find((f) => f.path === "tests/probe.test.mjs");
  assert.equal(record.status, "timeout");
  assert.equal(record.timeout_ms, 5000);
  rmSync(dir, { recursive: true, force: true });
});

test("gate: an unmapped changed source REFUSES, emits unmapped+unknown markers, and records the refusal", async () => {
  const { outcome, lines, dir } = await driveGate({ unmappedSources: ["lib/ghost.mjs"], matchedTests: [], partitioned: { unit: [], server: [], browser: [], unclassified: [] } });
  assert.equal(outcome.code, 1);
  assert.equal(outcome.manifest.verdict, "refused");
  assert.equal(outcome.manifest.reconciled, false);
  assert.deepEqual(outcome.manifest.unmapped, ["lib/ghost.mjs"]);
  assert.ok(lines.some((l) => /^fast-gate: unmapped: lib\/ghost\.mjs$/.test(l)));
  assert.ok(lines.some((l) => /^fast-gate: unknown: /.test(l)), "a refusal must not leave the hub reading the missing coverage as none");
  assert.ok(outcome.manifest.classifier.files.every((entry) => outcome.manifest.files.some((f) => f.path === entry.path && f.dispatch === "omitted")), "a refused run still accounts for the whole roster");
  rmSync(dir, { recursive: true, force: true });
});

test("gate: an unclassified mapped file REFUSES by name — no implicit unit fallback", async () => {
  const { outcome, lines, dir } = await driveGate({
    matchedTests: ["probe.test.mjs", "mystery.test.mjs"],
    partitioned: { unit: ["probe.test.mjs"], server: [], browser: [], unclassified: ["mystery.test.mjs"] },
  });
  assert.equal(outcome.code, 1);
  assert.ok(lines.some((l) => /mystery\.test\.mjs is mapped by a change but is in NO lane/.test(l)));
  assert.ok(lines.some((l) => /^fast-gate: unmapped: .*mystery\.test\.mjs/.test(l)));
  rmSync(dir, { recursive: true, force: true });
});

test("gate: a run that dispatched nothing is `empty`, never a pass", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "voicebox-gate-empty-"));
  const lines = [];
  const realLog = console.log;
  console.log = (...a) => lines.push(a.join(" "));
  try {
    const outcome = await runGate({
      changedFiles: [],
      matchedTests: [],
      partitioned: { unit: [], server: [], browser: [], unclassified: [] },
      classified: probeClassifier,
      gate: "fast",
      tree: "e".repeat(40),
      dir,
      runner: async () => {
        throw new Error("nothing should have been dispatched");
      },
    });
    assert.equal(outcome.code, 0, "an empty run is not a failure of the tree");
    assert.equal(outcome.manifest.verdict, "empty");
    assert.equal(outcome.manifest.summary.dispatched, 0);
    assert.ok(lines.some((l) => /EMPTY: 0 test files were dispatched/.test(l)));
    assert.ok(!lines.some((l) => /ALL SCOPED TESTS GREEN/.test(l)), "no green line for a run that measured nothing");
  } finally {
    console.log = realLog;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("gate: a full gate may not omit a classified file — the omission is the scope claim it cannot make", async () => {
  const { outcome, dir } = await driveGate({ gate: "full" });
  assert.equal(outcome.code, 1, "the full gate's own ruler refuses the omission it just made");
  assert.equal(outcome.manifest.reconciled, false);
  assert.ok(outcome.manifest.problems.some((p) => /no omitted scope/.test(p)), outcome.manifest.problems.join(" | "));
  rmSync(dir, { recursive: true, force: true });
});

test("gate: a fast gate omits the files it did not select, each by name and with its reason", async () => {
  const { outcome, dir } = await driveGate({ status: "passed" });
  const omitted = outcome.manifest.files.filter((f) => f.dispatch === "omitted");
  assert.equal(omitted.length, 1);
  assert.equal(omitted[0].path, "tests/unselected.test.mjs");
  assert.match(omitted[0].reason, /fast-only: not selected by the changed-path map/);
  assert.equal(outcome.manifest.summary.classified, 2, "the roster is recorded whole, not just the selection");
  rmSync(dir, { recursive: true, force: true });
});

test("gate: --dry-run writes the plan's manifest without dispatching anything", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "voicebox-gate-dry-"));
  const realLog = console.log;
  console.log = () => {};
  try {
    const outcome = await runGate({
      changedFiles: ["tests/probe.test.mjs"],
      matchedTests: ["probe.test.mjs"],
      partitioned: probePartition,
      classified: probeClassifier,
      gate: "fast",
      tree: "c".repeat(40),
      dir,
      dryRun: true,
      runner: async () => {
        throw new Error("a dry run must not dispatch");
      },
    });
    assert.equal(outcome.code, 0);
    assert.equal(outcome.manifest.summary.dispatched, 0);
    assert.equal(outcome.manifest.summary.omitted, 2);
    assert.ok(outcome.manifest.files.every((f) => /dry-run/.test(f.reason)));
    // A dry run is NOT a verdict about the tree, and the artifact says so rather than lending its
    // zero-dispatch record a `pass` a later reader could quote.
    assert.equal(outcome.manifest.verdict, "dry-run");
  } finally {
    console.log = realLog;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI gate: --allow-unmapped is refused outright, and the refusal names why", () => {
  const res = spawnSync(process.execPath, [SCRIPT, "--gate", "--allow-unmapped", "tests/gate-manifest.test.mjs"], { cwd: root, encoding: "utf8" });
  assert.equal(res.status, 2);
  assert.match(res.stderr, /--allow-unmapped is a developer escape and is not available to the gate/);
  assert.match(res.stderr, /a scope it can name and reconcile/);
});

test("CLI gate: a genuine changed test file dispatches, emits the hub's markers and writes a reconciled manifest", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "voicebox-gate-cli-"));
  try {
    const res = spawnSync(process.execPath, [SCRIPT, "--gate", "--manifest-dir", dir, "tests/gate-manifest.test.mjs"], { cwd: root, encoding: "utf8" });
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.match(res.stdout, /^\[test:changed\] running tests\/gate-manifest\.test\.mjs$/m);
    assert.match(res.stdout, /^fast-gate: passed: tests\/gate-manifest\.test\.mjs$/m);
    // `running:` is read as coverage by the hub's extractor and cannot be retracted by a killed process,
    // so the gate publishes terminal markers only.
    assert.equal(/^fast-gate: running:/m.test(res.stdout), false, "no coverage claim for a file a kill could interrupt");
    assert.match(res.stdout, /classified \d+, dispatched 1, omitted \d+, passed 1, failed 0/);
    assert.match(res.stdout, /ALL SCOPED TESTS GREEN/);
    const written = res.stdout.match(/manifest (\S+\.fast\.manifest\.json)/)[1];
    const manifest = JSON.parse(readFileSync(written, "utf8"));
    assert.equal(manifest.reconciled, true);
    assert.equal(manifest.summary.dispatched, 1);
    assert.equal(manifest.summary.problems, 0);
    assert.ok(manifest.classifier.counts.total >= 200, "the real roster is recorded, not just the selection");
    assert.ok(manifest.files.every((f) => f.dispatch === "ran" ? f.status === "passed" && f.secs > 0 : Boolean(f.reason)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
