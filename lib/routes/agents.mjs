/**
 * @summary Agent registration and update HTTP endpoints (POST /api/agents, PATCH /api/agents/:id).
 */
// Agent write routes (voicebox-beads-cwx5.1). Configuring an agent is the host's act: both routes declare the
// `authority` guard (host token, room session token, or this page's own Origin) and the guarded dispatcher
// (lib/routes/guarded.mjs) refuses before the body is read. The reads live in lib/routes/agents-read.mjs.
//
// The host still owns which harness is active. Registering the FIRST agent for a supported harness activates
// that harness, and that is the host's state — so it arrives here as `onRegistered` and `harnessState`.
import { defineRoutes } from "./guarded.mjs";

const refusal = (act) => ({
  refused: "host-token-required",
  why: `${act} an agent is the host's act and requires the host token (x-voicebox-host-token) or an authorized in-room session`,
});

export function createAgentRoutes({ agentRegistry, publicAgentProjection, onRegistered, harnessState, json }) {
  return defineRoutes("agents", [
    {
      key: "POST /api/agents",
      guard: "authority",
      body: "json",
      refusal: refusal("configuring"),
      handler: (_req, res, _url, { body }) => {
        const registered = agentRegistry.register(body);
        if (!registered.ok) return json(res, 400, registered);
        onRegistered(registered.agent);
        return json(res, 201, { ok: true, agent: publicAgentProjection(registered.agent), ...harnessState() });
      },
    },
    {
      key: "PATCH /api/agents/:id",
      guard: "authority",
      body: "json",
      refusal: refusal("updating"),
      handler: (_req, res, _url, { body, params }) => {
        // A body that is ONLY a name is a rename; anything else is a settings update.
        const rename = typeof body?.name === "string" && Object.keys(body).length === 1;
        const result = rename ? agentRegistry.rename(params.id, body.name) : agentRegistry.update(params.id, body);
        if (!result.ok) return json(res, result.refused === "agent-not-found" ? 404 : 400, result);
        return json(res, 200, { ok: true, agent: publicAgentProjection(result.agent) });
      },
    },
  ]);
}
