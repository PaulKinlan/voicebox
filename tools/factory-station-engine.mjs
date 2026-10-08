/**
 * Station engine selection and credential preflight for the local review trigger
 * (voicebox-beads-zljj).
 *
 * The review trigger used to call `factory run <station> --target <root>` with no `--engine`, so
 * the Software Factory resolved the engine itself (`choose_engine("auto")` -> `pi`, the only
 * engine whose adapter enforces a tool policy). On a project VM that silently produced
 * "No API key found for the selected model." for every station: the factory runs `pi` inside the
 * bubblewrap sandbox, which mounts a fresh tmpfs over `$HOME` by design, so the operator's
 * `~/.pi` session auth (Gemini / ChatGPT subscription logins) is unreachable and the engine
 * authenticates ONLY from the environment variables the factory's lib/child_env.py allowlists
 * (ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, GOOGLE_API_KEY, DEEPSEEK_API_KEY,
 * OPENROUTER_API_KEY). No such key is set on a fleet VM, the `claude` engine - the one adapter
 * that does read the subscription credentials in `~/.claude` - is refused by the factory for a
 * public target, and `antigravity` refuses every tool policy.
 *
 * That is not, however, the whole story, and believing the config was the whole fix is exactly
 * the trap this module exists to close. Driving the only remaining candidate - the host
 * provisioned `deepseek` integration (`https://deepseek.int.exe.xyz`, reachable from every
 * tagged VM, non-secret placeholder key) - produced a station run that **exited 0, wrote a
 * schema-valid report, and reported a clean scan**. It was not clean: the factory's
 * lib/adapters/deepseek.sh captures the prompt into $PROMPT and then runs the API call from
 * `python3 - <<EOF`, whose stdout/stdin heredoc consumes stdin, so the adapter's own
 * `prompt = sys.stdin.read()` returns "" and every run sends an EMPTY user message. The model
 * dutifully returns "No scanner data was supplied in the request", zero findings, exit 0 - a
 * silent false-clean that no schema, provenance or exit-code check can see. Verified 2026-10-08
 * against the adapter directly and against a real station run (see `UNSOUND_ENGINES`).
 *
 * So the policy is:
 *
 *   - `VOICEBOX_FACTORY_ENGINE` (host config, e.g. ~/.fleet/env) chooses the engine, so the
 *     operator can pin one per host.
 *   - otherwise the factory's own default (`pi`) is kept, and its missing credential is
 *     reported as a NAMED environment failure (exit 2, `verdict: ENVIRONMENT`) instead of the
 *     opaque no-verdict run the voicebox side produced before - the counterpart of agents-zrn
 *     (8622ba8) on the factory side.
 *   - an engine whose adapter cannot deliver the payload is REFUSED, with the upstream defect
 *     and the removal condition named, so a station can never be "clean" because it saw
 *     nothing.
 *   - a station that needs `worktree-write` (a proposer) is never pointed at a payload-only
 *     engine.
 *   - the engine and model are part of the review cache key, so a verdict is never replayed
 *     across engines.
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
 * Engines whose adapter is known NOT to deliver the station payload to the model.
 *
 * A run on one of these can exit 0 with a schema-valid report that says it saw nothing, so it
 * must be refused rather than trusted. Remove an entry when the upstream fix lands and a real
 * station run on that engine shows the model triaging the pre-pass candidates.
 */
export const UNSOUND_ENGINES = Object.freeze(
  new Map([
    [
      "deepseek",
      "the factory's lib/adapters/deepseek.sh never passes the prompt to its API call " +
        "(the prompt is read into $PROMPT, then `python3 - <<EOF` consumes stdin, so the " +
        "adapter's own sys.stdin.read() is empty): every run sends an empty user message and " +
        "returns a schema-valid 'No scanner data was supplied' report with exit 0. Verified " +
        "2026-10-08 by driving lib/adapters/deepseek.sh directly and by a real `factory run " +
        "accessibility --engine deepseek` on this repository. Remove after the adapter passes " +
        "the prompt (e.g. through the environment or a temp file) and a real run triages the " +
        "pre-pass candidates",
    ],
  ]),
);

/**
 * Engines whose adapters can enforce `worktree-write`. `deepseek` is payload-only
 * (lib/containment.py ENGINE_TOOL_POLICIES), so it may only run read-only stations.
 */
export const WRITE_CAPABLE_ENGINES = Object.freeze(new Set(["pi", "claude"]));

/** Tool policy the factory derives for each agent class (lib/containment.py, agents-6ce). */
export const READ_ONLY_CLASSES = Object.freeze(new Set(["observer", "optimizer"]));
export const WRITE_CLASSES = Object.freeze(new Set(["proposer"]));

/**
 * The model variable each engine's adapter actually reads. Only the engines that consume one are
 * listed: the `pi` and `claude` adapters pass no model flag at all, so reporting a model for them
 * would be a claim about the run that nothing verifies (and it would key the review cache on an
 * unrelated caller's PI_MODEL).
 */
const ENGINE_MODEL_VARS = Object.freeze({
  deepseek: ["DEEPSEEK_MODEL"],
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
 * Returns `"unknown"` when the manifest is absent or does not declare a class: the caller then
 * keeps the factory's own engine resolution rather than guessing a tool policy.
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
 *   source: "env" | "default", missing: string[], error?: string
 * }}
 */
export function resolveStationEngine({ station, env = process.env, agentsDir } = {}) {
  const className = stationClass(station, { env, agentsDir });
  const toolPolicy = toolPolicyForClass(className);

  const requested = envValue(env, "VOICEBOX_FACTORY_ENGINE");
  const engine = requested || "pi";
  const source = requested ? "env" : "default";
  const model = resolveEngineModel(engine, env);

  const unsound = UNSOUND_ENGINES.get(engine);
  if (unsound) {
    return {
      ok: false,
      engine,
      model,
      className,
      toolPolicy,
      source,
      missing: [],
      error: `engine '${engine}' cannot deliver the station payload to the model: ${unsound}`,
    };
  }

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
