// A skipped-by-pattern voicebox suite must still stop the server its before hook started.
// The child process and its own server are disposable: no other process is swept or killed.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverPath = path.join(root, "server.mjs");

function identity(pid) {
  try {
    // /proc/<pid>/stat field 22 is starttime; strip comm's parenthesized field first.
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? null;
  } catch { return null; }
}

function descendants(pid) {
  const seen = new Set();
  const visit = (current) => {
    if (seen.has(current)) return;
    seen.add(current);
    try {
      for (const id of readFileSync(`/proc/${current}/task/${current}/children`, "utf8").trim().split(/\s+/)) {
        if (id) visit(Number(id));
      }
    } catch { /* the child may exit between traversal steps */ }
  };
  visit(pid);
  return [...seen].filter((p) => p !== pid);
}

test("a zero-match voicebox suite exits and reaps exactly its spawned server", { timeout: 90000 }, async (t) => {
  const procAvailable = existsSync(`/proc/${process.pid}/task/${process.pid}/children`);
  if (!procAvailable) t.diagnostic("exact-PID liveness UNSUPPORTED: /proc task children unavailable");
  // Node marks test workers as recursive; remove that marker for a genuinely separate runner.
  const { NODE_TEST_CONTEXT: _parentTestContext, ...env } = process.env;
  const child = spawn(process.execPath, ["--test", "--test-name-pattern=__voicebox_no_match__", "tests/voicebox.test.mjs"], {
    cwd: root, env, detached: true, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += String(chunk); });
  child.stderr.on("data", (chunk) => { output += String(chunk); });
  const servers = new Map(); // exact PID -> /proc starttime, so PID reuse cannot fool cleanup/checks
  const observed = new Set();
  const sample = () => {
    if (!procAvailable) return;
    for (const pid of descendants(child.pid)) {
      try {
        const command = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
        observed.add(`${pid}:${command.slice(0, 2).join(' ')}`);
        if (command.includes(serverPath)) {
          const started = identity(pid);
          observed.add(`server-match:${pid}:${started ?? 'no-starttime'}`);
          if (started) servers.set(pid, started);
        }
      } catch { /* exited while observing */ }
    }
  };
  sample();
  const sampling = setInterval(sample, 25);
  let timedOut = false;
  const deadline = setTimeout(() => {
    timedOut = true;
    try { process.kill(-child.pid, "SIGTERM"); } catch { /* already exited */ }
    setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch { /* already exited */ } }, 300).unref();
  }, 60000);
  const finished = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  }).finally(() => { clearInterval(sampling); clearTimeout(deadline); });
  // A timed-out RED run can leave its detached server behind; clean only the recorded
  // exact PID/starttime, not another lane's process or a reused PID.
  const alive = [...servers].filter(([pid, started]) => identity(pid) === started);
  if (timedOut) {
    for (const [pid] of alive) { try { process.kill(-pid, "SIGKILL"); } catch { /* already gone */ } }
  }
  assert.equal(timedOut, false, `zero-match suite exceeded 60s; exact servers=${JSON.stringify(alive)}; observed=${JSON.stringify([...observed])}; ${output.slice(-800)}`);
  assert.equal(finished.code, 0, `zero-match suite failed: ${output.slice(-800)}`);
  if (procAvailable) assert.ok(servers.size > 0, `no exact server PID was observed; liveness unverified: ${JSON.stringify([...observed])}`);
  assert.deepEqual(alive, [], `server PID/starttime survived test exit: ${JSON.stringify(alive)}`);
  assert.match(output, /tests 0|pass 0|skipped/i, "the filter actually skipped the suite's tests");
});
