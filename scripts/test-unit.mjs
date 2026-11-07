#!/usr/bin/env node
// scripts/test-unit.mjs — the UNIT GATE the fleet's fast check runs, with the repository's own rules applied.
//
// `npm run test:unit` used to be `node --test $(node scripts/test-lanes.mjs --lane unit)`: one flat pass under node's
// own concurrency, and nothing else. Two things this repository already knows were therefore not applied to the
// command the fleet actually gates on (voicebox-beads-u32a, and the coverage half of the same gap):
//
//   1. ISOLATED (scripts/test-shards.mjs) names files that must run ALONE — `tests/tasks-browser.test.mjs` is there
//      with the reasoning "the one file whose outcome tracks the state of the box rather than the tree". The tier
//      dispatcher and `test:changed` honour that list; this command did not, so a file marked "run me alone" ran
//      beside six siblings and failed on the sibling contention. Measured on one tree: three task suites under
//      node's default concurrency failed 4-7 arms at 8s, 11s, 22s, 24s and 36s; the same files with
//      `--test-concurrency=1` passed 19/19 in 20s.
//   2. The hub's coverage extractor reads `fast-gate: passed: <path>` markers from the gate LOG
//      (scripts/gate-manifest.mjs MARKER_PREFIX). The tier dispatcher emits them; this command emitted none, so
//      every fast-gate verdict in this repository reported `coverage: UNKNOWN` — a reviewer could not tell that the
//      change had been exercised, which is the one thing a verdict is asked to say.
//
// So the unit lane now runs as: the ISOLATED files one at a time, then everything else in a pool of TIER_WORKERS
// file-per-child runs — which is what `node --test` does internally anyway, except that ONE PROCESS PER FILE is
// what makes a per-file verdict attributable at all (a multi-file `node --test` reports test names, never file
// names, so a batch exit status cannot honestly be turned into markers for the files inside it). One marker per
// file either way, and the exit status is 0 only when every file passed.
import { spawn } from "node:child_process";
import os from "node:os";
import { classify } from "./test-lanes.mjs";
import { ISOLATED, TIER_WORKERS } from "./test-shards.mjs";
import { emitMarker } from "./gate-manifest.mjs";

/** Split the unit lane by the ISOLATED list. Pure, so the split itself is testable without spawning anything. */
export function planUnitRuns(files, isolated = ISOLATED) {
  const alone = [];
  const together = [];
  for (const file of files) (isolated.has(file) ? alone : together).push(file);
  return { alone, together };
}

/**
 * NODE_TEST_CONTEXT is how node tells a CHILD of the test runner that it is one. A nested `node --test` that
 * inherits it does not run its files (it believes it is already inside a runner) and exits 0 — which reads as "every
 * file passed" while nothing ran. Measured: this file's own fixture arm marked a deliberately red file as passed
 * until the variable was stripped. The gate must be runnable from inside a test, so it strips it.
 */
function childEnv() {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

function runOne(file, cwd) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--test", file], { cwd, env: childEnv(), stdio: ["ignore", "pipe", "inherit"] });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.on("close", (code) => resolve({ file, status: code ?? 1, stdout }));
  });
}

/** A pool of `size` file-per-child runs; each result is one file's own exit status. */
async function runPool(files, { cwd, size }) {
  const results = [];
  let next = 0;
  const worker = async () => {
    while (next < files.length) {
      const file = files[next++];
      results.push(await runOne(file, cwd));
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, files.length) }, worker));
  return results;
}

/**
 * Run a file list as the unit lane runs it and print one marker per file. Returns the number of files that were not
 * green, so the caller owns the exit status and a test can drive a small fixture without running this repository.
 */
export async function runUnitLane(files, { cwd = process.cwd(), isolated = ISOLATED, workers = TIER_WORKERS.unit } = {}) {
  const { alone, together } = planUnitRuns(files, isolated);
  const results = [];

  if (alone.length > 0) {
    console.log(`[test:unit] ${alone.length} isolated file(s) run ALONE, then ${together.length} at ${workers} at a time`);
    // ONE AT A TIME, strictly: that is what ISOLATED asks for, and it is why these files exist in the list.
    for (const file of alone) {
      const result = await runOne(file, cwd);
      process.stdout.write(result.stdout);
      results.push(result);
    }
  }

  if (together.length > 0) {
    const settled = await runPool(together, { cwd, size: Math.max(1, workers) });
    // Printed as they finish so the gate log shows progress, and per file so a failure is readable in place.
    for (const result of settled) process.stdout.write(result.stdout);
    results.push(...settled);
  }

  let failed = 0;
  for (const result of results) {
    const state = result.status === 0 ? "passed" : "failed";
    if (result.status !== 0) failed += 1;
    console.log(emitMarker(state, [result.file]));
  }

  if (failed > 0) console.error(`[test:unit] FAILED — ${failed} of ${files.length} file(s) not green`);
  else console.log(`[test:unit] ALL GATES GREEN (unit) — ${files.length} file(s)`);
  return failed;
}

function main() {
  const files = classify().unit.map(({ file }) => `tests/${file}`);
  const workers = Number(process.env.VOICEBOX_UNIT_WORKERS ?? os.availableParallelism() - 1);
  runUnitLane(files, { workers }).then((failed) => process.exit(failed === 0 ? 0 : 1), (error) => {
    console.error(`[test:unit] runner failed: ${error?.message ?? error}`);
    process.exit(1);
  });
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) main();
