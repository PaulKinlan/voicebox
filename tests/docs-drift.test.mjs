// tests/docs-drift.test.mjs — the docs must describe the system, and drift must fail a test.
//
// The mechanism is scripts/docs-check.mjs: it derives the providers from the module that registers
// them, the routes from a real server on a scratch port, the page's scripts from public/index.html, and
// the presence of the live session from the file itself — then compares those against the generated
// blocks in README.md, docs/07-architecture.md and docs/08-how-it-runs.md.
//
// It is a test rather than a promise because a check that nobody runs is a description: this fails in
// the suite, on the machine that made the change, rather than in a reader's head a week later.
//
//   node --test tests/docs-drift.test.mjs
//
// The proof that it can fail is in the receipt: perturbing the resolver list, a route's status, and the
// page's script tags each turned it red, and each was restored byte-exact.

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

test("the documents describe the code: no generated block has drifted", () => {
  const r = spawnSync(process.execPath, ["scripts/docs-check.mjs"], { encoding: "utf8" });
  assert.equal(
    r.status,
    0,
    `docs-check failed — the documents no longer describe the code:\n${r.stdout}${r.stderr}\n` +
      "Regenerate with: node scripts/docs-check.mjs --write",
  );
  assert.match(r.stdout, /docs-check: OK/, "the check must say it checked something");
});

test("the denylist refuses retired literals by file and line — in hand-written regions only (f0b)", () => {
  // THE NAMED LIMIT, kept from f0b: a denylist catches RETIREMENT, not ROT — a sentence can
  // become false without using a forbidden word. This test proves the half it CAN do: a
  // retired word in a hand-written region fails the check, by file and line.

  // 1. END-TO-END: a retired literal in a HAND-WRITTEN region is refused, naming file, line and literal.
  const docs = join("docs", "08-how-it-runs.md");
  const originalDocs = readFileSync(docs, "utf8");
  try {
    writeFileSync(docs, originalDocs + "\nhistory: started as E1-M0, rendered from workspace/\n");
    const red = spawnSync(process.execPath, ["scripts/docs-check.mjs"], { encoding: "utf8" });
    assert.equal(red.status, 1, "docs-check passed with a retired literal in a hand-written region");
    assert.match(red.stderr, /retired literal/);
    assert.match(red.stderr, /E1-M0/, "the refusal names the matched literal");
    assert.match(red.stderr, /08-how-it-runs\.md/, "the refusal names the file");
    assert.match(red.stderr, /line \d+/, "the refusal names the line");
  } finally {
    writeFileSync(docs, originalDocs);
  }

  // 2. UNIT, on the extracted production function (verbatim bytes, the cdp-client pattern):
  const src = readFileSync("scripts/docs-check.mjs", "utf8");
  const START = src.indexOf("const RETIRED_LITERALS");
  const END = src.indexOf("const DOCS = [");
  assert(START !== -1 && END > START);
  const extracted = src.slice(START, END);
  const factory = new Function(`${extracted}\nreturn { retiredHits };`);
  const { retiredHits } = factory();

  // A hand-written hit fires with its line number:
  const hitText = "intro\nescapes the workspace was the old refusal\nmore";
  assert.deepEqual(retiredHits(hitText), ['line 2: retired literal "escapes the workspace" — the containment refusal is \'outside-root\', and the workspace default no longer exists to escape']);

  // A line inside a GENERATED region never fires (the skip is by RANGE, line numbers preserved):
  const withBlock = "<!-- BEGIN GENERATED: x -->\nworkspace/ and E1-M0\n<!-- END GENERATED: x -->\nhand-written after";
  assert.deepEqual(retiredHits(withBlock), [], "a generated region was scanned by the denylist");

  // A line carrying the escape-hatch marker is exempt:
  const hatched = "escapes the workspace <!-- docs-check: names the mechanism -->";
  assert.deepEqual(retiredHits(hatched), [], "the escape hatch did not exempt the marked line");
});
