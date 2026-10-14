// Public fleet discovery only. The host retains POST /api/fleet/contact because it forwards
// the caller's bearer and mints an audit token across an environment boundary.
export function createFleetRoutes({ fleetManager, publicFleetProjection, json }) {
  return {
    "GET /api/fleet": async (_req, res, url) => {
      const environmentKey = url.searchParams.get("environment") || undefined;
      const harness = url.searchParams.get("harness") || undefined;
      const fleet = await fleetManager.listAgents({ environmentKey, harness });
      return json(res, 200, { ok: true, fleet: fleet.map(publicFleetProjection) });
    },
  };
}
