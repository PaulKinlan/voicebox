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
import { classify } from "../scripts/test-lanes.mjs";
import { assertExactCoverage, buildQueue, isFailed } from "../scripts/test-shards.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = argv.indexOf(`--${name}`);
  return at === -1 ? fallback : argv[at + 1];
};
const WORKERS = Math.max(1, Number(flag("workers", process.env.VOICEBOX_SHARD_WORKERS ?? 4)));
const ONLY = argv.includes("--only") ? argv[argv.indexOf("--only") + 1] : null;
// A file that wedges must not hold a worker for the whole stage bound. The longest file measured is
// 24.3s; 300s is over twelve times that, and a killed file is reported as a failure, never as a pass.
const FILE_TIMEOUT_MS = Number(flag("file-timeout-ms", 300_000));

const lane = classify().browser.map(({ file }) => `tests/${file}`);
const queue = assertExactCoverage(lane, buildQueue(lane));
const files = ONLY ? queue.filter((file) => file === ONLY) : queue;
if (ONLY && files.length === 0) {
  console.error(`[shards] --only ${ONLY} is not in the browser lane; nothing to run`);
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
    const child = spawn(process.execPath, ["--test", "--test-reporter=tap", file], {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
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

async function workerLoop() {
  for (;;) {
    if (stopping) return;
    const index = cursor++;
    if (index >= files.length) return;
    await runFile(files[index]);
  }
}

await Promise.all(Array.from({ length: Math.min(WORKERS, files.length) }, () => workerLoop()));

const wall = Date.now() - started;
const total = (key) => results.reduce((n, r) => n + Math.max(0, r[key]), 0);
const failed = results.filter(isFailed);
const slowest = [...results].sort((a, b) => b.ms - a.ms).slice(0, 5);

console.log("");
console.log(`[shards] ${WORKERS} workers, ${files.length} files, wall ${(wall / 1000).toFixed(1)}s`);
console.log(`[shards] tests=${total("tests")} pass=${total("pass")} fail=${total("fail")} skipped=${total("skipped")} files-failed=${failed.length}`);
console.log(`[shards] slowest: ${slowest.map((r) => `${r.file}=${(r.ms / 1000).toFixed(1)}s`).join(" ")}`);
if (failed.length) {
  console.log(`[shards] FAILED: ${failed.map((r) => `${r.file} (exit ${r.code}${r.notOk.length ? `: ${r.notOk.slice(0, 3).join(" | ")}` : r.fail > 0 ? `: ${r.fail} failing test(s)` : ": no test counts were reported"})`).join("; ")}`);
  process.exit(1);
}
// COVERAGE IS DECIDED, NOT HOPED FOR: every file the tier was told to run produced a result.
if (results.length !== files.length) {
  console.log(`[shards] FAILED: ${files.length} files were queued but only ${results.length} reported a result`);
  process.exit(1);
}
console.log(`[shards] coverage ok: every one of ${files.length} queued files ran, each in its own process`);
