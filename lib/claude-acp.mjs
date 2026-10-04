// voicebox-beads-a74y: claude-code task adapter via @agentclientprotocol/claude-agent-acp.
// Identity-bound preflight only — the protocol pipeline is the SHARED runAcpTask
// core (lib/pi-acp.mjs), so pi and claude behavior cannot drift silently.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describeAdapterInstallFor, runAcpTask } from "./pi-acp.mjs";
import { TaskInterrupted } from "./task-interrupted.mjs";

const error = (refused, why) => Object.assign(new Error(why), { refused });

export const CLAUDE_ACP_AGENT = Object.freeze({
  name: "@agentclientprotocol/claude-agent-acp",
  version: "0.78.0", // pinned to the version CAP verified end-to-end (acp-bridge.ts, 2026-09-18)
});

function findNpxCachedClaudeAcp() {
  const npxCacheRoot = path.join(os.homedir(), ".npm", "_npx");
  try {
    if (fs.existsSync(npxCacheRoot)) {
      const entries = fs.readdirSync(npxCacheRoot, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const candidate = path.join(
          npxCacheRoot,
          entry.name,
          "node_modules",
          "@agentclientprotocol",
          "claude-agent-acp",
        );
        const pkgPath = path.join(candidate, "package.json");
        if (!fs.existsSync(pkgPath)) continue;
        try {
          const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
          if (pkg.name === CLAUDE_ACP_AGENT.name && pkg.version === CLAUDE_ACP_AGENT.version) {
            return candidate;
          }
        } catch {}
      }
    }
  } catch {}
  return null;
}

const CLAUDE_IDENTITY = {
  name: CLAUDE_ACP_AGENT.name,
  version: CLAUDE_ACP_AGENT.version,
  shortName: "claude-agent-acp",
  defaultDir: () => path.join(os.homedir(), ".voicebox", "acp", "claude-agent-acp"),
  dirEnv: "VOICEBOX_CLAUDE_ACP_ADAPTER",
  // Entry from the package's own manifest — never a guessed layout. bin may be
  // a string or an object; prefer the key matching the package short name.
  entryFor: (dir, pkg) => {
    let rel = null;
    if (typeof pkg.bin === "string") rel = pkg.bin;
    else if (pkg.bin && typeof pkg.bin === "object") {
      const short = CLAUDE_ACP_AGENT.name.split("/").pop();
      rel = pkg.bin[short] ?? Object.values(pkg.bin)[0];
    }
    if (typeof rel !== "string") rel = typeof pkg.main === "string" ? pkg.main : null;
    return rel ? path.join(dir, rel) : null;
  },
};

function npxOnPath(pathValue) {
  for (const dir of String(pathValue ?? process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, "npx");
    try { if (fs.existsSync(p) && fs.statSync(p).isFile()) return p; } catch {}
  }
  return null;
}

/**
 * The admission view of the claude adapter, one truth for delegate-time and
 * startup (mirrors describeAdapterInstall's contract). Resolution order is
 * CAP-verified: local install first, else npx-cached exact version when present,
 * else npx-pinned exact version. A PATH miss on the claude CLI is NOT fatal —
 * the adapter bundles the Agent SDK binary — and the returned describe says
 * WHICH runs; we never claim the CLI executed when the bundle did.
 */
export function describeClaudeAdapterInstall({ adapterDir: rawDir, pathEnv } = {}) {
  const configuredDir = rawDir ?? process.env[CLAUDE_IDENTITY.dirEnv];
  if (configuredDir) {
    const local = describeAdapterInstallFor(CLAUDE_IDENTITY, { adapterDir: configuredDir });
    if (local.ok) return { ...local, describe: `${local.adapterDir} (local install)`, via: "local" };
  }
  const npx = npxOnPath(pathEnv);
  if (!npx) {
    return { ok: false, refused: "adapter-unavailable", why: `${CLAUDE_ACP_AGENT.name} not installed at the configured dir and npx is not on PATH; set VOICEBOX_CLAUDE_ACP_ADAPTER or install npx.` };
  }
  if (!configuredDir) {
    const defaultLocal = describeAdapterInstallFor(CLAUDE_IDENTITY, {});
    if (defaultLocal.ok) {
      return { ...defaultLocal, describe: `${defaultLocal.adapterDir} (local install)`, via: "local" };
    }
    const cachedDir = findNpxCachedClaudeAcp();
    if (cachedDir) {
      const cached = describeAdapterInstallFor(CLAUDE_IDENTITY, { adapterDir: cachedDir });
      if (cached.ok) {
        return {
          ...cached,
          describe: `${CLAUDE_ACP_AGENT.name}@${CLAUDE_ACP_AGENT.version} via npx (${cached.adapterDir})`,
          via: "npx",
        };
      }
    }
  }
  return {
    ok: true,
    cmd: npx,
    args: ["-y", `${CLAUDE_ACP_AGENT.name}@${CLAUDE_ACP_AGENT.version}`],
    describe: `${CLAUDE_ACP_AGENT.name}@${CLAUDE_ACP_AGENT.version} via npx (pinned)`,
    via: "npx",
    // The PIN IS the version npx resolves to; stating it is not a claim about
    // a manifest — the local branch reports installedVersion from the package.
    installedVersion: CLAUDE_ACP_AGENT.version,
  };
}

export function resolveClaudeCli({ claudeCli } = {}) {
  const explicit = claudeCli ?? process.env.VOICEBOX_CLAUDE_CLI ?? "";
  if (explicit) {
    if (!fs.existsSync(explicit)) return { ok: false, refused: "adapter-unavailable", why: `VOICEBOX_CLAUDE_CLI points at ${explicit}, which is not a file.` };
    return { ok: true, path: explicit, ran: `explicit CLI ${explicit}` };
  }
  const userLocal = path.join(os.homedir(), ".local/bin/claude");
  if (fs.existsSync(userLocal)) return { ok: true, path: userLocal, ran: `user-installed CLI ${userLocal}` };
  return { ok: true, path: null, ran: "adapter-bundled Agent SDK binary (no CLI configured)" };
}

/**
 * The claude-code adapter's NAMED timeout ceiling (voicebox-beads-hmco): a warm claude turn
 * does not settle inside pi's 60s clamp (measured: a trivial prompt exceeded 60s warm), so
 * this adapter declares 120s. Bounded, named, and clamped — never unbounded.
 */
export const CLAUDE_ACP_TIMEOUT_CEILING_MS = 120000;

/**
 * The environment a claude-code adapter CHILD is spawned with (voicebox-beads-nz60).
 *
 * WHO IT IS FOR: the adapter process, never the host. `ANTHROPIC_API_KEY` is therefore scoped OUT by
 * default — an inherited key overrides claude.ai login inside the adapter and can stall the prompt
 * (measured on the sibling implementation's review; this box carries the key, so the defect was live
 * here). The host's own `process.env` is NEVER mutated: this returns a fresh copy.
 *
 * DELETE, DO NOT SET UNDEFINED. The property must be ABSENT from the child environment, not present
 * with the value `undefined`. Those are different children: a spawn path that forwards an
 * undefined-valued key writes the string "undefined", which is a key the adapter can still see. The
 * test asserts absence with `in`, not with `=== undefined`, so the weaker form cannot pass.
 *
 * THE OPT-BACK IS EXPLICIT AND NARROW, and there are two forms of it: the programmatic
 * `keepApiKey: true` (a caller that means it) and `VOICEBOX_CLAUDE_KEEP_API_KEY=1` (an owner's shell).
 * Anything else — unset, "0", "true" — scopes the key out.
 */
export function claudeChildEnv({ hostEnv = process.env, extraEnv = null, cliPath = null, keepApiKey = false } = {}) {
  // The flag reaches the helper through THREE doors, most specific first: an explicit caller's
  // extraEnv, the host env passed in (process.env by default), and the real process environment as a
  // fallback for a caller that passed a custom hostEnv. The middle read is spelled literally so the
  // generated environment table derives this variable instead of missing it — and it is load-bearing:
  // an owner who exported the flag keeps the key even when a caller supplies its own hostEnv.
  const env = {
    ...hostEnv,
    ...(extraEnv ?? {}),
    ...(cliPath ? { CLAUDE_CODE_EXECUTABLE: cliPath } : {}),
  };
  const flagFromProcess = process.env.VOICEBOX_CLAUDE_KEEP_API_KEY;
  const envFlag = extraEnv?.VOICEBOX_CLAUDE_KEEP_API_KEY ?? hostEnv?.VOICEBOX_CLAUDE_KEEP_API_KEY ?? flagFromProcess;
  const keepKey = keepApiKey === true || envFlag === "1";
  if (!keepKey) delete env.ANTHROPIC_API_KEY;
  return env;
}

export function createClaudeAcpExecutor(options = {}) {
  const timeoutMs = options.timeoutMs ?? CLAUDE_ACP_TIMEOUT_CEILING_MS;
  const maxOutputBytes = options.maxOutputBytes ?? 65536;

  function preflight() {
    const adapter = describeClaudeAdapterInstall({ adapterDir: options.adapterDir, pathEnv: options.pathEnv });
    if (!adapter.ok) return { ok: false, refused: adapter.refused, why: adapter.why };
    const cli = resolveClaudeCli({ claudeCli: options.claudeCli });
    if (!cli.ok) return cli;
    return { ok: true, adapter, cli };
  }

  function check(args = {}) {
    const harness = args.harness ?? args.agentConfig?.harness ?? args.input?.harness ?? args.input?.agent;
    if (harness && harness !== "claude" && harness !== "claude-code") {
      return { ok: false, refused: "adapter-not-configured", why: `claude executor only serves harness 'claude'/'claude-code', not '${harness}'.` };
    }
    const agentConfig = args.agentConfig;
    if (agentConfig) {
      if (agentConfig.adapter && agentConfig.adapter !== "claude-code" && agentConfig.adapter !== "claude") {
        return { ok: false, refused: "adapter-not-configured", why: `claude executor only supports adapter 'claude-code', not '${agentConfig.adapter}'.` };
      }
      if (agentConfig.pinnedVersion && agentConfig.pinnedVersion !== CLAUDE_ACP_AGENT.version) {
        return { ok: false, refused: "adapter-version-unsupported", why: `pinned adapter version '${agentConfig.pinnedVersion}' does not match installed ${CLAUDE_ACP_AGENT.name} ${CLAUDE_ACP_AGENT.version}.` };
      }
      if (agentConfig.transport && agentConfig.transport !== "stdio") {
        return { ok: false, refused: "unsupported-runtime-capability", why: `claude-agent-acp adapter only supports 'stdio' transport, not '${agentConfig.transport}'.` };
      }
      // NOTE vs pi: model/thinking are NOT refused at check — the adapter's own
      // config capability answers them at run (setConfigOption), and a failed
      // attempt throws model-unsupported named. check() must not fabricate a
      // capability verdict we have not measured for this adapter.
    }
    const pre = preflight();
    if (!pre.ok) return pre;
    const requestedDeadline = args.bounds?.deadlineMs ?? args.agentConfig?.bounds?.deadlineMs;
    const requestedOutput = args.bounds?.maxOutputBytes ?? args.agentConfig?.bounds?.maxOutputBytes;
    return {
      ok: true,
      mechanism: `stdio-acp-client: ${pre.adapter.describe} driving ${pre.cli.ran}`,
      bounds: {
        deadlineMs: Math.min(timeoutMs, typeof requestedDeadline === "number" ? requestedDeadline : CLAUDE_ACP_TIMEOUT_CEILING_MS),
        maxOutputBytes: Math.min(maxOutputBytes, typeof requestedOutput === "number" ? requestedOutput : 65536),
      },
    };
  }

  async function run({
    input, bounds, signal, report, root, agentConfig,
    enrichProjectContext, saveReport, reportPath, onProjectIntegration, returnProjectIntegration,
  } = {}) {
    const pre = preflight();
    if (!pre.ok) throw error(pre.refused, pre.why);
    const cwd = root?.path ?? (typeof options.root === "function" ? options.root()?.path : options.root?.path) ?? process.cwd();
    // The child environment is built by claudeChildEnv, which SCOPES the host's ANTHROPIC_API_KEY out
    // of the adapter child by default (delete-not-undefined, host process.env untouched) unless
    // VOICEBOX_CLAUDE_KEEP_API_KEY=1 says otherwise — see the helper's comment for why, and for the
    // absence-versus-undefined distinction the test pins.
    const env = claudeChildEnv({ hostEnv: process.env, extraEnv: options.env, cliPath: pre.cli.path, keepApiKey: options.keepApiKey === true });
    // Reach tools scoping matches pi's contract; asked-name extraction is
    // identical, imported through the shared decide shape below.
    const allowedTools = Array.isArray(agentConfig?.reach?.tools) ? new Set(agentConfig.reach.tools) : null;
    const scopedDecide = async (asked) => {
      if (allowedTools !== null) {
        const toolName = (typeof asked?.toolCall?.name === "string" && asked.toolCall.name.trim()) ||
          (typeof asked?.toolCall?.title === "string" && asked.toolCall.title.trim() && !asked.toolCall.title.includes(" ") ? asked.toolCall.title.trim() : null);
        if (!toolName || !allowedTools.has(toolName)) {
          return { allow: false, reason: `tool-not-in-agent-reach: tool '${toolName ?? "unknown"}' is not in declared reach [${Array.from(allowedTools).join(", ")}]` };
        }
      }
      if (typeof options.decide === "function") return options.decide(asked);
      return { allow: false, reason: "no permission host configured for claude executor" };
    };
    return runAcpTask({
      adapterCheck: pre.adapter,
      transportFactory: options.transportFactory,
      cwd, env, bounds, signal, report,
      decide: scopedDecide,
      agentConfig, input,
      timeoutMs, maxOutputBytes,
      timeoutCeilingMs: CLAUDE_ACP_TIMEOUT_CEILING_MS,
      agentLabel: "claude-code",
      expectedAgent: CLAUDE_ACP_AGENT,
      enrichProjectContext: enrichProjectContext ?? options.enrichProjectContext ?? false,
      saveReport: saveReport ?? options.saveReport ?? false,
      reportPath: reportPath ?? options.reportPath ?? null,
      onProjectIntegration: onProjectIntegration ?? options.onProjectIntegration ?? null,
      returnProjectIntegration: returnProjectIntegration ?? options.returnProjectIntegration ?? false,
    });
  }

  return Object.freeze({ check, run });
}
