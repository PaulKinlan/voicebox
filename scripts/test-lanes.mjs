#!/usr/bin/env node
// scripts/test-lanes.mjs — which test files are UNIT and which are LIVE.
//
// WHY TWO LANES (voicebox-beads-6qu, measured 2026-09-23): the pre-push gate ran
// the whole suite with the default runner, and node runs test FILES
// concurrently. Live tests — ones that launch a real Chromium over CDP or a real
// server process — then interfere with their neighbours: `extension-approval-ui`
// failed INSIDE the suite twice at ~20.5s while passing 1/1 alone AND passing in
// a serial run of the entire suite at load average 36, HIGHER than during any
// refusal. So the mechanism is the suite's own concurrency, not the box, and the
// fix is to keep the slow, resource-owning files out of the concurrent pass.
//
// THE RULE THAT KEEPS THIS HONEST: a file is classified by what it IMPORTS or
// SPAWNS, read from its code with comments stripped (a file that merely mentions
// a browser in a comment is a unit test), and every file lands in exactly one
// lane. `--check` fails if a test file is in neither or in both, so a new test
// cannot silently escape the lanes the way it could escape a hand-kept list.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TESTS = path.join(ROOT, "tests");

/** What makes a file LIVE: it starts a browser, or a server of its own. */
const LAUNCHES = [
  { what: "a browser over CDP", re: /from\s+["'][^"']*lib\/cdp\.mjs["']/ },
  { what: "a browser via page-acceptance", re: /\bpage-acceptance\.mjs\b/ },
  { what: "a server process", re: /from\s+["'][^"']*lib\/server\.mjs["']/ },
  { what: "a server process", re: /["'][^"']*\bserver\.mjs["']/ },
  { what: "a server via task-fixture", re: /from\s+["'][^"']*lib\/task-fixture\.mjs["']/ },
  { what: "a server via createServer", re: /\bcreateServer\b/ },
  { what: "worker threads or wasm execution", re: /\bcallWasmTool\b/ },
];

const stripComments = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

export function classify(root = TESTS) {
  const unit = [];
  const live = [];
  /**
   * A repository with no `tests/` classifies as empty rather than throwing:
   * the GATE FIXTURES drive this script inside a disposable repo to test the
   * refusal mechanics, and a fixture has no tests to sort. The real repository
   * always has them, and `npm test` would fail loudly if it did not.
   */
  let entries = [];
  try {
    entries = readdirSync(root);
  } catch {
    entries = [];
  }
  for (const file of entries.filter((f) => f.endsWith(".test.mjs")).sort()) {
    const code = stripComments(readFileSync(path.join(root, file), "utf8"));
    const launched = LAUNCHES.find(({ re }) => re.test(code));
    (launched ? live : unit).push({ file, why: launched?.what ?? null });
  }
  return { unit, live };
}

const laneArg = process.argv.includes("--lane") ? process.argv[process.argv.indexOf("--lane") + 1] : null;
const { unit, live } = classify();

if (process.argv.includes("--check")) {
  const seen = new Set();
  const problems = [];
  for (const { file } of [...unit, ...live]) {
    if (seen.has(file)) problems.push(`${file} is in both lanes`);
    seen.add(file);
  }
  if (unit.length + live.length !== seen.size) problems.push("a file is in neither lane");
  if (problems.length > 0) {
    console.error(`[lanes] ${problems.join("; ")}`);
    process.exit(1);
  }
  // Coverage only: this runs inside GATE FIXTURES too, which have no tests and
  // must still pass — the pin that the known victims stay LIVE belongs in the
  // test suite (tests/test-lanes.test.mjs), not in a check the gate runs on
  // every repository state.
  console.log(`[lanes] ok: ${unit.length} unit, ${live.length} live`);
  process.exit(0);
}

if (laneArg === "unit" || laneArg === "live") {
  const files = (laneArg === "unit" ? unit : live).map(({ file }) => `tests/${file}`);
  console.log(files.join(" "));
  process.exit(0);
}

console.log(`unit: ${unit.length} files\nlive: ${live.length} files`);
for (const { file, why } of live) console.log(`  live  ${file} — ${why}`);
