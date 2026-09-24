// lib/fleet.mjs — Fleet Addressability Manager (voicebox-beads-8fv.3)
//
// Manages multi-environment fleet agent discovery, session tracking, and contact routing.
// Works anywhere: server-side with local + remote environments, or browser-local with zero server.

import {
  formatTargetKey,
  parseTargetKey,
  resolveFleetTarget,
  publicFleetProjection,
} from "../core/fleet.ts";
import { publicAgentProjection } from "../core/harness-config.ts";

export {
  formatTargetKey,
  parseTargetKey,
  resolveFleetTarget,
  publicFleetProjection,
};

export function createFleetManager({
  localEnvironmentKey = "local",
  localRegistry = null,
  getEnvironments = async () => [{ key: localEnvironmentKey, reachable: true }],
  resolveEnvironment = async (envKey) => {
    if (envKey === localEnvironmentKey || envKey === "local") {
      return { ok: true, local: true, key: envKey };
    }
    const envs = await getEnvironments();
    const found = envs.find((e) => e.key === envKey);
    if (!found) {
      return { ok: false, refused: "environment-unknown", why: `no environment with key '${envKey}' is in the registry` };
    }
    return { ok: true, local: false, key: envKey, reachable: found.reachable !== false, ...found };
  },
  fetchRemoteAgents = null, // async (envKey, auth) => Array<ConfiguredAgent>
  remoteContact = null,      // async (envKey, { agentId, message, sessionId, auth }) => result
  tasks = null,
  runtime = "node",
} = {}) {
  // Map of targetKey -> Map of sessionId -> sessionRecord
  const sessions = new Map();

  function registerSession(environmentKey, agentId, sessionInfo) {
    const targetKey = `${environmentKey}/${agentId}`;
    if (!sessions.has(targetKey)) {
      sessions.set(targetKey, new Map());
    }
    const agentSessions = sessions.get(targetKey);
    agentSessions.set(sessionInfo.sessionId, {
      sessionId: sessionInfo.sessionId,
      startedAt: sessionInfo.startedAt || new Date().toISOString(),
      capabilities: sessionInfo.capabilities || ["interactive", "task"],
      handler: sessionInfo.handler || null,
    });
  }

  function unregisterSession(environmentKey, agentId, sessionId) {
    const targetKey = `${environmentKey}/${agentId}`;
    const agentSessions = sessions.get(targetKey);
    if (agentSessions) {
      agentSessions.delete(sessionId);
      if (agentSessions.size === 0) {
        sessions.delete(targetKey);
      }
    }
  }

  function getSessionsForAgent(environmentKey, agentId) {
    const targetKey = `${environmentKey}/${agentId}`;
    const agentSessions = sessions.get(targetKey);
    if (!agentSessions) return [];
    return Array.from(agentSessions.values()).map((s) => ({
      sessionId: s.sessionId,
      startedAt: s.startedAt,
      capabilities: s.capabilities,
    }));
  }

  async function listAgents({ environmentKey, harness, onlyReady = false, auth = null } = {}) {
    const envs = await getEnvironments();
    const result = [];

    for (const env of envs) {
      const isLocal = env.key === localEnvironmentKey || env.key === "local";
      if (environmentKey && env.key !== environmentKey && !(isLocal && (environmentKey === "local" || environmentKey === localEnvironmentKey))) {
        continue;
      }

      let rawAgents = [];
      let envReachable = env.reachable !== false && env.state !== "unreachable";

      if (isLocal && localRegistry) {
        rawAgents = localRegistry.list({ harness });
      } else if (fetchRemoteAgents) {
        try {
          const fetched = await fetchRemoteAgents(env.key, auth);
          if (Array.isArray(fetched)) {
            rawAgents = fetched;
            envReachable = true;
          }
        } catch {
          rawAgents = [];
          envReachable = false;
        }
      }

      for (const agent of rawAgents) {
        if (harness && agent.harness !== harness) continue;

        const effectiveEnvKey = isLocal ? env.key : (agent.environmentKey || env.key);
        const readiness = envReachable
          ? (agent.readiness || { state: "ready", observedAt: new Date().toISOString() })
          : { state: "unreachable", observedAt: new Date().toISOString(), why: `Environment '${effectiveEnvKey}' is stopped or unreachable` };

        if (onlyReady && readiness.state !== "ready") continue;

        const targetKey = formatTargetKey({ environmentKey: effectiveEnvKey, agentId: agent.id });
        const agentSessions = getSessionsForAgent(effectiveEnvKey, agent.id);

        result.push({
          id: agent.id,
          targetKey,
          environmentKey: effectiveEnvKey,
          agentId: agent.id,
          name: agent.name,
          harness: agent.harness,
          adapter: agent.adapter,
          transport: agent.transport,
          description: agent.description,
          isDefault: agent.isDefault,
          model: agent.model,
          reach: agent.reach,
          bounds: agent.bounds,
          readiness,
          sessions: agentSessions,
        });
      }
    }

    return result;
  }

  async function contact({ target, message, authority, sessionId, auth } = {}) {
    if (!target) {
      return { ok: false, refused: "bad-request", why: "target is required for fleet contact" };
    }
    const targetObj = typeof target === "string" ? parseTargetKey(target, localEnvironmentKey) : target;
    if (sessionId && !targetObj.sessionId) {
      targetObj.sessionId = sessionId;
    }

    // Step 1: Resolve target environment first
    const envInfo = await resolveEnvironment(targetObj.environmentKey);
    if (!envInfo.ok) {
      return {
        ok: false,
        refused: envInfo.refused || "environment-unknown",
        why: envInfo.why || `no environment with key '${targetObj.environmentKey}' is in the registry`,
      };
    }

    // Step 2: Handle remote environments
    if (!envInfo.local) {
      const bearer = auth?.bearer || envInfo.bearer;
      if (!bearer) {
        return {
          ok: false,
          refused: "environment-not-paired",
          why: `environment '${targetObj.environmentKey}' is listed but not paired — pair it before contacting agents`,
        };
      }

      if (envInfo.reachable === false) {
        return {
          ok: false,
          refused: "environment-unreachable",
          why: `environment '${targetObj.environmentKey}' is unreachable`,
        };
      }

      if (!remoteContact) {
        return {
          ok: false,
          refused: "cross-environment-unsupported",
          why: `No remote contact transport configured for environment '${targetObj.environmentKey}'`,
        };
      }

      try {
        return await remoteContact(targetObj.environmentKey, {
          agentId: targetObj.agentId,
          message,
          sessionId: targetObj.sessionId,
          auth: { bearer },
        });
      } catch (err) {
        return {
          ok: false,
          refused: "environment-unreachable",
          why: `environment '${targetObj.environmentKey}' is unreachable: ${err?.message ?? err}`,
        };
      }
    }

    // Step 3: Local environment — inspect local registry for agent existence
    const localAgent = localRegistry ? localRegistry.get(targetObj.agentId) : null;
    if (!localAgent) {
      return {
        ok: false,
        refused: "agent-not-found",
        why: `No agent '${targetObj.agentId}' found in environment '${targetObj.environmentKey}'`,
      };
    }

    // Step 4: Route message to a supported existing session
    if (targetObj.sessionId) {
      const targetKey = `${localEnvironmentKey}/${localAgent.id}`;
      const sessionEntry = sessions.get(targetKey)?.get(targetObj.sessionId);
      if (!sessionEntry) {
        return {
          ok: false,
          refused: "session-not-found",
          why: `No active session '${targetObj.sessionId}' exists for agent '${targetKey}'`,
        };
      }
      if (!sessionEntry.capabilities.includes("interactive")) {
        return {
          ok: false,
          refused: "session-contact-unsupported",
          why: `Session '${targetObj.sessionId}' on adapter '${localAgent.adapter}' does not support interactive contact messaging`,
        };
      }
      if (typeof sessionEntry.handler !== "function") {
        return {
          ok: false,
          refused: "session-contact-unsupported",
          why: `Session '${targetObj.sessionId}' does not have an active message handler`,
        };
      }

      try {
        const reply = await sessionEntry.handler(message, { authority, agent: localAgent });
        return {
          ok: true,
          targetKey,
          sessionId: targetObj.sessionId,
          existing: true,
          reply,
        };
      } catch (err) {
        return {
          ok: false,
          refused: "session-error",
          why: `Session error during contact: ${err?.message ?? err}`,
        };
      }
    }

    // Step 5: Delegate a new task to the local agent
    if (!tasks) {
      return {
        ok: false,
        refused: "task-host-unavailable",
        why: "No local task host available for task delegation",
      };
    }
    return tasks.call("delegate_task", {
      agent: localAgent.id,
      task: message,
    }, authority || { owner: "fleet-caller", callId: `fleet_${Date.now().toString(36)}` });
  }

  return {
    listAgents,
    contact,
    registerSession,
    unregisterSession,
    getSessionsForAgent,
  };
}
