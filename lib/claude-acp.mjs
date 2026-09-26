// lib/claude-acp.mjs — the Claude Code task adapter (voicebox-beads-a74y).
//
// Claude Code reaches ACP through the registry adapter package
// `@agentclientprotocol/claude-agent-acp`, which adapts the Claude Agent SDK (and its CLI)
// to the protocol. Launch resolution order, verified against CAP's acp-bridge.ts and the
// pinned package (2026-09-26):
//   1. VOICEBOX_CLAUDE_ACP_ADAPTER — an explicit local package directory. An explicit path
//      that does not verify refuses by name; it never falls through to npx (explicit config
//      fails closed).
//   2. The pi agent npm-prefix convention (~/.pi/agent/npm/node_modules/<pkg>) — how pi-acp
//      gets there; a local install avoids npx entirely: no PATH lookup, no network.
//   3. `npx -y <pkg>@<version>` — npx resolved to an ABSOLUTE path here: a launcher-started
//      server does not inherit the shell's PATH, and a bare "npx" spawn dies with ENOENT.
//
// The Claude CLI: the adapter honours CLAUDE_CODE_EXECUTABLE (verified: claudeCliPath() in
// the pinned package). When the CLI is visible we hand the adapter its ABSOLUTE path. When
// it is not, that is NOT fatal — the adapter bundles the Claude Agent SDK's native binary —
// and the mechanism string says "bundled fallback", never that the PATH CLI ran.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { createAcpClient } from "./acp-client.mjs";
import { TaskInterrupted } from "./task-interrupted.mjs";
import { extractToolName } from "./pi-acp.mjs";

const error = (refused, why) => Object.assign(new Error(why), { refused });

/** The pinned adapter identity — bumping means re-verifying the contract, not editing a string. */
export const CLAUDE_ACP_AGENT = Object.freeze({ name: "@agentclientprotocol/claude-agent-acp", version: "0.78.0" });

const DEFAULT_LOCAL_DIR = path.join(os.homedir(), ".pi/agent/npm/node_modules", CLAUDE_ACP_AGENT.name);

function resolveOnPath(name, pathValue = "") {
  for (const dir of String(pathValue).split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(dir, name);
    try { if (fs.statSync(candidate).isFile()) return candidate; } catch { /* not here */ }
  }
  return null;
}

/** The Claude CLI the adapter should drive, as an ABSOLUTE path — or null for the bundled fallback. */
export function resolveClaudeCli({ env = process.env } = {}) {
  const explicit = env.CLAUDE_CODE_EXECUTABLE;
  if (explicit) {
    try { if (path.isAbsolute(explicit) && fs.statSync(explicit).isFile()) return { cli: explicit, source: "CLAUDE_CODE_EXECUTABLE" }; } catch { /* fall through */ }
    return null;
  }
  const onPath = resolveOnPath("claude", env.PATH ?? "");
  return onPath ? { cli: onPath, source: "PATH" } : null;
}

/**
 * Describe the adapter the way the executor's own preflight sees it — the same contract as
 * pi-acp's describeAdapterInstall, plus an honest account of WHICH launch source answered.
 * For the npx source, presence is resolved at run time by npx itself — nothing here claims
 * the package is downloaded.
 */
export function describeClaudeAdapterInstall({ adapterDir, env = process.env } = {}) {
  const explicit = adapterDir ?? env.VOICEBOX_CLAUDE_ACP_ADAPTER ?? null;
  const candidates = explicit ? [explicit] : [DEFAULT_LOCAL_DIR];
  for (const candidate of candidates) {
    let resolved;
    try { resolved = fs.realpathSync(candidate); } catch { continue; }
    let pkg;
    try { pkg = JSON.parse(fs.readFileSync(path.join(resolved, "package.json"), "utf8")); }
    catch { return { ok: false, refused: "adapter-unavailable", why: `claude-agent-acp package.json is unreadable at ${resolved}.`, adapterDir: resolved }; }
    if (pkg.name !== CLAUDE_ACP_AGENT.name || pkg.version !== CLAUDE_ACP_AGENT.version) {
      return { ok: false, refused: "adapter-version-unsupported", why: `requires installed ${CLAUDE_ACP_AGENT.name} ${CLAUDE_ACP_AGENT.version}`, adapterDir: resolved, installedVersion: pkg.version ?? null };
    }
    const entry = path.join(resolved, "dist", "index.js");
    if (!fs.existsSync(entry)) {
      return { ok: false, refused: "adapter-unavailable", why: "claude-agent-acp dist/index.js missing; build or install the adapter package.", adapterDir: resolved };
    }
    return { ok: true, via: "local", adapterDir: resolved, entry, installedVersion: pkg.version };
  }
  if (explicit) {
    return { ok: false, refused: "adapter-unavailable", why: `claude-agent-acp not found at ${explicit} (VOICEBOX_CLAUDE_ACP_ADAPTER); install ${CLAUDE_ACP_AGENT.name}@${CLAUDE_ACP_AGENT.version} there or unset the override.`, adapterDir: explicit };
  }
  const npx = resolveOnPath("npx", env.PATH ?? "");
  if (!npx) {
    return { ok: false, refused: "adapter-unavailable", why: `no local ${CLAUDE_ACP_AGENT.name} install and no npx on this server's PATH; install the adapter package or repair the PATH.` };
  }
  return { ok: true, via: "npx", npx, installedVersion: null };
}

export function createClaudeAcpExecutor(options = {}) {
  const adapterDir = options.adapterDir ?? process.env.VOICEBOX_CLAUDE_ACP_ADAPTER ?? null;
  const timeoutMs = options.timeoutMs ?? 60000;
  const maxOutputBytes = options.maxOutputBytes ?? 65536;

  function checkAdapter() {
    return describeClaudeAdapterInstall({ adapterDir: adapterDir ?? undefined });
  }

  function launchSpec(described) {
    if (described.via === "local") return { cmd: process.execPath, args: [described.entry] };
    return { cmd: described.npx, args: ["-y", `${CLAUDE_ACP_AGENT.name}@${CLAUDE_ACP_AGENT.version}`] };
  }

  function check(args = {}) {
    const harness = args.harness ?? args.agentConfig?.harness ?? args.input?.harness ?? args.input?.agent;
    if (harness && harness !== "claude" && harness !== "claude-code") {
      return { ok: false, refused: "adapter-not-configured", why: `No Voicebox task adapter is configured for '${harness}'.` };
    }
    const agentConfig = args.agentConfig;
    if (agentConfig) {
      if (agentConfig.adapter && agentConfig.adapter !== "claude-code" && agentConfig.adapter !== "claude") {
        return { ok: false, refused: "adapter-not-configured", why: `claude executor only supports adapters 'claude-code'/'claude', not '${agentConfig.adapter}'.` };
      }
      if (agentConfig.pinnedVersion && agentConfig.pinnedVersion !== CLAUDE_ACP_AGENT.version) {
        return { ok: false, refused: "adapter-version-unsupported", why: `pinned adapter version '${agentConfig.pinnedVersion}' does not match installed ${CLAUDE_ACP_AGENT.name} ${CLAUDE_ACP_AGENT.version}.` };
      }
      if (agentConfig.transport && agentConfig.transport !== "stdio") {
        return { ok: false, refused: "unsupported-runtime-capability", why: `claude-agent-acp adapter only supports 'stdio' transport, not '${agentConfig.transport}'.` };
      }
      if (agentConfig.model?.options && Object.keys(agentConfig.model.options).length > 0) {
        return { ok: false, refused: "unsupported-model-options", why: "claude-agent-acp adapter does not support custom model options." };
      }
    }
    const adapterCheck = checkAdapter();
    if (!adapterCheck.ok) return { ok: false, refused: adapterCheck.refused, why: adapterCheck.why };
    const cli = resolveClaudeCli({ env: { ...process.env, ...options.env } });
    const adapterSource = adapterCheck.via === "local" ? `local install of ${CLAUDE_ACP_AGENT.name}` : `npx ${CLAUDE_ACP_AGENT.name}@${CLAUDE_ACP_AGENT.version}`;
    // Name the CLI's SOURCE, never its absolute path (the harness inventory asserts the report
    // carries no host PATH). The bundled fallback is named as what it is — never "the CLI ran".
    const cliSource = cli ? (cli.source === "CLAUDE_CODE_EXECUTABLE" ? "the Claude CLI named by CLAUDE_CODE_EXECUTABLE" : "the Claude CLI found on PATH") : "the Claude Agent SDK's bundled native binary (bundled fallback — no PATH CLI ran)";
    const requestedDeadline = args.bounds?.deadlineMs ?? args.agentConfig?.bounds?.deadlineMs;
    const requestedOutput = args.bounds?.maxOutputBytes ?? args.agentConfig?.bounds?.maxOutputBytes;
    return {
      ok: true,
      mechanism: `stdio-acp-client: ${adapterSource}; drives ${cliSource}`,
      bounds: {
        deadlineMs: Math.min(timeoutMs, typeof requestedDeadline === "number" ? requestedDeadline : 60000),
        maxOutputBytes: Math.min(maxOutputBytes, typeof requestedOutput === "number" ? requestedOutput : 65536),
      },
    };
  }

  async function run({ input, bounds, signal, report, root, agentConfig, harness } = {}) {
    const checked = check({ agentConfig, harness, bounds, input });
    if (!checked.ok) throw error(checked.refused, checked.why);
    const adapterCheck = checkAdapter();

    const cwd = root?.path ?? (typeof options.root === "function" ? options.root()?.path : options.root?.path) ?? process.cwd();
    const cli = resolveClaudeCli({ env: { ...process.env, ...options.env } });
    // ANTHROPIC_API_KEY is scoped OUT of the adapter child by default (voicebox-beads-a74y,
    // measured 2026-09-26): an inherited key takes precedence over the claude.ai login inside
    // the adapter and the prompt stalls to its deadline (same A/B, key in/out: stall / answer
    // in 8s). The host's env is never mutated; VOICEBOX_CLAUDE_KEEP_API_KEY=1 keeps today's
    // behaviour for a caller who WANTS the key to win.
    const keepKey = options.keepApiKey === true || process.env.VOICEBOX_CLAUDE_KEEP_API_KEY === "1";
    const env = {
      ...process.env,
      ...options.env,
      ...(cli ? { CLAUDE_CODE_EXECUTABLE: cli.cli } : {}),
    };
    // delete, not `= undefined` (spawn would string-ify an undefined value into the child's env)
    if (!keepKey) delete env.ANTHROPIC_API_KEY;

    // Needed reach is NOT effect authority — same rule as the pi executor.
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
      const spec = launchSpec(adapterCheck);
      const child = spawn(spec.cmd, spec.args, {
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
      expectedAgent: CLAUDE_ACP_AGENT,
    });

    if (signal) {
      if (signal.aborted) {
        kill();
        throw error("task-cancelled", "task was cancelled before execution");
      }
      signal.addEventListener("abort", () => {
        try { client.cancel(); } catch {}
        // Deterministic settle: close() rejects every pending request NOW. (The real-spawn
        // path would settle on the child's close event; a factory transport has no process
        // to kill, so the client itself must stop.)
        try { client.close(); } catch {}
        kill();
      }, { once: true });
    }

    try {
      if (report) report("initializing claude-agent-acp");
      await client.initialize();
      if (signal?.aborted) throw error("task-cancelled", "task was cancelled during initialization");

      if (report) report(`creating session in ${cwd}`);
      await client.newSession(cwd);
      if (signal?.aborted) throw error("task-cancelled", "task was cancelled during session creation");

      // A configured model id is applied the ACP way; a refusal names itself.
      const modelRef = agentConfig?.model;
      let modelId = null;
      if (typeof modelRef === "string") modelId = modelRef;
      else if (modelRef && typeof modelRef === "object") {
        const name = typeof modelRef.model === "string" && modelRef.model ? modelRef.model.trim()
          : typeof modelRef.id === "string" && modelRef.id ? modelRef.id.trim() : "";
        modelId = name || null;
      }
      if (modelId) {
        if (report) report(`configuring model: ${modelId}`);
        try {
          await client.setConfigOption("model", modelId);
        } catch (err) {
          throw error("model-unsupported", `configured model '${modelId}' is not supported by the adapter: ${err.message ?? err}`);
        }
      }

      if (report) report("sending prompt to claude");
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
