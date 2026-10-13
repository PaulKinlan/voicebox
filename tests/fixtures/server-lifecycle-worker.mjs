// Disposable worker for server-lifecycle.test.mjs. It owns a private process
// group; only this worker injects failed kill calls, never the shared test runner.
import { existsSync, readFileSync } from "node:fs";
import { once } from "node:events";
import { execFileSync } from "node:child_process";
import { startServer } from "../lib/server.mjs";

const server = await startServer({ readyTimeoutMs: 5000 });
const processGroup = (pid) => {
  if (process.platform === "linux" && existsSync(`/proc/${pid}/stat`)) {
    try {
      return Number(readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1].split(" ")[2]);
    } catch {}
  }
  try {
    const out = execFileSync("ps", ["-o", "pgid=", "-p", String(pid)], { encoding: "utf8" }).trim();
    return Number(out);
  } catch {
    return pid;
  }
};
const send = (payload) => new Promise((resolve, reject) => {
  process.send(payload, (error) => error ? reject(error) : resolve());
});
await send({ type: "spawned", pid: server.child.pid, scratch: server.extensionsDir,
  workerPid: process.pid, workerGroup: processGroup(process.pid), serverGroup: processGroup(server.child.pid) });

const mode = process.argv[2];
if (mode === "failed-kill") {
  const originalGroupKill = process.kill;
  const originalChildKill = server.child.kill;
  try {
    process.kill = (pid, signal) => {
      if (pid === -server.child.pid && signal === "SIGKILL") throw new Error("simulated failed group signal");
      return originalGroupKill(pid, signal);
    };
    server.child.kill = () => false;
    await server.stop(); // bounded 2s; the child is deliberately still alive
  } finally {
    process.kill = originalGroupKill;
    server.child.kill = originalChildKill;
  }
} else if (mode === "normal-stop") {
  await server.stop();
} else if (mode === "already-exited") {
  const exited = once(server.child, "exit");
  process.kill(server.child.pid, "SIGKILL"); // exact test-owned PID, not a process group
  await exited;
  await server.stop(); // cleanup must work even when exit predates stop()
} else if (mode !== "exit-without-stop") {
  throw new Error(`unknown lifecycle mode: ${mode}`);
}
await send({
  type: "result",
  mode,
  childExited: server.child.exitCode !== null || server.child.signalCode !== null,
  scratchExists: existsSync(server.extensionsDir),
});
// Force a worker exit so the process-exit fallback is actually exercised while
// an un-stopped (or failed-kill) server still owns a pipe and would keep it open.
process.exit(0);
