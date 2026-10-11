#!/usr/bin/env node
// scripts/test-shards.mjs — the browser tier's work queue, and the proof that it covers the lane.
//
// WHY THIS IS A VALUE AND NOT A SHELL EXPANSION (voicebox-beads-hhkg, ADR voicebox-beads-g9jf):
// the browser tier is the whole cost of the gate's live stage — measured 2026-10-11 on this tree,
// 63 files and 284.3s serial, and 395.5s in the box's own last full-gate log under load. Making it
// run in four shards is worth ~2.2x, but it also moves the tier's coverage from "whatever the shell
// expanded" to "whatever the queue says" — and a queue that quietly drops a file looks exactly like
// a faster gate. So the queue is built here, it can be read without running anything, and
// `assertExactCoverage` REFUSES a queue that drops, repeats or invents a file. The runner calls it
// before a single browser opens.
//
// THE ORDER IS A TIE-BREAK, NOT A SCHEDULE: the runner hands files to whichever shard is free, so
// balance comes from work-stealing and the order only decides which file is in flight when the queue
// empties. Longest first is still the right order — it is the one that keeps the TAIL short, which is
// the only part of the run work-stealing cannot fix — but no file's cost is predicted here, so a
// roster change cannot make this file wrong.
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

/**
 * A file's cost, used ONLY to order the queue (above). Bytes are a crude proxy — measured against
 * the 63 per-file durations from the 2026-10-11 baseline run, byte size correlates with wall time at
 * r=0.51 while a test count correlates at r=0.31, so bytes are the better of the two cheap
 * signals. Neither is good; that is why the runner steals work instead of partitioning on this.
 */
export function weightOf(source) {
  return source.length;
}

/**
 * The queue: every file once, heaviest first. `weights` is an optional name→number map for a caller
 * that HAS measured costs (the tests use one); with no weights the bytes of each file are read and
 * used, best-effort, and an unreadable file sorts as weight 0 rather than failing the gate.
 */
export function buildQueue(files, { cwd = ROOT, weights = null } = {}) {
  const cost = (file) => {
    if (weights && Number.isFinite(weights[file])) return weights[file];
    try {
      return weightOf(readFileSync(path.join(cwd, file), "utf8"));
    } catch {
      return 0;
    }
  };
  return [...files].sort((a, b) => cost(b) - cost(a) || a.localeCompare(b));
}

/**
 * Refuse a queue that is not the lane, exactly once each. Returns the queue so a caller can write
 * `const queue = assertExactCoverage(lane, buildQueue(lane))`. Every problem is named with the
 * file, because "the browser tier is 62 files today" is not a diagnosis.
 */
export function assertExactCoverage(lane, queue) {
  const laneSet = new Set(lane);
  const seen = new Set();
  const repeated = [];
  const unknown = [];
  for (const file of queue) {
    if (seen.has(file)) repeated.push(file);
    else seen.add(file);
    if (!laneSet.has(file)) unknown.push(file);
  }
  const dropped = lane.filter((file) => !seen.has(file));
  const problems = [];
  if (dropped.length) problems.push(`not queued: ${dropped.join(", ")}`);
  if (repeated.length) problems.push(`queued more than once: ${[...new Set(repeated)].join(", ")}`);
  if (unknown.length) problems.push(`queued but not in the browser lane: ${[...new Set(unknown)].join(", ")}`);
  if (problems.length) {
    throw new Error(`[shards] the browser tier's queue does not cover its lane — ${problems.join("; ")}`);
  }
  return queue;
}

if (import.meta.main) {
  const { classify } = await import("./test-lanes.mjs");
  const lane = classify().browser.map(({ file }) => `tests/${file}`);
  const queue = assertExactCoverage(lane, buildQueue(lane));
  if (process.argv.includes("--check")) {
    console.log(`[shards] ok: ${queue.length} browser files, each queued exactly once`);
    process.exit(0);
  }
  console.log(queue.join(" "));
}
