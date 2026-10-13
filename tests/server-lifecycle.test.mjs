import test from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const workerFile = fileURLToPath(new URL("./fixtures/server-lifecycle-worker.mjs", import.meta.url));
// This test starts a server through that worker: keep its helper path explicit so
// scripts/test-lanes.mjs assigns this subprocess test to the server lane.
const serverHelper = fileURLToPath(new URL("./lib/server.mjs", import.meta.url));

function isRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    // Reparented zombies can remain in /proc until init reaps them. They are no
    // longer live servers even though kill(pid, 0) temporarily succeeds.
    if (process.platform === "linux" && existsSync(`/proc/${pid}/stat`)) {
      return readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1][0] !== "Z";
    }
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitGone(pid, timeoutMs = 1600) {
  const deadline = Date.now() + timeoutMs;
  while (isRunning(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return !isRunning(pid);
}

async function runIsolated(mode, verify) {
  assert.equal(existsSync(serverHelper), true);
  const worker = fork(workerFile, [mode], { detached: true, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  let serverPid;
  let scratch;
  let report;
  let stderr = "";
  let workerExited = false;
  worker.stderr.on("data", (chunk) => { stderr += chunk; });
  try {
    const exitCode = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`lifecycle worker timed out: ${stderr}`)), 12000);
      worker.on("message", (message) => {
        try {
          if (message.type === "spawned") {
            serverPid = message.pid;
            scratch = message.scratch;
            assert.notEqual(serverPid, process.pid);
            assert.equal(message.workerPid, worker.pid);
            assert.equal(message.workerGroup, worker.pid, "worker must have a private group");
            assert.equal(message.serverGroup, serverPid, "server must have its own private group");
          } else if (message.type === "result") {
            report = message;
          }
        } catch (error) {
          clearTimeout(timer);
          reject(error);
        }
      });
      worker.once("error", (error) => { clearTimeout(timer); reject(error); });
      worker.once("exit", (code) => { clearTimeout(timer); workerExited = true; resolve(code); });
    });
    assert.equal(exitCode, 0, stderr);
    assert.ok(report, `missing lifecycle report: ${stderr}`);
    await verify(report, serverPid, scratch);
  } finally {
    // Only ever touch the exact child PID reported by this disposable worker.
    // Never signal our own process group or sweep unrelated server processes.
    if (isRunning(serverPid)) {
      try { process.kill(serverPid, "SIGKILL"); } catch { /* exited between check and signal */ }
    }
    const gone = await waitGone(serverPid);
    if (scratch && gone) rmSync(scratch, { recursive: true, force: true });
    if (!workerExited && worker.pid) {
      try { worker.kill("SIGKILL"); } catch { /* already exited */ }
    }
    assert.ok(gone, `test-owned server ${serverPid} remained live after exact-PID cleanup`);
  }
}

test("failed stop retains a live child for the worker exit fallback", async () => {
  await runIsolated("failed-kill", async (report, pid, scratch) => {
    assert.equal(report.childExited, false, "injected failed kill leaves the child live at stop timeout");
    assert.equal(report.scratchExists, true, "never remove a live host's token directory");
    assert.equal(await waitGone(pid), true, "worker exit fallback must still reap the tracked child");
    assert.equal(existsSync(scratch), true, "no stop-timeout scratch deletion before confirmed exit");
  });
});

test("normal stop reaps the server and removes owned scratch", async () => {
  await runIsolated("normal-stop", async (report, pid, scratch) => {
    assert.equal(report.childExited, true);
    assert.equal(report.scratchExists, false);
    assert.equal(isRunning(pid), false);
    assert.equal(existsSync(scratch), false);
  });
});

test("stop removes scratch even when the child exited before stop was called", async () => {
  await runIsolated("already-exited", async (report, pid, scratch) => {
    assert.equal(report.childExited, true);
    assert.equal(report.scratchExists, false);
    assert.equal(isRunning(pid), false);
    assert.equal(existsSync(scratch), false);
  });
});

test("worker exit reaps an intentionally un-stopped server", async () => {
  await runIsolated("exit-without-stop", async (report, pid, scratch) => {
    assert.equal(report.childExited, false, "server is live before worker exit");
    assert.equal(report.scratchExists, true);
    assert.equal(await waitGone(pid), true, "worker exit fallback must reap the un-stopped child");
    assert.equal(existsSync(scratch), true, "only stop() owns scratch removal");
  });
});
