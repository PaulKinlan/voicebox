#!/usr/bin/env node
// scripts/gate-tier.mjs — the full gate's per-file dispatch, one TIER at a time (voicebox-beads-wiby).
//
// WHY THIS EXISTS. `voicebox-beads-zjpm.3` gave the FAST gate an artifact that says what it measured, and
// `voicebox-beads-wiby` is the merger's static preflight on its own landing path: `npm run gate` ran
// docs-check, single-owner, unit, live and acceptance, but never invoked the aggregate — so the full gate
// could print ALL GATES GREEN and leave no `<tree>.full.manifest.json` behind for anybody to read. A
// landing whose only evidence is a log line is a landing nobody can audit afterwards.
//
// WHAT THIS DOES. Each tier is dispatched FILE BY FILE, in its own process, with its own timeout and its
// own exit code, and the results are written as ONE TIER RECORD that the single aggregator
// (`scripts/gate-manifest.mjs aggregate`, see `tierRecordPath`) folds into the full manifest. That shape is
// deliberate and already proven in this tree: it is exactly what `scripts/test-changed.mjs --gate` does for
// the fast gate and what `tools/browser-shard-runner.mjs` does for the browser tier, so the manifest's
// record for a file means the same thing whichever tier produced it.
//
// WHY NOT ONE `node --test <all files>` PER TIER. The aggregate needs a terminal status, a test count and a
// duration PER FILE, and a single aggregate run cannot give them: measured on this tree (node 24.21),
// `node --test a.test.mjs b.test.mjs --test-reporter=tap` prints the files' tests FLATTENED at top level —
// there is no per-file boundary in the output at all — so the only way to say "which file is this PASS
// about" is to run the file. Per-file dispatch also buys the two facts a full gate is most often wrong
// about: a file that WEDGES is killed at its own budget and recorded `timeout` (one file's failure, not the
// whole tier's), and a child whose exit was lost is recorded `unknown` rather than counted green.
//
// CONCURRENCY IS UNCHANGED, and that is a measured claim, not an intention: the unit lane's default
// `--test-concurrency` has always been `os.availableParallelism() - 1`, and the server lane's has been 4
// (`npm run test:live` passes `--test-concurrency=4`); those are the worker counts here (TIER_WORKERS), so
// the same number of files is in flight as before. The browser tier is not re-implemented either — it is
// `tools/browser-shard-runner.mjs`, which owns its own queue, its own isolation list and its own record.
//
//   node scripts/gate-tier.mjs --tier unit --dir <scratch>       # the unit lane, per file
//   node scripts/gate-tier.mjs --tier server --dir <scratch>     # the server tier, per file
//   node scripts/gate-tier.mjs --tier live --dir <scratch>       # server then browser (what test:live runs)
//   node scripts/gate-tier.mjs --tier browser --dir <scratch>    # the browser tier alone
//
// EXIT CODE: 0 only when the tier COMPLETED (every file in its lane has exactly one terminal record) and
// every dispatched file PASSED. That is the tier's own answer about itself; the union reconciliation stays
// with the one aggregator, and the pre-push gate runs it as its last stage.
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { classify } from "./test-lanes.mjs";
import { ISOLATED, TIER_WORKERS } from "./test-shards.mjs";
import { coverageGaps, emitMarker, tapCounts, tierRecordPath } from "./gate-manifest.mjs";
import { killRunningChildren, runOneFile, statusOf } from "./test-changed.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * TIER_WORKERS — the concurrency each tier runs at — lives in `scripts/test-shards.mjs`, which both tier
 * dispatchers already import (test-changed.mjs, for the fast gate, used to carry its own default of 2: two
 * copies of one fact, and the wrong one was in the fast gate). The reason the counts are not re-derived from
 * `npm run test:unit` / `npm run test:live` is unchanged: a dispatcher must not make a tier slower OR
 * concurrent-er than the lane it replaces (voicebox-beads-zjpm, speed is a design constraint).
 */

/** A tier's lane, as the gate names the files (`tests/<name>`), from the ONE classifier. */
export function tierFiles(tier, classified = classify()) {
  return (classified[tier] ?? []).map(({ file }) => `tests/${file}`);
}

/** The top-level `ok`/`not ok` results in a single file's TAP report. `# Subtest:` comments are not results. */
export function topLevelTapResults(text) {
  const results = [];
  for (const line of text.split("\n")) {
    const m = /^(ok|not ok)\s+\d+\s+-\s+(.*)$/.exec(line);
    if (m) results.push({ ok: m[1] === "ok", name: m[2].replace(/\s+#\s.*$/, "").trim() });
  }
  return results;
}

/** Is this TAP result name the file itself? Node names a path relative, absolute or `file://` — all three. */
const namesTheFile = (name, file) => {
  const strip = (s) => String(s).replace(/^file:\/\//, "");
  return strip(name) === strip(file) || path.resolve(strip(name)) === path.resolve(strip(file));
};

/**
 * A file's test counts, with the ZERO-TEST case made visible.
 *
 * A file with no tests is not silent: node reports ONE synthetic top-level result whose name IS THE FILE
 * PATH (`ok 1 - tests/zero.test.mjs`, `# tests 1` — measured on node 24.21), and counting that as a test is
 * how a file that demonstrates nothing looks like a one-test pass. The manifest refuses a passing file with
 * zero tests by name, and this is the half of that refusal that knows the synthetic entry is not a test.
 * Only the passing, single-result shape is rewritten: a file whose import throws reports the same
 * file-named entry as a FAILURE, which is a real failure and must keep its counts.
 */
export function testCounts(file, text) {
  const counts = tapCounts(text);
  const results = topLevelTapResults(text);
  if (counts.tests === 1 && results.length === 1 && results[0].ok && namesTheFile(results[0].name, file)) {
    return { tests: 0, pass: 0, fail: 0, skipped: counts.skipped > 0 ? 1 : 0 };
  }
  return counts;
}

/** One dispatched file's record, in the shape `gate-manifest.mjs`'s `recordTier` folds. */
export function recordOf(file, result, timeoutMs) {
  const counts = testCounts(file, result.out ?? "");
  return {
    path: file,
    status: statusOf({ ...result, counts }),
    counts: counts.tests >= 0 ? counts : null,
    timeout_ms: timeoutMs,
    secs: Number.isFinite(result.secs) ? result.secs : null,
  };
}

/**
 * Run one tier's files, each in its own process. The files that measure the BOX (scripts/test-shards.mjs
 * owns that list) run alone, after the queue — the same partition the browser tier uses, reused rather than
 * re-derived. Returns the tier record; nothing is written here.
 */
export async function runOneTier({ tier, files, workers = TIER_WORKERS[tier] ?? 1, timeoutMs = 240_000, runner = runOneFile, log = console }) {
  const results = [];
  let cursor = 0;
  const run = async (file) => {
    log.log(`[gate-tier] running ${file}`);
    const result = await runner(file, { timeoutMs });
    const record = recordOf(file, result, timeoutMs);
    results.push(record);
    if (record.status === "passed") log.log(emitMarker("passed", [file]));
    else if (record.status === "failed") log.log(emitMarker("failed", [file]));
    else log.log(emitMarker("unknown", [`${file} (${record.status})`]));
    log.log(
      `[gate-tier] ${record.status.toUpperCase().padEnd(7)} ${String(Math.round((record.secs ?? 0) * 1000)).padStart(7)}ms ` +
        `tests=${record.counts?.tests ?? -1} pass=${record.counts?.pass ?? -1} fail=${record.counts?.fail ?? -1} ${file}`,
    );
    if (record.status !== "passed") {
      const tail = String(result.out ?? "").split("\n").slice(-40).join("\n");
      log.log(`[gate-tier] ---- output of ${file} ----\n${tail}\n[gate-tier] ---- end ${file} ----`);
    }
    return record;
  };

  const parallel = files.filter((f) => !ISOLATED.has(f));
  const alone = files.filter((f) => ISOLATED.has(f));
  const workerLoop = async () => {
    for (;;) {
      const index = cursor++;
      if (index >= parallel.length) return;
      await run(parallel[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, workers), Math.max(1, parallel.length)) }, () => workerLoop()));
  for (const file of alone) await run(file);
  // The record is in the LANE's order, not the queue's, so two runs of the same tier are comparable.
  return { tier, files: results.sort((a, b) => a.path.localeCompare(b.path)) };
}

/** Write a tier record atomically (tmp + rename): the aggregator never reads a half-written record. */
export function writeTierRecord(record, dir) {
  mkdirSync(dir, { recursive: true });
  const target = tierRecordPath(dir, record.tier);
  const tmp = `${target}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`);
  renameSync(tmp, target);
  return target;
}

/** The browser tier's child, while it runs: `stop()` must take it with the per-file children. */
let browserChild = null;

/**
 * The browser tier, through the runner that owns it (`tools/browser-shard-runner.mjs`). It writes its own
 * record at `VOICEBOX_GATE_TIER_RECORD` — one owner per tier — and this function's job is only to give it
 * the path, keep its output streaming, and answer with its exit code. SIGTERM is left to the runner itself:
 * it takes its own per-file children (and their browsers) down before it goes.
 */
export function runBrowserTier({ dir, log = console }) {
  const record = tierRecordPath(dir, "browser");
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["tools/browser-shard-runner.mjs"], {
      cwd: ROOT,
      stdio: "inherit",
      env: { ...process.env, VOICEBOX_GATE_TIER_RECORD: record },
    });
    browserChild = child;
    child.on("exit", (code, signal) => {
      if (browserChild === child) browserChild = null;
      resolve({ code: code ?? (signal ? 1 : 0), record });
    });
    child.on("error", (error) => {
      if (browserChild === child) browserChild = null;
      log.error(`[gate-tier] the browser tier could not be started: ${error.message}`);
      resolve({ code: 1, record });
    });
  });
}

/** The tier's own verdict: did it complete, and did it pass? Names every file that says no. */
export function tierVerdict(record, files) {
  const problems = coverageGaps(record, files);
  const notPassed = (record?.files ?? []).filter((f) => f.status !== "passed");
  return { problems, notPassed, ok: problems.length === 0 && notPassed.length === 0 };
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (name, fallback = null) => {
    const at = args.indexOf(`--${name}`);
    return at === -1 ? fallback : args[at + 1];
  };
  const tier = flag("tier");
  const dir = flag("dir", process.env.VOICEBOX_GATE_TIER_DIR ?? null);
  const timeoutMs = Number(flag("file-secs", process.env.VOICEBOX_GATE_FILE_SECS ?? 240)) * 1000;

  if (!["unit", "server", "browser", "live"].includes(tier ?? "")) {
    console.error("[gate-tier] usage: node scripts/gate-tier.mjs --tier unit|server|browser|live --dir <scratch dir>");
    return 2;
  }
  if (!dir || dir.startsWith("--")) {
    console.error("[gate-tier] REFUSED: --dir names the scratch directory the tier records go in (or set VOICEBOX_GATE_TIER_DIR)");
    console.error("[gate-tier]   the aggregate reads those files; a tier that cannot write its record has no evidence to fold");
    return 2;
  }
  // THE DIRECTORY IS OURS TO MAKE: the browser tier's runner writes its own record with `writeFileSync` (one
  // owner per tier) and does not create the directory, so a `--dir` that does not exist yet costs that
  // whole tier's record — measured: 75 browser files ran green and the aggregate refused the tree for a
  // missing record, which is fail-closed but is a refusal about plumbing rather than about the code.
  mkdirSync(dir, { recursive: true });

  // A gate that is terminated must not leave browsers and servers behind: the per-file children lead their
  // own process groups (so a per-file timeout can take a wedged file down with its browser), which means
  // nothing else kills them when THIS process is signalled. The browser-tier child is tracked the same way.
  //
  // THE HANDLER MUST ALSO LEAVE. Installing a signal handler SUPPRESSES node's default termination, so a
  // process that answers SIGTERM by tidying up and then carrying on is a process the outer
  // `timeout --kill-after` has to SIGKILL — and it would keep scanning a lane it has already given up on.
  const stop = (signal) => {
    killRunningChildren(signal);
    if (browserChild) {
      try {
        browserChild.kill(signal);
      } catch {
        /* already gone */
      }
    }
    setTimeout(() => process.exit(128 + (os.constants.signals[signal] ?? 0)), 3000).unref();
  };
  for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, () => stop(signal));

  // ── LIVE = the server tier then the browser tier, in that order, which is what `npm run test:live`
  // runs (`node --test server… && node tools/browser-shard-runner.mjs`). The `&&` is load-bearing: a red
  // server tier stops the gate before it spends the browser tier's minutes.
  const sequence = tier === "live" ? ["server", "browser"] : [tier];
  const failed = [];
  for (const one of sequence) {
    if (one === "browser") {
      const { code, record: recordPath } = await runBrowserTier({ dir });
      const record = readRecord(recordPath);
      const files = tierFiles("browser");
      const gaps = coverageGaps(record, files);
      const notPassed = (record?.files ?? []).filter((f) => f.status !== "passed");
      for (const f of record?.files ?? []) console.log(emitMarker(f.status === "passed" ? "passed" : f.status === "failed" ? "failed" : "unknown", [f.path]));
      console.log(`[gate-tier] browser: ${files.length} file(s) in lane, ${record?.files?.length ?? 0} recorded, ${notPassed.length} not passed, exit ${code}`);
      if (gaps.length > 0 || notPassed.length > 0 || code !== 0) {
        failed.push({ tier: "browser", code, gaps, notPassed });
        break;
      }
      continue;
    }
    const files = tierFiles(one);
    console.log(`[gate-tier] ${one}: ${files.length} file(s), ${TIER_WORKERS[one] ?? 1} worker(s), ${timeoutMs / 1000}s per file`);
    const record = await runOneTier({ tier: one, files, workers: TIER_WORKERS[one], timeoutMs });
    const written = writeTierRecord(record, dir);
    const verdict = tierVerdict(record, files);
    console.log(`[gate-tier] tier record: ${written}`);
    console.log(
      `[gate-tier] ${one}: ${record.files.length} recorded, ${record.files.filter((f) => f.status === "passed").length} passed, ` +
        `${record.files.filter((f) => f.status === "failed").length} failed, ${record.files.filter((f) => !["passed", "failed"].includes(f.status)).length} not terminal`,
    );
    if (!verdict.ok) {
      failed.push({ tier: one, gaps: verdict.problems, notPassed: verdict.notPassed });
      break;
    }
  }

  if (failed.length > 0) {
    const { tier: which, gaps = [], notPassed = [], code } = failed[0];
    console.error(`[gate-tier] REFUSED: the ${which} tier did not complete green${code === undefined ? "" : ` (exit ${code})`}`);
    for (const file of notPassed.slice(0, 20)) console.error(`  · ${file.path} (${file.status}${file.counts ? `: tests=${file.counts.tests} fail=${file.counts.fail}` : ": no counts reported"})`);
    for (const problem of gaps.slice(0, 20)) console.error(`  · ${problem}`);
    return 1;
  }
  console.log(`[gate-tier] ${tier}: every file in the lane has a terminal record and passed`);
  return 0;
}

/** Read a tier record, or null when the tier wrote none — a missing record is the aggregate's business, not a crash. */
function readRecord(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

if (process.argv[1] && process.argv[1].endsWith("gate-tier.mjs")) {
  process.exit(await main());
}
