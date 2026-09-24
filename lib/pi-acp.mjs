// Machine placement of the ACP client.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { createAcpClient, ACP_AGENT } from "./acp-client.mjs";
import { TaskInterrupted } from "./task-interrupted.mjs";

const error = (refused, why) => Object.assign(new Error(why), { refused });

export function createPiAcpExecutor(options = {}) {
  const adapterDir = options.adapterDir ?? process.env.VOICEBOX_ACP_ADAPTER ?? path.join(os.homedir(), ".pi/agent/npm/node_modules/pi-acp");
  const piBinary = options.piBinary ?? process.env.VOICEBOX_ACP_PI ?? "pi";
  const timeoutMs = options.timeoutMs ?? 60000;
  const maxOutputBytes = options.maxOutputBytes ?? 65536;

  function checkAdapter() {
    let resolved;
    try { resolved = fs.realpathSync(adapterDir); }
    catch { return { ok: false, refused: "adapter-unavailable", why: `pi-acp adapter not found at ${adapterDir}; install pi-acp or set VOICEBOX_ACP_ADAPTER.` }; }
    let pkg;
    try { pkg = JSON.parse(fs.readFileSync(path.join(resolved, "package.json"), "utf8")); }
    catch { return { ok: false, refused: "adapter-unavailable", why: "pi-acp package.json is unreadable." }; }
    if (pkg.name !== ACP_AGENT.name || pkg.version !== ACP_AGENT.version) {
      return { ok: false, refused: "adapter-version-unsupported", why: `requires installed ${ACP_AGENT.name} ${ACP_AGENT.version}` };
    }
    const entry = path.join(resolved, "dist", "index.js");
    if (!fs.existsSync(entry)) {
      return { ok: false, refused: "adapter-unavailable", why: "pi-acp dist/index.js missing; build or install the adapter package." };
    }
    return { ok: true, resolved, entry };
  }

  function check(args = {}) {
    const harness = args.harness ?? args.agentConfig?.harness ?? args.input?.harness ?? args.input?.agent;
    if (harness && harness !== "pi" && harness !== "pi-acp") {
      if (harness === "claude") {
        return { ok: false, refused: "adapter-not-configured", why: "No Voicebox task adapter is configured for this CLI; configure an adapter before delegating." };
      }
      return { ok: false, refused: "adapter-not-configured", why: `No Voicebox task adapter is configured for '${harness}'.` };
    }
    const adapterCheck = checkAdapter();
    if (!adapterCheck.ok) return adapterCheck;
    const requestedDeadline = args.bounds?.deadlineMs ?? args.agentConfig?.bounds?.deadlineMs;
    const requestedOutput = args.bounds?.maxOutputBytes ?? args.agentConfig?.bounds?.maxOutputBytes;
    return {
      ok: true,
      mechanism: "stdio-acp-client: pi-acp adapter with pi coding agent",
      bounds: {
        deadlineMs: Math.min(timeoutMs, typeof requestedDeadline === "number" ? requestedDeadline : 60000),
        maxOutputBytes: Math.min(maxOutputBytes, typeof requestedOutput === "number" ? requestedOutput : 65536),
      },
    };
  }

  async function run({ input, bounds, signal, report, root } = {}) {
    const adapterCheck = checkAdapter();
    if (!adapterCheck.ok) throw error(adapterCheck.refused, adapterCheck.why);

    const cwd = root?.path ?? (typeof options.root === "function" ? options.root()?.path : options.root?.path) ?? process.cwd();
    const env = {
      ...process.env,
      ...options.env,
      ...(piBinary && piBinary !== "pi" ? { PI_ACP_PI_COMMAND: piBinary } : {}),
    };

    const child = spawn(process.execPath, [adapterCheck.entry], {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let receive = () => {}, close = () => {}, cause = null;
    const decoder = new StringDecoder("utf8");
    let buffer = "";

    child.stdout.on("data", (chunk) => {
      buffer += decoder.write(chunk);
      while (buffer.includes("\n") && !cause) {
        const end = buffer.indexOf("\n");
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (!line.trim()) continue;
        try { receive(JSON.parse(line)); }
        catch {
          cause = error("acp-invalid-frame", "diagnostic stdout was not newline-delimited JSON");
          child.kill("SIGKILL");
        }
      }
    });

    const kill = () => {
      try { child.kill("SIGKILL"); } catch {}
    };

    child.once("close", (code) => {
      close(cause ?? new TaskInterrupted("harness-ended-outcome-unknown"));
    });

    const client = createAcpClient({
      onMessage(fn) { receive = fn; },
      onClose(fn) { close = fn; },
      send(message) { child.stdin.write(`${JSON.stringify(message)}\n`); },
      close: kill,
    }, {
      timeoutMs: Math.min(bounds?.deadlineMs ?? timeoutMs, 60000),
      maxBytes: bounds?.maxOutputBytes ?? maxOutputBytes,
      decide: options.decide,
    });

    if (signal) {
      if (signal.aborted) {
        kill();
        throw error("task-cancelled", "task was cancelled before execution");
      }
      signal.addEventListener("abort", () => {
        try { client.cancel(); } catch {}
        kill();
      }, { once: true });
    }

    try {
      if (report) report("initializing pi-acp");
      await client.initialize();
      if (signal?.aborted) throw error("task-cancelled", "task was cancelled during initialization");

      if (report) report(`creating session in ${cwd}`);
      await client.newSession(cwd);
      if (signal?.aborted) throw error("task-cancelled", "task was cancelled during session creation");

      if (report) report("sending prompt to pi");
      const text = await client.prompt(input?.task ?? "");
      return text;
    } catch (err) {
      if (signal?.aborted) throw error("task-cancelled", "the person asked to stop this task");
      throw err;
    } finally {
      try { client.close(); } catch {}
      kill();
    }
  }

  return Object.freeze({
    check,
    run,
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
