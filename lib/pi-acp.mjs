// Machine placement of the ACP client.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { createAcpClient, ACP_AGENT, isPeerGoneWrite } from "./acp-client.mjs";
import {
  buildProjectAwareTaskPrompt,
  integrateHarnessOutput,
  snapshotProjectWorkspace,
} from "./harness-project-loop.mjs";
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

/**
 * Describe the INSTALLED adapter the way the executor's own preflight sees it — one truth for
 * both the delegate-time gate and the startup validation table (voicebox-beads-aaj). Answers
 * three questions with the executor's exact refusal names: is the adapter directory present,
 * is it the pinned identity/version, and is its entry built. The pi BINARY is deliberately
 * not stat'ed here: a PATH-resolved command is the launcher's to probe, and a version answer
 * for an absent binary would be a fabrication.
 */
/** Generic installed-adapter preflight — the ONE mechanism pi-acp and
 * claude-acp share (voicebox N18: two copies drift silently). Callers pass
 * the identity and the dir-resolution inputs; nothing else varies. */
export function describeAdapterInstallFor(identity, { adapterDir: rawAdapterDir, dirEnv }) {
  const adapterDir = rawAdapterDir ?? (dirEnv ? process.env[dirEnv] : undefined) ?? identity.defaultDir();
  let resolved;
  try { resolved = fs.realpathSync(adapterDir); }
  catch { return { ok: false, refused: "adapter-unavailable", why: `pi-acp adapter not found at ${adapterDir}; install pi-acp or set VOICEBOX_ACP_ADAPTER.`, adapterDir }; }
  let pkg;
  try { pkg = JSON.parse(fs.readFileSync(path.join(resolved, "package.json"), "utf8")); }
  catch { return { ok: false, refused: "adapter-unavailable", why: `${identity.shortName} package.json is unreadable.`, adapterDir: resolved }; }
  if (pkg.name !== identity.name || pkg.version !== identity.version) {
    return { ok: false, refused: "adapter-version-unsupported", why: `requires installed ${identity.name} ${identity.version}`, adapterDir: resolved, installedVersion: pkg.version ?? null };
  }
  const entry = identity.entryFor(resolved, pkg);
  if (!entry || !fs.existsSync(entry)) {
    return { ok: false, refused: "adapter-unavailable", why: `${identity.shortName} adapter entry missing; build or install the adapter package.`, adapterDir: resolved };
  }
  return { ok: true, adapterDir: resolved, entry, installedVersion: pkg.version };
}

/** The pi-branded call signature every existing caller and test pins. */
export function describeAdapterInstall(opts = {}) {
  return describeAdapterInstallFor(PI_IDENTITY, opts);
}

const PI_IDENTITY = {
  name: ACP_AGENT.name, // "pi-acp" — the identity acp-client pins
  version: ACP_AGENT.version,
  shortName: "pi-acp",
  defaultDir: () => path.join(os.homedir(), ".pi/agent/npm/node_modules/pi-acp"),
  dirEnv: "VOICEBOX_ACP_ADAPTER",
  entryFor: (dir) => path.join(dir, "dist", "index.js"),
};
export { PI_IDENTITY };

/**
 * The SHARED run pipeline (voicebox-beads-a74y): transport spawn, line
 * framing, ACP session lifecycle, cancellation, model/thinking config, and
 * the system-instructions prompt prefix. pi-acp and claude-acp both execute
 * through this ONE mechanism — per-adapter modules keep only identity-bound
 * check() preflights, so protocol behavior cannot drift silently (N18).
 */
export async function runAcpTask({
  adapterCheck, transportFactory, cwd, env, bounds, signal, report, decide,
  agentConfig, input, timeoutMs, maxOutputBytes, agentLabel = "pi-acp",
  expectedAgent, timeoutCeilingMs = 60000,
  enrichProjectContext = false,
  saveReport = false,
  reportPath = null,
  onProjectIntegration = null,
  returnProjectIntegration = false,
}) {
  let clientTransport;
  let kill = () => {};
  let currentStage = "starting";
  const reportStage = (note) => {
    currentStage = note;
    if (report) report(note);
  };

  if (typeof transportFactory === "function") {
    const created = transportFactory({ cwd, env, agentConfig, bounds });
    clientTransport = created.transport;
    kill = created.kill ?? (() => {});
  } else {
    const cmdDesc = adapterCheck.describe || [adapterCheck.cmd ?? process.execPath, ...(adapterCheck.args ?? [adapterCheck.entry])].join(" ");
    const child = spawn(adapterCheck.cmd ?? process.execPath, adapterCheck.args ?? [adapterCheck.entry], {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    {
      let receive = () => {}, close = () => {}, cause = null;
      const decoder = new StringDecoder("utf8");
      const stderrDecoder = new StringDecoder("utf8");
      let buffer = "";
      let stderrBuffer = "";

      child.stderr?.on("data", (chunk) => {
        if (stderrBuffer.length < 4096) {
          stderrBuffer += stderrDecoder.write(chunk);
          if (stderrBuffer.length > 4096) stderrBuffer = stderrBuffer.slice(0, 4096);
        }
      });

      // A write to a child whose stdin is already gone can also arrive ASYNCHRONOUSLY (the frame
      // was buffered before the child exited), and an unhandled 'error' on a stream is a process
      // crash. The client already treats the synchronous form as "the peer is gone" — the child's
      // 'close' below carries the diagnostic — so absorb the same condition here and let anything
      // else be named rather than swallowed (voicebox-beads-cps6).
      child.stdin.on("error", (err) => {
        if (isPeerGoneWrite(err)) return;
        const detail = `${agentLabel} failed writing to the harness (${cmdDesc}) during '${currentStage}': ${err?.message ?? err}`;
        console.error(`[acp:${agentLabel}] ${detail}`);
        cause = Object.assign(error("adapter-unavailable", detail), { detail });
        kill();
      });

      child.once("error", (err) => {
        const detail = `${agentLabel} failed to spawn (${cmdDesc}) during '${currentStage}': ${err?.message ?? err}`;
        console.error(`[acp:${agentLabel}] ${detail}`);
        cause = Object.assign(error("adapter-unavailable", detail), { detail });
        close(cause);
      });

      child.stdout.on("data", (chunk) => {
        buffer += decoder.write(chunk);
        while (buffer.includes("\n") && !cause) {
          const end = buffer.indexOf("\n");
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 1);
          if (!line.trim()) continue;
          try { receive(JSON.parse(line)); }
          catch {
            const snippet = line.trim().slice(0, 200);
            const stderrNote = stderrBuffer.trim() ? ` | stderr: ${stderrBuffer.trim().slice(0, 400)}` : "";
            const detail = `${agentLabel} wrote non-JSON output to stdout during '${currentStage}': ${snippet}${stderrNote}`;
            cause = Object.assign(error("acp-invalid-frame", detail), { detail });
            child.kill("SIGKILL");
          }
        }
      });

      kill = () => {
        try { child.kill("SIGKILL"); } catch {}
      };

      child.once("close", (code, sig) => {
        if (cause) {
          close(cause);
          return;
        }
        const exitDesc = code !== null && code !== undefined
          ? `exited with code ${code}`
          : sig
            ? `terminated by signal ${sig}`
            : "closed unexpectedly";
        const stderrClean = stderrBuffer.trim();
        const parts = [
          `${agentLabel} process ${exitDesc} while ${currentStage} (${cmdDesc}).`,
        ];
        if (stderrClean) {
          parts.push(`Stderr: ${stderrClean}`);
        } else {
          parts.push("No stderr output was emitted by the process.");
        }
        const detail = parts.join("\n");
        if (!signal?.aborted) {
          console.error(`[acp:${agentLabel}] ${detail}`);
        }
        close(new TaskInterrupted("harness-ended-outcome-unknown", detail));
      });

      clientTransport = {
        onMessage(fn) { receive = fn; },
        onClose(fn) { close = fn; },
        send(message) { child.stdin.write(`${JSON.stringify(message)}\n`); },
        close: kill,
      };
    }
  }

  const client = createAcpClient(clientTransport, {
    // The adapter NAMES its ceiling; the requested deadline is clamped to it (hmco).
    timeoutMs: Math.min(bounds?.deadlineMs ?? timeoutMs, timeoutCeilingMs),
    maxOutputBytes: bounds?.maxOutputBytes ?? maxOutputBytes,
    decide,
    ...(expectedAgent ? { expectedAgent } : {}),
    timeoutCeilingMs,
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

  const beforeSnapshot = snapshotProjectWorkspace(cwd);

  try {
    reportStage(`initializing ${agentLabel}`);
    await client.initialize();
    if (signal?.aborted) throw error("task-cancelled", "task was cancelled during initialization");

    reportStage(`creating session in ${cwd}`);
    await client.newSession(cwd);
    if (signal?.aborted) throw error("task-cancelled", "task was cancelled during session creation");

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
        reportStage(`configuring model: ${modelId}`);
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

    reportStage(`sending prompt to ${agentLabel}`);
    const rawTask = input?.task ?? "";
    const shouldEnrich = enrichProjectContext === true || input?.enrichProjectContext === true || agentConfig?.enrichProjectContext === true;
    let promptText = shouldEnrich
      ? buildProjectAwareTaskPrompt({
          task: rawTask,
          rootPath: cwd,
          subDir: input?.subDir ?? "",
          includeProjectContext: true,
        })
      : rawTask;
    if (agentConfig?.prompt && typeof agentConfig.prompt === "string" && agentConfig.prompt.trim()) {
      promptText = `[System Instructions: ${agentConfig.prompt.trim()}]\n\n${promptText}`;
    }
    const text = await client.prompt(promptText);
    const projectIntegration = integrateHarnessOutput(cwd, {
      harness: agentLabel,
      taskId: input?.taskId ?? null,
      prompt: rawTask,
      output: text,
      beforeSnapshot,
      saveReport: saveReport === true || input?.saveReport === true,
      reportPath: reportPath ?? input?.reportPath ?? null,
    });
    if (projectIntegration.changedFiles.length > 0) {
      reportStage(`${agentLabel} updated ${projectIntegration.changedFiles.length} workspace file(s): ${projectIntegration.changedFiles.slice(0, 5).join(", ")}`);
    }
    if (typeof onProjectIntegration === "function") {
      try { onProjectIntegration(projectIntegration); } catch {}
    }
    if (returnProjectIntegration === true || input?.returnProjectIntegration === true) {
      return {
        ok: true,
        status: "completed",
        output: text,
        summary: projectIntegration.summary || text.slice(0, 400),
        changedFiles: projectIntegration.changedFiles,
        createdFiles: projectIntegration.createdFiles,
        modifiedFiles: projectIntegration.modifiedFiles,
        deletedFiles: projectIntegration.deletedFiles,
        projectIntegration,
      };
    }
    return text;
  } catch (err) {
    if (signal?.aborted) throw error("task-cancelled", "the person asked to stop this task");
    throw err;
  } finally {
    try { client.close(); } catch {}
    kill();
  }
}

export function createPiAcpExecutor(options = {}) {
  const adapterDir = options.adapterDir ?? process.env.VOICEBOX_ACP_ADAPTER ?? PI_IDENTITY.defaultDir();
  const piBinary = options.piBinary ?? process.env.VOICEBOX_ACP_PI ?? "pi";
  const timeoutMs = options.timeoutMs ?? 60000;
  const maxOutputBytes = options.maxOutputBytes ?? 65536;

  function checkAdapter() {
    const described = describeAdapterInstall({ adapterDir });
    if (!described.ok) return { ok: false, refused: described.refused, why: described.why };
    return { ok: true, resolved: described.adapterDir, entry: described.entry };
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
    // cpbr (measured 2026-09-26): the ambient key is pi's anthropic FALLBACK, and the mechanism
    // says so per host — present/absent is operator-visible, and this read is what the generated
    // env table's pattern sees (docs-check only scans process.env.X).
    const hasAmbientAnthropicKey = Boolean(process.env.ANTHROPIC_API_KEY);
    return {
      ok: true,
      mechanism: `stdio-acp-client: pi-acp adapter with pi coding agent — ambient ANTHROPIC_API_KEY ${hasAmbientAnthropicKey ? "present (pi's anthropic fallback, cpbr)" : "absent (anthropic-model delegations refuse model-unsupported)"}`,
      bounds: {
        deadlineMs: Math.min(timeoutMs, typeof requestedDeadline === "number" ? requestedDeadline : 60000),
        maxOutputBytes: Math.min(maxOutputBytes, typeof requestedOutput === "number" ? requestedOutput : 65536),
      },
    };
  }

  async function run({
    input, bounds, signal, report, root, agentConfig, harness,
    enrichProjectContext, saveReport, reportPath, onProjectIntegration, returnProjectIntegration,
  } = {}) {
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
    // THE CHILD ENV IS A DELIBERATE PASS-THROUGH, NOT INHERITANCE BY DEFAULT (voicebox-beads-cpbr,
    // measured 2026-09-26): pi's anthropic provider has NO other auth path on a box whose pi auth
    // store lacks an anthropic entry — with the ambient ANTHROPIC_API_KEY removed, an
    // anthropic-model delegation refuses model-unsupported at set_config_option; with it, the same
    // delegation runs (answer content shape aside). Unlike the claude adapter (nz60: the key
    // OVERRIDES the login and stalls the prompt), pi's key is a fallback, not an override. So the
    // pi child keeps it — on purpose, and the test at tests/pi-acp-options.test.mjs pins that the
    // key flows and the host env is never mutated. If a measured stall ever appears on the pi
    // path, scope it the nz60 way (delete + opt-back), not half-way.
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

    return runAcpTask({
      adapterCheck,
      transportFactory: options.transportFactory,
      cwd, env, bounds, signal, report,
      decide: scopedDecide,
      agentConfig, input,
      timeoutMs, maxOutputBytes,
      agentLabel: "pi-acp",
      enrichProjectContext: enrichProjectContext ?? options.enrichProjectContext ?? false,
      saveReport: saveReport ?? options.saveReport ?? false,
      reportPath: reportPath ?? options.reportPath ?? null,
      onProjectIntegration: onProjectIntegration ?? options.onProjectIntegration ?? null,
      returnProjectIntegration: returnProjectIntegration ?? options.returnProjectIntegration ?? false,
    });
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
  // /lib64 holds the ELF loader and its host path is NOT constant (Debian/Ubuntu: usr/lib64, Arch:
  // usr/lib, aarch64: usr/lib64 with a different loader name), so mirror the host's own /lib64
  // target when it resolves under /usr — the only tree this bwrap binds.
  const lib64 = (() => {
    try { const t = fs.realpathSync("/lib64"); if (t.startsWith("/usr/")) return t.slice(1); } catch { /* not a symlink into /usr */ }
    return fs.existsSync("/usr/lib64") ? "usr/lib64" : "usr/lib";
  })();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "voicebox-acp-probe-"));
  // Only this fixed launch script is mounted; no user/project config or credentials are present.
  const launcher = path.join(dir, "launch.sh");
  fs.writeFileSync(launcher, `#!/bin/sh\nset -eu\nv=$(/harness/pi --version)\n[ "$v" = "${ACP_AGENT.piVersion}" ] || exit 78\nexec /usr/bin/node /packages/pi-acp/dist/index.js\n`, { mode: 0o700 });
  const args = ["--unshare-all", "--die-with-parent", "--new-session", "--clearenv",
    "--ro-bind", "/usr", "/usr", "--symlink", "usr/bin", "/bin", "--symlink", "usr/lib", "/lib", "--symlink", lib64, "/lib64",
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
