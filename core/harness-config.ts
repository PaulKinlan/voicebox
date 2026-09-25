// core/agent-config.ts — CONFIGURATION OF AGENTS, RUNTIMES, AND EXECUTION ENVIRONMENTS
//
// WHY THIS FILE EXISTS (voicebox-beads-8fv.2):
// docs/03-architecture-k3.md §1 and §9 distinguish harnesses (the engine implementation, e.g. pi),
// configured agents (named instances with specific model, tools, bounds, and persona),
// and execution environments (where the agent runs — its filesystem root, boundary, and authority).
//
// This file defines the pure, secret-free contract connecting them:
// 1. RUNTIME: The execution platform ("node" | "deno" | "browser") and its physical capabilities
//    (e.g., a browser cannot spawn a stdio CLI; node/deno can).
// 2. EXECUTION ENVIRONMENT: An environment key (from core/environment.ts) owning the root, sandboxing,
//    and authority.
// 3. CONFIGURED AGENT: A stable, secret-free record defining an agent instance. One harness can have
//    multiple configured instances in the same environment. Labels are mutable; IDs are permanent.
//
// PURE: No imports outside core/ (N18). Zero IO, zero network, zero secrets.

export type RuntimeKind = "node" | "deno" | "browser";

export interface RuntimeCapabilities {
  canSpawnCli: boolean;
  transports: Array<"stdio" | "websocket" | "in-process" | "web-worker">;
}

export const RUNTIME_CAPABILITIES: Record<RuntimeKind, RuntimeCapabilities> = {
  node: {
    canSpawnCli: true,
    transports: ["stdio", "websocket", "in-process"],
  },
  deno: {
    canSpawnCli: true,
    transports: ["stdio", "websocket", "in-process", "web-worker"],
  },
  browser: {
    canSpawnCli: false,
    transports: ["websocket", "in-process", "web-worker"],
  },
};

/** Detect the current JavaScript execution runtime platform. */
export function detectRuntime(): RuntimeKind {
  // @ts-ignore: Deno global check
  if (typeof Deno !== "undefined") {
    return "deno";
  }
  // Browser main window, iframe, or web worker (WorkerGlobalScope)
  // @ts-ignore
  const isWorker = typeof WorkerGlobalScope !== "undefined" && (
    (typeof self !== "undefined" && self instanceof WorkerGlobalScope) ||
    (typeof globalThis !== "undefined" && Boolean((globalThis as any).WorkerGlobalScope) && globalThis instanceof (globalThis as any).WorkerGlobalScope)
  );
  // @ts-ignore
  const isWindow = typeof window !== "undefined" && typeof window.document !== "undefined";
  // @ts-ignore
  const isBrowserEnv = typeof navigator !== "undefined" && typeof process === "undefined";

  if (isWindow || isWorker || isBrowserEnv) {
    return "browser";
  }
  return "node";
}

export type AdapterTransport = "stdio" | "websocket" | "in-process" | "web-worker";

export interface ModelReference {
  provider: string; // e.g. "anthropic", "openai", "gemini"
  model: string;    // e.g. "claude-3-7-sonnet", "gpt-4o"
  id?: string;
  thinking?: string;
  options?: Record<string, unknown>;
}

export interface AgentReach {
  root: "active" | "none" | "scoped";
  network: "none" | "bounded" | "ambient";
  tools: string[];
}

export interface AgentBounds {
  deadlineMs: number;
  maxOutputBytes: number;
}

export type ObservedReadinessState = "ready" | "unreachable" | "unrunnable" | "absent" | "unknown";

export interface AgentReadiness {
  state: ObservedReadinessState;
  observedAt: string;
  why?: string;
}

export interface ConfiguredAgent {
  /** Stable configured-agent ID. Permanent; distinct from task address and ACP session ID. */
  id: string;
  /** Human-readable display label. Mutable. NOT the identity. */
  name: string;
  /** The harness/engine implementation (e.g. "pi", "claude", "browser-worker"). */
  harness: string;
  /** The adapter used to talk to the harness (e.g. "pi-acp", "acp-stdio", "in-process"). */
  adapter: string;
  /** Pinned adapter/harness version if required (e.g. "0.0.34"). */
  pinnedVersion: string | null;
  /** Transport required by the adapter. */
  transport: AdapterTransport;
  /** Key of the executing environment (core/environment.ts) where this agent runs. */
  environmentKey: string;
  /** Description of what this configured agent is for. */
  description: string;
  /** Whether this is the default agent for this environment/harness. */
  isDefault: boolean;
  /** Model reference. Secret-free. */
  model: ModelReference | null;
  /** Base persona or system instruction. */
  prompt: string | null;
  /** Needed reach: filesystem root, network, and tools. */
  reach: AgentReach;
  /** Enforceable execution bounds. */
  bounds: AgentBounds;
  /** Timestamped observed readiness. Separated from configured claims. */
  readiness?: AgentReadiness;
  /** Creation timestamp (ISO). */
  createdAt: string;
  /** Last update timestamp (ISO). */
  updatedAt: string;
}

export type AgentValidationResult =
  | { ok: true; agent: ConfiguredAgent }
  | { ok: false; refused: string; why: string };

const SECRET_PATTERNS = [
  /token/i,
  /secret/i,
  /password/i,
  /bearer/i,
  /apikey/i,
  /api[_-]?key/i,
  /private[_-]?key/i,
  /credential/i,
];

const SECRET_PREFIXES = ["sk-", "vbx_", "ghp_", "xoxb-", "Bearer "];

/**
 * Scan an object recursively for secret-bearing keys or values.
 * Returns the violating key or value pattern if found, null otherwise.
 */
function findSecretLeak(obj: unknown, path = ""): string | null {
  if (typeof obj === "string") {
    for (const prefix of SECRET_PREFIXES) {
      if (obj.includes(prefix)) {
        return `value at '${path || "root"}' contains secret prefix '${prefix}'`;
      }
    }
    return null;
  }
  if (!obj || typeof obj !== "object") return null;
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      const leak = findSecretLeak(obj[i], `${path}[${i}]`);
      if (leak) return leak;
    }
    return null;
  }
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const currentPath = path ? `${path}.${k}` : k;
    for (const pat of SECRET_PATTERNS) {
      if (pat.test(k)) return `key '${currentPath}' looks like a secret`;
    }
    const leak = findSecretLeak(v, currentPath);
    if (leak) return leak;
  }
  return null;
}

/**
 * Validate that a configured agent record is well-formed, secret-free,
 * and compatible with the target runtime capabilities.
 */
export function validateConfiguredAgent(
  raw: unknown,
  runtime: RuntimeKind = "node",
): AgentValidationResult {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, refused: "bad-request", why: "configured agent must be an object" };
  }

  // 1. Check for secret leaks
  const leak = findSecretLeak(raw);
  if (leak) {
    return {
      ok: false,
      refused: "secrets-forbidden",
      why: `Configured agent records must be secret-free (${leak}). Credentials belong to the environment owner, not the agent config.`,
    };
  }

  const o = raw as Record<string, unknown>;

  // 2. Validate stable ID
  const id = typeof o.id === "string" ? o.id.trim() : "";
  if (!id || !/^[a-zA-Z0-9_-]{1,128}$/.test(id)) {
    return {
      ok: false,
      refused: "bad-request",
      why: "configured agent requires a stable id (1-128 alphanumeric characters, underscores or hyphens)",
    };
  }

  // 3. Validate name/label
  const name = typeof o.name === "string" ? o.name.trim() : "";
  if (!name) {
    return { ok: false, refused: "bad-request", why: "configured agent requires a display name" };
  }

  // 4. Validate harness and adapter
  const harness = typeof o.harness === "string" ? o.harness.trim() : "";
  if (!harness) {
    return { ok: false, refused: "bad-request", why: "configured agent requires a harness identifier" };
  }
  const adapter = typeof o.adapter === "string" ? o.adapter.trim() : "";
  if (!adapter) {
    return { ok: false, refused: "bad-request", why: "configured agent requires an adapter identifier" };
  }

  // 5. Validate environmentKey
  const environmentKey = typeof o.environmentKey === "string" ? o.environmentKey.trim() : "";
  if (!environmentKey) {
    return { ok: false, refused: "bad-request", why: "configured agent requires an environmentKey" };
  }

  // 6. Validate transport and runtime capability
  const transport = (typeof o.transport === "string" ? o.transport.trim() : "stdio") as AdapterTransport;
  if (!["stdio", "websocket", "in-process", "web-worker"].includes(transport)) {
    return { ok: false, refused: "bad-request", why: `unknown adapter transport '${String(o.transport)}'` };
  }

  const capabilities = RUNTIME_CAPABILITIES[runtime];
  if (!capabilities.transports.includes(transport)) {
    return {
      ok: false,
      refused: "unsupported-runtime-capability",
      why: `A ${runtime} runtime cannot support '${transport}' transport (supported: ${capabilities.transports.join(", ")}). A browser cannot spawn a stdio CLI; use an in-process or web-worker adapter instead.`,
    };
  }

  // 7. Validate bounds
  const rawBounds = (o.bounds && typeof o.bounds === "object" ? o.bounds : {}) as Record<string, unknown>;
  const deadlineMs = Number(rawBounds.deadlineMs ?? 60000);
  const maxOutputBytes = Number(rawBounds.maxOutputBytes ?? 65536);
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 100 || deadlineMs > 600000) {
    return { ok: false, refused: "bad-request", why: "deadlineMs must be between 100 and 600000 ms" };
  }
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 256 || maxOutputBytes > 10485760) {
    return { ok: false, refused: "bad-request", why: "maxOutputBytes must be between 256 and 10485760 bytes" };
  }

  // 8. Validate reach
  const rawReach = (o.reach && typeof o.reach === "object" ? o.reach : {}) as Record<string, unknown>;
  const reachRoot = ["active", "none", "scoped"].includes(String(rawReach.root))
    ? (rawReach.root as AgentReach["root"])
    : "active";
  const reachNetwork = ["none", "bounded", "ambient"].includes(String(rawReach.network))
    ? (rawReach.network as AgentReach["network"])
    : "none";
  const tools = Array.isArray(rawReach.tools)
    ? rawReach.tools.filter((t): t is string => typeof t === "string" && Boolean(t.trim()))
    : [];

  const now = new Date().toISOString();
  const agent: ConfiguredAgent = {
    id,
    name,
    harness,
    adapter,
    pinnedVersion: typeof o.pinnedVersion === "string" ? o.pinnedVersion.trim() : null,
    transport,
    environmentKey,
    description: typeof o.description === "string" ? o.description.trim() : "",
    isDefault: Boolean(o.isDefault),
    model: typeof o.model === "string"
      ? (o.model.includes("/")
          ? { provider: o.model.split("/")[0], model: o.model.split("/").slice(1).join("/") }
          : { provider: "", model: o.model })
      : (o.model && typeof o.model === "object"
          ? {
              provider: String((o.model as Record<string, unknown>).provider ?? ""),
              model: String((o.model as Record<string, unknown>).model ?? (o.model as Record<string, unknown>).id ?? ""),
              ...(typeof (o.model as Record<string, unknown>).id === "string"
                ? { id: String((o.model as Record<string, unknown>).id) }
                : {}),
              ...(typeof (o.model as Record<string, unknown>).thinking === "string"
                ? { thinking: String((o.model as Record<string, unknown>).thinking) }
                : {}),
              options: (o.model as Record<string, unknown>).options && typeof (o.model as Record<string, unknown>).options === "object"
                ? ((o.model as Record<string, unknown>).options as Record<string, unknown>)
                : undefined,
            }
          : null),
    prompt: typeof o.prompt === "string" ? o.prompt : null,
    reach: {
      root: reachRoot,
      network: reachNetwork,
      tools,
    },
    bounds: {
      deadlineMs,
      maxOutputBytes,
    },
    readiness: o.readiness && typeof o.readiness === "object"
      ? {
          state: (["ready", "unreachable", "unrunnable", "absent", "unknown"].includes(String((o.readiness as Record<string, unknown>).state))
            ? (o.readiness as Record<string, unknown>).state
            : "unknown") as ObservedReadinessState,
          observedAt: String((o.readiness as Record<string, unknown>).observedAt ?? now),
          why: typeof (o.readiness as Record<string, unknown>).why === "string"
            ? String((o.readiness as Record<string, unknown>).why)
            : undefined,
        }
      : undefined,
    createdAt: typeof o.createdAt === "string" ? o.createdAt : now,
    updatedAt: now,
  };

  return { ok: true, agent };
}

/**
 * Safe public projection of a configured agent for unauthenticated inventory readback.
 * Strictly excludes unvetted model options, prompts, or credentials.
 */
export function publicAgentProjection(agent: ConfiguredAgent) {
  return {
    id: agent.id,
    name: agent.name,
    harness: agent.harness,
    adapter: agent.adapter,
    pinnedVersion: agent.pinnedVersion,
    transport: agent.transport,
    environmentKey: agent.environmentKey,
    description: agent.description,
    isDefault: agent.isDefault,
    model: agent.model ? { provider: agent.model.provider, model: agent.model.model, thinking: agent.model.thinking } : null,
    reach: agent.reach,
    bounds: agent.bounds,
    readiness: agent.readiness,
    createdAt: agent.createdAt,
    updatedAt: agent.updatedAt,
  };
}
export function renameConfiguredAgent(agent: ConfiguredAgent, newName: string): ConfiguredAgent {
  const trimmed = newName.trim();
  if (!trimmed) {
    throw new Error("agent name cannot be empty");
  }
  const leak = findSecretLeak(trimmed, "name");
  if (leak) {
    throw Object.assign(new Error(`secrets-forbidden: Renaming agent cannot inject secrets (${leak})`), {
      refused: "secrets-forbidden",
    });
  }
  return {
    ...agent,
    name: trimmed,
    updatedAt: new Date().toISOString(),
  };
}
