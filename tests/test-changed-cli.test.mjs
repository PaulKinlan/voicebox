// tests/test-changed-cli.test.mjs — the scoped runner's ANSWER-ONLY surface (voicebox-beads-afsx, from p9bf/zjpm.3).
//
// WHY THIS FILE EXISTS SEPARATELY FROM tests/test-changed-gate.test.mjs. They were one file, and it took 484s wall /
// 499s CPU on the fleet VM (load 5-6): eight Node startups, each re-deriving the lane roster (scripts/test-lanes.mjs
// classify() reads and parses all 271 test files), plus two probes that dispatch a REAL test file. The unit tier's
// per-file budget is 120s, so one slow dispatch could kill the whole file — including the fourteen assertions here
// that never needed a dispatch at all. The gate's own probes now live in the gate file, where a dispatch is what
// that file is FOR, and every answer-only CLI probe in this file runs inside ONE child process instead of four.
//
// Everything here answers without acting: usage, refusals before selection, --dry-run/--json shapes, `--` parsing,
// and the pure mapping helpers. No test in this file dispatches a suite or writes a manifest.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mapToTests, checkStaticRelevance, partitionTests, getBaseRef } from "../scripts/test-changed.mjs";
import { BATCHED_PROBE_BOUND_MS, CLI_PROBE_BOUND_MS, GATE_PROBE_BOUND_MS, assertProbeTerminated } from "./lib/probe-bounds.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const SCRIPT = path.join(root, "scripts/test-changed.mjs");

/**
 * THE ANSWER-ONLY PROBES, IN ONE CHILD (voicebox-beads-afsx). Four CLI startups each re-derived the lane roster
 * (~25s under load), and none of them needed anything but an answer. This writes ONE probe that imports the CLI
 * once and calls the SAME main() for every invocation, capturing each call's stdout/stderr/status, and returns the
 * parsed results. The no-child-process preload still applies: an answer-only path that spawns has to fail here.
 */
function answerOnlyCli(cases) {
  const scratch = mkdtempSync(path.join(os.tmpdir(), "voicebox-test-changed-answers-"));
  const marker = path.join(scratch, "spawn-attempted");
  const preload = path.join(scratch, "no-spawn.cjs");
  const probe = path.join(scratch, "answers.mjs");
  writeFileSync(preload, [
    "const child = require('node:child_process');",
    "const fs = require('node:fs');",
    "for (const method of ['execFileSync', 'spawnSync', 'spawn']) {",
    "  child[method] = () => { fs.writeFileSync(" + JSON.stringify(marker) + ", method); throw new Error('child process forbidden by CLI test'); };",
    "}",
    "require('node:module').syncBuiltinESMExports();",
  ].join("\n"));
  writeFileSync(probe, [
    "import { main } from " + JSON.stringify(pathToFileURL(SCRIPT).href) + ";",
    "const write = process.stdout.write.bind(process.stdout);",
    "const answers = [];",
    "for (const args of " + JSON.stringify(cases) + ") {",
    "  let stdout = '', stderr = '';",
    "  const realOut = process.stdout.write, realErr = process.stderr.write;",
    "  process.stdout.write = (chunk) => { stdout += String(chunk); return true; };",
    "  process.stderr.write = (chunk) => { stderr += String(chunk); return true; };",
    "  process.argv = [process.execPath, 'answers.mjs', ...args];",
    "  let status;",
    "  try { status = await main(); } catch (error) { status = 'THREW:' + (error && error.message ? error.message : String(error)); }",
    "  process.stdout.write = realOut;",
    "  process.stderr.write = realErr;",
    "  answers.push({ args, status, stdout, stderr });",
    "}",
    "write('ANSWERS ' + JSON.stringify(answers) + '\\n');",
  ].join("\n"));
  try {
    const startedAt = Date.now();
    const result = spawnSync(process.execPath, [probe], {
      cwd: root, encoding: "utf8", timeout: BATCHED_PROBE_BOUND_MS,
      env: { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --require=${preload}`.trim() },
    });
    result.elapsedMs = Date.now() - startedAt;
    assertProbeTerminated(result, "the batched answer-only CLI probe", BATCHED_PROBE_BOUND_MS);
    assert.equal(existsSync(marker), false, "an answer-only CLI path must not launch Git, a test, or another child process");
    const line = result.stdout.split("\n").find((l) => l.startsWith("ANSWERS "));
    assert.ok(line, `the batched probe must report its answers: ${result.stdout}\n${result.stderr}`);
    return JSON.parse(line.slice("ANSWERS ".length));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// The message is a diagnostic, so it is worth asserting rather than trusting: the default names the CLI bound and an
// explicit bound names itself. Without the `boundMs` parameter in ./lib/probe-bounds.mjs the second case reports
// 60000 and this fails.
test("the probe bound a timeout is reported against is the bound the probe ran under (voicebox-beads-03w5)", () => {
  const timedOut = { error: { code: "ETIMEDOUT" }, elapsedMs: 60_100 };
  assert.throws(
    () => assertProbeTerminated(timedOut, "a CLI probe"),
    /against a 60000ms bound/,
    "the CLI probe's default bound is 60s",
  );
  assert.throws(
    () => assertProbeTerminated(timedOut, "the gate-mode CLI probe", GATE_PROBE_BOUND_MS),
    /against a 300000ms bound/,
    "the gate probe must name ITS bound, not the CLI's",
  );
  // The split gave the answer-only probes their own bound (voicebox-beads-afsx); it must name itself too, or a
  // timeout here reads as a 60s CLI answer that overran when it was a 120s batch that never returned.
  assert.throws(
    () => assertProbeTerminated(timedOut, "the batched answer-only CLI probe", BATCHED_PROBE_BOUND_MS),
    /against a 120000ms bound/,
    "the batched probe must name ITS bound",
  );
  // A probe that terminated is not this helper's business; it must not throw.
  assertProbeTerminated({ error: undefined }, "a probe that finished");
});

const unmappedPath = path.join("lib", "unmapped_" + "source_module.mjs");

// EVERY ANSWER-ONLY INVOCATION IN ONE CHILD (voicebox-beads-afsx). One roster derivation (~25s under load) instead of
// four, and no invocation here dispatches a suite or writes a manifest — the preload would fail the probe if one tried.
const invalid = [
  ["--gat", "tests/test-changed-cli.test.mjs"],
  ["--gate", "--gtae", "tests/test-changed-cli.test.mjs"],
  ["--help", "--gtae"],
  ["-x", "tests/test-changed-cli.test.mjs"],
  ["--base", "--dry-run", "tests/test-changed-cli.test.mjs"],
  ["--gate-kind", "--gate", "tests/test-changed-cli.test.mjs"],
  ["--manifest-dir"],
  ["--base=HEAD", "--dry-run"],
  ["--gate-kind", "full"],
  ["--json", "--gate"],
];
// No case passes `--manifest-dir`: the CLI refuses it without `--gate`, and an answer-only path writes no artifact at
// all (that is what the --dry-run and --json assertions check).
const answers = answerOnlyCli([
  ["--help", "tests/test-changed-cli.test.mjs"],
  ...invalid,
  [unmappedPath],
  ["--allow-unmapped", "--dry-run", unmappedPath],
  ["--dry-run", "lib/commands.mjs"],
  ["--json", "lib/state-dirs.mjs"],
  ["--json", "--", "--gate"],
]);
const answer = (index) => answers[index];

test("CLI --help prints usage without computing scope, spawning children or writing manifests", () => {
  const result = answer(0);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /^Usage: node scripts\/test-changed\.mjs/);
  assert.equal(result.stderr, "");
});

test("CLI refuses unknown flags and malformed values before any selection or gate dispatch", () => {
  const results = invalid.map((_, index) => answer(index + 1));
  assert.deepEqual(results.map((r) => r.status), invalid.map(() => 2), "every invalid invocation must fail closed");
  const stderr = results.map((r) => r.stderr).join("");
  assert.match(stderr, /\[test:changed\] REFUSED: unknown-option --gat/);
  assert.match(stderr, /\[test:changed\] REFUSED: missing-option-value --base/);
  assert.doesNotMatch(results.map((r) => r.stdout).join(""), /ALL SCOPED TESTS GREEN|gate=fast/);
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

test("getBaseRef: resolves valid git base ref", () => {
  const base = getBaseRef();
  assert.ok(typeof base === "string" && base.length > 0);
});

test("CLI: unmapped source files refuse with unmapped-source-file and exit 1 (voicebox-beads-p9bf F1)", () => {
  assert.equal(mapToTests([unmappedPath]).length, 0, "unmapped file must map to zero tests");

  const refused = answer(invalid.length + 1);
  assert.equal(refused.status, 1, "must exit 1 on unmapped source file");
  assert.match(refused.stderr, /\[test:changed\] REFUSED: unmapped-source-file/);
  assert.match(refused.stderr, /unmapped_source_module\.mjs/);

  // Passing --allow-unmapped permits running despite unmapped source:
  const allowed = answer(invalid.length + 2);
  assert.equal(allowed.status, 0);
  assert.match(allowed.stdout, /\[test:changed\] Detected 1 changed file\(s\):/);
});

test("CLI --dry-run: reports mapped tests and exits 0 without running suites", () => {
  const out = answer(invalid.length + 3).stdout;
  assert.match(out, /\[test:changed\] Detected 1 changed file\(s\):/);
  assert.match(out, /· lib\/commands\.mjs/);
  assert.match(out, /Mapped to \d+ test file\(s\) across lanes:/);
  assert.match(out, /commands\.test\.mjs/);
  assert.match(out, /--dry-run: skipping test execution\./);
});

test("CLI --json: outputs structured mapping payload", () => {
  const payload = answer(invalid.length + 4);
  assert.equal(payload.status, 0, payload.stderr);
  const data = JSON.parse(payload.stdout);
  assert.deepEqual(data.changed, ["lib/state-dirs.mjs"]);
  assert.ok(data.tests.includes("single-owner.test.mjs"));
  assert.equal(data.static.singleOwner, true);
  assert.equal(data.static.docsCheck, false);
  assert.ok(Array.isArray(data.lanes.unit));
});

test("CLI -- ends option parsing: a flag-shaped changed path cannot secretly enable the gate", () => {
  // --json returns before test dispatch even if the sentinel parser regresses; the assertion
  // then catches the accidental --gate interpretation without launching any suite.
  const payload = answer(invalid.length + 5);
  assert.equal(payload.status, 0, payload.stderr);
  const data = JSON.parse(payload.stdout);
  assert.deepEqual(data.changed, ["--gate"]);
});
