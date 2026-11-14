// tests/test-unit-runner.test.mjs — the unit gate command now honours the repository's own rules
// (voicebox-beads-u32a; the marker half is the coverage gap that made every fast-gate verdict say UNKNOWN).
//
//   node --test tests/test-unit-runner.test.mjs
//
// `npm run test:unit` was `node --test $(scripts/test-lanes.mjs --lane unit)`: one flat concurrent pass. So a file
// named in ISOLATED ("run me alone") ran beside six siblings, and no `fast-gate:` marker ever reached the log the
// hub reads. Both are asserted here, against a disposable fixture repo rather than this one, because the runner's
// job is a shape and not a file list.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { planUnitRuns, runUnitLane, selectChangedLiveTests, runChangedLiveTests } from "../scripts/test-unit.mjs";
import { ISOLATED } from "../scripts/test-shards.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("the unit plan splits exactly the ISOLATED files out, and nothing else", () => {
  const files = ["tests/tasks-cancel.test.mjs", "tests/a.test.mjs", "tests/tasks-browser.test.mjs", "tests/b.test.mjs"];
  const { alone, together } = planUnitRuns(files, new Set(["tests/tasks-cancel.test.mjs", "tests/tasks-browser.test.mjs"]));
  assert.deepEqual(alone, ["tests/tasks-cancel.test.mjs", "tests/tasks-browser.test.mjs"]);
  assert.deepEqual(together, ["tests/a.test.mjs", "tests/b.test.mjs"]);
  // And the real list answers for the family this bead was filed on.
  for (const file of ["tests/tasks-cancel.test.mjs", "tests/task-outcome.test.mjs", "tests/task-redaction.test.mjs", "tests/tasks.test.mjs", "tests/tasks-progress.test.mjs"]) {
    assert.ok(ISOLATED.has(file), `${file} must be ISOLATED: its arms are what expires beside siblings`);
  }
});

test("an isolated file runs ALONE, and a failing file is marked and reported", async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "voicebox-test-unit-"));
  try {
    const tests = path.join(scratch, "tests");
    fs.mkdirSync(tests, { recursive: true });
    // The isolated file holds a witness file for 250ms; the concurrent file asserts the witness is ABSENT. If the
    // runner ever ran the isolated file beside its siblings, the sibling sees the witness and fails — so this is a
    // discriminating test of the isolation, not a restatement of the plan.
    fs.writeFileSync(path.join(tests, "held.test.mjs"), `
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
test("the isolated file owns the box while it runs", async () => {
  fs.writeFileSync(path.join(${JSON.stringify(scratch)}, "running"), "1");
  await new Promise((resolve) => setTimeout(resolve, 250));
  fs.rmSync(path.join(${JSON.stringify(scratch)}, "running"), { force: true });
});
`);
    fs.writeFileSync(path.join(tests, "peer.test.mjs"), `
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
test("no isolated sibling was running beside me", () => {
  assert.equal(fs.existsSync(path.join(${JSON.stringify(scratch)}, "running")), false, "an isolated file ran concurrently");
});
`);
    fs.writeFileSync(path.join(tests, "red.test.mjs"), `
import test from "node:test";
import assert from "node:assert/strict";
test("this one is red on purpose", () => { assert.equal(1, 2); });
`);
    const collected = [];
    const printed = [];
    const originalLog = console.log;
    // The fixtures are REAL test files, so their reporter output would otherwise land in this suite's own TAP
    // stream and read as this file failing. Swallow it: the marker lines below are what is under test.
    const originalWrite = process.stdout.write.bind(process.stdout);
    console.log = (...args) => { printed.push(args.join(" ")); };
    process.stdout.write = () => true;
    let failed;
    try {
      failed = await runUnitLane(
        ["tests/held.test.mjs", "tests/peer.test.mjs", "tests/red.test.mjs"],
        { cwd: scratch, isolated: new Set(["tests/held.test.mjs"]) },
      );
    } finally {
      console.log = originalLog;
      process.stdout.write = originalWrite;
    }
    collected.push(...printed);
    assert.equal(failed, 1, "exactly the red file counts as failed");
    const markers = collected.filter((line) => line.startsWith("fast-gate:"));
    assert.ok(markers.includes("fast-gate: passed: tests/held.test.mjs"), `missing held marker: ${markers.join(" | ")}`);
    assert.ok(markers.includes("fast-gate: passed: tests/peer.test.mjs"), `missing peer marker: ${markers.join(" | ")}`);
    assert.ok(markers.includes("fast-gate: failed: tests/red.test.mjs"), `a red file must be marked failed: ${markers.join(" | ")}`);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test("changed live tests are selected exactly once and an unknown changed test fails closed", () => {
  const classified = {
    unit: [{ file: "pure.test.mjs" }],
    live: [{ file: "server.test.mjs" }, { file: "browser.test.mjs" }],
  };
  assert.deepEqual(selectChangedLiveTests([
    "tests/pure.test.mjs", "tests/browser.test.mjs", "tests/server.test.mjs",
    "tests/browser.test.mjs", "tests/unclassified.test.mjs", "lib/other.mjs",
  ], classified), {
    selected: ["tests/browser.test.mjs", "tests/server.test.mjs"],
    unmapped: ["tests/unclassified.test.mjs"],
  });
  assert.deepEqual(selectChangedLiveTests(["tests/pure.test.mjs"], classified), { selected: [], unmapped: [] });
});

test("changed live test results emit per-file markers and refuse red or silent files", async () => {
  const marked = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (line) => { marked.push(String(line)); };
  console.error = (line) => { marked.push(String(line)); };
  const calls = [];
  try {
    const failed = await runChangedLiveTests(
      ["tests/green.test.mjs", "tests/red.test.mjs", "tests/silent.test.mjs"],
      {
        runFile: async (file, options) => { calls.push([file, options.timeoutMs]); return { file }; },
        statusOf: ({ file }) => file.includes("green") ? "passed" : file.includes("red") ? "failed" : "unknown",
        budgetMs: 250,
        now: () => 0,
      },
    );
    assert.equal(failed, 2);
    assert.deepEqual(calls, [["tests/green.test.mjs", 250], ["tests/red.test.mjs", 250], ["tests/silent.test.mjs", 250]]);
    assert.ok(marked.includes("fast-gate: passed: tests/green.test.mjs"));
    assert.ok(marked.includes("fast-gate: failed: tests/red.test.mjs"));
    assert.ok(marked.includes("fast-gate: unknown: tests/silent.test.mjs"));
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
});

test("a changed live file actually runs and its failing assertion blocks the gate", async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "voicebox-fast-live-"));
  const marker = path.join(scratch, "executed");
  const printed = [];
  const originalLog = console.log;
  const originalError = console.error;
  try {
    fs.mkdirSync(path.join(scratch, "tests"));
    fs.writeFileSync(path.join(scratch, "tests", "green.test.mjs"), `import test from 'node:test'; import fs from 'node:fs'; test('runs', () => fs.writeFileSync(${JSON.stringify(marker)}, 'yes'));`);
    fs.writeFileSync(path.join(scratch, "tests", "red.test.mjs"), `import test from 'node:test'; import assert from 'node:assert/strict'; test('red', () => assert.fail('real assertion'));`);
    const { runOneFile, statusOf } = await import("../scripts/test-changed.mjs");
    console.log = (line) => { printed.push(String(line)); };
    console.error = (line) => { printed.push(String(line)); };
    const failed = await runChangedLiveTests(["tests/green.test.mjs", "tests/red.test.mjs"], {
      runFile: (file, options) => runOneFile(file, { ...options, cwd: scratch }), statusOf,
      budgetMs: 5000,
    });
    assert.equal(failed, 1);
    assert.equal(fs.readFileSync(marker, "utf8"), "yes", "the child ran its body, not just the selector");
    assert.ok(printed.includes("fast-gate: passed: tests/green.test.mjs"));
    assert.ok(printed.includes("fast-gate: failed: tests/red.test.mjs"));
  } finally {
    console.log = originalLog;
    console.error = originalError;
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test("changed live test budget refuses unrun files instead of reporting a green gate", async () => {
  const markers = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (line) => { markers.push(String(line)); };
  console.error = (line) => { markers.push(String(line)); };
  let calls = 0;
  try {
    const failed = await runChangedLiveTests(["tests/slow.test.mjs", "tests/unrun.test.mjs"], {
      budgetMs: 100,
      now: () => ++calls === 1 ? 0 : 101,
      runFile: async () => { throw new Error("a file beyond the budget must never start"); },
      statusOf: () => "passed",
    });
    assert.equal(failed, 2);
    assert.ok(markers.includes("fast-gate: unknown: tests/slow.test.mjs"));
    assert.ok(markers.includes("fast-gate: unknown: tests/unrun.test.mjs"));
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
});

test("the markers this runner prints are the ones the hub's extractor reads", async () => {
  const { HUB_MARKER_PATTERNS } = await import("../scripts/gate-manifest.mjs");
  const { emitMarker } = await import("../scripts/gate-manifest.mjs");
  for (const kind of ["passed", "failed"]) {
    const line = emitMarker(kind, ["tests/example.test.mjs"]);
    assert.match(line, HUB_MARKER_PATTERNS.suites, `the hub cannot read this marker: ${line}`);
    assert.match(line, /tests\/example\.test\.mjs/);
  }
  // And the runner prints one per file: the shape is asserted by the source, because a real run of the whole unit
  // lane inside the unit lane is not something this file may do.
  const source = fs.readFileSync(path.join(REPO, "scripts", "test-unit.mjs"), "utf8");
  assert.match(source, /emitMarker\(state, \[result\.file\]\)/);
});
