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
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { findBrowserBinary, launch } from "./lib/cdp.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function isPidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code !== "ESRCH";
  }
}

async function waitForPidGone(pid, maxAttempts = 20, delayMs = 50) {
  let alive = isPidAlive(pid);
  for (let i = 0; i < maxAttempts && alive; i++) {
    await new Promise((r) => setTimeout(r, delayMs));
    alive = isPidAlive(pid);
  }
  return !alive;
}

async function waitForProcessGroupGone(pgid, maxAttempts = 20, delayMs = 50) {
  let remaining = [];
  for (let i = 0; i < maxAttempts; i++) {
    const ps = spawnSync("ps", ["-g", String(pgid), "-o", "pid,comm"], { encoding: "utf8" });
    remaining = (ps.stdout || "").trim().split("\n").slice(1).filter(Boolean);
    if (remaining.length === 0) break;
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return remaining;
}

async function waitForProfileProcessesGone(profileDir, maxAttempts = 20, delayMs = 50) {
  let remaining = [];
  for (let i = 0; i < maxAttempts; i++) {
    const ps = spawnSync("ps", ["-C", "chrome,chrome_crashpad_handler", "-o", "pid,args"], { encoding: "utf8" });
    const lines = (ps.stdout || "").trim().split("\n").slice(1).filter(Boolean);
    remaining = lines.filter((line) => line.includes(profileDir));
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
  assert.ok(browserPid > 0, "page must expose browser child PID");
  assert.equal(isPidAlive(browserPid), true, "browser process must be alive before close");

  await page.close();

  // 1. Observable assertion: browser leader PID is gone
  const leaderGone = await waitForPidGone(browserPid);
  assert.equal(leaderGone, true, `browser process ${browserPid} must be terminated after page.close()`);

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

  // 1. Observable assertion: browser leader PID is gone
  const leaderGone = await waitForPidGone(browserPid);
  assert.equal(leaderGone, true, `browser PID ${browserPid} must not survive unhandled runner crash`);

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

  // 1. Observable assertion: browser leader PID is gone
  const leaderGone = await waitForPidGone(browserPid);
  assert.equal(leaderGone, true, `browser PID ${browserPid} must not survive SIGTERM`);

  // 2. Observable assertion: browser process group is completely empty
  const groupRemaining = await waitForProcessGroupGone(browserPid);
  assert.equal(groupRemaining.length, 0, `no processes in group ${browserPid} should remain: ${groupRemaining.join(", ")}`);

  // 3. Observable assertion: helper processes tied to profile cleanly exit
  const profileRemaining = await waitForProfileProcessesGone(profileDir);
  assert.equal(profileRemaining.length, 0, `no processes for profile ${profileDir} should survive SIGTERM: ${profileRemaining.join("; ")}`);

  rmSync(profileDir, { recursive: true, force: true });
});
