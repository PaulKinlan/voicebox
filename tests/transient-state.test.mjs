// tests/transient-state.test.mjs — the checker for "wait on A, assert B" (voicebox-beads-zjpm.5.3).
//
// WHY THIS FILE IS MOSTLY NEGATIVE CONTROLS. The defect this catches is a SHAPE, not a line: a fixed delay
// immediately before an assertion on page state, where the delay says nothing about whether the asserted
// observable had arrived. But the same shape is CORRECT whenever the assertion is an absence, the delay is a
// poll interval, the delay is the page's own timeline, or the assertion observes nothing asynchronous. Three
// surface-form scans over the tiers produced 100 / 36 / 50 candidates and hand-reading cleared all but one,
// so a checker that flags the shape without those clauses would be red for the base — which is the failure
// this repository keeps finding. Every clause therefore gets an arm that proves it CLEARS, and one arm proves
// the checker still fails closed when nothing clears.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { classifyDelay } from "../scripts/transient-state.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const CHECKER = path.join(root, "scripts/transient-state.mjs");

/** Write one fixture test file and run the checker over just that file, as a reviewer would. */
function check(source) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "voicebox-transient-"));
  const file = path.join(dir, "fixture.test.mjs");
  writeFileSync(file, source);
  try {
    const res = spawnSync(process.execPath, [CHECKER, file], { cwd: root, encoding: "utf8", timeout: 60_000, killSignal: "SIGKILL" });
    return { code: res.status, out: `${res.stdout}${res.stderr}`, file };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** One delay, then one assertion — the shape under test, parameterised by both halves. */
const shape = ({ delay = "await sleep(300);", body = 'assert.equal(await page.evaluate(() => window.__state), "ready");', open = "", close = "" } = {}) =>
  `import test from "node:test";\nimport assert from "node:assert/strict";\ntest("fixture", async () => {\n${open}\n  ${delay}\n  ${body}\n${close}\n});\n`;
const sleepStmt = "const sleep = (ms) => new Promise((r) => setTimeout(r, ms));\n";

test("transient-state: a fixed delay before an assertion on page state FAILS CLOSED and is named (voicebox-beads-zjpm.5.3)", () => {
  // THE ARM THAT MUST GO RED. Write-once-and-read behaviour with nothing saying it arrived: this is the
  // jeye/y1db shape, and the checker's job is to say the file and line, not to guess the cause.
  const res = check(sleepStmt + shape());
  assert.equal(res.code, 1, `an uncleared candidate must exit 1 — output was ${res.out}`);
  assert.match(res.out, /fixture\.test\.mjs:6/, "the candidate is named by file and line");
  assert.match(res.out, /FIXED delay immediately before an assertion on page state/, "and the reason is the shape, not the surface form");

  // …and NOT for a variable delay: `sleep(delayMs)` is not a fixed sleep, so it is not this class.
  const computed = check(sleepStmt + shape({ delay: "await sleep(delayMs);" }));
  assert.equal(computed.code, 0, `a computed delay is not a fixed sleep — output was ${computed.out}`);
  assert.match(computed.out, /0 fixed delay|every one cleared/, "and it is not reported as a delay at all");
});

test("transient-state: every clause that clears a candidate clears it BY NAME, and nothing else does", () => {
  // ABSENCE: a delay before an absence is the point of the assertion (the negative controls in
  // changelog-dialog-extraction and opfs-scratch-room are exactly this).
  for (const body of [
    'assert.equal((await readRoot(s)).declared, false, "still not declared");',
    "assert.equal(window.__calls.length, 0);",
    'assert.notEqual(await page.evaluate(() => window.__x), "ready");',
    'assert.ok(!(await page.evaluate(() => window.__panel.open)));',
  ]) {
    const res = check(sleepStmt + shape({ body }));
    assert.equal(res.code, 0, `ABSENCE must clear ${body} — output was ${res.out}`);
    assert.match(res.out, /cleared .* — ABSENCE/, "and the clause is named in the output");
  }

  // POLL: the loop is the wait, the delay is how often it looks.
  const poll = check(sleepStmt + shape({ open: "for (let i = 0; i < 20; i++) {", close: "}" , delay: "await sleep(50);", body: 'assert.equal(await page.evaluate(() => window.__ready), true);' }));
  assert.equal(poll.code, 0, `POLL must clear a delay inside a loop — output was ${poll.out}`);
  assert.match(poll.out, /— POLL/, "named");

  // IN-PAGE: the delay runs inside page.evaluate(), i.e. it is the measured timeline, not the test's wait.
  const inPage = check(sleepStmt + shape({ open: "await page.evaluate(async () => {", close: "});", delay: "await sleep(400);", body: 'assert.equal(await page.evaluate(() => window.__n), 1);' }));
  assert.equal(inPage.code, 0, `IN-PAGE must clear a delay inside the page — output was ${inPage.out}`);
  assert.match(inPage.out, /— IN-PAGE/, "named");

  // NO-ASYNC: a fixture asserting its own arithmetic observes nothing that can arrive late.
  const noAsync = check(sleepStmt + shape({ body: "assert.equal(2 + 2, process.env.GATE_CASE === 'x' ? 5 : 4);" }));
  assert.equal(noAsync.code, 0, `NO-ASYNC must clear a fixture assertion — output was ${noAsync.out}`);
  assert.match(noAsync.out, /— NO-ASYNC/, "named");

  // NOT-IMMEDIATE: the delay is followed by a read, not an assertion — not this shape at all.
  const notImmediate = check(sleepStmt + shape({ body: "const overflow = await page.evaluate(() => document.body.scrollWidth);" }));
  assert.equal(notImmediate.code, 0, `NOT-IMMEDIATE must clear a delay followed by a read — output was ${notImmediate.out}`);
  assert.match(notImmediate.out, /— NOT-IMMEDIATE/, "named");
});

test("transient-state: the tree it ships on is CLEAN — no candidate survives, so a red run means a new site", () => {
  // THE ARM THAT MAKES IT USEFUL. If the repository's own delays could not be cleared, this checker would be
  // red for the base and would teach everyone to ignore it. So it is run here over the real browser lane: any
  // future fixed delay immediately before an assertion on page state fails THIS test until someone either
  // fixes the site or adds the clause that legitimately clears it — which is the review the bead asked for.
  const res = spawnSync(process.execPath, [CHECKER], { cwd: root, encoding: "utf8", timeout: 120_000, killSignal: "SIGKILL" });
  assert.equal(res.status, 0, `the browser lane must have no uncleared candidate — got:\n${res.stdout}${res.stderr}`);
  assert.match(res.stdout, /transient-state: OK — \d+ file\(s\), \d+ fixed delay\(s\)/, "and it says how much it looked at, so 'clean' cannot mean 'scanned nothing'");
});

test("transient-state: the status-observable half is a REVIEW LIST, not a verdict (it never changes the exit code)", () => {
  // The audit's second acceptance item needs a human: an exact string or count on a status observable the
  // test never waits for is only a defect if the writer is asynchronous, and that is not decidable from the
  // test file. So it is listed and it does not decide anything — a gate that failed on those would be red for
  // the base, which is exactly the failure mode this repository keeps finding.
  const listing = check(sleepStmt + shape({ body: 'await page.click("#go");\n  assert.equal(await page.evaluate(() => window.__count), 1);' }));
  assert.equal(listing.code, 0, `the review list must not change the exit code — output was ${listing.out}`);
});
