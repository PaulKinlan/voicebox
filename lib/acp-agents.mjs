/**
 * @summary Config-driven ACP agents: a spec of { id, command, args } is all it takes to delegate to any agent that speaks the Agent Client Protocol over stdio.
 */
// ONE ADAPTER, MANY AGENTS (voicebox-beads-cwx5.10). Pi and Claude Code each have a module because each needs
// something of its own (Pi a sandboxed probe, Claude a bundled binary and an npx cache). Every other ACP agent
// needs nothing of the kind: it is a command that speaks JSON-RPC on stdin/stdout. So an agent here is DATA —
//
//   { id, command, args, label?, keepEnv?, handshakeTimeoutMs? }
//
// — and the protocol pipeline is the shared `runAcpTask` (lib/pi-acp.mjs), the same one Pi and Claude run, so
// the handshake, the three clocks, cancellation, permissions and reporting cannot differ between agents.
//
// WHERE SPECS COME FROM, AND WHY NOT FROM THE PAGE. The built-in list below names agents whose launch line is
// documented by their vendor. Anything else is added by the HOST, in `acp-agents.json` in the host's own
// directory (or the file VOICEBOX_ACP_AGENTS_FILE names). A spec is a command line this process will run, so
// it has the custody of the host token: a file the person's shell writes, never a field on an agent row the
// page can post. An agent row only NAMES a spec, by `adapter: "<id>"`.
//
// THE VERSION IS NOT CHECKED. The ACP handshake checks the protocol version (lib/acp-client.mjs); which agent
// answered, and which version of it, is reported and refuses nothing (owner decision 2026-11-12).
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_TASK_BUDGET_MS } from "../core/tasks.ts";
import { runAcpTask } from "./pi-acp.mjs";
import { createWorkspaceDecide } from "./acp-decide.mjs";
import { expandHome } from "./state-dirs.mjs";

const fail = (refused, why) => Object.assign(new Error(why), { refused });

/**
 * Agents whose ACP launch line is published by the people who ship them. Sources, read 2026-11-12:
 * Antigravity — antigravity.google/docs/cli/acp (`agy acp`; sign in once with `agy acp --login`).
 * Gemini CLI, OpenCode, Codex — the launch lines ACP clients ship for them (`gemini --acp`, `opencode acp`,
 * and Zed's `@zed-industries/codex-acp` bridge run through npx).
 * None of these was run end to end from this repository's CI: no agent binary or account is present there.
 */
export const BUILTIN_ACP_AGENTS = Object.freeze([
  { id: "antigravity-acp", label: "Antigravity", command: "agy", args: ["acp"] },
  { id: "gemini-acp", label: "Gemini CLI", command: "gemini", args: ["--acp"] },
  { id: "opencode-acp", label: "OpenCode", command: "opencode", args: ["acp"] },
  { id: "codex-acp", label: "Codex", command: "npx", args: ["-y", "@zed-industries/codex-acp"] },
].map((spec) => Object.freeze({ ...spec, args: Object.freeze([...spec.args]), source: "built-in" })));

/** The model-provider keys Voicebox itself holds. A delegated agent uses its own sign-in unless a spec keeps one. */
export const SCOPED_OUT_ENV = Object.freeze(["GEMINI_API_KEY", "GOOGLE_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"]);

const ID = /^[a-z][a-z0-9-]{1,47}$/;
const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,63}$/;
/** Adapter names other executors already answer to; a spec may not take one over. */
export const RESERVED_ADAPTER_IDS = Object.freeze([
  "pi-acp", "pi", "claude-code", "claude", "antigravity", "agy", "agentapi", "codex-cli", "codex",
  "gemini-cli", "gemini", "opencode", "in-process", "browser-worker",
]);

/**
 * Check one spec. Returns `{ ok: true, spec }` (frozen, defaults filled) or `{ ok: false, refused, why }`.
 * Deliberately strict: this is a command line, and a malformed one should be named at startup, not at delegation.
 */
export function validateAcpAgentSpec(raw, { source = "host" } = {}) {
  const bad = (why) => ({ ok: false, refused: "acp-agent-spec-invalid", why });
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return bad("an ACP agent spec is an object: { id, command, args }");
  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  if (!ID.test(id)) return bad(`'${String(raw.id).slice(0, 48)}' is not a spec id: lowercase letters, digits and dashes, starting with a letter, 2 to 48 characters`);
  if (RESERVED_ADAPTER_IDS.includes(id)) return bad(`'${id}' is an adapter Voicebox already provides; choose another id (for example '${id}-acp')`);
  const command = typeof raw.command === "string" ? raw.command.trim() : "";
  if (!command || command.length > 512 || /[\0\n\r]/.test(command)) return bad(`spec '${id}' needs a command: a program name on PATH or an absolute path`);
  const args = raw.args === undefined ? [] : raw.args;
  if (!Array.isArray(args) || args.length > 32 || args.some((a) => typeof a !== "string" || a.length > 1024 || a.includes("\0"))) {
    return bad(`spec '${id}': args is a list of at most 32 strings`);
  }
  const keepEnv = raw.keepEnv === undefined ? [] : raw.keepEnv;
  if (!Array.isArray(keepEnv) || keepEnv.length > 16 || keepEnv.some((name) => typeof name !== "string" || !ENV_NAME.test(name))) {
    return bad(`spec '${id}': keepEnv is a list of at most 16 environment variable names`);
  }
  const handshakeTimeoutMs = raw.handshakeTimeoutMs === undefined ? 120000 : raw.handshakeTimeoutMs;
  if (!Number.isSafeInteger(handshakeTimeoutMs) || handshakeTimeoutMs < 1000 || handshakeTimeoutMs > 600000) {
    return bad(`spec '${id}': handshakeTimeoutMs is between 1000 and 600000`);
  }
  const label = typeof raw.label === "string" && raw.label.trim() ? raw.label.trim().slice(0, 64) : id;
  return {
    ok: true,
    spec: Object.freeze({ id, label, command, args: Object.freeze([...args]), keepEnv: Object.freeze([...keepEnv]), handshakeTimeoutMs, source }),
  };
}

/**
 * The specs this host runs with: the built-ins, then the host's own file. A host spec with a built-in's id
 * REPLACES it (the person knows their install better than this list does). Returns `{ specs, problems, file }`;
 * a problem never stops the server — a bad entry is skipped and named, the rest load.
 */
export function loadAcpAgentSpecs({ hostDir = null, file = process.env.VOICEBOX_ACP_AGENTS_FILE } = {}) {
  const specs = new Map();
  const problems = [];
  for (const builtin of BUILTIN_ACP_AGENTS) {
    const checked = validateAcpAgentSpec(builtin, { source: "built-in" });
    if (checked.ok) specs.set(checked.spec.id, checked.spec);
    else problems.push(checked.why);
  }
  const chosen = typeof file === "string" && file.trim() ? expandHome(file.trim()) : (hostDir ? path.join(hostDir, "acp-agents.json") : null);
  if (chosen) {
    let text = null;
    try { text = fs.readFileSync(chosen, "utf8"); }
    catch (e) { if (e?.code !== "ENOENT") problems.push(`${chosen} could not be read: ${e?.code ?? e?.message}`); }
    if (text !== null) {
      let parsed = null;
      try { parsed = JSON.parse(text); }
      catch (e) { problems.push(`${chosen} is not JSON: ${e?.message}`); }
      const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.agents) ? parsed.agents : parsed === null ? [] : null;
      if (list === null) problems.push(`${chosen} must hold a list of specs, or { "agents": [ … ] }`);
      for (const raw of (list ?? []).slice(0, 64)) {
        const checked = validateAcpAgentSpec(raw, { source: chosen });
        if (checked.ok) specs.set(checked.spec.id, checked.spec);
        else problems.push(`${chosen}: ${checked.why}`);
      }
    }
  }
  return { specs: Object.freeze([...specs.values()]), problems: Object.freeze(problems), file: chosen };
}

function isExecutable(file) {
  try { fs.accessSync(file, fs.constants.X_OK); return fs.statSync(file).isFile(); }
  catch { return false; }
}

/** Find a spec's program: an absolute (or ~) path as given, otherwise the first match on PATH. */
export function resolveAcpCommand(command, pathEnv = process.env.PATH) {
  const expanded = expandHome(command);
  if (path.isAbsolute(expanded)) return isExecutable(expanded) ? expanded : null;
  if (expanded.includes("/") || expanded.includes(path.sep)) return null; // a relative path means nothing here: the cwd is the task's root
  for (const dir of String(pathEnv ?? "").split(path.delimiter)) {
    if (!dir || !path.isAbsolute(dir)) continue;
    const candidate = path.join(dir, expanded);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

/**
 * The environment an agent child is spawned with: the host's, minus the model-provider keys Voicebox holds for
 * itself, unless the spec keeps one by name. The property is DELETED, never set to undefined (see claudeChildEnv
 * for why those are different children). The host's own environment is not touched.
 */
export function acpAgentChildEnv(spec, { hostEnv = process.env, extraEnv = null } = {}) {
  const env = { ...hostEnv, ...(extraEnv ?? {}) };
  for (const name of SCOPED_OUT_ENV) {
    if (!spec.keepEnv.includes(name)) delete env[name];
  }
  return env;
}

/**
 * The task executor for one spec: `{ check(args), run(args) }`, the shape every other adapter has.
 * `options`: { root, decide, env, pathEnv, transportFactory, budgetMs, maxOutputBytes, onProjectIntegration, … }.
 */
export function createAcpAgentExecutor(rawSpec, options = {}) {
  const validated = validateAcpAgentSpec(rawSpec, { source: rawSpec?.source ?? "host" });
  if (!validated.ok) throw fail(validated.refused, validated.why);
  const spec = validated.spec;
  const budgetMs = options.budgetMs ?? DEFAULT_TASK_BUDGET_MS;
  const maxOutputBytes = options.maxOutputBytes ?? 65536;

  function preflight() {
    if (typeof options.transportFactory === "function") {
      return { ok: true, cmd: spec.command, args: [...spec.args], describe: `${spec.label} (${spec.command} ${spec.args.join(" ")}`.trim() + ")" };
    }
    const binary = resolveAcpCommand(spec.command, options.pathEnv ?? options.env?.PATH ?? process.env.PATH);
    if (!binary) {
      return {
        ok: false,
        refused: "adapter-unavailable",
        why: `${spec.label} is not installed where Voicebox can find it: '${spec.command}' is not an executable on PATH. Install it, or set an absolute path for '${spec.id}' in acp-agents.json.`,
      };
    }
    return { ok: true, cmd: binary, args: [...spec.args], describe: `${spec.label} (${binary} ${spec.args.join(" ")}`.trim() + ")" };
  }

  function check(args = {}) {
    const agentConfig = args.agentConfig;
    if (agentConfig?.adapter && agentConfig.adapter !== spec.id) {
      return { ok: false, refused: "adapter-not-configured", why: `the '${spec.id}' executor does not serve adapter '${agentConfig.adapter}'.` };
    }
    if (agentConfig?.transport && agentConfig.transport !== "stdio") {
      return { ok: false, refused: "unsupported-runtime-capability", why: `ACP agent '${spec.id}' speaks over stdio, not '${agentConfig.transport}'.` };
    }
    const pre = preflight();
    if (!pre.ok) return pre;
    const requestedDeadline = args.bounds?.deadlineMs ?? agentConfig?.bounds?.deadlineMs;
    const requestedOutput = args.bounds?.maxOutputBytes ?? agentConfig?.bounds?.maxOutputBytes;
    return {
      ok: true,
      mechanism: `stdio-acp-client: ${pre.describe}`,
      bounds: {
        deadlineMs: Math.min(budgetMs, typeof requestedDeadline === "number" ? requestedDeadline : budgetMs),
        maxOutputBytes: Math.min(maxOutputBytes, typeof requestedOutput === "number" ? requestedOutput : maxOutputBytes),
      },
    };
  }

  async function run({
    input, bounds, signal, report, onConsole, root, agentConfig,
    enrichProjectContext, saveReport, reportPath, onProjectIntegration, returnProjectIntegration,
  } = {}) {
    const pre = preflight();
    if (!pre.ok) throw fail(pre.refused, pre.why);
    const cwd = root?.path ?? (typeof options.root === "function" ? options.root()?.path : options.root?.path) ?? process.cwd();
    return runAcpTask({
      adapterCheck: pre,
      transportFactory: options.transportFactory,
      cwd,
      env: acpAgentChildEnv(spec, { hostEnv: process.env, extraEnv: options.env }),
      bounds, signal, report, onConsole,
      decide: createWorkspaceDecide({ cwd, agentConfig, report, agentLabel: spec.id, hostDecide: options.decide }),
      agentConfig, input,
      timeoutMs: spec.handshakeTimeoutMs,
      maxOutputBytes,
      timeoutCeilingMs: spec.handshakeTimeoutMs,
      agentLabel: spec.id,
      enrichProjectContext: enrichProjectContext ?? options.enrichProjectContext ?? false,
      saveReport: saveReport ?? options.saveReport ?? false,
      reportPath: reportPath ?? options.reportPath ?? null,
      onProjectIntegration: onProjectIntegration ?? options.onProjectIntegration ?? null,
      returnProjectIntegration: returnProjectIntegration ?? options.returnProjectIntegration ?? false,
    });
  }

  return Object.freeze({ spec, check, run });
}
