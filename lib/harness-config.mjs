// lib/harness-config.mjs — Harness and Configured Agent Registry (voicebox-beads-8fv.2)
//
// WHY THIS FILE EXISTS:
// Connects the core secret-free configured-agent contract with both server-side and browser-local
// execution placements.
//
// KEY INVARIANTS:
// 1. Secret-free: Configuration records contain zero API keys, tokens, or model-supplied shell commands.
// 2. Stable identity: An agent's ID is permanent. Renaming an agent's display name updates its label
//    without retargeting tasks or changing its ID.
// 3. Zero-server browser support (binding requirement): The registry and loader work fully in-browser
//    with all server API and bridge access blocked.
// 4. Runtime capability checking: A browser runtime explicitly refuses stdio CLI adapters.
// 5. One harness, multiple configured instances: Distinct models, bounds, prompts, or tools can be
//    configured for the same harness engine in the same environment.

import {
  detectRuntime,
  validateConfiguredAgent,
  renameConfiguredAgent,
  publicAgentProjection,
} from "../core/harness-config.ts";

export {
  detectRuntime,
  validateConfiguredAgent,
  renameConfiguredAgent,
  publicAgentProjection,
};

/** Standard default agents for fresh environments. */
export const DEFAULT_CONFIGURED_AGENTS = [
  {
    id: "agent_pi_default",
    name: "Pi Default",
    harness: "pi",
    adapter: "pi-acp",
    pinnedVersion: "0.0.33",
    transport: "stdio",
    environmentKey: "local",
    description: "Default Pi coding agent instance on local machine",
    isDefault: true,
    model: { provider: "anthropic", model: "claude-3-7-sonnet" },
    prompt: null,
    reach: { root: "active", network: "ambient", tools: ["read", "write", "list", "bash"] },
    bounds: { deadlineMs: 60000, maxOutputBytes: 65536 },
  },
  {
    id: "agent_browser_default",
    name: "Browser Agent",
    harness: "browser-worker",
    adapter: "in-process",
    pinnedVersion: null,
    transport: "in-process",
    environmentKey: "browser",
    description: "In-browser worker agent with zero server dependency",
    isDefault: true,
    model: { provider: "web-llm", model: "local-prompt-api" },
    prompt: null,
    reach: { root: "active", network: "none", tools: ["read", "write", "list"] },
    bounds: { deadlineMs: 30000, maxOutputBytes: 32768 },
  },
];

/**
 * Create a configured agent registry.
 * Works anywhere: in-memory, browser localStorage, or server storage.
 */
export function createAgentRegistry({
  storage = null,
  storageKey = "voicebox.configured_agents",
  defaultAgents = DEFAULT_CONFIGURED_AGENTS,
  runtime = detectRuntime(),
} = {}) {
  const agents = new Map();

  function loadInitial() {
    let loaded = false;
    if (storage) {
      try {
        const raw = storage.getItem(storageKey);
        if (typeof raw === "string" && raw.trim()) {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) {
            for (const item of parsed) {
              const checked = validateConfiguredAgent(item, runtime);
              if (checked.ok) {
                agents.set(checked.agent.id, checked.agent);
                loaded = true;
              }
            }
          }
        }
      } catch {
        // Fall back to defaults on unreadable storage
      }
    }
    if (!loaded && Array.isArray(defaultAgents)) {
      for (const item of defaultAgents) {
        // Only seed agents compatible with this runtime
        const checked = validateConfiguredAgent(item, runtime);
        if (checked.ok) {
          agents.set(checked.agent.id, checked.agent);
        }
      }
    }
  }

  function persist(mutation = null) {
    if (!storage) return { ok: true };
    try {
      const array = Array.from(agents.values());
      storage.setItem(storageKey, JSON.stringify(array));
      return { ok: true };
    } catch (err) {
      if (mutation?.rollback) mutation.rollback();
      return {
        ok: false,
        refused: "storage-failed",
        why: `Failed to persist agent configuration to storage: ${err?.name ?? err?.message}`,
      };
    }
  }

  loadInitial();

  return {
    /** Get an agent by its stable ID. */
    get(id) {
      if (typeof id !== "string") return null;
      return agents.get(id) ?? null;
    },

    /** Find default agent for an environment and optional harness. */
    getDefault(environmentKey, harness = null) {
      for (const agent of agents.values()) {
        if (agent.environmentKey === environmentKey && agent.isDefault) {
          if (!harness || agent.harness === harness) return agent;
        }
      }
      // If no agent explicitly marked default, return first matching agent
      for (const agent of agents.values()) {
        if (agent.environmentKey === environmentKey) {
          if (!harness || agent.harness === harness) return agent;
        }
      }
      return null;
    },

    /**
     * List configured agents matching criteria.
     * Guaranteed secret-free.
     */
    list({ environmentKey, harness, isDefault } = {}) {
      const result = [];
      for (const agent of agents.values()) {
        if (environmentKey !== undefined && agent.environmentKey !== environmentKey) continue;
        if (harness !== undefined && agent.harness !== harness) continue;
        if (isDefault !== undefined && agent.isDefault !== isDefault) continue;
        result.push({ ...agent });
      }
      return result;
    },

    /**
     * Register a new configured agent.
     * Validates secret-free requirement and runtime capability.
     */
    register(rawConfig) {
      const checked = validateConfiguredAgent(rawConfig, runtime);
      if (!checked.ok) {
        return checked;
      }
      const agent = checked.agent;
      if (agents.has(agent.id)) {
        return {
          ok: false,
          refused: "agent-id-conflict",
          why: `Configured agent with ID '${agent.id}' already exists. IDs are permanent.`,
        };
      }
      // If this agent is marked default, unset default on other agents of same harness in environment
      const previousDefaults = [];
      if (agent.isDefault) {
        for (const existing of agents.values()) {
          if (existing.environmentKey === agent.environmentKey && existing.harness === agent.harness && existing.isDefault) {
            previousDefaults.push(existing);
            existing.isDefault = false;
          }
        }
      }
      agents.set(agent.id, agent);
      const saved = persist({
        rollback: () => {
          agents.delete(agent.id);
          for (const prev of previousDefaults) prev.isDefault = true;
        },
      });
      if (!saved.ok) {
        return saved;
      }
      return { ok: true, agent: { ...agent } };
    },

    /**
     * Rename an agent's display name without changing its stable ID.
     */
    rename(id, newName) {
      const agent = agents.get(id);
      if (!agent) {
        return {
          ok: false,
          refused: "agent-not-found",
          why: `No configured agent with ID '${id}' exists to rename.`,
        };
      }
      const previous = { ...agent };
      try {
        const renamed = renameConfiguredAgent(agent, newName);
        agents.set(id, renamed);
        const saved = persist({
          rollback: () => { agents.set(id, previous); },
        });
        if (!saved.ok) {
          return saved;
        }
        return { ok: true, agent: { ...renamed } };
      } catch (err) {
        return {
          ok: false,
          refused: err.refused ?? "bad-request",
          why: err.message ?? "failed to rename agent",
        };
      }
    },

    /**
     * Update non-identity fields of a configured agent.
     */
    update(id, updates) {
      const existing = agents.get(id);
      if (!existing) {
        return {
          ok: false,
          refused: "agent-not-found",
          why: `No configured agent with ID '${id}' exists.`,
        };
      }
      // Prohibit changing identity fields via update
      const previous = { ...existing };
      const candidate = {
        ...existing,
        ...updates,
        id: existing.id, // ID is permanent
        createdAt: existing.createdAt,
      };
      const checked = validateConfiguredAgent(candidate, runtime);
      if (!checked.ok) {
        return checked;
      }
      agents.set(id, checked.agent);
      const saved = persist({
        rollback: () => { agents.set(id, previous); },
      });
      if (!saved.ok) {
        return saved;
      }
      return { ok: true, agent: { ...checked.agent } };
    },

    /** Remove a configured agent. */
    remove(id) {
      const previous = agents.get(id);
      if (!previous) return false;
      agents.delete(id);
      const saved = persist({
        rollback: () => { agents.set(id, previous); },
      });
      return saved.ok;
    },

    /** Export all agents as a JSON-serializable array. */
    toJSON() {
      return Array.from(agents.values());
    },
  };
}

/**
 * Feed configured agents into harness discovery to fulfill D3 without a parallel inventory.
 */
export async function listHarnessesWithConfiguredAgents(inventoryPromise, registry) {
  const inventory = await inventoryPromise;
  if (!inventory || !Array.isArray(inventory.entries)) return inventory;

  const entriesWithAgents = inventory.entries.map((harness) => {
    const matchingAgents = registry.list({ harness: harness.id });
    return {
      ...harness,
      configuredAgents: matchingAgents.map(publicAgentProjection),
    };
  });

  return {
    ...inventory,
    entries: entriesWithAgents,
  };
}
