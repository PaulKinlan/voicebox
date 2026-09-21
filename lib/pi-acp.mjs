// Machine placement of the ACP client. No provider keys, inherited home, or ambient env.
// Production admission stays refused until the task-scoped provider broker is enforced.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { createAcpClient, ACP_AGENT } from "./acp-client.mjs";
import { TaskInterrupted } from "./task-interrupted.mjs";

const absent = () => ({ ok: false, refused: "absent-capability", why: "network and credential isolation: no task-scoped provider broker is installed; shared-network S1 is insufficient. Install and verify bounded broker-only model access before admitting pi-acp tasks." });
const error = (refused, why) => Object.assign(new Error(why), { refused });

export function createPiAcpExecutor() {
  return Object.freeze({
    check: absent,
    async run() { const r = absent(); throw error(r.refused, r.why); },
  });
}

/** Credential-free diagnostics ONLY, not an admitted model task. Paths are host-code config.
 * Exact installed metadata is checked before launch; actual ACP initialize is checked on wire.
 * Pi's binary version is checked INSIDE the no-network sandbox before starting the adapter.
 * The returned probe deliberately has no prompt/effect API. */
export async function openPiAcpProbe({ adapterDir, piBinary, timeoutMs = 10000, maxBytes = 262144 }) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000 ||
      !Number.isSafeInteger(maxBytes) || maxBytes < 1024 || maxBytes > 1048576) {
    throw error("unbounded-executor", "diagnostics require a deadline <=30000ms and <=1048576 total output bytes");
  }
  adapterDir = fs.realpathSync(adapterDir); piBinary = fs.realpathSync(piBinary);
  const pkg = JSON.parse(fs.readFileSync(path.join(adapterDir, "package.json"), "utf8"));
  if (pkg.name !== ACP_AGENT.name || pkg.version !== ACP_AGENT.version) throw error("adapter-version-unsupported", `requires installed ${ACP_AGENT.name} ${ACP_AGENT.version}`);
  const sdk = fs.realpathSync(path.join(adapterDir, "..", "@agentclientprotocol", "sdk"));
  const zod = fs.realpathSync(path.join(adapterDir, "node_modules", "zod"));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "voicebox-acp-probe-"));
  // Only this fixed launch script is mounted; no user/project config or credentials are present.
  const launcher = path.join(dir, "launch.sh");
  fs.writeFileSync(launcher, `#!/bin/sh\nset -eu\nv=$(/harness/pi --version)\n[ "$v" = "${ACP_AGENT.piVersion}" ] || exit 78\nexec /usr/bin/node /packages/pi-acp/dist/index.js\n`, { mode: 0o700 });
  const args = ["--unshare-all", "--die-with-parent", "--new-session", "--clearenv",
    "--ro-bind", "/usr", "/usr", "--symlink", "usr/bin", "/bin", "--symlink", "usr/lib", "/lib", "--symlink", "usr/lib", "/lib64",
    "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--tmpfs", "/home", "--dir", "/home/agent",
    "--dir", "/work", "--ro-bind", path.dirname(piBinary), "/harness", "--ro-bind", launcher, "/launch.sh",
    "--ro-bind", adapterDir, "/packages/pi-acp", "--ro-bind", sdk, "/packages/node_modules/@agentclientprotocol/sdk",
    "--ro-bind", zod, "/packages/node_modules/zod", "--setenv", "HOME", "/home/agent", "--setenv", "PATH", "/usr/bin",
    "--setenv", "PI_ACP_PI_COMMAND", "/harness/pi", "--chdir", "/work", "--", "/bin/sh", "/launch.sh"];
  let child;
  try { child = spawn("/usr/bin/bwrap", args, { env: {}, stdio: ["pipe", "pipe", "pipe"] }); }
  catch (e) { fs.rmSync(dir, { recursive: true, force: true }); throw e; }
  let receive = () => {}, close = () => {}, total = 0, buffer = "", cause = null;
  const decoder = new StringDecoder("utf8");
  const kill = () => { child.kill("SIGKILL"); };
  const deadline = setTimeout(() => { cause = new TaskInterrupted("acp-probe-deadline"); kill(); }, timeoutMs);
  const exited = new Promise((resolve) => {
    child.once("error", () => { cause = error("absent-capability", "bubblewrap diagnostic could not start; install the isolation runtime"); });
    child.once("close", (code, signal) => {
      clearTimeout(deadline); fs.rmSync(dir, { recursive: true, force: true });
      const outcome = cause ?? (code === 78
        ? error("harness-version-unsupported", `requires pi ${ACP_AGENT.piVersion}`)
        : new TaskInterrupted("harness-ended-outcome-unknown"));
      close(outcome); resolve({ code, signal, outcome });
    });
  });
  function charge(chunk) {
    total += chunk.length;
    if (total > maxBytes) { cause = error("acp-output-over-budget", "diagnostic output exceeded its total byte bound"); kill(); return false; }
    return !cause;
  }
  child.stderr.on("data", charge); // Discard, never log harness internals or model output.
  child.stdout.on("data", (chunk) => {
    if (!charge(chunk)) return;
    buffer += decoder.write(chunk);
    while (buffer.includes("\n") && !cause) {
      const end = buffer.indexOf("\n"); const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      try { receive(JSON.parse(line)); }
      catch { cause = error("acp-invalid-frame", "diagnostic stdout was not newline-delimited JSON"); kill(); }
    }
  });
  child.stdin.on("error", () => { cause ??= new TaskInterrupted("harness-ended-outcome-unknown"); kill(); });
  const client = createAcpClient({
    onMessage(fn) { receive = fn; }, onClose(fn) { close = fn; },
    send(message) { child.stdin.write(`${JSON.stringify(message)}\n`); }, close: kill,
  }, { timeoutMs, maxBytes });
  try {
    const info = await client.initialize();
    return { info, pid: child.pid, newSession: () => client.newSession("/work"), exited,
      async close() { client.close(); await exited; } };
  } catch (e) { kill(); await exited; throw e; }
}
