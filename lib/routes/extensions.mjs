// Inventory and staging HTTP routes (voicebox-beads-1bv5). The host retains the auth wall,
// bounded JSON door and extension runtime; admission decisions remain in server.mjs.
const ROUTES = new Set([
  "GET /api/extensions",
  "GET /api/extensions/catalogue",
  "POST /api/extensions/proposals",
  "POST /api/extensions/local",
  "POST /api/extensions/create",
  "POST /api/extensions/sideload",
]);
const PLAN = /^\/api\/extensions\/(proposals|catalogue)\/([a-z0-9_-]+)\/plan$/;

/** Return true for an answered route; unknown paths fall through to the host's 404. */
export function createExtensionRoutes({ json, readJsonBody, contentJsonBodyMaxBytes, extensionRuntime: extensions }) {
  return async function handleExtensionRoute(req, res, url) {
    const key = `${req.method} ${url.pathname}`;
    const planMatch = req.method === "GET" ? url.pathname.match(PLAN) : null;
    if (!ROUTES.has(key) && !planMatch) return false;
    const CONTENT_JSON_BODY_MAX_BYTES = contentJsonBodyMaxBytes;
    const readJson = (maxBytes) => readJsonBody(req, res, maxBytes);
    await (async () => {
      if (req.method === "GET" && url.pathname === "/api/extensions") {
        return json(res, 200, extensions.inventory());
      }
      if (req.method === "GET" && url.pathname === "/api/extensions/catalogue") {
        return json(res, 200, { catalogue: extensions.catalogue() });
      }
      if (req.method === "POST" && url.pathname === "/api/extensions/proposals") {
        // The model's door over HTTP (what a model resolver calls): the same
        // destination as the transcript path — a PENDING proposal, nothing loaded.
        // descriptor.source is extension CODE — a content body, so the larger cap (voicebox-beads-d808).
        const body = await readJson(CONTENT_JSON_BODY_MAX_BYTES);
        const r = extensions.propose(body?.descriptor, body?.descriptor?.source ?? "model");
        return r.ok ? json(res, 200, { ...r, note: "staged as a pending proposal — NOT loaded; the host admits it" }) : json(res, 400, r);
      }
      if (req.method === "POST" && ["/api/extensions/local", "/api/extensions/create"].includes(url.pathname)) {
        // Create and locally add new extensions (voicebox-beads-b1p).
        // Host-owned admission gate: staging creates a pending proposal with source "local".
        // Direct admission requires the host token (x-voicebox-host-token); without it, direct admission is refused.
        // descriptor.source is extension CODE — a content body, so the larger cap (voicebox-beads-d808).
        const body = await readJson(CONTENT_JSON_BODY_MAX_BYTES);
        const descriptor = body?.descriptor ?? body;
        if (!descriptor || typeof descriptor !== "object") {
          return json(res, 400, { ok: false, refused: "bad-request", why: "extension descriptor object required" });
        }
        const wantsAdmit = Boolean(body?.admit);
        if (wantsAdmit) {
          if (!extensions.hostTokenOk(req.headers["x-voicebox-host-token"])) {
            return json(res, 403, { ok: false, refused: "host-token-required", why: "direct admission is the host's act — this requires the host token (x-voicebox-host-token); stage as proposal first" });
          }
          const r = extensions.createAndAdmitExtension(descriptor, "host");
          return json(res, r.ok ? 200 : 400, r);
        }
        const r = extensions.createExtension(descriptor, descriptor.source ?? "local");
        return json(res, r.ok ? 200 : 400, r);
      }
      if (req.method === "GET" && planMatch) {
        const plan = planMatch[1] === "proposals" ? extensions.proposalPlan(planMatch[2]) : extensions.cataloguePlan(planMatch[2]);
        return plan ? json(res, 200, plan) : json(res, 404, { error: `no ${planMatch[1].replace(/s$/, "")} '${planMatch[2]}'` });
      }
      if (req.method === "POST" && url.pathname === "/api/extensions/sideload") {
        const body = await readJson();
        if (!body?.id) return json(res, 400, { error: "body must be JSON with an id" });
        const plan = extensions.cataloguePlan(body.id);
        if (!plan) return json(res, 404, { error: `no catalogue entry '${body.id}'` });
        if (body.confirm !== true) {
          // Confirm-first: show the plan, stage nothing.
          return json(res, 200, { confirmFirst: true, plan, note: "nothing staged — repeat with confirm:true to stage the sideload as a PENDING proposal (it does not load; admission is still the host's)" });
        }
        const r = extensions.sideload(body.id);
        return r.ok ? json(res, 200, { ...r, note: "staged as a pending proposal — NOT loaded; the host admits it" }) : json(res, 400, r);
      }
    })();
    return true;
  };
}
