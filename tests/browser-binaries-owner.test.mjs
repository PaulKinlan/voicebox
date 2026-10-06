// tests/browser-binaries-owner.test.mjs — ONE owner for "which browser does this box have", enforced.
//
// voicebox-beads-phs9 (from the 80vw review, which refused to let a narrowed claim stand as a
// repo-wide one): the candidate list — `VOICEBOX_CHROME`, then the usual system paths — was written
// out three times (the test driver, tools/page-acceptance.mjs, tests/voicebox.test.mjs). Three
// places deciding one fact is voicebox-beads-q0a3's shape, and its failure mode is why this guard
// exists: a divergence does not announce itself as a divergence. Measured in 80vw — a box with no
// browser made a pre-push case die at 'spawn /usr/bin/chromium ENOENT' BEFORE the network path it
// asserted, so a missing browser read as a network failure for as long as nobody read the output.
//
// WHY A TEST RATHER THAN A LINE IN scripts/single-owner.mjs: the standing check deliberately does
// not scan `tests/` (its SKIP_DIRS), and one of the three copies lived in `tests/` — so nothing else
// in the tree could see it. This file scans where the copies were.
//
// SCOPE, STATED EXACTLY (so the claim can be checked rather than believed): the scan covers
// .mjs/.js/.cjs/.mts/.cts/.ts under the repository, excluding node_modules, .git, docs/ (prose),
// .beads/ (task state), workspace/ (a root the product writes) and THIS FILE (its own patterns and
// fixtures legitimately contain the strings it hunts for — the same self-exclusion
// scripts/single-owner.mjs documents, bounded here by a scanned-count assertion so a scan that
// silently stopped looking cannot pass).
//
//   node --test tests/browser-binaries-owner.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { browserCandidates, findBrowserBinary } from "../lib/browser-binaries.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OWNER = "lib/browser-binaries.mjs";
const SELF = "tests/browser-binaries-owner.test.mjs";
const SCANNABLE = new Set([".mjs", ".js", ".cjs", ".mts", ".cts", ".ts"]);
const SKIP_DIRS = new Set(["node_modules", ".git", "docs", "workspace", ".beads"]);
/**
 * Files that may contain browser-path literals for a reason of their own. The exemption relaxes the
 * LIST rule ONLY — the env-read rule still applies to every file, including these (review finding:
 * a whole-file `continue` let an exempt file read the variable unobserved).
 */
const EXEMPT = {
  "public/verify.mjs": "reads its own CHROME variable with one literal path, no candidate list",
};

/** Comments blanked, line numbers kept — the view for hunting path literals (which ARE strings). */
const withoutComments = (source) =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, (b) => b.replace(/[^\n]/g, ""))
    .split("\n")
    .map((line) => { const m = /(^|[^:\\])\/\//.exec(line); return m ? line.slice(0, m.index + m[1].length) : line; })
    .join("\n");
/** And string CONTENTS blanked — the view for hunting variable reads (a message that names the
 * variable is documentation, not a read: the same call single-owner.mjs makes for comments). */
const withoutStrings = (source) =>
  source.replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/'(?:[^'\\]|\\.)*'/g, "''").replace(/`(?:[^`\\]|\\.)*`/g, "``");

const BROWSER_PATH = /["'](?:\/usr\/bin\/(?:chromium|chromium-browser|google-chrome-stable|google-chrome)|\/Applications\/[^"']*(?:Chrome|Chromium)[^"']*)["']/g;
const ENV_READ = /(?:process\s*\.\s*env\s*\.\s*VOICEBOX_CHROME|(?:^|[^.\w])env\s*\.\s*VOICEBOX_CHROME)\b/;

const sources = (root, dir = root, out = []) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) sources(root, path.join(dir, entry.name), out);
    } else if (SCANNABLE.has(path.extname(entry.name))) {
      out.push(path.relative(root, path.join(dir, entry.name)));
    }
  }
  return out;
};

/**
 * THE SCANNER, as a function of a root — so the guard can be DRIVEN against a scratch tree instead
 * of being asserted about (review finding: the first version's negative control tested two regexes
 * and never ran the real scan).
 */
export function scanTree(root) {
  const violations = [];
  const exempted = [];
  const files = sources(root);
  for (const file of files) {
    if (file === OWNER || file === SELF) continue;
    const code = withoutComments(readFileSync(path.join(root, file), "utf8"));
    const isExempt = Object.prototype.hasOwnProperty.call(EXEMPT, file);
    if (isExempt) {
      const hits = (code.match(BROWSER_PATH) ?? []).length;
      if (hits > 1) violations.push(`${file}: ${hits} browser-path literals inside a file exempted for having ONE (${EXEMPT[file]})`);
      else exempted.push(`${file} — ${EXEMPT[file]}`);
    } else {
      const literals = (code.match(BROWSER_PATH) ?? []).length;
      if (literals > 1) violations.push(`${file}: ${literals} browser-path literals — that is a candidate LIST; ask ${OWNER}'s findBrowserBinary()`);
    }
    // THE READ RULE APPLIES TO EVERY FILE, exempt or not, on the strings-blanked view.
    withoutStrings(code).split("\n").forEach((line, i) => {
      if (ENV_READ.test(line)) violations.push(`${file}:${i + 1} reads VOICEBOX_CHROME outside ${OWNER} — the variable is the owner's to read`);
    });
  }
  return { violations, exempted, files };
}

test("no file but the owner keeps a browser candidate LIST, and none but the owner reads VOICEBOX_CHROME", () => {
  const { violations, exempted, files } = scanTree(ROOT);
  // Coverage, not decoration: a scan that looked at nothing must not pass, and the named exemption
  // is PRINTED (a silently skipped file is the thing this guard is about).
  assert.ok(files.length > 20, `the scan must actually look at the tree (saw ${files.length} files)`);
  for (const note of exempted) console.log(`EXEMPT ${note}`);
  assert.ok(exempted.length >= 1, "the named exemption is still present and still named");
  assert.deepEqual(violations, [], `a second computing site for browser discovery reappeared:\n  ${violations.join("\n  ")}\n(the owner is ${OWNER}; callers ask it and pass the resolved path down)`);
});

test("the owner answers by VALUE, deterministically — env first, then the first existing candidate, then null", () => {
  const allPresent = { exists: () => true };
  const nonePresent = { exists: () => false };
  // Determinism is the point of the injectable seam: `findBrowserBinary({})` depends on the BOX
  // (a machine with chromium installed answers a path), and a guard whose verdict is a property of
  // the box is the defect class this module exists to end (review finding).
  assert.equal(findBrowserBinary({}, allPresent), "/usr/bin/chromium", "no var -> the first system candidate");
  assert.equal(findBrowserBinary({}, nonePresent), null, "nothing exists -> null, the answer a caller must say out loud");
  assert.equal(findBrowserBinary({ VOICEBOX_CHROME: "/fake/chrome" }, allPresent), "/fake/chrome", "an explicit var WINS over the system paths");
  assert.equal(findBrowserBinary({ VOICEBOX_CHROME: "/fake/chrome" }, { exists: (b) => b === "/usr/bin/google-chrome" }), "/usr/bin/google-chrome", "a var that does not exist is skipped — precedence is not a false positive");
  assert.equal(findBrowserBinary({ VOICEBOX_CHROME: "/fake/chrome" }, nonePresent), null, "and a var that does not exist with nothing else present is still null");
  // The list is a FUNCTION of the environment, not a constant captured at import.
  assert.equal(browserCandidates({ VOICEBOX_CHROME: "/second" })[0], "/second", "the variable is read at CALL time");
  // And the real box answers in the same vocabulary: a path that exists, or null — never a guess.
  const real = findBrowserBinary();
  assert.ok(real === null || typeof real === "string", "the real answer is a path or null");
});

test("NEGATIVE CONTROLS, driven through the REAL scanner in scratch trees", () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "vb-browser-nc-"));
  const build = (files) => {
    const root = mkdtempSync(path.join(scratch, "tree-"));
    mkdirSync(path.join(root, "tests"), { recursive: true });
    mkdirSync(path.join(root, "lib"), { recursive: true });
    mkdirSync(path.join(root, "public"), { recursive: true });
    writeFileSync(path.join(root, "lib", "browser-binaries.mjs"), readFileSync(path.join(ROOT, OWNER), "utf8"));
    for (const [rel, body] of Object.entries(files)) writeFileSync(path.join(root, rel), body);
    return root;
  };
  try {
    // 1. A reintroduced LIST (two literals) is caught, and the message names the file and the owner.
    const withList = build({ "tests/second-list.mjs": 'export const C = [process.env.VOICEBOX_CHROME, "/usr/bin/chromium", "/usr/bin/google-chrome"].filter(Boolean);\n' });
    const nc1 = scanTree(withList);
    assert.ok(nc1.violations.some((v) => v.includes("tests/second-list.mjs") && v.includes("candidate LIST")), `a reintroduced list must be caught (got ${JSON.stringify(nc1.violations)})`);
    // 2. A single READ with no literals at all is caught by the read rule.
    const withRead = build({ "tests/single-read.mjs": 'export const p = process.env.VOICEBOX_CHROME;\n' });
    const nc2 = scanTree(withRead);
    assert.ok(nc2.violations.some((v) => v.includes("single-read.mjs") && v.includes("reads VOICEBOX_CHROME")), `a single read must be caught (got ${JSON.stringify(nc2.violations)})`);
    // 3. A message that merely NAMES the variable is NOT a read (the documentation call).
    const withMention = build({ "tests/mentions-only.mjs": 'export const msg = "set VOICEBOX_CHROME to continue"; // process.env.VOICEBOX_CHROME in a comment is prose too\n' });
    assert.deepEqual(scanTree(withMention).violations, [], "a message naming the variable is documentation, not a second computing site");
    // 4. The EXEMPT file growing a list is caught (the exemption is for one literal).
    const exemptList = build({ "public/verify.mjs": 'const a = "/usr/bin/chromium"; const b = "/usr/bin/google-chrome";\n' });
    assert.ok(scanTree(exemptList).violations.some((v) => v.includes("public/verify.mjs") && v.includes("exempted for having ONE")), "an exempt file that grows a list must be caught");
    // 5. And the EXEMPT file READING the variable is caught too (the read rule is not exempt).
    const exemptRead = build({ "public/verify.mjs": 'const a = "/usr/bin/chromium"; const b = process.env.VOICEBOX_CHROME;\n' });
    assert.ok(scanTree(exemptRead).violations.some((v) => v.includes("public/verify.mjs") && v.includes("reads VOICEBOX_CHROME")), "an exempt file reading the variable must be caught");
    // 6. A clean tree passes (the controls above are the tree being dirty, not the scanner being noisy).
    const clean = build({ "tests/fine.mjs": 'export const x = 1;\n' });
    assert.deepEqual(scanTree(clean).violations, [], "a clean tree passes");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
