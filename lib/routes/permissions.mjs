/**
 * @summary Pending permission requests and their resolution (GET /api/permissions/pending, POST /api/permissions/resolve).
 */
// Permission routes (voicebox-beads-cwx5.1). A delegated agent that asks to do something gated waits on a
// pending request; anyone behind the auth wall may READ the queue, but only the host token may answer it —
// the page cannot hold that token, so a page cannot approve its own agent's request.
import { defineRoutes } from "./guarded.mjs";

export function createPermissionRoutes({ permissions, json }) {
  return defineRoutes("permissions", [
    {
      key: "GET /api/permissions/pending",
      guard: "read",
      handler: (_req, res) => json(res, 200, { ok: true, pending: permissions.pending() }),
    },
    {
      key: "POST /api/permissions/resolve",
      guard: "host-token",
      body: "json",
      refusal: {
        refused: "host-token-required",
        why: "resolving a permission request requires the host token (x-voicebox-host-token); the page cannot hold it",
      },
      handler: (_req, res, _url, { body }) => {
        const requestId = typeof body?.requestId === "string" ? body.requestId : null;
        if (!requestId) return json(res, 400, { ok: false, refused: "bad-request", why: "resolving a permission request names the requestId" });
        const result = permissions.resolve(requestId, {
          allow: Boolean(body.allow),
          optionId: typeof body.optionId === "string" ? body.optionId : undefined,
          reason: typeof body.reason === "string" ? body.reason : undefined,
        });
        return json(res, result.ok ? 200 : 409, result);
      },
    },
  ]);
}
