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
// a time. Each file still gets its own Node process and ephemeral-port server. Default-option
// launch() calls use one warm Chromium *per worker* with a disposable CDP browser context per test;
// a file requesting custom dimensions, fake devices/audio, or a prepared profile keeps its own
// browser process. Neither a test process nor one worker may reap another worker's warm browser.
// This is a measured, conservative extension of the original isolated-browser design: the prior
// runner recorded ~0.39s browser startup, so no 75–180s win is assumed without a same-tree run.
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
//   node tools/browser-shard-runner.mjs                  # two workers, the whole browser lane
//   node tools/browser-shard-runner.mjs --workers 2      # fewer, for a loaded box
//   node tools/browser-shard-runner.mjs --only tests/x.test.mjs
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { classify } from "../scripts/test-lanes.mjs";
import { assertExactCoverage, buildQueue, isFailed, splitQueue, TIER_WORKERS } from "../scripts/test-shards.mjs";
import { emitMarker, testChildEnv } from "../scripts/gate-manifest.mjs";
import { loadavg1m } from "../lib/host-load.mjs";
import { findBrowserBinary } from "../lib/browser-binaries.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = argv.indexOf(`--${name}`);
  return at === -1 ? fallback : argv[at + 1];
};
// THE WIDTH COMES FROM THE ONE OWNER, AND THERE IS NO SECOND DEFAULT (voicebox-beads-q4j6). This line used
// to be `?? 4`, and because `scripts/gate-tier.mjs` spawns this runner with NO `--workers`, that literal was
// the FULL GATE'S browser width while the gate's own log line printed `TIER_WORKERS.browser` - two numbers
// for one fact, which had already drifted apart by the time q4j6 was filed, and the number in the log was
// the wrong one. The env var and `--workers` stay as the deliberate overrides for a loaded box.
const WORKERS = Math.max(1, Number(flag("workers", process.env.VOICEBOX_SHARD_WORKERS ?? TIER_WORKERS.browser)));
// A bounded same-tree A/B measurement and a rollback lever if shared contexts prove incompatible.
const COLD_BROWSERS = argv.includes("--cold-browsers");
// Repeated --only entries keep focused two-file reuse/crash tests within the actual browser lane.
const ONLY = argv.flatMap((arg, i) => arg === "--only" ? [argv[i + 1]] : []);
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
const files = ONLY.length ? queue.filter((file) => ONLY.includes(file)) : queue;
const missing = ONLY.find((file) => !queue.includes(file));
if (missing || files.length !== (ONLY.length || files.length)) {
  console.error(`[shards] --only ${missing ?? "duplicate file"} is not in the browser lane${PHASE ? `'s ${PHASE} phase` : ""}; nothing to run`);
  process.exit(2);
}

const running = new Map(); // pid -> {file, ...}
const warmBrowsers = new Map(); // worker index -> browser OS process owned by THIS runner
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

function stopWarm(worker) {
  const warm = warmBrowsers.get(worker);
  if (!warm) return;
  warmBrowsers.delete(worker);
  try { warm.child.stdout?.destroy(); } catch {}
  try { warm.child.stderr?.destroy(); } catch {}
  killGroup(warm.child, "SIGKILL");
  try { rmSync(warm.profile, { recursive: true, force: true }); } catch {}
}

// A killed runner never leaves the persistent browsers behind. They are separate process groups
// from test children, so killing a timed-out file does not kill another worker's browser.
process.on("exit", () => {
  for (const worker of warmBrowsers.keys()) stopWarm(worker);
});

// Only a file whose call sites are all literally launch() can profit from the default-option pool.
// An ambiguous call or an absent launch is cold. cdp.launch independently checks its *runtime*
// options, so source inspection is only a conservative resource-budget hint, never permission to
// run a specialized test with incorrect process flags.
function offersWarmBrowser(file) {
  const source = readFileSync(path.join(ROOT, file), "utf8");
  const calls = [...source.matchAll(/\blaunch\s*\(([^)]*)\)/g)];
  return calls.length > 0 && calls.every(([, options]) => !options.trim());
}

async function warmHealthy(warm) {
  if (!warm || warm.child.exitCode !== null || warm.child.signalCode !== null) return false;
  const versionUrl = warm.wsUrl.replace(/^ws:/, "http:").replace(/\/devtools\/browser\/[^/]+$/, "/json/version");
  try {
    const response = await fetch(versionUrl, { signal: AbortSignal.timeout(1000) });
    return response.ok && (await response.json()).webSocketDebuggerUrl === warm.wsUrl;
  } catch {
    return false;
  }
}

async function startWarm(worker) {
  const binary = findBrowserBinary();
  if (!binary) return null; // retain each browser test's own named missing-browser precondition
  const profile = mkdtempSync(path.join(os.tmpdir(), "voicebox-shard-chrome-"));
  const child = spawn(binary, [
    "--headless=new", "--no-sandbox", "--no-zygote", "--disable-crash-reporter",
    "--disable-gpu", "--disable-extensions", "--disable-component-extensions-with-background-pages",
    "--disable-background-networking", "--disable-component-update", "--no-first-run",
    "--no-default-browser-check", "--disable-dev-shm-usage", "--window-size=1000,800",
    `--user-data-dir=${profile}`, "--remote-debugging-port=0", "about:blank",
  ], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
  const warm = { child, profile, wsUrl: null };
  warmBrowsers.set(worker, warm); // register before the first await, including startup errors/signals
  try {
    warm.wsUrl = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Chromium endpoint timed out")), 20_000);
      let buffer = "", settled = false;
      const scan = (chunk) => {
        if (settled) return; // keep draining Chromium's pipes without accumulating its logs
        buffer = (buffer + String(chunk)).slice(-8192);
        const match = buffer.match(/ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[0-9a-f-]+(?=\s)/);
        if (match) {
          settled = true;
          clearTimeout(timer);
          resolve(match[0]);
        }
      };
      child.stderr.on("data", scan);
      child.stdout.on("data", scan);
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`Chromium exited early (${code})`)); });
    });
    console.log(`[shards] warm browser started for worker ${worker} pid=${child.pid}`);
    return warm;
  } catch (error) {
    console.error(`[shards] worker ${worker} warm startup failed (${error.message}); using a standalone browser for this file`);
    stopWarm(worker);
    return null;
  }
}
let stopping = false;
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.once(sig, () => {
    stopping = true;
    for (const { child } of running.values()) killGroup(child, "SIGTERM");
    for (const worker of warmBrowsers.keys()) stopWarm(worker);
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

function runFile(file, warmUrl = null) {
  return new Promise((resolve) => {
    const at = Date.now();
    // THE LOG IS THE HUB'S COVERAGE EVIDENCE (voicebox-beads-zjpm.3). `fleet-check` reads this gate log
    // with the hub's check-coverage.py, which recognises `fast-gate: <kind>: <path>` at line start; without
    // it a full-gate PASS carries no runner evidence and the hub can only report coverage UNKNOWN. Only
    // TERMINAL markers are emitted, below, from this file's own result: `running:` is read by that
    // extractor as proof of execution, and a killed run cannot retract it (see scripts/gate-manifest.mjs).
    console.log(`[shards] running ${file}`);
    const env = testChildEnv();
    delete env.VOICEBOX_SHARED_CDP_URL; // never inherit another runner's endpoint into a nested run
    if (warmUrl) env.VOICEBOX_SHARED_CDP_URL = warmUrl;
    const child = spawn(process.execPath, ["--test", "--test-reporter=tap", file], {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
      // A gate child is TOP-LEVEL, not nested — `testChildEnv` owns that fact and why, including the
      // measured case where a nested child is skipped and this runner then reports a file it never ran as
      // failed for "no test counts were reported" (voicebox-beads-zjpm.3).
      env,
    });
    let out = "";
    const eat = (chunk) => (out += String(chunk));
    child.stdout.on("data", eat);
    child.stderr.on("data", eat);
    const timer = setTimeout(() => {
      killGroup(child, "SIGTERM");
      setTimeout(() => killGroup(child, "SIGKILL"), 5000).unref();
    }, FILE_TIMEOUT_MS);
    // THE BOX, AROUND THIS FILE. Two readings bracket the child's own window (voicebox-beads-zjpm.6): the
    // same file measured 12.2s at four-way idle and 39.1s in a loaded gate, and before this the artifact held
    // only the 39.1s. These are 1-minute averages, so they lag a burst — which is why both ends are kept and
    // why nothing here retries or excuses anything: a loaded box is still a red gate.
    const loadStart = loadavg1m();
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
        loadavg_1m: { start: loadStart, end: loadavg1m() },
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
        // ONE LINE, IN THE FAILURE BLOCK, SAYING WHAT THE BOX WAS DOING. It goes after the end marker so the
        // file's own output stays verbatim, and it ATTRIBUTES rather than excuses: there is no retry, no
        // isolation and no longer bound anywhere behind it. Reading a red file an hour later, "it timed out"
        // and "the box was at 27" were previously the same log line.
        console.log(
          `[shards] host loadavg (1m) start ${result.loadavg_1m.start ?? "?"} end ${result.loadavg_1m.end ?? "?"} on ${os.cpus().length} cpu(s) — a reading, not a waiver: a loaded box is still a red gate`,
        );
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
async function workerLoop(worker) {
  try {
    for (;;) {
      if (stopping) return;
      const index = cursor++;
      if (index >= phase.length) return;
      const file = phase[index];
      if (COLD_BROWSERS || !offersWarmBrowser(file)) {
        // Do not hold an idle process beside a specialized test's dedicated Chromium.
        stopWarm(worker);
      } else if (!(await warmHealthy(warmBrowsers.get(worker)))) {
        stopWarm(worker);
        await startWarm(worker);
      }
      if (stopping) return;
      const result = await runFile(file, warmBrowsers.get(worker)?.wsUrl);
      // A failure/timeout may have poisoned the browser; replacement occurs before the next file.
      if (isFailed(result)) stopWarm(worker);
    }
  } finally {
    stopWarm(worker);
  }
}

// A phase invocation runs its own slice and nothing else; an unphased invocation keeps the original
// two-stage behaviour (parallel queue, then the isolated files alone).
const split = PHASE ? { parallel: PHASE === "parallel" ? files : [], isolated: PHASE === "isolated" ? files : [] } : splitQueue(files);
phase = PHASE ? files : split.parallel;
if (split.parallel.length) {
  await Promise.all(Array.from({ length: Math.min(WORKERS, split.parallel.length) }, (_, worker) => workerLoop(worker)));
}
if (split.isolated.length && PHASE !== "parallel") {
  if (!PHASE) {
    console.log(
      `[shards] ${split.isolated.length} file(s) isolated (run alone, after the queue, still exactly once): ${split.isolated.join(", ")} — reason in scripts/test-shards.mjs ISOLATED`,
    );
  }
  cursor = 0;
  phase = split.isolated;
  await Promise.all(Array.from({ length: Math.min(1, split.isolated.length) }, (_, worker) => workerLoop(worker)));
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
      // The manifest keeps this per file: a sweep of the browser tier can then show which files were measured
      // on a loaded box and which were not, without anybody re-running anything (voicebox-beads-zjpm.6).
      loadavg_1m: r.loadavg_1m ?? null,
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
