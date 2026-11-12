/**
 * @summary Mini-App shelf and Web MCP tool-registration HTTP endpoints (/api/mini-apps, /api/mini-app/tools).
 */
// Mini-App routes (voicebox-beads-cwx5.1), moved out of server.mjs unchanged. The host retains the
// auth wall, the browser CSRF boundary for POST /api/mini-app/tools, the bounded JSON door, the
// active-root declaration, the live registry and the sockets a saved or deleted app is announced on.
import { saveMiniApp, discoverMiniApps, getMiniApp, deleteMiniApp } from "../mini-app-store.mjs";

const KEYS = new Set([
  "GET /api/mini-apps", "POST /api/mini-apps", "PUT /api/mini-apps", "DELETE /api/mini-apps",
  "GET /api/mini-app/tools", "POST /api/mini-app/tools",
]);

/** A handled boolean keeps dispatch independent of json(), which returns undefined. */
export function createMiniAppRoutes({ getRootPath, registry, sendToRoom, json, readJsonBody, BodyRefusal, contentJsonBodyMaxBytes }) {
  return async function handleMiniAppRoute(req, res, url) {
    if (!KEYS.has(`${req.method} ${url.pathname}`)) return false;
    const CONTENT_JSON_BODY_MAX_BYTES = contentJsonBodyMaxBytes;
    const readJson = (maxBytes) => readJsonBody(req, res, maxBytes);
    await (async () => {
  if (req.method === "GET" && url.pathname === "/api/mini-apps") {
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
  }

  if ((req.method === "POST" || req.method === "PUT") && url.pathname === "/api/mini-apps") {
    // The body CARRIES the mini-app's html — content, so the larger cap (voicebox-beads-d808).
    const body = await readJson(CONTENT_JSON_BODY_MAX_BYTES);
    if (!body || typeof body !== "object") {
      return json(res, 400, { ok: false, refused: "bad-request", why: "body must be JSON" });
    }
    const rootPath = getRootPath();
    const saved = saveMiniApp({ ...body, rootPath });
    if (!saved.ok) return json(res, 400, saved);
    const frame = JSON.stringify({
      type: "mini_app",
      miniApp: saved.miniApp,
      created: saved.created,
      updated: saved.updated,
    });
    sendToRoom(frame);
    return json(res, 200, saved);
  }

  if (req.method === "DELETE" && url.pathname === "/api/mini-apps") {
    // A BodyRefusal must propagate — the door already answered it (voicebox-beads-d808).
    const body = await readJson().catch((err) => { if (err instanceof BodyRefusal) throw err; return {}; });
    const id = String(body?.appId ?? body?.id ?? url.searchParams.get("id") ?? url.searchParams.get("appId") ?? "").trim();
    const rootPath = getRootPath();
    const deleted = deleteMiniApp(id, { rootPath });
    if (!deleted.ok) return json(res, deleted.refused === "mini-app-not-found" || deleted.refused === "not-found" ? 404 : 400, deleted);
    if (deleted.miniApp?.appId) registry.unregisterApp(deleted.miniApp.appId);
    if (id) registry.unregisterApp(id);
    const frame = JSON.stringify({
      type: "mini_app_deleted",
      appId: deleted.miniApp?.appId ?? id,
      miniApp: deleted.miniApp,
    });
    sendToRoom(frame);
    return json(res, 200, deleted);
  }

  if (req.method === "GET" && url.pathname === "/api/mini-app/tools") {
    return json(res, 200, {
      ok: true,
      tools: registry.getAllTools(),
      declarations: registry.getFunctionDeclarations(),
    });
  }

  if (req.method === "POST" && url.pathname === "/api/mini-app/tools") {
    let bodyStr = "", bytes = 0, tooLarge = false;
    await new Promise((resolve) => {
      req.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > 65536) {
          tooLarge = true;
        } else {
          bodyStr += chunk;
        }
      });
      req.on("end", resolve);
    });

    if (tooLarge) {
      return json(res, 400, { ok: false, refused: "body-too-large", why: "request body exceeds maximum allowed bound of 65536 bytes" });
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
  }
    })();
    return true;
  };
}
