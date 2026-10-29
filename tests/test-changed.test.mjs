// tests/test-changed.test.mjs — verify scoped test runner for inner-loop development (voicebox-beads-p9bf)
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mapToTests, checkStaticRelevance, partitionTests, getBaseRef, runGate } from "../scripts/test-changed.mjs";
import { buildQueue, ISOLATED, TIER_WORKERS } from "../scripts/test-shards.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const SCRIPT = path.join(root, "scripts/test-changed.mjs");

// Fail-closed CLI probes run under a disposable no-child-process preload. Even the old broken
// parser cannot launch a test gate: a Git/test spawn records a marker and throws before launch.
function noSpawnCli(args) {
  const scratch = mkdtempSync(path.join(os.tmpdir(), "voicebox-test-changed-cli-"));
  const marker = path.join(scratch, "spawn-attempted");
  const preload = path.join(scratch, "no-spawn.cjs");
  const manifest = path.join(scratch, "manifest");
  writeFileSync(preload, `
    const child = require('node:child_process');
    const fs = require('node:fs');
    for (const method of ['execFileSync', 'spawnSync', 'spawn']) {
      child[method] = () => { fs.writeFileSync(${JSON.stringify(marker)}, method); throw new Error('child process forbidden by CLI test'); };
    }
    require('node:module').syncBuiltinESMExports();
  `);
  try {
    const batch = Array.isArray(args[0]);
    const probe = path.join(scratch, "probe.mjs");
    if (batch) {
      // Import the CLI once and call the SAME main() for each invalid shape. Seven fresh Node
      // startups/import rosters here used to add seconds to every future unit-gate landing.
      writeFileSync(probe, `
        import { main } from ${JSON.stringify(pathToFileURL(SCRIPT).href)};
        for (const args of ${JSON.stringify(args)}) {
          process.argv = [process.execPath, 'probe.mjs', ...args, '--manifest-dir', ${JSON.stringify(manifest)}];
          console.log('CLI_RESULT', await main());
        }
      `);
    }
    const cliArgs = batch ? [probe] : [SCRIPT, ...args, "--manifest-dir", manifest];
    const result = spawnSync(process.execPath, cliArgs, {
      // A HANG DETECTOR, NOT A SPEED ASSERTION (voicebox-beads-i9k0, 2026-10-28): this bound was 8000
      // and it was the only thing standing between the unit tier and green. classify() lexes all 271
      // test files and measures 10.9s on this VM, so every real CLI invocation here - even one that maps
      // zero test files - spends more than 8s inside the child. Raising it to 30000 keeps the purpose
      // (a wedged CLI is still caught, and the assertions still prove no child was spawned and no
      // manifest written) without failing a healthy lane on a slow box. Making classify() cheap is
      // tracked separately as the real perf fix.
      cwd: root, encoding: "utf8", timeout: 30000,
      env: { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --require=${preload}`.trim() },
    });
    assert.equal(result.error, undefined, "bounded CLI probe must terminate normally");
    assert.equal(existsSync(marker), false, "CLI must not launch Git, a test, or another child process");
    assert.equal(existsSync(manifest), false, "CLI must not write a gate artifact");
    return result;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

test("CLI --help prints usage without computing scope, spawning children or writing manifests", () => {
  const result = noSpawnCli(["--help", "tests/test-changed.test.mjs"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /^Usage: node scripts\/test-changed\.mjs/);
  assert.equal(result.stderr, "");
});

test("CLI refuses unknown flags and malformed values before any selection or gate dispatch", () => {
  const invalid = [
    ["--gat", "tests/test-changed.test.mjs"],
    ["--gate", "--gtae", "tests/test-changed.test.mjs"],
    ["--help", "--gtae"],
    ["-x", "tests/test-changed.test.mjs"],
    ["--base", "--dry-run", "tests/test-changed.test.mjs"],
    ["--gate-kind", "--gate", "tests/test-changed.test.mjs"],
    ["--manifest-dir"],
    ["--base=HEAD", "--dry-run"],
    ["--gate-kind", "full"],
    ["--json", "--gate"],
  ];
  const result = noSpawnCli(invalid);
  assert.equal(result.status, 0, `the disposable no-spawn probe must finish: ${result.stderr}`);
  assert.deepEqual([...result.stdout.matchAll(/CLI_RESULT (\d+)/g)].map((match) => Number(match[1])),
    invalid.map(() => 2), "every invalid invocation must fail closed");
  assert.match(result.stderr, /\[test:changed\] REFUSED: unknown-option --gat/);
  assert.match(result.stderr, /\[test:changed\] REFUSED: missing-option-value --base/);
  assert.doesNotMatch(result.stdout, /ALL SCOPED TESTS GREEN|gate=fast/);
});

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

test("mapToTests: route edits trigger targeted tests rather than entire server suites (voicebox-beads-ybwq)", () => {
  const doctorMapped = mapToTests(["lib/routes/doctor.mjs"]);
  assert.ok(doctorMapped.includes("doctor-route.test.mjs"), "must include direct doctor route unit test");
  assert.ok(doctorMapped.includes("server-lifecycle.test.mjs"), "must include bounded server smoke test");
  assert.ok(doctorMapped.length <= 5, `expected <= 5 targeted tests, got ${doctorMapped.length}`);

  const branchesMapped = mapToTests(["lib/routes/branches.mjs"]);
  assert.ok(branchesMapped.includes("branches-route.test.mjs"), "must include direct branches route unit test");
  assert.ok(branchesMapped.includes("server-lifecycle.test.mjs"), "must include bounded server smoke test");
  assert.ok(branchesMapped.length <= 5, `expected <= 5 targeted tests, got ${branchesMapped.length}`);

  // Untested route module maps to zero tests and is refused as unmapped (voicebox-beads-rpym)
  const unmappedRoute = "lib/routes/" + "untested_" + Date.now() + "_route.mjs";
  assert.equal(mapToTests([unmappedRoute]).length, 0, "untested route must not receive smoke-only mapping");

  // Non-exclusive route edit (e.g. Touching server.mjs too) triggers full transitive coverage
  const mixedMapped = mapToTests(["lib/routes/doctor.mjs", "server.mjs"]);
  assert.ok(mixedMapped.length >= 100, `expected >= 100 tests on server.mjs change, got ${mixedMapped.length}`);
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

test("CLI -- ends option parsing: a flag-shaped changed path cannot secretly enable the gate", () => {
  // --json returns before test dispatch even if the sentinel parser regresses; the assertion
  // then catches the accidental --gate interpretation without launching any suite.
  // 120s, not 30s (voicebox-beads-p2r9): --json still lexes every test file to classify it, which costs
  // 11-20s on an idle box and overran 30s inside the gate's unit tier at 7 workers (status null = SIGTERM
  // from this very timeout). The arm is about "--" ending option parsing, not about how fast the
  // classifier is, so the bound only has to be long enough to be a hang detector on a loaded box.
  const res = spawnSync(process.execPath, [SCRIPT, "--json", "--", "--gate"], { cwd: root, encoding: "utf8", timeout: 120000 });
  assert.equal(res.status, 0, res.stderr);
  const data = JSON.parse(res.stdout);
  assert.deepEqual(data.changed, ["--gate"]);
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
  // The rest of the roster is OMITTED, and an omitted file must not inherit a scope claim: it says
  // `not-selected`, not the aggregator's old default of `changed` (voicebox-beads-zjpm.3).
  const omittedRecord = outcome.manifest.files.find((f) => f.path === "tests/unselected.test.mjs");
  assert.equal(omittedRecord.dispatch, "omitted");
  assert.equal(omittedRecord.selection, "not-selected", "nothing selected this file, and the artifact says so");
  assert.deepEqual(
    [...new Set(outcome.manifest.files.map((f) => f.selection))].sort(),
    ["changed", "not-selected"],
    "every record states its own reason: the one changed test, and the one nothing selected",
  );
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

test("gate: route-scoped change records route_scoping in manifest and sets descriptive omitted reasons (voicebox-beads-ybwq)", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "voicebox-gate-route-"));
  const realLog = console.log;
  console.log = () => {};
  try {
    const outcome = await runGate({
      changedFiles: ["lib/routes/doctor.mjs"],
      matchedTests: ["doctor-route.test.mjs", "server-lifecycle.test.mjs"],
      partitioned: { unit: ["doctor-route.test.mjs"], server: ["server-lifecycle.test.mjs"], browser: [], unclassified: [] },
      classified: {
        unit: [{ file: "doctor-route.test.mjs", why: null }],
        server: [{ file: "server-lifecycle.test.mjs", why: null }, { file: "unselected.test.mjs", why: null }],
        browser: [],
      },
      gate: "fast",
      tree: "r".repeat(40),
      dir,
      runner: async (file) => result("passed", { file }),
    });

    assert.equal(outcome.code, 0);
    assert.ok(outcome.manifest.route_scoping);
    assert.deepEqual(outcome.manifest.route_scoping.routes, ["lib/routes/doctor.mjs"]);
    assert.deepEqual(outcome.manifest.route_scoping.smoke_tests, ["server-lifecycle.test.mjs"]);
  } finally {
    console.log = realLog;
    rmSync(dir, { recursive: true, force: true });
  }
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
    // A plan that recorded the whole roster as `changed` would be a scope claim inside the plan. The plan
    // keeps the selection reason it would have used, which is the thing a reader consults it for.
    assert.deepEqual(
      Object.fromEntries(outcome.manifest.files.map((f) => [f.path, f.selection])),
      { "tests/probe.test.mjs": "changed", "tests/unselected.test.mjs": "not-selected" },
      "the plan names what the changed-path map selected and what it did not",
    );
    // A dry run is NOT a verdict about the tree, and the artifact says so rather than lending its
    // zero-dispatch record a `pass` a later reader could quote.
    assert.equal(outcome.manifest.verdict, "dry-run");
  } finally {
    console.log = realLog;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("gate: every record states its OWN selection reason, and a dependency is not called changed", async () => {
  // Three reasons from one run: the changed test, a matched sibling the change did not touch, and a file
  // the changed-path map never picked. The aggregator's old `?? "changed"` default collapsed all three.
  const dir = mkdtempSync(path.join(os.tmpdir(), "voicebox-gate-sel-"));
  const realLog = console.log;
  console.log = () => {};
  try {
    const outcome = await runGate({
      changedFiles: ["tests/probe.test.mjs"],
      matchedTests: ["probe.test.mjs", "side.test.mjs"],
      partitioned: { unit: ["probe.test.mjs", "side.test.mjs"], server: [], browser: [], unclassified: [] },
      classified: { unit: [{ file: "probe.test.mjs", why: null }, { file: "side.test.mjs", why: null }, { file: "unselected.test.mjs", why: null }], server: [], browser: [] },
      gate: "fast",
      tree: "d".repeat(40),
      dir,
      runner: async (file) => result("passed", { file }),
    });
    const byPath = Object.fromEntries(outcome.manifest.files.map((f) => [f.path, f.selection]));
    assert.deepEqual(byPath, {
      "tests/probe.test.mjs": "changed",
      "tests/side.test.mjs": "dependency",
      "tests/unselected.test.mjs": "not-selected",
    });
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
    const res = spawnSync(process.execPath, [SCRIPT, "--gate", "--manifest-dir", dir, "tests/icon-sprite.test.mjs"], { cwd: root, encoding: "utf8" });
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.match(res.stdout, /^\[test:changed\] running tests\/icon-sprite\.test\.mjs$/m);
    assert.match(res.stdout, /^fast-gate: passed: tests\/icon-sprite\.test\.mjs$/m);
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

// ═══════════════ the gate's concurrency and its queue (voicebox-beads-buy8) ═══════════════
// The fast gate used to dispatch every tier at a hard-coded 2 files in flight — a number no tier runs at —
// and hand each tier's files to the workers in the order the changed-path map produced them (alphabetical).
// Measured on the fused.js scope (159 files, 2026-10-14): 2 workers cost 273s of wall clock where the tier's
// own concurrency costs 190s, and taking the pool's order from the browser tier's own queue took the
// modeled tier-serial total from 207.4s to 181.7s (longest-first ideal: 179.2s) against a 180s bound.
//
// Both are SCHEDULING facts, so these cases assert the schedule itself — how many files were in flight at
// once, in what order, and that the isolated files still ran alone — through the gate's own stub runner, so
// nothing is launched and the numbers come from this file's roster rather than from the box.

/** A synthetic roster in the classifier's own shape: { unit: ["a.test.mjs", …], server: […], browser: […] }. */
function synthetic(perTier) {
  const classified = { unit: [], server: [], browser: [] };
  for (const tier of ["unit", "server", "browser"]) {
    for (const file of perTier[tier] ?? []) classified[tier].push({ file, why: null });
  }
  return classified;
}

/** Drive the gate over a synthetic roster with a runner that RECORDS the schedule instead of running. */
async function driveSchedule(classified, { workers } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "voicebox-gate-sched-"));
  const tierOf = new Map();
  for (const tier of ["unit", "server", "browser"]) for (const { file } of classified[tier]) tierOf.set(file, tier);
  const files = [...tierOf.keys()];
  const events = [];                      // dispatch order, with how many OTHER files were in flight
  const dispatched = new Map();           // file -> how many times it was dispatched
  const peak = { unit: 0, server: 0, browser: 0 };
  const inFlight = { unit: 0, server: 0, browser: 0 };
  const realLog = console.log;
  const realErr = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    const outcome = await runGate({
      changedFiles: files.map((f) => `tests/${f}`),
      matchedTests: files,
      partitioned: { unit: classified.unit.map((e) => e.file), server: classified.server.map((e) => e.file), browser: classified.browser.map((e) => e.file), unclassified: [] },
      classified,
      gate: "fast",
      tree: "f".repeat(40),
      sha: "deadbee",
      dir,
      ...(workers === undefined ? {} : { workers }),
      runner: async (relPath) => {
        const file = relPath.replace(/^tests\//, "");
        const tier = tierOf.get(file);
        dispatched.set(file, (dispatched.get(file) ?? 0) + 1);
        events.push({ file, tier, withOthers: inFlight.unit + inFlight.server + inFlight.browser });
        inFlight[tier] += 1;
        peak[tier] = Math.max(peak[tier], inFlight[tier]);
        // Yield, so the schedule is the dispatcher's and not this stub's: every worker that can start has
        // started before any file here finishes.
        await new Promise((resolve) => setImmediate(resolve));
        inFlight[tier] -= 1;
        return { file: relPath, code: 0, signal: null, timedOut: false, counts: { tests: 1, pass: 1, fail: 0, skipped: 0 }, secs: 0.01, out: "" };
      },
    });
    return { outcome, events, dispatched, peak };
  } finally {
    console.log = realLog;
    console.error = realErr;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("gate: each tier is dispatched at the concurrency THAT tier runs at, from the one owner (voicebox-beads-buy8)", async () => {
  const classified = synthetic({
    unit: Array.from({ length: 8 }, (_, i) => `u${i + 1}.test.mjs`),
    server: Array.from({ length: 6 }, (_, i) => `s${i + 1}.test.mjs`),
    browser: Array.from({ length: 6 }, (_, i) => `b${i + 1}.test.mjs`),
  });
  const before = process.env.VOICEBOX_FAST_WORKERS;
  delete process.env.VOICEBOX_FAST_WORKERS; // this case is about the DEFAULT, so the override must not be in the air
  try {
    const { outcome, peak } = await driveSchedule(classified);
    assert.equal(outcome.code, 0, "the stub runner passes every file, so the schedule is the only question");
    for (const tier of ["unit", "server", "browser"]) {
      const n = classified[tier].length;
      assert.equal(
        peak[tier],
        Math.min(TIER_WORKERS[tier], n),
        `${tier} must run at TIER_WORKERS.${tier} (${TIER_WORKERS[tier]}) in flight, capped by its ${n} file(s) — not the 2 the gate used to hard-code`,
      );
    }
  } finally {
    if (before === undefined) delete process.env.VOICEBOX_FAST_WORKERS;
    else process.env.VOICEBOX_FAST_WORKERS = before;
  }
});

test("gate: VOICEBOX_FAST_WORKERS still overrides every tier, so a loaded box can run fewer (voicebox-beads-buy8)", async () => {
  const classified = synthetic({
    unit: Array.from({ length: 5 }, (_, i) => `u${i + 1}.test.mjs`),
    server: Array.from({ length: 5 }, (_, i) => `s${i + 1}.test.mjs`),
    browser: Array.from({ length: 5 }, (_, i) => `b${i + 1}.test.mjs`),
  });
  const before = process.env.VOICEBOX_FAST_WORKERS;
  process.env.VOICEBOX_FAST_WORKERS = "2";
  try {
    const { peak } = await driveSchedule(classified);
    for (const tier of ["unit", "server", "browser"]) assert.equal(peak[tier], 2, `${tier} must honour the documented override`);
  } finally {
    if (before === undefined) delete process.env.VOICEBOX_FAST_WORKERS;
    else process.env.VOICEBOX_FAST_WORKERS = before;
  }
});

test("gate: the parallel pool is dispatched in the browser tier's own heaviest-first queue, not the map's order (voicebox-beads-buy8)", async () => {
  // REAL file names, so the queue's byte weights are this tree's: the stub runner dispatches them and runs
  // none of them. The roster is chosen so byte order is NOT alphabetical — otherwise this case would pass
  // against the alphabetical order it replaced (mini-app-architecture is 92KB and voicebox 35KB, while
  // theme-browser sorts first at 9KB).
  const names = ["theme-browser.test.mjs", "settings-dialog.test.mjs", "mini-app-architecture.test.mjs", "voicebox.test.mjs"];
  const classified = synthetic({ browser: names });
  const { events } = await driveSchedule(classified);
  const queue = buildQueue(names.map((f) => `tests/${f}`), { cwd: root }).map((p) => p.replace(/^tests\//, ""));
  assert.notDeepEqual(queue, [...names].sort(), "the fixture is a roster whose byte order is not alphabetical");
  assert.deepEqual(events.map((e) => e.file), queue, "the pool runs the tier's own queue, heaviest first");
});

test("gate: the isolated files still run ALONE, after the whole queue, exactly once (voicebox-beads-buy8)", async () => {
  const names = ["voicebox.test.mjs", "theme-browser.test.mjs", ...ISOLATED].map((f) => f.replace(/^tests\//, ""));
  const isolated = names.filter((f) => ISOLATED.has(`tests/${f}`));
  // THE REAL LIST, NOT A COUNT (voicebox-beads-i9k0). This asserted `isolated.length === 2`, which pinned the
  // membership as a side effect: adding a measured casualty to `scripts/test-shards.mjs` failed a unit test
  // whose subject is the SCHEDULE, not the roster. The fixture is built from `ISOLATED` itself, so the
  // property worth asserting is that the fixture covers every member and that the list is not empty.
  assert.ok(ISOLATED.size > 0, "the isolated list is non-empty, so this case is not vacuous");
  assert.equal(isolated.length, ISOLATED.size, "the fixture keeps every name in scripts/test-shards.mjs ISOLATED");
  const classified = synthetic({ browser: names });
  const { events, dispatched } = await driveSchedule(classified);
  const order = events.map((e) => e.file);
  for (const file of isolated) {
    const at = events.find((e) => e.file === file);
    assert.equal(at.withOthers, 0, `${file} must run with nothing else in flight — it measures the box`);
    assert.ok(order.indexOf(file) >= names.length - isolated.length, `${file} must run after the parallel queue`);
    assert.equal(dispatched.get(file), 1, `${file} runs exactly once, isolation is a schedule and not an omission`);
  }
  assert.equal(events.length, names.length, "every file in the lane is dispatched exactly once");
});
