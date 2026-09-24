// core/fleet.ts — Fleet Addressability: Multi-environment agent naming & routing (voicebox-beads-8fv.3)
//
// Pure TypeScript: no platform, IO, or network dependencies (N18).
// Secret-free: handles target keys, session capabilities, and routing invariants.

import type {
  ConfiguredAgent,
  AgentReadiness,
  ModelReference,
  AgentReach,
  AgentBounds,
  AdapterTransport,
} from "./harness-config.ts";

export interface FleetTarget {
  environmentKey: string;
  agentId: string;
  sessionId?: string;
}

export interface FleetSessionInfo {
  sessionId: string;
  startedAt: string;
  capabilities: Array<"interactive" | "task" | "status">;
}

export interface FleetAgent {
  targetKey: string; // "${environmentKey}/${agentId}"
  environmentKey: string;
  agentId: string;
  name: string;
  harness: string;
  adapter: string;
  transport: AdapterTransport;
  description: string;
  isDefault: boolean;
  model: ModelReference | null;
  reach: AgentReach;
  bounds: AgentBounds;
  readiness: AgentReadiness;
  sessions?: FleetSessionInfo[];
}

export type FleetTargetResolution =
  | { ok: true; agent: FleetAgent; target: FleetTarget; session?: FleetSessionInfo }
  | { ok: false; refused: string; why: string };

/**
 * Format a canonical target key string: "env/agent" or "env/agent:sessionId"
 */
export function formatTargetKey(target: FleetTarget): string {
  const base = `${target.environmentKey}/${target.agentId}`;
  return target.sessionId ? `${base}:${target.sessionId}` : base;
}

/**
 * Parse a target key string into a FleetTarget record.
 * Accepts:
 *   "env/agent:session" -> { environmentKey: "env", agentId: "agent", sessionId: "session" }
 *   "env/agent"         -> { environmentKey: "env", agentId: "agent" }
 *   "agent"             -> { environmentKey: defaultEnv, agentId: "agent" }
 */
export function parseTargetKey(raw: string, defaultEnv = "local"): FleetTarget {
  const trimmed = raw.trim();
  const sessionSplit = trimmed.split(":");
  const pathPart = sessionSplit[0];
  const sessionId = sessionSplit[1] || undefined;

  if (pathPart.includes("/")) {
    const slashIdx = pathPart.indexOf("/");
    const environmentKey = pathPart.slice(0, slashIdx);
    const agentId = pathPart.slice(slashIdx + 1);
    return { environmentKey, agentId, sessionId };
  }

  return { environmentKey: defaultEnv, agentId: pathPart, sessionId };
}

/**
 * Resolve a fleet target against an inventory of known fleet agents.
 * Invariants enforced:
 *   1. No collisions across environments (identified by environmentKey + agentId).
 *   2. If environment is unreachable or stopped, refuse without blind rerouting.
 *   3. If session requested but not found, refuse by name without creating replacement.
 */
export function resolveFleetTarget(
  targetInput: string | FleetTarget,
  inventory: FleetAgent[],
  defaultEnv = "local",
): FleetTargetResolution {
  const target = typeof targetInput === "string" ? parseTargetKey(targetInput, defaultEnv) : targetInput;

  const agent = inventory.find(
    (a) => a.environmentKey === target.environmentKey && a.agentId === target.agentId,
  );

  if (!agent) {
    return {
      ok: false,
      refused: "agent-not-found",
      why: `No agent '${target.agentId}' found in environment '${target.environmentKey}'`,
    };
  }

  // If the target environment is marked unreachable, stopped, or stale, refuse explicitly without rerouting
  if (agent.readiness.state === "unreachable" || agent.readiness.state === "absent") {
    return {
      ok: false,
      refused: "environment-unreachable",
      why: `Environment '${target.environmentKey}' is ${agent.readiness.state}. Calls are refused without blind rerouting.`,
    };
  }

  if (target.sessionId) {
    const session = (agent.sessions || []).find((s) => s.sessionId === target.sessionId);
    if (!session) {
      return {
        ok: false,
        refused: "session-not-found",
        why: `No active session '${target.sessionId}' exists for agent '${agent.targetKey}'`,
      };
    }
    if (!session.capabilities.includes("interactive")) {
      return {
        ok: false,
        refused: "session-contact-unsupported",
        why: `Session '${target.sessionId}' on adapter '${agent.adapter}' does not support interactive contact messaging`,
      };
    }
    return { ok: true, agent, target, session };
  }

  return { ok: true, agent, target };
}

/**
 * Filter and format fleet agents for public safe projection.
 */
export function publicFleetProjection(agent: FleetAgent) {
  return {
    id: agent.agentId,
    targetKey: agent.targetKey,
    environmentKey: agent.environmentKey,
    agentId: agent.agentId,
    name: agent.name,
    harness: agent.harness,
    adapter: agent.adapter,
    transport: agent.transport,
    description: agent.description,
    isDefault: agent.isDefault,
    model: agent.model ? { provider: agent.model.provider, model: agent.model.model, thinking: agent.model.thinking } : null,
    reach: agent.reach,
    bounds: agent.bounds,
    readiness: agent.readiness,
    sessions: agent.sessions ? agent.sessions.map((s) => ({ sessionId: s.sessionId, startedAt: s.startedAt, capabilities: s.capabilities })) : [],
  };
}
