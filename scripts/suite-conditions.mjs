#!/usr/bin/env node
// Opt-in three-condition diagnostic for a named test file. Never changes the original gate verdict.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { loadavg1m, hostCores } from "../lib/host-load.mjs";
import { tierFiles, runOneTier } from "./gate-tier.mjs";
import { ISOLATED, TIER_WORKERS } from "./test-shards.mjs";
import { killRunningChildren, runOneFile, statusOf } from "./test-changed.mjs";
import { classifySuiteConditions } from "./suite-condition-verdict.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// voicebox-beads-eoy1: MEASURED per-arm bounds for named slow-warm fixtures. The 10s default
// arm bound cannot classify a fixture that legitimately runs 6-30s per arm (browser boot +
// nested runner files; measured in ohg8 and reproduced locally at ~7s idle), so its three
// conditions kept coming back UNKNOWN for a HEALTHY fixture — hiding exactly the signal this
// diagnostic exists for. The map raises the bound ONLY for the named file (never lowers it;
// every other suite keeps the caller's bound), and the artifact records the bound used so
// the evidence stays auditable. 60s is the measured worst case plus margin, not a global raise.
const MEASURED_FIXTURE_ARM_BOUNDS_MS = new Map([
  ["tests/browser-shard-runner.test.mjs", 60000],
]);
const armBoundMs = (file, timeoutMs) => Math.max(timeoutMs, MEASURED_FIXTURE_ARM_BOUNDS_MS.get(file) ?? 0);
const incomplete = (reason, load = null) => ({ status: "unknown", secs: null, loadavg_1m: { start: load, end: loadavg1m() }, reason });
const killGroup = (child) => { try { process.kill(-child.pid, "SIGTERM"); } catch { try { child.kill("SIGTERM"); } catch {} } };
let activeHolder = null;

/** Peer holder: fleet-heavy owns the slot in a separate process while this caller runs the suite directly. */
export function startLoadedPeer({ targetLoad, waitMs = 35000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn("fleet-heavy", [process.execPath, "scripts/suite-load-holder.mjs", String(targetLoad)], {
      cwd: ROOT, detached: true, stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, FLEET_HEAVY_HELD: "" },
    });
    activeHolder = child;
    let settled = false;
    let alive = true;
    let output = "";
    const finish = (ready, reason) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!ready) { killGroup(child); if (activeHolder === child) activeHolder = null; }
      resolve({ ready, reason, holder: ready ? `fleet-heavy:suite-load-holder.mjs pid=${child.pid}` : "none (peer holder not acquired)", isAlive: () => alive, stop: () => { child.stdin.end(); killGroup(child); if (activeHolder === child) activeHolder = null; } });
    };
    const timer = setTimeout(() => finish(false, "peer holder did not reach measured target load within bound"), waitMs);
    child.stdout.on("data", (chunk) => {
      output += String(chunk).slice(0, 1024);
      if (/^READY\s+\d+(?:\.\d+)?\s*$/m.test(output)) finish(true, "peer holder reached observed target load");
      if (output.length > 2048) output = output.slice(-1024);
    });
    child.on("error", (err) => finish(false, `peer holder could not start: ${err.message}`));
    child.on("exit", () => { alive = false; finish(false, "peer holder exited before acquired/load-ready handshake"); });
  });
}

/** Run exactly one arm and retain the machine reading from each side of the file's window. */
async function measure(run, timeoutMs, readLoad = loadavg1m) {
  const start = readLoad();
  try {
    const result = await run(timeoutMs);
    return { status: result.status, secs: result.secs ?? null, loadavg_1m: { start, end: readLoad() }, ...(result.reason ? { reason: result.reason } : {}) };
  } catch (err) {
    return { status: "unknown", secs: null, loadavg_1m: { start, end: readLoad() }, reason: `measurement could not finish: ${String(err?.message ?? err).slice(0, 160)}` };
  }
}

/** The three arms are one observation each, in order: never retry a red or unknown arm. */
export async function measureSuite(file, { tier, timeoutMs = 10000, targetLoad = null, peer = startLoadedPeer, runFile = runOneFile, runTier = runOneTier, roster = tierFiles(tier), readLoad = loadavg1m, parentHoldsSlot = Boolean(process.env.FLEET_HEAVY_HELD) } = {}) {
  if (!tier || !roster.includes(file)) throw new Error(`${file}: not in the ${tier} tier's classified roster`);
  const perArmMs = armBoundMs(file, timeoutMs);
  const call = async () => {
    const result = await runFile(file, { timeoutMs: perArmMs });
    return { status: statusOf(result), secs: result.secs };
  };
  const conditions = {};
  let holder = "none (peer holder not acquired)";
  conditions.standalone = await measure(call, perArmMs, readLoad);
  if (parentHoldsSlot) {
    conditions.heavy_slot = incomplete("parent already holds the heavy slot; peer-held contention cannot be measured reentrantly");
  } else {
    const baseline = readLoad();
    const target = targetLoad ?? (baseline === null ? null : Math.round((baseline + Math.min(1.5, hostCores().available_parallelism)) * 100) / 100);
    if (target === null) conditions.heavy_slot = incomplete("host does not report load average");
    else {
      let held;
      try { held = await peer({ targetLoad: target }); }
      catch (err) { held = { ready: false, reason: `peer holder unavailable: ${String(err?.message ?? err).slice(0, 160)}` }; }
      if (held.holder) holder = held.holder;
      if (!held.ready) conditions.heavy_slot = incomplete(held.reason);
      else if (!held.holder) {
        conditions.heavy_slot = incomplete("peer holder did not identify itself; cannot attest peer-held measurement");
        held.stop();
      } else {
        try {
          conditions.heavy_slot = await measure(call, perArmMs, readLoad);
          if (held.isAlive && !held.isAlive()) conditions.heavy_slot = incomplete("peer holder exited during measured suite; contention not established");
          else if (conditions.heavy_slot.loadavg_1m.start === null || conditions.heavy_slot.loadavg_1m.end === null ||
                   conditions.heavy_slot.loadavg_1m.start < target || conditions.heavy_slot.loadavg_1m.end < target) {
            conditions.heavy_slot = incomplete("observed load fell below the peer holder target during the suite");
          }
        } finally { held.stop(); }
      }
    }
  }
  const workers = TIER_WORKERS[tier];
  const peers = roster.filter((name) => name !== file && !ISOLATED.has(name)).slice(0, Math.max(0, workers - 1));
  if (ISOLATED.has(file) || peers.length < workers - 1) {
    conditions.shard_concurrency = incomplete("cannot measure at configured tier width without changing the tier's isolation/roster");
  } else {
    conditions.shard_concurrency = await measure(async () => {
      const record = await runTier({ tier, files: [file, ...peers], workers, timeoutMs: perArmMs, log: { log() {}, error() {} } });
      const target = record.files.find((entry) => entry.path === file);
      return { status: target?.status ?? "unknown", secs: target?.secs ?? null };
    }, perArmMs, readLoad);
  }
  // The tier file already owns its path, status and verdict. Conditions are only optional evidence.
  const suiteCommand = `node --test --test-reporter=tap ${file}`;
  const entries = [
    { condition: "standalone", ...conditions.standalone, worker_count: 1, command: suiteCommand },
    // heavy_slot means a SEPARATE holder produces measured contention; the suite never owns or queues for its lock.
    { condition: "heavy_slot", ...conditions.heavy_slot, worker_count: 1, command: suiteCommand, holder },
    { condition: "shard_concurrency", ...conditions.shard_concurrency, worker_count: workers, command: `node scripts/suite-conditions.mjs --tier ${tier} --file ${file} --dir <artifact-dir>` },
  ];
  // Internal classification is for the CLI report, not a second gate verdict in the artifact.
  return { suite: file, tier, conditions: entries };
}

export function attachConditionRecord(record, tierPath) {
  const tier = JSON.parse(readFileSync(tierPath, "utf8"));
  const entry = tier.files?.find((file) => file.path === record.suite);
  if (tier.tier !== record.tier || !entry || entry.status === "passed" || entry.condition_request !== "pending") {
    throw new Error(`${record.suite}: no pending failed suite in ${tierPath}; refusing to overwrite the gate record`);
  }
  // This is an evidence-only update. The file's original status, counts and tier verdict never change.
  entry.conditions = record.conditions;
  delete entry.condition_request;
  const temp = `${tierPath}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(tier, null, 2)}\n`);
  renameSync(temp, tierPath);
}

export function writeConditionRecord(record, dir) {
  mkdirSync(dir, { recursive: true });
  const key = createHash("sha256").update(record.suite).digest("hex").slice(0, 16);
  const target = path.join(dir, `${key}.conditions.json`);
  const temp = `${target}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`);
  renameSync(temp, target);
  return target;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => {
    if (activeHolder) killGroup(activeHolder);
    killRunningChildren();
    process.exit(signal === "SIGINT" ? 130 : 143);
  });
  const args = process.argv.slice(2);
  const value = (flag) => args[args.indexOf(flag) + 1];
  const files = args.flatMap((arg, index) => arg === "--file" ? [args[index + 1]] : []);
  const dir = args.includes("--dir") ? value("--dir") : null;
  const tier = args.includes("--tier") ? value("--tier") : null;
  const fileSecs = args.includes("--file-secs") ? Number(value("--file-secs")) : 10;
  const targetLoad = args.includes("--target-load") ? Number(value("--target-load")) : null;
  const tierRecord = args.includes("--tier-record") ? value("--tier-record") : null;
  if (!files.length || files.length > 4 || !dir || dir.startsWith("--") || !["unit", "server", "browser"].includes(tier) ||
      !Number.isFinite(fileSecs) || fileSecs <= 0 || fileSecs > 30 ||
      (targetLoad !== null && (!Number.isFinite(targetLoad) || targetLoad < 0))) {
    console.error("usage: node scripts/suite-conditions.mjs --tier unit|server|browser --file tests/name.test.mjs [--file ... up to 4] --dir <artifact-dir> [--tier-record <retained-tier.json>] [--file-secs 1..30] [--target-load <number>]");
    process.exitCode = 2;
  } else {
    const maxArmMs = Math.max(...files.map((f) => armBoundMs(f, fileSecs * 1000)));
    const maxTotalMs = Math.max(120000, files.length * (3 * maxArmMs + 40000));
    // A detached lane can never wedge indefinitely: signal cleanup leaves any unfinished arm UNKNOWN.
    // The total bound scales with the requested files' arm bounds (voicebox-beads-eoy1): a named
    // slow-warm fixture's three 60s arms + holder handshake cannot fit 120s, and cutting the last
    // arm at a fixed bound would ship incomplete evidence for a healthy fixture all over again.
    // Ordinary files keep the original 120s floor exactly.
    const bound = setTimeout(() => {
      if (activeHolder) killGroup(activeHolder);
      killRunningChildren();
      console.error(`[conditions] total ${Math.round(maxTotalMs / 1000)}s bound expired; unfinished measurements remain UNKNOWN`);
      process.exit(124);
    }, maxTotalMs);
    for (const file of files) {
      try {
        if (tierRecord && process.env.FLEET_HEAVY_HELD) throw new Error("the original gate still owns the heavy slot; wait until it releases before attaching peer-held evidence");
        const record = await measureSuite(file, { tier, timeoutMs: fileSecs * 1000, targetLoad });
        const written = writeConditionRecord(record, dir);
        if (tierRecord) attachConditionRecord(record, tierRecord);
        const byName = Object.fromEntries(record.conditions.map(({ condition, ...arm }) => [condition, arm]));
        const diagnosis = classifySuiteConditions(file, byName);
        console.log(`[conditions] ${diagnosis.verdict} ${file}: ${diagnosis.reason}; arm bound ${armBoundMs(file, fileSecs * 1000) / 1000}s; ${written}`);
        if (diagnosis.verdict !== "passed") process.exitCode = 1;
      } catch (err) { console.error(`[conditions] ${file}: incomplete — ${err.message}`); process.exitCode = 1; }
    }
    clearTimeout(bound);
  }
}
