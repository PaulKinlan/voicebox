import { spawn } from "node:child_process";

// A nested shard runner owns separately detached test and Chromium process groups. Give it a
// chance to run its own signal reapers; SIGKILLing only its PID strands both groups.
export function runOwnedShard(entry, args, {
  cwd, env, timeoutMs = 240_000, graceMs = 5_000, onOutput,
} = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [entry, ...args], {
      cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "", timedOut = false, settled = false;
    let deadline, hardKill;
    const signalGroup = (signal) => {
      try { process.kill(-child.pid, signal); }
      catch { try { child.kill(signal); } catch { /* already gone */ } }
    };
    const expire = () => {
      if (timedOut || settled) return;
      timedOut = true;
      signalGroup("SIGTERM");
      hardKill = setTimeout(() => signalGroup("SIGKILL"), graceMs);
    };
    const finish = (status, signal, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      clearTimeout(hardKill);
      resolve({
        status: timedOut ? null : status,
        signal,
        error: timedOut ? Object.assign(new Error("nested shard runner timed out"), { code: "ETIMEDOUT" }) : error,
        timedOut, stdout, stderr,
      });
    };
    const capture = (stream) => (chunk) => {
      const text = String(chunk);
      if (stream === "stdout") stdout += text;
      else stderr += text;
      onOutput?.({ stream, text, stdout, stderr, pid: child.pid, expire });
    };
    child.stdout.on("data", capture("stdout"));
    child.stderr.on("data", capture("stderr"));
    child.once("close", (status, signal) => finish(status, signal));
    child.once("error", (error) => finish(null, null, error));
    deadline = setTimeout(expire, timeoutMs);
  });
}
