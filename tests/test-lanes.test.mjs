// tests/test-lanes.test.mjs — the classification the gate now depends on
// (`voicebox-beads-6qu`).
//
// The gate runs two lanes because the suite's own file-concurrency caused the
// refusals: live tests (Chromium over CDP, or a server process of their own)
// failed inside the concurrent suite while passing alone and passing serial.
// A hand-kept list would rot the moment somebody adds a test, so the lanes are
// DERIVED from each file's code — and these cases hold the derivation, including
// its one real trap: a file that merely MENTIONS a browser in a comment is not a
// live test.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { classify } from "../scripts/test-lanes.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const run = (...args) => execFileSync(process.execPath, [path.join(root, "scripts/test-lanes.mjs"), ...args], { cwd: root, encoding: "utf8" });

test("every test file is in exactly one lane, and the known victims are LIVE", () => {
  const output = run("--check");
  assert.match(output, /\[lanes\] ok: \d+ unit, \d+ live/);
  const live = new Set(execFileSync(process.execPath, [path.join(root, "scripts/test-lanes.mjs"), "--lane", "live"], { cwd: root, encoding: "utf8" }).trim().split(/\s+/));
  for (const victim of [
    "tests/extension-approval-ui.test.mjs",
    "tests/environment-probe.test.mjs",
    "tests/pre-push.test.mjs",
    "tests/tasks-http.test.mjs",
  ]) {
    assert.ok(live.has(victim), `${victim} launches a browser or a server and must be in the live lane`);
  }
  // The lane that races must not contain the files that broke the gate.
  const unit = new Set(execFileSync(process.execPath, [path.join(root, "scripts/test-lanes.mjs"), "--lane", "unit"], { cwd: root, encoding: "utf8" }).trim().split(/\s+/));
  for (const victim of [
    "tests/extension-approval-ui.test.mjs",
    "tests/environment-probe.test.mjs",
    "tests/pre-push.test.mjs",
    "tests/tasks-http.test.mjs",
  ]) {
    assert.equal(unit.has(victim), false, `${victim} must not be in the concurrent lane`);
  }
});

test("classification reads CODE: a comment naming a browser does not make a live test", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "voicebox-lanes-"));
  try {
    writeFileSync(path.join(dir, "mentions.test.mjs"), `// this one talks about tests/lib/cdp.mjs and a server.mjs but launches nothing\nimport test from "node:test";\ntest("unit", () => {});\n`);
    writeFileSync(path.join(dir, "launches.test.mjs"), `import { launch } from "./lib/cdp.mjs";\n`);
    writeFileSync(path.join(dir, "fixture.cjs"), `// not a test file: the classifier only reads *.test.mjs\n`);
    const { unit, live } = classify(dir);
    assert.deepEqual(unit.map(({ file }) => file), ["mentions.test.mjs"]);
    assert.deepEqual(live.map(({ file }) => file), ["launches.test.mjs"]);
    assert.equal(live[0].why, "a browser over CDP", "the reason is named, so a misclassification can be argued with");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("classification detects browser/server helper launches: page-acceptance, task-fixture, and createServer are LIVE", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "voicebox-lanes-helpers-"));
  try {
    writeFileSync(path.join(dir, "prepush.test.mjs"), `// spawns page acceptance\nconst child = spawn(process.execPath, ['tools/page-acceptance.mjs']);\n`);
    writeFileSync(path.join(dir, "taskfix.test.mjs"), `import { taskFixture } from "./lib/task-fixture.mjs";\n`);
    writeFileSync(path.join(dir, "netserver.test.mjs"), `import { createServer } from "node:http";\n`);
    const { unit, live } = classify(dir);
    assert.deepEqual(unit, []);
    assert.equal(live.length, 3);
    assert.ok(live.some((l) => l.file === "prepush.test.mjs" && l.why.includes("page-acceptance")));
    assert.ok(live.some((l) => l.file === "taskfix.test.mjs" && l.why.includes("task-fixture")));
    assert.ok(live.some((l) => l.file === "netserver.test.mjs" && l.why.includes("createServer")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the lane scripts exist and swap out at the same files npm test runs", () => {
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  assert.match(pkg.scripts["test:unit"], /test-lanes\.mjs --lane unit/);
  assert.match(pkg.scripts["test:live"], /--test-concurrency=1/);
  assert.match(pkg.scripts["test:live"], /--lane live/);
  // `npm test` stays the whole suite for humans and CI: the split is the GATE's,
  // not a redefinition of what the repository's test command means.
  assert.equal(pkg.scripts.test, "node --test tests/*.mjs");
});
