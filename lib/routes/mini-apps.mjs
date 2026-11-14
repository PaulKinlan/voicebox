/**
 * @summary Mini-App shelf and Web MCP tool-registration HTTP endpoints (/api/mini-apps, /api/mini-app/tools).
 */
// Mini-App routes (voicebox-beads-cwx5.1). Each route DECLARES its guard and the guarded dispatcher
// (lib/routes/guarded.mjs) enforces it before the handler runs: the three shelf mutations read their body
// through the bounded JSON door, and POST /api/mini-app/tools — the TOOL REGISTRATION body, which is small and
// separate from app HTML — is behind the browser CSRF guard and reads through that same door at its own 64 KiB
// bound (voicebox-beads-gesp). The host still owns the auth wall, the active-root declaration, the live registry
// and the sockets a saved or deleted app is announced on.
import { saveMiniApp, discoverMiniApps, getMiniApp, deleteMiniApp } from "../mini-app-store.mjs";
import { defineRoutes } from "./guarded.mjs";

/**
 * The bound on the tool-registration body (voicebox-beads-gesp). It stays 64 KiB — smaller than the door's default —
 * because this body carries tool DECLARATIONS, not app content or file text, and the bridge already bounds the args
 * it will ever send here. The bound is passed to the door rather than re-implemented.
 */
const TOOLS_BODY_MAX_BYTES = 65536;

export function createMiniAppRoutes({ getRootPath, registry, sendToRoom, json, contentJsonBodyMaxBytes }) {
  const save = (_req, res, _url, { body }) => {
    if (!body || typeof body !== "object") {
      return json(res, 400, { ok: false, refused: "bad-request", why: "body must be JSON" });
    }
    const saved = saveMiniApp({ ...body, rootPath: getRootPath() });
    if (!saved.ok) return json(res, 400, saved);
    sendToRoom(JSON.stringify({
      type: "mini_app",
      miniApp: saved.miniApp,
      created: saved.created,
      updated: saved.updated,
    }));
    return json(res, 200, saved);
  };

  return defineRoutes("mini-apps", [
    {
      key: "GET /api/mini-apps",
      guard: "read",
      handler: (_req, res, url) => {
        const rootPath = getRootPath();
        const id = (url.searchParams.get("id") ?? url.searchParams.get("appId") ?? "").trim();
        if (id) {
          const found = getMiniApp(id, { rootPath });
          return json(res, found.ok ? 200 : 404, found);
        }
        const discovered = discoverMiniApps({ rootPath });
        let apps = discovered.miniApps ?? [];
        const kindFilter = (url.searchParams.get("kind") ?? "").trim().toLowerCase();
        if (kindFilter) {
          apps = apps.filter((a) => (a.kind ?? "app") === kindFilter);
        }
        return json(res, 200, { ok: true, apps, miniApps: apps, count: apps.length });
      },
    },
    // The body CARRIES the mini-app's html — content, so the larger cap (voicebox-beads-d808).
    { key: "POST /api/mini-apps", guard: "json", maxBytes: contentJsonBodyMaxBytes, handler: save },
    { key: "PUT /api/mini-apps", guard: "json", maxBytes: contentJsonBodyMaxBytes, handler: save },
    {
      key: "DELETE /api/mini-apps",
      guard: "json",
      handler: (_req, res, url, { body }) => {
        const id = String(body?.appId ?? body?.id ?? url.searchParams.get("id") ?? url.searchParams.get("appId") ?? "").trim();
        const deleted = deleteMiniApp(id, { rootPath: getRootPath() });
        if (!deleted.ok) return json(res, deleted.refused === "mini-app-not-found" || deleted.refused === "not-found" ? 404 : 400, deleted);
        if (deleted.miniApp?.appId) registry.unregisterApp(deleted.miniApp.appId);
        if (id) registry.unregisterApp(id);
        sendToRoom(JSON.stringify({
          type: "mini_app_deleted",
          appId: deleted.miniApp?.appId ?? id,
          miniApp: deleted.miniApp,
        }));
        return json(res, 200, deleted);
      },
    },
    {
      key: "GET /api/mini-app/tools",
      guard: "read",
      handler: (_req, res) => json(res, 200, {
        ok: true,
        tools: registry.getAllTools(),
        declarations: registry.getFunctionDeclarations(),
      }),
    },
    {
      key: "POST /api/mini-app/tools",
      // THE BODY GOES THROUGH THE SHARED DOOR, AFTER THE GUARD (voicebox-beads-gesp, residual of 3bwx). This route
      // used to hand-roll its reader: it accepted ANY Content-Type, so a browser's SIMPLE cross-origin POST — which
      // cannot declare application/json without a preflight — was parsed as JSON here, the hole 1la5 closed for every
      // other route; and it answered an oversized body with a bare 400. Declaring the body on the route means the
      // guard answers FIRST (an unauthorised caller is refused before a byte is read), then the door reads it, at this
      // route's own bound, refusing a non-JSON Content-Type 415 and an oversize 413 like every other JSON route.
      guard: "csrf",
      body: "json",
      maxBytes: TOOLS_BODY_MAX_BYTES,
      handler: async (req, res, _url, { body }) => {
        if (body === null) {
          return json(res, 400, { ok: false, refused: "bad-json", why: "request body must be valid JSON" });
        }
        if (!body || typeof body !== "object" || Array.isArray(body)) {
          return json(res, 400, { ok: false, refused: "bad-json", why: "request body must be a JSON object" });
        }

        const appId = String(body.appId ?? "").trim();
        const tools = Array.isArray(body.tools) ? body.tools : [];
        for (const prevId of [...registry.apps.keys()]) {
          if (prevId !== appId) registry.unregisterApp(prevId);
        }
        if (appId) {
          if (tools.length === 0) {
            registry.unregisterApp(appId);
          } else {
            registry.registerApp(appId, { title: body?.title });
            registry.updateTools(appId, tools);
          }
        }
        return json(res, 200, {
          ok: true,
          appId: appId || null,
          tools: registry.getAllTools(),
        });
      },
    },
  ]);
}
