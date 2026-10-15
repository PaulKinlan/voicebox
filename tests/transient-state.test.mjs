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
function check(source, { list = false } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "voicebox-transient-"));
  const file = path.join(dir, "fixture.test.mjs");
  writeFileSync(file, source);
  try {
    const res = spawnSync(process.execPath, [CHECKER, file, ...(list ? ["--list"] : [])], { cwd: root, encoding: "utf8", timeout: 60_000, killSignal: "SIGKILL" });
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

  // A real poll re-checks after sleeping, before reaching its assertion. That intervening check
  // breaks the immediate-delay shape; merely putting the assertion in a loop does not.
  const poll = check(sleepStmt + shape({ open: "while (true) {", close: "}", delay: "await sleep(50);", body: 'if (!(await page.evaluate(() => window.__ready))) continue;\n  assert.equal(await page.evaluate(() => window.__ready), true);' }));
  assert.equal(poll.code, 0, `a post-sleep re-check must clear by NOT-IMMEDIATE — output was ${poll.out}`);
  assert.match(poll.out, /— NOT-IMMEDIATE/, "named");

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

test("transient-state: a loop alone does NOT turn a fixed sleep into a bounded polling wait (voicebox-beads-174g)", () => {
  const loops = ["for (let i = 0; i < 1; i++) {", "for (let i = 0; i < 20; i++) {", "while (window.__other) {", "for (const item of items) {"];
  const dir = mkdtempSync(path.join(os.tmpdir(), "voicebox-174g-"));
  try {
    const files = loops.map((loop, index) => {
      const file = path.join(dir, `unsafe-${index}.test.mjs`);
      writeFileSync(file, sleepStmt + shape({ open: loop, close: "}" }));
      return file;
    });
    const res = spawnSync(process.execPath, [CHECKER, ...files], { cwd: root, encoding: "utf8", timeout: 60_000, killSignal: "SIGKILL" });
    assert.equal(res.status, 1, `all four unsafe loops must refuse: ${res.stdout}${res.stderr}`);
    assert.match(res.stderr, /4 candidate\(s\)/, "every loop must be a candidate");
    for (const file of files) assert.ok(res.stderr.includes(`${file}:6:`), `candidate missing for ${file}`);
    assert.doesNotMatch(res.stdout, /— POLL/, "a loop header is not proof of a post-sleep poll");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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

test("transient-state: invoked from outside repo root resolves roster files against repo root (voicebox-beads-vm16)", () => {
  // When run without arguments from an arbitrary cwd (e.g. /tmp), the checker must resolve the
  // roster files against the repository root rather than failing open with 0 delays scanned.
  const res = spawnSync(process.execPath, [CHECKER], { cwd: os.tmpdir(), encoding: "utf8", timeout: 120_000, killSignal: "SIGKILL" });
  assert.equal(res.status, 0, `scanner from outside repo root must succeed — got:\n${res.stdout}${res.stderr}`);
  assert.match(res.stdout, /transient-state: OK — \d+ file\(s\), ([1-9]\d*) fixed delay\(s\)/, "must scan the real files and find non-zero delays");
});

test("transient-state: unreadable files fail closed with exit 1 naming the unreadable paths (voicebox-beads-vm16)", () => {
  const missing = path.join(os.tmpdir(), "definitely-missing-file.test.mjs");
  const res = spawnSync(process.execPath, [CHECKER, missing], { cwd: os.tmpdir(), encoding: "utf8", timeout: 60_000, killSignal: "SIGKILL" });
  assert.equal(res.status, 1, `unreadable file must exit 1 — got:\n${res.stdout}${res.stderr}`);
  assert.match(res.stderr, /transient-state: REFUSED — could not read 1 of 1 file\(s\)/, "named refusal");
  assert.match(res.stderr, /definitely-missing-file\.test\.mjs/, "names the missing file");
});

test("transient-state: roster paths resolve unconditionally to repo root and summary names base/root (voicebox-beads-rm1h)", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "voicebox-rm1h-"));
  try {
    // 1. Without args from an external directory, output reports root
    const resRoster = spawnSync(process.execPath, [CHECKER], { cwd: dir, encoding: "utf8", timeout: 120_000, killSignal: "SIGKILL" });
    assert.equal(resRoster.status, 0);
    assert.match(resRoster.stdout, /transient-state: OK — \d+ file\(s\), \d+ fixed delay\(s\), every one cleared by a named clause \(root: [^)]+\)/);

    // 2. With explicit named file from external directory, output reports base
    const testFile = path.join(dir, "explicit.test.mjs");
    writeFileSync(testFile, 'import test from "node:test";\ntest("empty", () => {});\n');
    const resNamed = spawnSync(process.execPath, [CHECKER, testFile], { cwd: dir, encoding: "utf8", timeout: 60_000, killSignal: "SIGKILL" });
    assert.equal(resNamed.status, 0);
    assert.match(resNamed.stdout, /transient-state: OK — 1 file\(s\), 0 fixed delay\(s\), every one cleared by a named clause \(base: [^)]+\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("transient-state: the status-observable half is a REVIEW LIST, not a verdict (it never changes the exit code)", () => {
  // The audit's second acceptance item needs a human: an exact string or count on a status observable the
  // test never waits for is only a defect if the writer is asynchronous, and that is not decidable from the
  // test file. So it is listed and it does not decide anything — a gate that failed on those would be red for
  // the base, which is exactly the failure mode this repository keeps finding.
  const listing = check(sleepStmt + shape({ body: 'await page.click("#go");\n  assert.equal(await page.evaluate(() => window.__count), 1);' }));
  assert.equal(listing.code, 0, `the review list must not change the exit code — output was ${listing.out}`);
});

test("transient-state: delayed page read before assertion is offered under --list (voicebox-beads-omja)", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "voicebox-omja-"));
  const file = path.join(dir, "omja.test.mjs");
  writeFileSync(
    file,
    'import test from "node:test";\nimport assert from "node:assert/strict";\nconst sleep = (ms) => new Promise((r) => setTimeout(r, ms));\ntest("omja", async () => {\n  await sleep(300);\n  const status = await page.evaluate(() => window.__status);\n  assert.equal(status, "ready");\n});\n',
  );
  try {
    const res = spawnSync(process.execPath, [CHECKER, file, "--list"], { cwd: root, encoding: "utf8" });
    assert.equal(res.status, 0);
    assert.match(res.stdout, /— DELAYED-READ/, "named clause clears direct failure");
    assert.match(res.stdout, /review .* delayed read of page state asserted at line 7/, "review list includes the delayed read");
    assert.match(res.stdout, /review .* exact status assertion, no wait on it: assert\.equal\(status, "ready"\)/, "review list includes status assertion");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("transient-state: nested wait scopes and page writer are named accurately for status review (voicebox-beads-a2gd)", () => {
  // One checker process for independent files: each review item keeps its file name; this avoids six
  // separate Node startups in the fast tier without allowing one fixture's wait to clear another's.
  const fixtures = {
    waited: 'await page.waitForFunction(() => window.__status === "ready");\nassert.equal(await page.evaluate(() => window.__status), "ready");\n',
    unwaited: 'await page.waitForFunction(() => window.__other);\nawait page.evaluate(() => { window.__status = "ready"; window.__count = 1; });\nassert.equal(await page.evaluate(() => window.__status), "ready");\nassert.equal(await page.evaluate(() => window.__count), 1);\n',
    suffix: 'await page.waitForFunction(() => window.__statusText);\nassert.equal(await page.evaluate(() => window.__status), "ready");\n',
    future: 'assert.equal(await page.evaluate(() => window.__status), "ready");\nawait page.waitForFunction(() => window.__status);\n',
    publicWriter: 'assert.equal(await page.evaluate(() => window.__voiceboxPip), 1);\n',
    unknown: 'assert.equal(await page.evaluate(() => window.__status), "ready");\n',
  };
  const dir = mkdtempSync(path.join(os.tmpdir(), "voicebox-a2gd-"));
  try {
    const files = Object.entries(fixtures).map(([name, body]) => {
      const file = path.join(dir, `${name}.test.mjs`);
      writeFileSync(file, body);
      return file;
    });
    const res = spawnSync(process.execPath, [CHECKER, ...files, "--list"], { cwd: root, encoding: "utf8", timeout: 60_000, killSignal: "SIGKILL" });
    assert.equal(res.status, 0, `${res.stdout}${res.stderr}`);
    const review = (name) => res.stdout.split("\n").filter((line) => line.includes(`  review  ${path.join(dir, name)}.test.mjs:`)).join("\n");
    assert.equal(review("waited"), "", "matching nested wait clears its review item");
    assert.match(review("unwaited"), /__status.*writer: .*unwaited\.test\.mjs:2/, "string status links to its in-page writer");
    assert.match(review("unwaited"), /__count.*writer: .*unwaited\.test\.mjs:2/, "positive count links to its writer");
    assert.match(review("suffix"), /__status.*writer: unknown/, "a longer identifier is not the asserted status");
    assert.match(review("future"), /__status.*writer: unknown/, "a later wait cannot clear an earlier read");
    assert.match(review("publicWriter"), /writer: public\/pip-mic\.mjs:\d+/, "a real page writer is linked by location");
    assert.match(review("unknown"), /__status.*writer: unknown/, "missing page writer stays unresolved");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("transient-state: an earlier test's wait never clears a later test's in-loop sleep and assertion (voicebox-beads-z5wb)", () => {
  const source = `import test from "node:test";
import assert from "node:assert/strict";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
test("earlier", async () => {
  await page.waitForFunction(() => window.__status === "ready");
});
test("later", async () => {
  for (let i = 0; i < 3; i++) {
    await sleep(100);
  }
  assert.equal(await page.evaluate(() => window.__status), "ready");
});
`;
  // One scanner process over independent files keeps this unit arm bounded on the two-vCPU host.
  const dir = mkdtempSync(path.join(os.tmpdir(), "voicebox-z5wb-"));
  try {
    const fixtures = {
      combined: source,
      commentedBrace: source.replace('  }\n  assert.equal', '  } // end of loop\n  assert.equal'),
      within: 'test("same", async () => {\n  await page.waitForFunction(() => window.__status === "ready");\n  assert.equal(await page.evaluate(() => window.__status), "ready");\n});\n',
      conditional: 'test("title 😀 test( is not a scope", async () => {\n  if (enabled) {\n    await page.waitForFunction(() => window.__status === "ready");\n  }\n  assert.equal(await page.evaluate(() => window.__status), "ready");\n});\n',
    };
    const files = Object.entries(fixtures).map(([name, body]) => {
      const file = path.join(dir, `${name}.test.mjs`);
      writeFileSync(file, body);
      return file;
    });
    const res = spawnSync(process.execPath, [CHECKER, ...files, "--list"], { cwd: root, encoding: "utf8", timeout: 60_000, killSignal: "SIGKILL" });
    const out = `${res.stdout}${res.stderr}`;
    assert.equal(res.status, 1, `a sleep at a loop's end cannot guard a one-shot page assertion: ${out}`);
    assert.match(out, /combined\.test\.mjs:9: a FIXED delay inside a loop/, "the in-loop sleep is a candidate");
    assert.match(out, /commentedBrace\.test\.mjs:9: a FIXED delay inside a loop/, "a trailing brace comment cannot hide the boundary");
    assert.match(out, /review .*combined\.test\.mjs:11.*__status/, "only the earlier test waited");
    assert.doesNotMatch(out, /review .*within\.test\.mjs:/, "a wait in the SAME test clears its own review item");
    assert.match(out, /review .*conditional\.test\.mjs:.*__status/, "a conditional wait cannot clear a read outside its block");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("transient-state: status review list captures exact strings and positive counts on unwaited observables (voicebox-beads-a2gd)", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "voicebox-a2gd-"));
  const file = path.join(dir, "a2gd.test.mjs");
  writeFileSync(
    file,
    'import test from "node:test";\nimport assert from "node:assert/strict";\ntest("a2gd", async () => {\n  await page.waitForFunction(() => window.__other);\n  assert.equal(await page.evaluate(() => window.__status), "ready");\n  assert.equal(await page.evaluate(() => window.__count), 1);\n});\n',
  );
  try {
    const res = spawnSync(process.execPath, [CHECKER, file, "--list"], { cwd: root, encoding: "utf8" });
    assert.equal(res.status, 0);
    assert.match(res.stdout, /review .* assert\.equal\(await page\.evaluate\(\(\) => window\.__status\), "ready"\)/, "exact string on unwaited observable is listed");
    assert.match(res.stdout, /review .* assert\.equal\(await page\.evaluate\(\(\) => window\.__count\), 1\)/, "positive count on unwaited observable is listed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
