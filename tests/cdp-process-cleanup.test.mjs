// tests/cdp-process-cleanup.test.mjs — negative throw-control and isolated browser process cleanup.
//
// Hardens CDP browser lifecycle against orphan helpers, zygote namespace traps, and unhandled
// test runner aborts or signals (voicebox-beads-uv1q).
//
// Mechanism notes (verified by measurement, roboticon review):
// 1. Browsers launched via tests/lib/cdp.mjs run in isolated process groups (`detached: true`)
//    with `--no-sandbox` and `--no-zygote`. On Linux, `--no-zygote` prevents Chromium from creating
//    an internal zygote PID namespace, where PID 1 in the namespace drops signal handlers and can
//    become an unkillable zombie if parent aborts abruptly.
// 2. Crashpad handlers (`chrome_crashpad_handler`) daemonize with `ppid=1` and run in their own
//    process group outside the browser's group; they monitor the browser process directly and
//    exit independently within <=500ms after the browser terminates.
// 3. Process groups are reaped synchronously via `process.kill(-pid, "SIGKILL")` on normal
//    teardown (`page.close()`, `abandon()`), unhandled runner exit (`process.on("exit")`),
//    and OS termination signals (`SIGTERM`, `SIGINT`, `SIGHUP`).
// 4. Assertions verify both that the browser's process group (`ps -g <pgid>`) is completely empty
//    and that no Chrome helper processes survive for the test's unique profile directory.
// 5. WHAT "GONE" MEANS (voicebox-beads-3lwx). `process.kill(pid, 0)` answers "does this PID exist",
//    not "is this process still running": it says yes for a process that has already terminated and
//    is only awaiting collection (a zombie, state `Z`) and yes for an unrelated process since given
//    the same PID. On 2026-10-08 the leader was still in /proc when the one-second bound expired, on
//    two runs of the same tree (06:55 and 11:53 — the second with two full gates on 2 CPUs, load
//    4.8, /tmp on disk), and the assertion could not say whether that was a leaked browser or a
//    teardown not yet collected. It now reads /proc for the state and for the process's own start
//    time, which is the identity a reused PID cannot fake: terminated = absent, or state `Z`, or a
//    different start time. A process still running under the identity we killed is the leak this
//    test is for, and it still fails — see the three synthetic-process cases at the end of this file.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { findBrowserBinary, launch } from "./lib/cdp.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ── THE WITNESS: /proc ───────────────────────────────────────────────────────────────────────────
// There is no portable "is this process the one I killed" answer, and this file runs where /proc
// exists. Without it (macOS) the old question is the only one available, and the helpers say so
// rather than pretending to a precision they do not have.
const PROC_FS = existsSync("/proc/self/stat");

/**
 * One read of a process's own record: its state and its start time.
 * `starttime` is field 22, the process's own clock ticks since boot — an identity a reused PID
 * cannot match (Linux does not reuse a PID at all until the space wraps, but the check costs a
 * string compare and removes the doubt). `comm` is parenthesised and may hold spaces and
 * parentheses, so the fields are read from after the LAST ')'.
 * Returns null when the PID does not exist (or /proc does).
 */
function procSnapshot(pid) {
  if (!pid || !PROC_FS) return null;
  let stat;
  try {
    stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch {
    return null;
  }
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  return { state: fields[0], ppid: Number(fields[1]), starttime: fields[19] };
}

/**
 * Does this PID EXIST — a zombie included? This is the question `kill(pid, 0)` really answers, and
 * it is the right one for one thing only: proving the browser is alive before we kill it.
 */
function isPidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code !== "ESRCH";
  }
}

/**
 * Has the process we killed TERMINATED? `identity` is the snapshot taken before the kill (null when
 * the process was already gone at that moment). True when the slot is free, when what holds it is a
 * zombie (terminated; only its exit status is unreaped), or when the holder is a different process
 * by start time. False only while a live process still holds the identity we killed.
 */
function pidTerminated(pid, identity) {
  const now = procSnapshot(pid);
  if (now === null) return true;
  if (now.state === "Z") return true;
  if (!identity || identity.starttime === undefined || identity.starttime === null) {
    // No identity was available to compare, so anything still here that is NOT a zombie is a
    // different process than the one that was already gone at capture time.
    return PROC_FS ? true : !isPidAlive(pid);
  }
  return now.starttime !== identity.starttime;
}

/** The witness line for a failure message: identity and state, never just "it was still there". */
function describePid(pid) {
  const snap = procSnapshot(pid);
  const ps = spawnSync("ps", ["-o", "pid,ppid,stat,etime,comm", "-p", String(pid)], { encoding: "utf8" });
  const table = (ps.stdout || "").trim().split("\n").join(" | ");
  if (snap === null) return `pid ${pid} is absent from /proc${table ? ` (ps: ${table})` : ""}`;
  const verdict = snap.state === "Z" ? "a ZOMBIE — terminated, awaiting collection" : `STILL RUNNING (state ${snap.state})`;
  return `pid ${pid} is ${verdict}; ps: ${table}`;
}

/**
 * Wait for the process behind `pid`/`identity` to terminate, bounded so a wedged process cannot hang
 * a suite. The bound is load-tolerant rather than one second (voicebox-beads-3lwx): the same tree
 * failed twice under a full gate on a loaded box, and the fix is not "wait longer" but "say what is
 * true" — this still returns `terminated: false` for a process that is genuinely still running.
 */
async function waitForPidGone(pid, identity, { maxAttempts = 100, delayMs = 100 } = {}) {
  for (let i = 0; i < maxAttempts; i++) {
    if (pidTerminated(pid, identity)) return { terminated: true, attempts: i, waitedMs: i * delayMs };
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return { terminated: false, attempts: maxAttempts, waitedMs: maxAttempts * delayMs };
}

/** A row from `ps -o pid,stat,…` that is a zombie: not a running process, merely an uncollected exit. */
function isZombieRow(line) {
  return /^\s*\d+\s+Z/.test(line);
}

async function waitForProcessGroupGone(pgid, maxAttempts = 100, delayMs = 100) {
  let remaining = [];
  for (let i = 0; i < maxAttempts; i++) {
    const ps = spawnSync("ps", ["-g", String(pgid), "-o", "pid,stat,comm"], { encoding: "utf8" });
    remaining = (ps.stdout || "").trim().split("\n").slice(1).filter(Boolean).filter((line) => !isZombieRow(line));
    if (remaining.length === 0) break;
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return remaining;
}

async function waitForProfileProcessesGone(profileDir, maxAttempts = 100, delayMs = 100) {
  let remaining = [];
  for (let i = 0; i < maxAttempts; i++) {
    const ps = spawnSync("ps", ["-C", "chrome,chrome_crashpad_handler", "-o", "pid,stat,args"], { encoding: "utf8" });
    const lines = (ps.stdout || "").trim().split("\n").slice(1).filter(Boolean);
    remaining = lines.filter((line) => line.includes(profileDir)).filter((line) => !isZombieRow(line));
    if (remaining.length === 0) break;
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return remaining;
}

test("cdp-process-cleanup: normal page.close() terminates browser process group and leaves zero descendants", async (t) => {
  const binary = findBrowserBinary();
  if (!binary) {
    t.skip("no browser binary found; set VOICEBOX_CHROME");
    return;
  }

  const profileDir = mkdtempSync(path.join(os.tmpdir(), "vb-cdp-normal-"));
  const page = await launch({ profile: profileDir });
  const browserPid = page.pid;
  const identity = procSnapshot(browserPid); // taken while it is alive: the identity a reused PID cannot fake
  assert.ok(browserPid > 0, "page must expose browser child PID");
  assert.equal(isPidAlive(browserPid), true, "browser process must be alive before close");
  assert.ok(identity, "the browser's own /proc record must be readable before the kill — the identity check needs it");

  await page.close();

  // 1. Observable assertion: the leader we launched is TERMINATED — absent, collected, or holding a
  //    different start time. "The PID is still in /proc" is not that claim (voicebox-beads-3lwx).
  const leaderGone = await waitForPidGone(browserPid, identity);
  assert.equal(leaderGone.terminated, true, `browser process ${browserPid} must be terminated after page.close() — ${describePid(browserPid)}`);

  // 2. Observable assertion: browser process group is completely empty (no zombie cat or helper processes)
  const groupRemaining = await waitForProcessGroupGone(browserPid);
  assert.equal(groupRemaining.length, 0, `no processes in group ${browserPid} should remain: ${groupRemaining.join(", ")}`);

  // 3. Observable assertion: all Chrome helpers and monitor daemons tied to profile exit
  const profileRemaining = await waitForProfileProcessesGone(profileDir);
  assert.equal(profileRemaining.length, 0, `no chrome processes for profile ${profileDir} should remain: ${profileRemaining.join("; ")}`);

  rmSync(profileDir, { recursive: true, force: true });
});

test("cdp-process-cleanup: negative throw-control — unhandled runner crash reaps browser without orphan helpers", async (t) => {
  const binary = findBrowserBinary();
  if (!binary) {
    t.skip("no browser binary found; set VOICEBOX_CHROME");
    return;
  }

  const profileDir = mkdtempSync(path.join(os.tmpdir(), "vb-cdp-throw-"));
  // Spawn an isolated child node runner that launches a browser and throws an unhandled error before close()
  const script = `
    import { launch } from "./tests/lib/cdp.mjs";
    const page = await launch({ profile: ${JSON.stringify(profileDir)} });
    console.log("BROWSER_PID:" + page.pid + "\\n");
    // Simulate unexpected runner crash / syntax error abort before normal teardown
    throw new Error("simulated unexpected test runner crash");
  `;

  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    cwd: ROOT,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => { stdout += String(d); });
  child.stderr.on("data", (d) => { stderr += String(d); });

  const exitCode = await new Promise((resolve) => {
    child.on("close", resolve);
  });

  assert.notEqual(exitCode, 0, "child runner process must fail on unhandled exception");
  assert.match(stderr, /simulated unexpected test runner crash/);

  const match = stdout.match(/BROWSER_PID:(\d+)\n/);
  assert.ok(match, `child runner must emit BROWSER_PID, stdout was: ${stdout}`);
  const browserPid = Number(match[1]);
  // The runner has already crashed, so the browser may be gone already: a snapshot that comes back
  // empty is the answer "it was terminated", not a missing witness.
  const identity = procSnapshot(browserPid);

  // 1. Observable assertion: the leader is terminated (see `pidTerminated` — a zombie is terminated)
  const leaderGone = await waitForPidGone(browserPid, identity);
  assert.equal(leaderGone.terminated, true, `browser PID ${browserPid} must not survive unhandled runner crash — ${describePid(browserPid)}`);

  // 2. Observable assertion: browser process group is completely empty
  const groupRemaining = await waitForProcessGroupGone(browserPid);
  assert.equal(groupRemaining.length, 0, `no processes in group ${browserPid} should remain: ${groupRemaining.join(", ")}`);

  // 3. Observable assertion: helper processes tied to profile cleanly exit
  const profileRemaining = await waitForProfileProcessesGone(profileDir);
  assert.equal(profileRemaining.length, 0, `no descendants of ${browserPid} should survive crash: ${profileRemaining.join("; ")}`);

  rmSync(profileDir, { recursive: true, force: true });
});

test("cdp-process-cleanup: signal termination — SIGTERM reaps browser process group without leaking processes", async (t) => {
  const binary = findBrowserBinary();
  if (!binary) {
    t.skip("no browser binary found; set VOICEBOX_CHROME");
    return;
  }

  const profileDir = mkdtempSync(path.join(os.tmpdir(), "vb-cdp-sigterm-"));
  // Spawn an isolated child node runner that launches a browser and hangs awaiting signal
  const script = `
    import { launch } from "./tests/lib/cdp.mjs";
    const page = await launch({ profile: ${JSON.stringify(profileDir)} });
    console.log("BROWSER_PID:" + page.pid + "\\n");
    await new Promise(() => {});
  `;

  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    cwd: ROOT,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  child.stdout.on("data", (d) => {
    stdout += String(d);
    const match = stdout.match(/BROWSER_PID:(\d+)\n/);
    if (match) {
      child.kill("SIGTERM");
    }
  });

  const exitCode = await new Promise((resolve) => {
    child.on("close", resolve);
  });

  // Runner terminates with 128 + 15 = 143 via process.once("SIGTERM")
  assert.equal(exitCode, 143, `child runner must exit with SIGTERM status 143, got ${exitCode}`);

  const match = stdout.match(/BROWSER_PID:(\d+)\n/);
  assert.ok(match, `child runner must emit BROWSER_PID, stdout was: ${stdout}`);
  const browserPid = Number(match[1]);
  const identity = procSnapshot(browserPid);

  // 1. Observable assertion: the leader is terminated after SIGTERM reaped the group
  const leaderGone = await waitForPidGone(browserPid, identity);
  assert.equal(leaderGone.terminated, true, `browser PID ${browserPid} must not survive SIGTERM — ${describePid(browserPid)}`);

  // 2. Observable assertion: browser process group is completely empty
  const groupRemaining = await waitForProcessGroupGone(browserPid);
  assert.equal(groupRemaining.length, 0, `no processes in group ${browserPid} should remain: ${groupRemaining.join(", ")}`);

  // 3. Observable assertion: helper processes tied to profile cleanly exit
  const profileRemaining = await waitForProfileProcessesGone(profileDir);
  assert.equal(profileRemaining.length, 0, `no processes for profile ${profileDir} should survive SIGTERM: ${profileRemaining.join("; ")}`);

  rmSync(profileDir, { recursive: true, force: true });
});

// ── THE THREE CASES THAT PIN THE DISTINCTION (voicebox-beads-3lwx — no browser needed) ──────────
// These are the controlled experiments behind the witness above: a REAL zombie, a teardown that
// outlasts the old one-second bound, and a process that is genuinely still running. The first two
// are the states the old check reported as a leak; the third is the leak it must keep reporting.

test("cdp-process-cleanup: a terminated process awaiting collection is not a survivor — and its group is empty (voicebox-beads-3lwx)", async (t) => {
  if (!PROC_FS) {
    t.skip("/proc is not available here, so the state witness (and this case) is Linux-only");
    return;
  }

  // A REAL zombie, not a constructed one. The ordering is the experiment: kill the child while its
  // only collector is still running and libuv collects it within milliseconds, leaving nothing to
  // look at — so the collector is STOPPED first, and only then is the child killed. Its slot then
  // stays occupied with state `Z`, and `kill(pid, 0)` — the old check — answers "alive" for it.
  const starter = `
    import { spawn } from "node:child_process";
    const child = spawn("sleep", ["600"], { detached: true, stdio: "ignore" });
    console.log("SLEEP_PID:" + child.pid);
    console.log("RUNNER_PID:" + process.pid);
    await new Promise((r) => setTimeout(r, 300));
    process.kill(process.pid, "SIGSTOP");
  `;
  const runner = spawn(process.execPath, ["--input-type=module", "-e", starter], { cwd: ROOT, stdio: ["ignore", "pipe", "ignore"] });
  let out = "";
  runner.stdout.on("data", (d) => { out += String(d); });
  try {
    const until = Date.now() + 5000;
    while (!/RUNNER_PID:(\d+)/.test(out) && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
    const sleepPid = Number(out.match(/SLEEP_PID:(\d+)/)?.[1]);
    const runnerPid = Number(out.match(/RUNNER_PID:(\d+)/)?.[1]);
    assert.ok(sleepPid && runnerPid, `the starter must report both pids; stdout was: ${out}`);

    const stopUntil = Date.now() + 5000;
    while (procSnapshot(runnerPid)?.state !== "T" && Date.now() < stopUntil) await new Promise((r) => setTimeout(r, 20));
    assert.equal(
      procSnapshot(runnerPid)?.state,
      "T",
      `the only process that may collect the child must be STOPPED before the child is killed — ${describePid(runnerPid)}`,
    );

    const identity = procSnapshot(sleepPid);
    assert.ok(identity, "the sleep process must be readable in /proc before the kill");

    process.kill(-sleepPid, "SIGKILL"); // detached made it its own group leader, so this kills only it
    let snap = procSnapshot(sleepPid);
    const zombieUntil = Date.now() + 5000;
    while (snap && snap.state !== "Z" && Date.now() < zombieUntil) {
      await new Promise((r) => setTimeout(r, 20));
      snap = procSnapshot(sleepPid);
    }
    assert.equal(snap?.state, "Z", `the killed process must be a zombie while its only reaper is stopped — ${describePid(sleepPid)}`);
    assert.equal(isPidAlive(sleepPid), true, "the OLD question (does the PID exist) must answer yes here — that is the false leak report");
    assert.equal(pidTerminated(sleepPid, identity), true, "the process HAS terminated: only its exit status is unreaped");
    assert.match(describePid(sleepPid), /ZOMBIE/);
    assert.deepEqual(
      await waitForProcessGroupGone(sleepPid, 3, 50),
      [],
      "a group holding only a zombie has no running descendant to report",
    );
  } finally {
    runner.kill("SIGKILL"); // the stopped reaper — SIGKILL reaches it — and the zombie is then collected
    await new Promise((r) => setTimeout(r, 100));
  }
});

test("cdp-process-cleanup: a teardown that outlasts one second is not read as a leak (voicebox-beads-3lwx)", async () => {
  // THE REPRODUCTION, without a browser and without load: the old check asked `kill(pid, 0)` every
  // 50ms for one second, so a teardown collected later than that was reported as a survivor. This
  // process is killed at 1.8s — collected inside the load-tolerant bound, outside the old one.
  const child = spawn("sleep", ["600"], { detached: true, stdio: "ignore" });
  const killTimer = setTimeout(() => {
    try { process.kill(-child.pid, "SIGKILL"); } catch {}
  }, 1800);
  const startedAt = Date.now();
  try {
    const identity = procSnapshot(child.pid);
    await new Promise((r) => setTimeout(r, 1000)); // exactly the old bound
    assert.equal(
      pidTerminated(child.pid, identity),
      false,
      "the reproduction is only meaningful if the teardown outlasts the old one-second bound",
    );
    const gone = await waitForPidGone(child.pid, identity);
    assert.equal(gone.terminated, true, `a process killed at 1800ms must be reported as terminated — ${describePid(child.pid)}`);
    const elapsed = Date.now() - startedAt;
    assert.ok(elapsed >= 1800, `the wait must have outlasted the old one-second bound (elapsed ${elapsed}ms)`);
  } finally {
    clearTimeout(killTimer);
    try { process.kill(-child.pid, "SIGKILL"); } catch {}
  }
});

test("cdp-process-cleanup: a process that is really still running is still reported as a survivor (voicebox-beads-3lwx)", async () => {
  // THE MUTATION CONTROL: the witness must not blank the leak check. This process is never killed, so
  // the helper must answer `terminated: false` — with a deliberately short bound, because its answer
  // is the whole point of the case.
  const child = spawn("sleep", ["600"], { detached: true, stdio: "ignore" });
  try {
    const identity = procSnapshot(child.pid);
    const gone = await waitForPidGone(child.pid, identity, { maxAttempts: 3, delayMs: 50 });
    assert.equal(gone.terminated, false, "a process that is still running must be reported as a survivor");
    assert.match(describePid(child.pid), /STILL RUNNING/);
  } finally {
    try { process.kill(-child.pid, "SIGKILL"); } catch {}
  }
});
