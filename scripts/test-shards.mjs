#!/usr/bin/env node
// scripts/test-shards.mjs — the browser tier's work queue, and the proof that it covers the lane.
//
// WHY THIS IS A VALUE AND NOT A SHELL EXPANSION (voicebox-beads-hhkg, ADR voicebox-beads-g9jf):
// the browser tier is the whole cost of the gate's live stage — measured 2026-10-11 on this tree,
// 63 files and 284.3s serial, and 395.5s in the box's own last full-gate log under load. Making it
// run in parallel shards is worth ~2.2x, but it also moves the tier's coverage from "whatever the shell
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
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

/**
 * THE CONCURRENCY EACH TIER RUNS AT, for every dispatcher that runs a tier file by file.
 *
 * ONE OWNER (voicebox-beads-buy8). These counts used to live in `scripts/gate-tier.mjs`, which was the
 * full gate's dispatcher, and the fast gate (`scripts/test-changed.mjs --gate`) carried its own default of
 * 2 — a number no tier has ever run at. The two dispatchers run the SAME lanes, so a tier's concurrency is
 * one fact and it is this one: `npm run test:unit` is one `node --test` over the unit lane (default
 * concurrency = availableParallelism - 1) and `npm run test:live` passes `--test-concurrency=4` to the
 * server lane, while the browser tier is `tools/browser-shard-runner.mjs`'s two shards. Nothing here
 * raises a lane's concurrency above what the full gate already runs: the point is that a scoped run may not
 * be MORE serial than the gate it is a strict subset of. Measured on the fast gate's own 159-file fused.js
 * scope (2026-10-14): the accidental 2-worker default cost 273s of wall clock where the tier's own
 * concurrency costs 190s.
 *
 * TWO SHARDS FOR THE BROWSER TIER, BECAUSE FOUR IS NOT SAFE (voicebox-beads-q4j6, measured 2026-10-15).
 * Wall time is why the browser tier was widened; the tier's own evidence is why it cannot stay wide. Two
 * full-gate unions at four shards went red on DIFFERENT sets of files — 4c1441b: 8 files (extensions-ui
 * boot timeout, changelog-dialog, mini-app-architecture, explorer-folders, pip-presence,
 * environment-root-dialog, pip-window-styling, modal-panels) in 1095s; c47991b: 3 different files
 * (changelog-links build-stamp wait, room-explorer-ui, agent-monitor-miniapp 25s timeout) in 670s — while
 * every file that failed in either union passes STANDALONE (7/7 in 48s; all 8 pass standalone at 4c1441b),
 * neither union carries product changes against a green main, and the SAME union at two shards is green:
 * 250/250 files, browser tier 89/89, browser wall 750.1s, whole gate 984s (merger, 2026-10-15, tree
 * aef9e6e1 / union e22f9ed). A red whose failing set changes run to run cannot be attributed by any
 * reader, and nothing may retry, isolate or widen a bound to cover it, so the width is the shape that
 * changes: two shards costs wall time on the browser tier and buys a gate whose answer means something.
 * The failing set was invisible from inside any one file — a single browser file alone, at four-way and at
 * four-way plus burners, stayed green (voicebox-beads-18lh, loadavg 11) — which is why this is a TIER
 * measurement and not a per-file one.
 */
export const TIER_WORKERS = Object.freeze({ unit: Math.max(1, os.availableParallelism() - 1), server: 4, browser: 2 });

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

/**
 * Whether a finished file counts as a FAILURE. The exit code is the authority — Node's test runner
 * sets it non-zero for any failing test — and the other three conditions are there because an exit
 * code can be lost or absent in exactly the cases where nobody is watching:
 *   · a child killed by a signal reports `code === null`, so it cannot be trusted to be green;
 *   · a TAP run that reported `fail > 0` or an `not ok` line is failing whatever the code says;
 *   · `tests < 0` means the reporter's summary was never seen at all (a spawn that errored, a run
 *     cut short), and a file that reported NO counts must never be recorded as a pass — that is the
 *     one shape of bug that would let this tier buy speed by running less.
 * Kept here, not inline in the runner, so the refusal is a value a test can hold.
 */
export function isFailed({ code, tests, fail, notOk }) {
  return code !== 0 || fail > 0 || notOk.length > 0 || tests < 0;
}

/**
 * THE FILES THAT MUST NOT RUN BESIDE ANOTHER.
 *
 * Every browser file is independent by construction — its own process, its own ephemeral-port server,
 * its own browser — which is what makes the sharding safe. One file is not independent of the BOX:
 * `tests/ldxa-barge-in-browser.test.mjs` drives the real audio path through Chromium's fake-audio
 * device, and its own comments record that the device lags its file under CPU load (+76ms idle,
 * +366ms at 4-core load). Measured 2026-10-11 (voicebox-beads-hhkg, filed as voicebox-beads-9c3r):
 * with four workers it failed `tests/ldxa-barge-in-browser.test.mjs:168` — "playback must be flushed,
 * not left playing", `true !== false` — twice in nine concurrent runs of the whole tier, and passed
 * every focused control: alone, alone through this runner, and beside three other browser files at
 * four-way concurrency without this runner. The same assertion, with the same "inside the full gate /
 * green in isolation" profile, was already recorded as environmental in voicebox-beads-y82w.
 *
 * SO IT RUNS ALONE, AFTER THE PARALLEL QUEUE. This is a SCHEDULING change, not a repair: the file
 * still runs, exactly once, with every assertion it has, and `tests/test-shards.test.mjs` proves the
 * split is a partition. It is also not a claim that the flake is gone — voicebox-beads-9c3r stays
 * open for a deterministic reproduction, and the honest reading of this list is "one measured
 * casualty of CPU contention, isolated until somebody can fail it on demand".
 *
 * THE SECOND CASUALTY IS A FILE WHOSE SUBJECT IS WALL-CLOCK BUDGET ENFORCEMENT (voicebox-beads-0nt3).
 * `tests/pre-push.test.mjs` drives the real pre-push gate and asserts that each stage's output
 * appeared BEFORE the stage's budget killed it, using an accelerated budget in its `timeout` shim:
 * the stage must print, then be killed, then be reported as TIMED OUT. The thing it measures is the
 * startup of `timeout → npm → sh → node`, and on a loaded box that startup is longer than the
 * budget it is given. Measured 2026-10-12 on this VM: time-to-marker 0.25s idle, 1.76–3.41s at
 * loadavg 6 (32 CPU burners on 8 vCPU), and 5.2–6.3s at 8x oversubscription — while the shim's
 * budget was 2s and the suite's own elapsed assertion accepts at most 10s. So there is no budget
 * value that is both large enough for a contended box and small enough for that assertion: at 4
 * workers the file failed the psfw union full gate (tests/pre-push.test.mjs:227, "LIVE OUTPUT
 * BEFORE TERMINATION" absent, slowest file 62.6s) and passed the xzrr union on the identical
 * blobs. It is also the tier's slowest file (67.3s under 4 workers vs 23.3s alone), so it is
 * paying the contention twice: once in its duration, once in the race that only exists because of
 * it. Run alone, its shim keeps a 5×–20× margin over the same chain.
 */
export const ISOLATED = new Set(["tests/ldxa-barge-in-browser.test.mjs", "tests/pre-push.test.mjs"]);

/**
 * Split a queue into the part that runs with `workers` shards and the part that runs alone. Pure: it
 * partitions and nothing else, so the caller keeps `assertExactCoverage` as the one guard on the
 * whole queue and `tests/test-shards.test.mjs` can hold the partition property directly. A name in
 * `isolated` that is not in the queue simply lands nowhere, which is why the unit test asserts every
 * isolated name is a real browser-lane file: a renamed file would otherwise rejoin the parallel run
 * silently and bring its flake back with it.
 */
export function splitQueue(queue, isolated = ISOLATED) {
  return {
    parallel: queue.filter((file) => !isolated.has(file)),
    isolated: queue.filter((file) => isolated.has(file)),
  };
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
