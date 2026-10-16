/**
 * @summary Work activity log HTTP endpoints (GET/DELETE /api/activity).
 */
// The host owns the mutable log and every producer/reset; these exact HTTP keys only
// read or clear the SAME injected array. Never replace it: producers retain its reference.
export function createActivityRoutes({ workActivityLog, json }) {
  return {
    "GET /api/activity": (_req, res) => json(res, 200, { ok: true, entries: workActivityLog }),
    "DELETE /api/activity": (_req, res) => {
      workActivityLog.length = 0;
      return json(res, 200, { ok: true, entries: [] });
    },
  };
}
