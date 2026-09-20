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
