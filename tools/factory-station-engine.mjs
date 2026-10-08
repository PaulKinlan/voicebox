/**
 * Station engine selection and credential preflight for the local review trigger
 * (voicebox-beads-zljj).
 *
 * The review trigger used to call `factory run <station> --target <root>` with no `--engine`,
 * so the Software Factory resolved the engine itself (`choose_engine("auto")` -> `pi`, the only
 * engine whose adapter enforces a tool policy). On a project VM that silently produced
 * "No API key found for the selected model." for every station: the factory runs `pi` inside
 * the bubblewrap sandbox, which mounts a fresh tmpfs over `$HOME` by design, so the operator's
 * `~/.pi` session auth (Gemini / ChatGPT subscription logins) is unreachable and the engine
 * authenticates ONLY from the environment variables lib/child_env.py allowlists
 * (ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, GOOGLE_API_KEY, DEEPSEEK_API_KEY,
 * OPENROUTER_API_KEY). No such key is set on the fleet VMs, and the `claude` engine - the one
 * adapter that does read the subscription credentials in `~/.claude` - is refused by the
 * factory for a public target (`engine 'claude' ... refusing on target`), and `antigravity`
 * refuses every tool policy.
 *
 * What DOES authenticate on the VMs is the host-provisioned model integration: Paul's exe.dev
 * BYOK LLM integrations (`https://<provider>.int.exe.xyz`) are reachable from every tagged VM
 * and accept the fixed, non-secret placeholder `exe-integration` as the key. For the payload
 * engines (`deepseek`) the factory already passes DEEPSEEK_API_KEY / DEEPSEEK_BASE_URL /
 * DEEPSEEK_MODEL from the host environment through lib/child_env.py, so a read-only station
 * can run end to end with no raw key and no sandbox change.
 *
 * This module makes that selection explicit, honest and non-regressing:
 *
 *   - `VOICEBOX_FACTORY_ENGINE` (host config, e.g. ~/.fleet/env) always wins, so the operator
 *     can pin an engine per host.
 *   - Otherwise a station whose agent manifest declares a read-only class (`observer`,
 *     `optimizer`) uses `deepseek` WHEN the integration credentials are present, because the
 *     factory grants it `read-only` and the payload engine can honour that.
 *   - Everything else keeps `pi` - proposer stations need `worktree-write`, which only the `pi`
 *     (sandboxed) and `claude` adapters can enforce, and a payload engine would be refused by
 *     `lib/containment.py:check_engine`.
 *   - The credential preflight turns a missing engine credential into a NAMED environment
 *     failure (exit 2, `verdict: ENVIRONMENT`) instead of the opaque station failure that
 *     produced "no verdict" runs (the voicebox-side counterpart of agents-zrn 8622ba8).
 *
 * The engine and model are part of the review cache key (see
 * `tools/factory-issue-router.mjs:computeReviewCacheKey`), so a verdict produced by one engine
 * is never replayed for a different one.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { homedir } from "node:os";

/** The environment variables each engine adapter may authenticate from (lib/child_env.py). */
export const ENGINE_CREDENTIAL_VARS = Object.freeze({
  pi: Object.freeze([
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "DEEPSEEK_API_KEY",
    "OPENROUTER_API_KEY",
  ]),
  deepseek: Object.freeze(["DEEPSEEK_API_KEY"]),
  claude: Object.freeze([
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN",
  ]),
  // Listed for completeness: its adapter refuses every tool policy, so the factory will refuse
  // it before authentication ever matters (lib/containment.py ENGINE_TOOL_POLICIES).
  antigravity: Object.freeze(["GEMINI_API_KEY", "GOOGLE_API_KEY"]),
});

/**
 * Engines whose adapters can enforce `worktree-write`. `deepseek` is payload-only
 * (lib/containment.py ENGINE_TOOL_POLICIES), so it may only run read-only stations.
 */
export const WRITE_CAPABLE_ENGINES = Object.freeze(new Set(["pi", "claude"]));

/** Tool policy the factory derives for each agent class (lib/containment.py, agents-6ce). */
export const READ_ONLY_CLASSES = Object.freeze(new Set(["observer", "optimizer"]));
export const WRITE_CLASSES = Object.freeze(new Set(["proposer"]));

/** The model each engine reports for evidence; the adapters read it from their own env vars. */
const ENGINE_MODEL_VARS = Object.freeze({
  deepseek: ["DEEPSEEK_MODEL"],
  pi: ["PI_MODEL"],
  claude: ["CLAUDE_MODEL", "ANTHROPIC_MODEL"],
});

function envValue(env, name) {
  const value = env?.[name];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : "";
}

/** The agents tree that carries each station's manifest (`~/agents` on a fleet VM). */
export function resolveAgentsDir(env = process.env) {
  return env.VOICEBOX_FACTORY_AGENTS_DIR || path.join(homedir(), "agents");
}

/**
 * The station's declared class from its manifest (`agents/<station>/agent.yaml`).
 *
 * Returns `"unknown"` when the manifest is absent or does not declare a class: the trigger
 * then keeps the factory's own engine resolution rather than guessing a tool policy.
 */
export function stationClass(station, { env = process.env, agentsDir } = {}) {
  const root = agentsDir || resolveAgentsDir(env);
  const manifest = path.join(root, "agents", String(station || ""), "agent.yaml");
  if (!station || !existsSync(manifest)) return "unknown";
  try {
    const match = readFileSync(manifest, "utf8").match(/^class:\s*([A-Za-z-]+)\s*$/m);
    return match ? match[1].toLowerCase() : "unknown";
  } catch {
    return "unknown";
  }
}

/** The tool policy the factory grants a declared class; `unknown` is left to the factory. */
export function toolPolicyForClass(className) {
  if (READ_ONLY_CLASSES.has(className)) return "read-only";
  if (WRITE_CLASSES.has(className)) return "worktree-write";
  return "unknown";
}

/** The first model variable the engine's adapter actually reads, or "". */
export function resolveEngineModel(engine, env = process.env) {
  const explicit = envValue(env, "VOICEBOX_FACTORY_MODEL");
  if (explicit) return explicit;
  for (const name of ENGINE_MODEL_VARS[engine] || []) {
    const value = envValue(env, name);
    if (value) return value;
  }
  return "";
}

/** Credential variables the engine needs but that are absent from the environment. */
export function unmetEngineCredentials(engine, env = process.env) {
  const vars = ENGINE_CREDENTIAL_VARS[engine];
  if (!vars) return [`unknown engine '${engine}'`];
  const present = vars.some((name) => envValue(env, name) !== "");
  return present ? [] : [...vars];
}

/**
 * Choose the engine for `station` and report why, without executing anything.
 *
 * @returns {{
 *   ok: boolean, engine: string, model: string, className: string, toolPolicy: string,
 *   source: "env" | "class-default" | "default", missing: string[], error?: string
 * }}
 */
export function resolveStationEngine({ station, env = process.env, agentsDir } = {}) {
  const className = stationClass(station, { env, agentsDir });
  const toolPolicy = toolPolicyForClass(className);

  let engine;
  let source;
  const requested = envValue(env, "VOICEBOX_FACTORY_ENGINE");
  if (requested) {
    engine = requested;
    source = "env";
  } else if (toolPolicy === "read-only" && envValue(env, "DEEPSEEK_API_KEY") !== "") {
    // The integration is provisioned on this host and the station only needs read-only, which
    // is the one policy the payload engine can honour.
    engine = "deepseek";
    source = "class-default";
  } else {
    engine = "pi";
    source = "default";
  }

  const model = resolveEngineModel(engine, env);
  const missing = unmetEngineCredentials(engine, env);

  if (missing.length > 0) {
    return {
      ok: false,
      engine,
      model,
      className,
      toolPolicy,
      source,
      missing,
      error: `engine '${engine}' has no credential in the environment (looked for ${missing.join(", ")})`,
    };
  }

  if (toolPolicy === "worktree-write" && !WRITE_CAPABLE_ENGINES.has(engine)) {
    return {
      ok: false,
      engine,
      model,
      className,
      toolPolicy,
      source,
      missing: [],
      error:
        `station '${station}' is a '${className}' and needs the worktree-write tool policy, ` +
        `but engine '${engine}' is payload-only; use --engine pi (or set VOICEBOX_FACTORY_ENGINE)`,
    };
  }

  return { ok: true, engine, model, className, toolPolicy, source, missing: [] };
}

/** One-line, log-safe description of a selection (never prints credential values). */
export function describeStationEngine(selection) {
  if (!selection) return "engine: (unresolved)";
  const parts = [
    `engine '${selection.engine}'`,
    `class ${selection.className}`,
    `policy ${selection.toolPolicy}`,
    `source ${selection.source}`,
  ];
  if (selection.model) parts.push(`model ${selection.model}`);
  return parts.join(", ");
}
