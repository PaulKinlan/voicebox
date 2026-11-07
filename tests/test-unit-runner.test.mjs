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
import { planUnitRuns, runUnitLane } from "../scripts/test-unit.mjs";
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
    console.log = (...args) => { printed.push(args.join(" ")); };
    let failed;
    try {
      failed = await runUnitLane(
        ["tests/held.test.mjs", "tests/peer.test.mjs", "tests/red.test.mjs"],
        { cwd: scratch, isolated: new Set(["tests/held.test.mjs"]) },
      );
    } finally {
      console.log = originalLog;
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
