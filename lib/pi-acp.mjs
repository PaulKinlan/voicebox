// Machine placement of the ACP client.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { createAcpClient, ACP_AGENT } from "./acp-client.mjs";
import { TaskInterrupted } from "./task-interrupted.mjs";

const error = (refused, why) => Object.assign(new Error(why), { refused });

function extractToolName(asked) {
  if (!asked) return null;
  if (typeof asked.toolCall?.name === "string" && asked.toolCall.name) {
    return asked.toolCall.name.trim();
  }
  if (typeof asked.toolCall?.tool === "string" && asked.toolCall.tool) {
    return asked.toolCall.tool.trim();
  }
  const titleCandidate = (typeof asked.toolCall?.title === "string" && asked.toolCall.title) ||
    (typeof asked.toolCall?.rawInput?.title === "string" && asked.toolCall.rawInput.title) ||
    (typeof asked.title === "string" && asked.title) ||
    "";
  const match = titleCandidate.match(/Permission:\s*([a-zA-Z0-9_-]+)/i);
  if (match) return match[1].toLowerCase().trim();
  if (titleCandidate.trim() && !titleCandidate.includes(" ")) {
    return titleCandidate.toLowerCase().trim();
  }
  return null;
}

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
    const agentConfig = args.agentConfig;
    if (agentConfig) {
      if (agentConfig.adapter && agentConfig.adapter !== "pi-acp") {
        return { ok: false, refused: "adapter-not-configured", why: `pi executor only supports adapter 'pi-acp', not '${agentConfig.adapter}'.` };
      }
      if (agentConfig.pinnedVersion && agentConfig.pinnedVersion !== ACP_AGENT.version) {
        return { ok: false, refused: "adapter-version-unsupported", why: `pinned adapter version '${agentConfig.pinnedVersion}' does not match installed ${ACP_AGENT.name} ${ACP_AGENT.version}.` };
      }
      if (agentConfig.transport && agentConfig.transport !== "stdio") {
        return { ok: false, refused: "unsupported-runtime-capability", why: `pi-acp adapter only supports 'stdio' transport, not '${agentConfig.transport}'.` };
      }
      if (agentConfig.model?.options && Object.keys(agentConfig.model.options).length > 0) {
        return { ok: false, refused: "unsupported-model-options", why: "pi-acp adapter does not support custom model options." };
      }
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

  async function run({ input, bounds, signal, report, root, agentConfig, harness } = {}) {
    const adapterCheck = checkAdapter();
    if (!adapterCheck.ok) throw error(adapterCheck.refused, adapterCheck.why);

    if (agentConfig) {
      if (agentConfig.adapter && agentConfig.adapter !== "pi-acp") {
        throw error("adapter-not-configured", `pi executor only supports adapter 'pi-acp', not '${agentConfig.adapter}'.`);
      }
      if (agentConfig.pinnedVersion && agentConfig.pinnedVersion !== ACP_AGENT.version) {
        throw error("adapter-version-unsupported", `pinned adapter version '${agentConfig.pinnedVersion}' does not match installed ${ACP_AGENT.name} ${ACP_AGENT.version}.`);
      }
      if (agentConfig.transport && agentConfig.transport !== "stdio") {
        throw error("unsupported-runtime-capability", `pi-acp adapter only supports 'stdio' transport, not '${agentConfig.transport}'.`);
      }
      if (agentConfig.model?.options && Object.keys(agentConfig.model.options).length > 0) {
        throw error("unsupported-model-options", "pi-acp adapter does not support custom model options.");
      }
    }

    const cwd = root?.path ?? (typeof options.root === "function" ? options.root()?.path : options.root?.path) ?? process.cwd();
    const env = {
      ...process.env,
      ...options.env,
      ...(piBinary && piBinary !== "pi" ? { PI_ACP_PI_COMMAND: piBinary } : {}),
    };

    // Needed reach is NOT effect authority.
    // When reach.tools is specified (including explicit empty []), tools outside reach are denied.
    const allowedTools = Array.isArray(agentConfig?.reach?.tools)
      ? new Set(agentConfig.reach.tools)
      : null;

    const scopedDecide = async (asked) => {
      if (allowedTools !== null) {
        const toolName = extractToolName(asked);
        if (!toolName || !allowedTools.has(toolName)) {
          return {
            allow: false,
            reason: `tool-not-in-agent-reach: tool '${toolName ?? "unknown"}' is not in declared reach [${Array.from(allowedTools).join(", ")}]`,
          };
        }
      }
      if (typeof options.decide === "function") {
        return await options.decide(asked);
      }
      return { allow: false, reason: "no-effect-authority" };
    };

    let clientTransport;
    let kill;

    if (typeof options.transportFactory === "function") {
      const created = options.transportFactory({ cwd, env, agentConfig, bounds });
      clientTransport = created.transport;
      kill = created.kill ?? (() => {});
    } else {
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

      kill = () => {
        try { child.kill("SIGKILL"); } catch {}
      };

      child.once("close", (code) => {
        close(cause ?? new TaskInterrupted("harness-ended-outcome-unknown"));
      });

      clientTransport = {
        onMessage(fn) { receive = fn; },
        onClose(fn) { close = fn; },
        send(message) { child.stdin.write(`${JSON.stringify(message)}\n`); },
        close: kill,
      };
    }

    const client = createAcpClient(clientTransport, {
      timeoutMs: Math.min(bounds?.deadlineMs ?? timeoutMs, 60000),
      maxBytes: bounds?.maxOutputBytes ?? maxOutputBytes,
      decide: scopedDecide,
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

      // Apply configured model and thinking level if declared
      if (agentConfig?.model) {
        const modelRef = agentConfig.model;
        let modelId = null;
        if (typeof modelRef === "string") {
          modelId = modelRef;
        } else if (modelRef && typeof modelRef === "object") {
          const provider = typeof modelRef.provider === "string" ? modelRef.provider.trim() : "";
          const name = typeof modelRef.model === "string" && modelRef.model
            ? modelRef.model.trim()
            : typeof modelRef.id === "string" && modelRef.id
            ? modelRef.id.trim()
            : "";
          if (provider && name) {
            modelId = `${provider}/${name}`;
          } else if (name) {
            modelId = name;
          }
        }
        if (modelId) {
          if (report) report(`configuring model: ${modelId}`);
          try {
            await client.setConfigOption("model", modelId);
          } catch (err) {
            throw error("model-unsupported", `configured model '${modelId}' is not supported by the adapter: ${err.message ?? err}`);
          }
        }
        const thinking = typeof modelRef === "object"
          ? (typeof modelRef.thinking === "string" ? modelRef.thinking : null)
          : (typeof agentConfig.thinking === "string" ? agentConfig.thinking : null);
        if (thinking) {
          try {
            await client.setConfigOption("thought_level", thinking);
          } catch (err) {
            throw error("thinking-level-unsupported", `configured thinking level '${thinking}' is not supported: ${err.message ?? err}`);
          }
        }
      }

      if (report) report("sending prompt to pi");
      let promptText = input?.task ?? "";
      if (agentConfig?.prompt && typeof agentConfig.prompt === "string" && agentConfig.prompt.trim()) {
        promptText = `[System Instructions: ${agentConfig.prompt.trim()}]\n\n${promptText}`;
      }
      const text = await client.prompt(promptText);
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
  const resolveDep = (name) => {
    const local = path.join(adapterDir, "node_modules", name);
    if (fs.existsSync(local)) return fs.realpathSync(local);
    const parent = path.join(adapterDir, "..", name);
    if (fs.existsSync(parent)) return fs.realpathSync(parent);
    return null;
  };
  const extraDeps = ["cross-spawn", "path-key", "shebang-command", "shebang-regex", "which", "isexe"];
  const extraBinds = [];
  for (const dep of extraDeps) {
    const loc = resolveDep(dep);
    if (loc) extraBinds.push("--ro-bind", loc, `/packages/node_modules/${dep}`);
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "voicebox-acp-probe-"));
  // Only this fixed launch script is mounted; no user/project config or credentials are present.
  const launcher = path.join(dir, "launch.sh");
  fs.writeFileSync(launcher, `#!/bin/sh\nset -eu\nv=$(/harness/pi --version)\n[ "$v" = "${ACP_AGENT.piVersion}" ] || exit 78\nexec /usr/bin/node /packages/pi-acp/dist/index.js\n`, { mode: 0o700 });
  const args = ["--unshare-all", "--die-with-parent", "--new-session", "--clearenv",
    "--ro-bind", "/usr", "/usr", "--symlink", "usr/bin", "/bin", "--symlink", "usr/lib", "/lib", "--symlink", "usr/lib", "/lib64",
    "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--tmpfs", "/home", "--dir", "/home/agent",
    "--dir", "/work", "--ro-bind", path.dirname(piBinary), "/harness", "--ro-bind", launcher, "/launch.sh",
    "--ro-bind", adapterDir, "/packages/pi-acp", "--ro-bind", sdk, "/packages/node_modules/@agentclientprotocol/sdk",
    "--ro-bind", zod, "/packages/node_modules/zod", ...extraBinds, "--setenv", "HOME", "/home/agent", "--setenv", "PATH", "/usr/bin",
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
