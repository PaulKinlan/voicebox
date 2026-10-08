// docs/evidence/3lwx-cdp-cleanup-20261008/old-helper-repro.mjs — the controlled experiment behind
// voicebox-beads-3lwx: the SAME three conditions, asked with the OLD check (verbatim from
// d2a2db6: tests/cdp-process-cleanup.test.mjs) and with the NEW witness, next to what was
// independently true of each process.
//
//   node docs/evidence/3lwx-cdp-cleanup-20261008/old-helper-repro.mjs
//
// Nothing here is a browser: the failing assertion was about how a PID is read, and these three
// processes isolate that question from Chrome. No tree is written to; every child is killed in a
// `finally`, and the script prints the table the receipt quotes.
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

// ── the OLD helpers, verbatim from tests/cdp-process-cleanup.test.mjs at d2a2db6 ─────────────────
function oldIsPidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code !== "ESRCH";
  }
}
async function oldWaitForPidGone(pid, maxAttempts = 20, delayMs = 50) {
  let alive = oldIsPidAlive(pid);
  for (let i = 0; i < maxAttempts && alive; i++) {
    await new Promise((r) => setTimeout(r, delayMs));
    alive = oldIsPidAlive(pid);
  }
  return !alive;
}

// ── the NEW witness, as landed ────────────────────────────────────────────────────────────────────
function snapshot(pid) {
  if (!pid) return null;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return { state: fields[0], starttime: fields[19] };
  } catch {
    return null;
  }
}
function terminated(pid, identity) {
  const now = snapshot(pid);
  if (now === null) return true;
  if (now.state === "Z") return true;
  if (!identity || identity.starttime === undefined || identity.starttime === null) return true;
  return now.starttime !== identity.starttime;
}
async function waitTerminated(pid, identity, { maxAttempts = 100, delayMs = 100 } = {}) {
  for (let i = 0; i < maxAttempts; i++) {
    if (terminated(pid, identity)) return { terminated: true, waitedMs: i * delayMs };
    await sleep(delayMs);
  }
  return { terminated: false, waitedMs: maxAttempts * delayMs };
}
const ps = (pid) => (spawnSync("ps", ["-o", "pid,ppid,stat,comm", "-p", String(pid)], { encoding: "utf8" }).stdout || "").trim().split("\n").join(" | ");

const rows = [];
const record = (condition, truth, oldSays, newSays, detail) => {
  rows.push({ condition, truth, "old check": oldSays, "new witness": newSays, detail });
  console.log(`${condition}\n  truth:       ${truth}\n  old check:   ${oldSays}\n  new witness: ${newSays}\n  detail:      ${detail}\n`);
};

// ── CONDITION 1: a REAL zombie whose only collector is stopped ────────────────────────────────────
// The ordering is the experiment: kill the child while its collector runs and libuv collects it in
// milliseconds, so the collector is STOPPED first — then the child is killed and its slot stays.
{
  const starter = `
    import { spawn } from "node:child_process";
    const child = spawn("sleep", ["600"], { detached: true, stdio: "ignore" });
    console.log("SLEEP_PID:" + child.pid);
    console.log("RUNNER_PID:" + process.pid);
    await new Promise((r) => setTimeout(r, 300));
    process.kill(process.pid, "SIGSTOP");
  `;
  const runner = spawn(process.execPath, ["--input-type=module", "-e", starter], { stdio: ["ignore", "pipe", "ignore"] });
  let out = "";
  runner.stdout.on("data", (d) => { out += String(d); });
  try {
    const until = Date.now() + 5000;
    while (!/RUNNER_PID:(\d+)/.test(out) && Date.now() < until) await sleep(20);
    const sleepPid = Number(out.match(/SLEEP_PID:(\d+)/)?.[1]);
    const runnerPid = Number(out.match(/RUNNER_PID:(\d+)/)?.[1]);
    const stopUntil = Date.now() + 5000;
    while (snapshot(runnerPid)?.state !== "T" && Date.now() < stopUntil) await sleep(20);
    const identity = snapshot(sleepPid);
    process.kill(-sleepPid, "SIGKILL");
    let snap = snapshot(sleepPid);
    const zombieUntil = Date.now() + 5000;
    while (snap && snap.state !== "Z" && Date.now() < zombieUntil) {
      await sleep(20);
      snap = snapshot(sleepPid);
    }
    const oldSaid = await oldWaitForPidGone(sleepPid); // 20 × 50ms, the bound the gate ran with
    const newSaid = await waitTerminated(sleepPid, identity, { maxAttempts: 3, delayMs: 50 });
    record(
      "1. a terminated process whose collector is stopped (a real zombie)",
      snap?.state === "Z" ? "TERMINATED — the slot holds only a zombie; it runs nothing" : `NOT A ZOMBIE (state ${snap?.state})`,
      oldSaid ? "terminated" : "SURVIVOR — reported as a leak",
      newSaid.terminated ? "terminated" : "SURVIVOR — reported as a leak",
      `${ps(sleepPid)} · kill(pid,0) on the same pid answers "${oldIsPidAlive(sleepPid)}"`,
    );
  } finally {
    runner.kill("SIGKILL");
    await sleep(100);
  }
}

// ── CONDITION 2: THE REPRODUCTION — a teardown collected at 1.8s ──────────────────────────────────
{
  const child = spawn("sleep", ["600"], { detached: true, stdio: "ignore" });
  const killTimer = setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch {} }, 1800);
  try {
    const identity = snapshot(child.pid);
    const startedAt = Date.now();
    const oldSaid = await oldWaitForPidGone(child.pid); // 20 × 50ms = 1000ms of asking
    const oldMs = Date.now() - startedAt;
    const newSaid = await waitTerminated(child.pid, identity);
    const elapsed = Date.now() - startedAt;
    const afterwards = snapshot(child.pid);
    record(
      "2. a teardown the kernel collects at 1800ms (the reported failure, without load)",
      truthOf(afterwards),
      oldSaid ? "terminated" : `SURVIVOR after ${oldMs}ms — reported as a leak`,
      newSaid.terminated ? `terminated after ${elapsed}ms` : "SURVIVOR — reported as a leak",
      `the same process, asked again afterwards: ${afterwards === null ? "absent from /proc (provably collected)" : ps(child.pid)}`,
    );
  } finally {
    clearTimeout(killTimer);
    try { process.kill(-child.pid, "SIGKILL"); } catch {}
  }
}

// ── CONDITION 3: THE CONTROL — a process that is genuinely still running ───────────────────────────
{
  const child = spawn("sleep", ["600"], { detached: true, stdio: "ignore" });
  try {
    const identity = snapshot(child.pid);
    const oldSaid = await oldWaitForPidGone(child.pid, 3, 50);
    const newSaid = await waitTerminated(child.pid, identity, { maxAttempts: 3, delayMs: 50 });
    record(
      "3. a process that is really still running (the leak the test exists for)",
      `RUNNING — ${ps(child.pid)}`,
      oldSaid ? "terminated" : "SURVIVOR",
      newSaid.terminated ? "terminated" : "SURVIVOR",
      "both checks must say SURVIVOR here: the fix must not blank the leak check",
    );
  } finally {
    try { process.kill(-child.pid, "SIGKILL"); } catch {}
  }
}

function truthOf(snap) {
  return snap === null ? "TERMINATED — the slot is free" : snap.state === "Z" ? "TERMINATED — a zombie" : `RUNNING (state ${snap.state})`;
}

console.log("SUMMARY");
for (const row of rows) {
  console.log(`- ${row.condition}\n    truth: ${row.truth}\n    old:   ${row["old check"]}\n    new:   ${row["new witness"]}`);
}
