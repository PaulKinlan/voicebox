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
//
// THE CHECKOUT IS NEVER WRITTEN (voicebox-beads-qxy2). The refusal test used to plant its retired literal
// by rewriting the TRACKED docs/08-how-it-runs.md in place for the length of a whole docs-check run (~7s,
// server and all) — a writer inside a measured tree (voicebox-beads-bp8): any `git status` taken meanwhile
// (acceptance, docs-touched, another test, a person) saw a modification nobody authored, and a killed run
// left the document modified. Measured before the change: 558 of 1604 polls of `git status --porcelain`
// during three runs of this file showed ` M docs/08-how-it-runs.md`. Now every perturbation is made in a
// COPY of the documents under the OS temp dir (makeScratchDir refuses a destination inside the tree),
// docs-check reads the copy through `--docs-root`, and the copy is removed in `finally`.
//
// The first test still runs the check exactly as the gate and a person do — no flag, the real documents,
// the live scratch server — because "the docs match the code" is only proven by asking the code.

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { constants, cpSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeScratchDir } from "../tools/tree-dirt.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CHECK = join(ROOT, "scripts", "docs-check.mjs");

/**
 * The documents docs-check reads — README.md and docs/ (the markdown and the claims policy) — copied into
 * scratch outside the checkout, laid out as `--docs-root` expects. Cloned where the filesystem can (APFS),
 * copied where it cannot. The CALLER removes it, in `finally`.
 */
function copyOfTheDocuments() {
  const dir = makeScratchDir("voicebox-docs-drift-", { tree: ROOT });
  cpSync(join(ROOT, "README.md"), join(dir, "README.md"), { mode: constants.COPYFILE_FICLONE });
  cpSync(join(ROOT, "docs"), join(dir, "docs"), { recursive: true, mode: constants.COPYFILE_FICLONE });
  return dir;
}

/** Append `line` to a document in the copy; returns the 1-based line number it landed on. */
function plant(docsRoot, rel, line) {
  const file = join(docsRoot, rel);
  const text = `${readFileSync(file, "utf8")}\n${line}\n`;
  writeFileSync(file, text);
  return text.split("\n").indexOf(line) + 1;
}

const docsCheckOn = (docsRoot) => spawnSync(process.execPath, [CHECK, "--docs-root", docsRoot], { encoding: "utf8" });

/** The refusal headlines — every stderr line docs-check starts with its own name. */
const headlines = (stderr) => stderr.split("\n").filter((l) => l.startsWith("docs-check:"));

test("the documents describe the code: no generated block has drifted", () => {
  const r = spawnSync(process.execPath, [CHECK], { encoding: "utf8" });
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

  // 1. END-TO-END: a retired literal in a HAND-WRITTEN region is refused, naming file, line and literal —
  //    planted in a COPY of the documents, never in the checkout (voicebox-beads-qxy2).
  const docsRoot = copyOfTheDocuments();
  try {
    const line = plant(docsRoot, join("docs", "08-how-it-runs.md"), "history: started as E1-M0, rendered from workspace/");
    const red = docsCheckOn(docsRoot);
    assert.equal(red.status, 1, `docs-check passed with a retired literal in a hand-written region:\n${red.stdout}${red.stderr}`);
    assert.match(red.stderr, /retired literal/);
    assert.match(red.stderr, /E1-M0/, "the refusal names the matched literal");
    assert.match(red.stderr, /08-how-it-runs\.md/, "the refusal names the file");
    assert.match(red.stderr, new RegExp(`line ${line}: `), `the refusal names the line the literal was planted on (${line})`);
    // Refused by the STATIC half, before any server: a retired word cannot be excused by what a server
    // answers, so none is booted for it — and the run says the blocks were not compared rather than
    // letting silence imply they were.
    assert.match(red.stderr, /generated blocks were not compared/, "a static refusal must say the blocks were not compared");
    // And it is the ONLY refusal. The copy is the checkout's documents byte for byte, so anything else
    // would be the copy talking — above all, a path claim resolved against the COPY (which holds no code)
    // rather than the tree, which would fail by the hundred.
    const heads = headlines(red.stderr);
    assert.equal(heads.length, 2, `expected the retired-literal refusal and the skip note, got:\n${red.stderr}`);
    assert.match(heads[0], /^docs-check: docs\/08-how-it-runs\.md carries retired literals/);
    assert.match(heads[1], /generated blocks were not compared/);
  } finally {
    rmSync(docsRoot, { recursive: true, force: true });
  }

  // 2. UNIT, on the extracted production function (verbatim bytes, the cdp-client pattern):
  const src = readFileSync(CHECK, "utf8");
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

test("every static refusal is reported in one run, before any server (qxy2)", () => {
  // Three documents, three kinds of static failure, one run. Each used to be a separate ~7s round trip:
  // the first refusal exited, and only after a server had booted.
  const docsRoot = copyOfTheDocuments();
  try {
    plant(docsRoot, "README.md", "See `lib/no-such-module-qxy2.mjs` for how this used to work.");
    const architecture = join(docsRoot, "docs", "07-architecture.md");
    const withMarkers = readFileSync(architecture, "utf8");
    const withoutPageEnd = withMarkers.replace("<!-- END GENERATED: page -->\n", "");
    assert.notEqual(withoutPageEnd, withMarkers, "docs/07-architecture.md no longer carries a 'page' block to break");
    writeFileSync(architecture, withoutPageEnd);
    plant(docsRoot, join("docs", "08-how-it-runs.md"), "the E1-M0 tool");

    const red = docsCheckOn(docsRoot);
    assert.equal(red.status, 1, `docs-check passed with three static failures:\n${red.stdout}${red.stderr}`);
    const heads = headlines(red.stderr);
    // In the order the checks walk: the documents in DOCS order, then the claims policy, then the note.
    const expected = [
      /^docs-check: README\.md names files that do not exist in this tree/,
      /^docs-check: docs\/07-architecture\.md has no generated block named 'page'/,
      /^docs-check: docs\/08-how-it-runs\.md carries retired literals/,
      /^docs-check: FAILED — 1 hand-written claim\(s\) do not hold/,
      /^docs-check: generated blocks were not compared — fix the failures above, then re-run/,
    ];
    assert.equal(heads.length, expected.length, `expected ${expected.length} refusal headlines, got:\n${red.stderr}`);
    expected.forEach((re, i) => assert.match(heads[i], re));
    assert.match(red.stderr, /\n {2}- lib\/no-such-module-qxy2\.mjs\n/, "the missing path is named under its document");
    assert.match(red.stderr, /README\.md:\d+ — backtick path `lib\/no-such-module-qxy2\.mjs` does not exist in this tree/);
  } finally {
    rmSync(docsRoot, { recursive: true, force: true });
  }

  // A --docs-root that is not a directory is refused by name, with its own exit code — never quietly
  // replaced by the checkout's documents, which would turn every refusal test above green for nothing.
  const typo = join(ROOT, "no-such-docs-root-qxy2");
  const usage = docsCheckOn(typo);
  assert.equal(usage.status, 2, `a missing --docs-root must exit 2:\n${usage.stdout}${usage.stderr}`);
  assert.match(usage.stderr, /--docs-root '.*no-such-docs-root-qxy2' is not a directory/);
});

test("stripComments preserves code in comment-adjacent forms and eliminates phantom env reads (voicebox-beads-5qox)", async () => {
  const { stripComments, envVars } = await import("../scripts/docs-check.mjs");

  // 1. Pinned forms where naive regex comment-strippers drop real code:
  // Form A: /* inside a string with a read before the next */
  const formA = 'const a = "/*";\nconst key = process.env.REAL_A;\nconst b = "*/";';
  assert.match(stripComments(formA), /process\.env\.REAL_A/);

  // Form B: /* inside a regex literal
  const formB = 'const r = /\\/*\\//;\nconst key = process.env.REAL_B;';
  assert.match(stripComments(formB), /process\.env\.REAL_B/);

  // Form C: // inside a string with read on same line
  const formC = 'const u = "http://example.com"; const key = process.env.REAL_C;';
  assert.match(stripComments(formC), /process\.env\.REAL_C/);

  // Form D: // inside a template literal
  const formD = 'const t = `// text ${process.env.REAL_D}`;';
  assert.match(stripComments(formD), /process\.env\.REAL_D/);

  // Form E: Genuine line comment containing process.env.X must be stripped
  const formE = '// docs-check only scans process.env.X\nconst key = process.env.REAL_E;';
  const strippedE = stripComments(formE);
  assert.doesNotMatch(strippedE, /process\.env\.X\b/);
  assert.match(strippedE, /process\.env\.REAL_E/);

  // 2. envVars() live verification:
  const vars = envVars();
  assert.equal(vars.some((v) => v.name === "X"), false, "phantom variable X must not be in envVars");
  assert.equal(vars.some((v) => v.name === "BRAVE_API_KEY"), true, "BRAVE_API_KEY derived from catalogue declaration");
});

test("the docs probe is isolated from ambient Anthropic credentials (voicebox-beads-tgvk)", () => {
  // THE REGRESSION: with an ambient ANTHROPIC_API_KEY in the shell, the probe server's
  // effectiveProvider resolved to Claude and the probe's own turns answered HTTP 401 — the
  // generated loop block went undefined and the check failed. The probe now blanks all three
  // vendor keys, so this runs the check with the key PINNED to a fixture value and requires the
  // same clean exit a keyless shell gets. (The 401 symptom itself stopped reproducing when the
  // claude transport began refusing by name — this test pins the ISOLATION, so the next provider
  // behaviour cannot reopen it.)
  const run = spawnSync(process.execPath, [CHECK], {
    encoding: "utf8",
    timeout: 120000,
    env: { ...process.env, ANTHROPIC_API_KEY: "fixture-anthropic-key-tgvk" },
  });
  assert.equal(run.status, 0, `docs-check failed with an ambient Anthropic credential:\n${(run.stderr ?? "").slice(-600)}\n${(run.stdout ?? "").slice(-600)}`);
  assert.doesNotMatch(run.stdout ?? "", /401/, "no vendor 401 may appear in the probe's output");
});
