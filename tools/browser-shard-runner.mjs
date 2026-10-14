#!/usr/bin/env node
// tools/browser-shard-runner.mjs — the browser tier, in four concurrent shards.
//
// THE PROBLEM (voicebox-beads-hhkg, ADR voicebox-beads-g9jf): the browser tier is the whole cost of
// the gate's live stage. Measured on this tree, 2026-10-11: 63 files, 284.3s one file at a time on a
// quiet box, 395.5s in the box's own last full-gate log under load — against a 400s bound
// (VOICEBOX_GATE_LIVE_SECS), i.e. a stage that can be killed for finishing rather than for failing.
// The files are independent: each spawns its own server on an ephemeral port and its own browser,
// and the only reason they ever ran serially was that the parent process could not tell which of
// them a raw `--test-concurrency` would put in flight together.
//
// WHAT THIS DOES: builds the tier's work queue from the lane classifier (`scripts/test-shards.mjs`),
// REFUSES the queue unless it covers the lane exactly once, and then runs up to `--workers` files at
// a time. Each file still gets its own process, its own server and its own browser — the isolation
// every fixture was written against is unchanged — and the shards are the CONCURRENCY, not a
// long-lived shared instance. That is deliberate: 44 of the 63 files hand `startServer()` their own
// VOICEBOX_INSTANCE / VOICEBOX_WORKSPACE / VOICEBOX_EXTENSIONS_DIR, which are process environment,
// and 10 more need browser-level flags (`fakeMedia`, a prepared profile) that a shared browser
// cannot give a single tab. A shared instance is not available to these fixtures without rewriting
// them, and the parallelism is where the time was anyway: per-file launch overhead measures ~0.6s of
// a ~4.5s file (warm browser launch 0.39s, server start 0.21s), so instance reuse can win ~10% while
// the shards win 2.2x.
//
// WORK-STEALING, NOT PARTITIONING: the ADR describes four pinned shards, and a static split needs a
// cost model for the files. Measured over all 63 per-file durations, the best cheap proxy (byte
// size, r=0.51 against wall time) mispredicts the tier's longest file — pre-push, 24.3s of 249
// tests — by enough to leave one shard running 63% longer than another. A worker that takes the
// next file when it is free has no such blind spot, and the queue is ordered longest-first so the
// TAIL of the run is short, which is the one part stealing cannot fix.
//
// THE NUMBERS ARE THE GATE'S EVIDENCE: every file's wall time and test counts are printed as it
// finishes, and the run ends with a total plus an explicit coverage line. A tier that got faster by
// running fewer tests is the failure this file is written to make impossible, so the totals are
// compared against what the lane is expected to contribute before the exit code is decided.
//
//   node tools/browser-shard-runner.mjs                  # four workers, the whole browser lane
//   node tools/browser-shard-runner.mjs --workers 2      # fewer, for a loaded box
//   node tools/browser-shard-runner.mjs --only tests/x.test.mjs
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync } from "node:fs";
import { classify } from "../scripts/test-lanes.mjs";
import { assertExactCoverage, buildQueue, isFailed, splitQueue } from "../scripts/test-shards.mjs";
import { emitMarker, testChildEnv } from "../scripts/gate-manifest.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = argv.indexOf(`--${name}`);
  return at === -1 ? fallback : argv[at + 1];
};
const WORKERS = Math.max(1, Number(flag("workers", process.env.VOICEBOX_SHARD_WORKERS ?? 4)));
const ONLY = argv.includes("--only") ? argv[argv.indexOf("--only") + 1] : null;
// PHASED INVOCATIONS (agreed with the live-tier supervisor, zjpm.2): a supervisor may run the tier in two
// processes — the parallel queue first, beside the server pool, then the isolated files on an otherwise
// idle box — because the phases want different box conditions. Each invocation now asserts its own PHASE
// exactly, and the UNION receipt is the aggregate manifest: a phase that quietly drops a file is caught by
// `scripts/gate-manifest.mjs aggregate`, which refuses a file no tier recorded (see PHASES below).
const PARALLEL_ONLY = argv.includes("--parallel-only");
const ISOLATED_ONLY = argv.includes("--isolated-only");
const PHASE = PARALLEL_ONLY ? "parallel" : ISOLATED_ONLY ? "isolated" : null;
if (PARALLEL_ONLY && ISOLATED_ONLY) {
  console.error("[shards] --parallel-only and --isolated-only are mutually exclusive: each names the one phase this process runs");
  process.exit(2);
}
// A file that wedges must not hold a worker for the whole stage bound. The longest file measured is
// 24.3s; 300s is over twelve times that, and a killed file is reported as a failure, never as a pass.
const FILE_TIMEOUT_MS = Number(flag("file-timeout-ms", 300_000));

const lane = classify().browser.map(({ file }) => `tests/${file}`);
const laneQueue = buildQueue(lane);
// The phase's slice of the lane, from the one owner of that partition (scripts/test-shards.mjs). A phase is
// asserted to cover ITS SLICE exactly once, so a slice can never silently drop or invent a file; that the
// two slices together are the lane is `splitQueue`'s own partition property, held by tests/test-shards.test.mjs.
const laneSplit = splitQueue(laneQueue);
const phaseQueue = PHASE === "parallel" ? laneSplit.parallel : PHASE === "isolated" ? laneSplit.isolated : laneQueue;
const queue = assertExactCoverage(phaseQueue, buildQueue(phaseQueue));
if (PHASE && queue.length === 0) {
  console.error(`[shards] --${PHASE}-only: the ${PHASE} phase is empty; nothing to run`);
  process.exit(2);
}
const files = ONLY ? queue.filter((file) => file === ONLY) : queue;
if (ONLY && files.length === 0) {
  console.error(`[shards] --only ${ONLY} is not in the browser lane${PHASE ? `'s ${PHASE} phase` : ""}; nothing to run`);
  process.exit(2);
}

const running = new Map(); // pid -> {file, ...}
/**
 * One way a child dies: SIGTERM to its own group first so the file's `process.on(signal)` reapers in
 * tests/lib/cdp.mjs and tests/lib/server.mjs can take their browser and server down with them, then
 * SIGKILL after a short grace. A SIGKILL straight away would orphan every Chromium the file started.
 */
function killGroup(child, signal) {
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* already gone */
    }
  }
}
let stopping = false;
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.once(sig, () => {
    stopping = true;
    for (const { child } of running.values()) killGroup(child, "SIGTERM");
    setTimeout(() => {
      for (const { child } of running.values()) killGroup(child, "SIGKILL");
      process.exit(128 + (os.constants.signals[sig] ?? 0));
    }, 3000).unref();
  });
}

const counts = (text, kind) => Number(new RegExp(`^# ${kind} (\\d+)$`, "m").exec(text)?.[1] ?? -1);
const notOk = (text) => [...text.matchAll(/^not ok \d+ - (.+)$/gm)].map((m) => m[1]);

const results = [];
const started = Date.now();
// The queue cursor is shared, so the workers steal in order and a finished file frees exactly one slot.
let cursor = 0;

function runFile(file) {
  return new Promise((resolve) => {
    const at = Date.now();
    // THE LOG IS THE HUB'S COVERAGE EVIDENCE (voicebox-beads-zjpm.3). `fleet-check` reads this gate log
    // with the hub's check-coverage.py, which recognises `fast-gate: <kind>: <path>` at line start; without
    // it a full-gate PASS carries no runner evidence and the hub can only report coverage UNKNOWN. Only
    // TERMINAL markers are emitted, below, from this file's own result: `running:` is read by that
    // extractor as proof of execution, and a killed run cannot retract it (see scripts/gate-manifest.mjs).
    console.log(`[shards] running ${file}`);
    const child = spawn(process.execPath, ["--test", "--test-reporter=tap", file], {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
      // A gate child is TOP-LEVEL, not nested — `testChildEnv` owns that fact and why, including the
      // measured case where a nested child is skipped and this runner then reports a file it never ran as
      // failed for "no test counts were reported" (voicebox-beads-zjpm.3).
      env: testChildEnv(),
    });
    let out = "";
    const eat = (chunk) => (out += String(chunk));
    child.stdout.on("data", eat);
    child.stderr.on("data", eat);
    const timer = setTimeout(() => {
      killGroup(child, "SIGTERM");
      setTimeout(() => killGroup(child, "SIGKILL"), 5000).unref();
    }, FILE_TIMEOUT_MS);
    const entry = { file, child };
    running.set(child.pid, entry);
    // EXACTLY ONE RESULT PER FILE, whichever way the child ends (reviewer finding, P2). `exit` is
    // not the only ending: a `spawn` that fails asynchronously (EMFILE, ENOMEM, EAGAIN) emits
    // `error` and may never emit `exit` at all — and an unhandled `error` on a child process takes
    // the whole runner down with an uncaught EventEmitter exception, which is a crash rather than a
    // reported failure. `settled` keeps the two paths from double-counting a file that does both.
    let settled = false;
    const settle = (code, signal, note = "") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      running.delete(child.pid);
      const ms = Date.now() - at;
      const result = {
        file,
        ms,
        code: code ?? (signal ? 1 : 0),
        tests: counts(out, "tests"),
        pass: counts(out, "pass"),
        fail: counts(out, "fail"),
        skipped: counts(out, "skipped"),
        notOk: notOk(out),
        out: note ? `${note}\n${out}` : out,
      };
      results.push(result);
      const status = isFailed(result) ? "FAIL" : "ok  ";
      // The marker follows this runner's own verdict (`isFailed`, which refuses to trust an exit code
      // alone); a file that produced no counts is `unknown`, never a pass, and the hub then reports the
      // whole run's coverage as UNKNOWN rather than counting the file as covered.
      console.log(emitMarker(!isFailed(result) ? "passed" : result.tests >= 0 ? "failed" : "unknown", [file]));
      console.log(
        `[shards] ${status} ${String(ms).padStart(7)}ms tests=${result.tests} pass=${result.pass} fail=${result.fail} skipped=${result.skipped} ${file}`,
      );
      if (isFailed(result)) {
        const tail = out.split("\n").slice(-60).join("\n");
        console.log(`[shards] ---- output of ${file} ----\n${tail}\n[shards] ---- end ${file} ----`);
      }
      resolve(result);
    };
    child.on("exit", (code, signal) => settle(code, signal));
    child.on("error", (error) => settle(1, null, `the test file could not be spawned: ${error.message}`));
  });
}

// TWO PHASES. The parallel queue first, with `WORKERS` shards stealing from one cursor; then the
// isolated files one at a time, on an otherwise idle box. `phase`/`cursor` are shared across the
// worker loops, so draining is just two runs of the same loop and there is no second scheduler to
// keep in step with the first. `tests/test-shards.test.mjs` proves the two phases are a PARTITION of
// the queue — a file cannot be in both, and none can be in neither.
let phase = files;
async function workerLoop() {
  for (;;) {
    if (stopping) return;
    const index = cursor++;
    if (index >= phase.length) return;
    await runFile(phase[index]);
  }
}

// A phase invocation runs its own slice and nothing else; an unphased invocation keeps the original
// two-stage behaviour (parallel queue, then the isolated files alone).
const split = PHASE ? { parallel: PHASE === "parallel" ? files : [], isolated: PHASE === "isolated" ? files : [] } : splitQueue(files);
phase = PHASE ? files : split.parallel;
if (split.parallel.length) {
  await Promise.all(Array.from({ length: Math.min(WORKERS, split.parallel.length) }, () => workerLoop()));
}
if (split.isolated.length && PHASE !== "parallel") {
  if (!PHASE) {
    console.log(
      `[shards] ${split.isolated.length} file(s) isolated (run alone, after the queue, still exactly once): ${split.isolated.join(", ")} — reason in scripts/test-shards.mjs ISOLATED`,
    );
  }
  cursor = 0;
  phase = split.isolated;
  await Promise.all(Array.from({ length: Math.min(1, split.isolated.length) }, () => workerLoop()));
}

// A TIER RECORD, not a manifest: this runner knows what IT dispatched and nothing about the roster the
// unit and server tiers cover, so it publishes records and leaves reconciliation to the one aggregator
// (scripts/gate-manifest.mjs, `recordTier`). Writing a partial manifest here would be a second, weaker
// answer to a question that already has an owner.
if (process.env.VOICEBOX_GATE_TIER_RECORD) {
  // ONE FILE PER INVOCATION, BY CONSTRUCTION. The supervisor runs this tier twice (parallel, then
  // isolated); if both wrote the same path the second would overwrite the first and the union would be
  // short by a whole phase — which the aggregate manifest would then refuse as missing files, or worse,
  // an aggregator could paper over. The phase is inserted into the name here so that cannot happen.
  const tierRecordPath = PHASE ? process.env.VOICEBOX_GATE_TIER_RECORD.replace(/(\.json)?$/, `.${PHASE}$1`) : process.env.VOICEBOX_GATE_TIER_RECORD;
  const record = {
    tier: "browser",
    phase: PHASE ?? "all",
    files: results.map((r) => ({
      path: r.file,
      status: !isFailed(r) ? "passed" : r.tests >= 0 ? "failed" : "unknown",
      counts: r.tests >= 0 ? { tests: r.tests, pass: r.pass, fail: r.fail, skipped: r.skipped } : null,
      timeout_ms: FILE_TIMEOUT_MS,
      secs: Math.round(r.ms) / 1000,
    })),
  };
  try {
    writeFileSync(tierRecordPath, `${JSON.stringify(record, null, 2)}\n`);
    console.log(`[shards] tier record: ${tierRecordPath}`);
  } catch (error) {
    console.log(`[shards] tier record could not be written (${error.message}) — the markers above remain the log's evidence`);
  }
}

const wall = Date.now() - started;
const total = (key) => results.reduce((n, r) => n + Math.max(0, r[key]), 0);
const failed = results.filter(isFailed);
const slowest = [...results].sort((a, b) => b.ms - a.ms).slice(0, 5);

console.log("");
console.log(
  `[shards] ${WORKERS} worker(s), ${files.length} file(s) queued${PHASE ? `, phase ${PHASE}` : ` (${split.isolated.length} isolated)`}, wall ${(wall / 1000).toFixed(1)}s`,
);
console.log(`[shards] tests=${total("tests")} pass=${total("pass")} fail=${total("fail")} skipped=${total("skipped")} files-failed=${failed.length}`);
console.log(`[shards] slowest: ${slowest.map((r) => `${r.file}=${(r.ms / 1000).toFixed(1)}s`).join(" ")}`);
// COVERAGE IS DECIDED, NOT HOPED FOR: every file the tier was told to run produced a result.
// It is reported BEFORE the failure exit (a red run is exactly when a reader needs to know whether
// the tier also ran less — the first red run this file produced printed no coverage line at all,
// because the failure path exited first). Distinct-file counting rather than a length compare, so a
// file that somehow reported twice cannot stand in for one that never ran.
const reported = new Set(results.map((r) => r.file)).size;
const covered = reported === files.length && results.length === files.length;
console.log(
  `[shards] coverage ${covered ? "ok" : "INCOMPLETE"}: ${results.length} result(s) for ${files.length} queued file(s), ${reported} distinct, each in its own process`,
);
if (failed.length) {
  console.log(`[shards] FAILED: ${failed.map((r) => `${r.file} (exit ${r.code}${r.notOk.length ? `: ${r.notOk.slice(0, 3).join(" | ")}` : r.fail > 0 ? `: ${r.fail} failing test(s)` : ": no test counts were reported"})`).join("; ")}`);
  process.exit(1);
}
if (!covered) {
  console.log(`[shards] FAILED: ${files.length} files were queued but ${results.length} reported a result (${reported} distinct)`);
  process.exit(1);
}
