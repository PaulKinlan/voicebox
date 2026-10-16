/**
 * @summary Agent inventory and admission status query endpoint (GET /api/agents).
 */
// The host owns agent configuration and mutable adapter/harness state. Fetch its
// admission context for EACH GET; a boot-time snapshot would give stale verdicts.
export function createAgentsReadRoutes({ agentRegistry, json, publicAgentProjection, describeAgentAdmission, getAdmissionContext }) {
  return {
    "GET /api/agents": (_req, res, url) => {
      const environmentKey = url.searchParams.get("environment") || undefined;
      const harness = url.searchParams.get("harness") || undefined;
      // A live verdict for this environment: late-registered agents and changing
      // host adapters/harnesses must be reflected. Non-local agents remain
      // 'not-judged-here' according to the host's admission policy.
      const admissionContext = getAdmissionContext();
      const agents = agentRegistry.list({ environmentKey, harness }).map((agent) => ({
        ...publicAgentProjection(agent),
        admission: describeAgentAdmission(agent, admissionContext),
      }));
      return json(res, 200, { ok: true, agents });
    },
  };
}
