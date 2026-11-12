/**
 * @summary Mini-App shelf and Web MCP tool-registration HTTP endpoints (/api/mini-apps, /api/mini-app/tools).
 */
// Mini-App routes (voicebox-beads-cwx5.1). Each route DECLARES its guard and the guarded dispatcher
// (lib/routes/guarded.mjs) enforces it before the handler runs: the three shelf mutations read their body
// through the bounded JSON door, and POST /api/mini-app/tools — which reads its own small body so the bridge
// can post it without a JSON preflight — is behind the browser CSRF guard. The host still owns the auth
// wall, the active-root declaration, the live registry and the sockets a saved or deleted app is announced on.
import { saveMiniApp, discoverMiniApps, getMiniApp, deleteMiniApp } from "../mini-app-store.mjs";
import { defineRoutes } from "./guarded.mjs";

/** The bound on the tool-registration body, which this route reads itself. */
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
      guard: "csrf",
      handler: async (req, res) => {
        let bodyStr = "", bytes = 0, tooLarge = false;
        await new Promise((resolve) => {
          req.on("data", (chunk) => {
            bytes += chunk.length;
            if (bytes > TOOLS_BODY_MAX_BYTES) {
              tooLarge = true;
            } else {
              bodyStr += chunk;
            }
          });
          req.on("end", resolve);
        });

        if (tooLarge) {
          return json(res, 400, { ok: false, refused: "body-too-large", why: `request body exceeds maximum allowed bound of ${TOOLS_BODY_MAX_BYTES} bytes` });
        }

        let body;
        try {
          body = JSON.parse(bodyStr || "{}");
        } catch {
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
