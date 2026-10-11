// Extension HTTP routes (voicebox-beads-1bv5, voicebox-beads-5c5p). The host retains
// the auth wall, bounded JSON door, authority checks and extension runtime.
const ROUTES = new Set([
  "GET /api/extensions",
  "GET /api/extensions/catalogue",
  "POST /api/extensions/proposals",
  "POST /api/extensions/local",
  "POST /api/extensions/create",
  "POST /api/extensions/sideload",
]);
const DECISIONS = new Set([
  "POST /api/extensions/approval-request",
  "POST /api/extensions/approve",
  "POST /api/extensions/admit",
  "POST /api/extensions/revoke",
  "POST /api/extensions/refuse",
  "POST /api/extensions/reconfigure",
]);
const PLAN = /^\/api\/extensions\/(proposals|catalogue)\/([a-z0-9_-]+)\/plan$/;
const REFUSE = /^\/api\/extensions\/([a-z0-9_-]+)\/refuse$/;
const ID = /^\/api\/extensions\/([a-z0-9_-]+)$/;

/** Return true for an answered route; unknown paths fall through to the host's 404. */
export function createExtensionRoutes({ json, readJsonBody, contentJsonBodyMaxBytes, extensionRuntime: extensions, hasExtensionAuthority }) {
  return async function handleExtensionRoute(req, res, url) {
    const key = `${req.method} ${url.pathname}`;
    const planMatch = req.method === "GET" ? url.pathname.match(PLAN) : null;
    const decisionMatch = req.method === "POST" ? REFUSE.test(url.pathname)
      : (req.method === "DELETE" || req.method === "PATCH") && ID.test(url.pathname);
    if (!ROUTES.has(key) && !DECISIONS.has(key) && !planMatch && !decisionMatch) return false;
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
  if (req.method === "POST" && ["/api/extensions/approval-request", "/api/extensions/approve"].includes(url.pathname)) {
    // JSON-only stops cross-site form submissions; no CORS permission is granted. The console
    // code, not an Origin claim or page-held host credential, authorizes this specific plan.
    if (req.headers["content-type"]?.split(";")[0].trim() !== "application/json") {
      return json(res, 415, { ok: false, refused: "approval-json-required", why: "Send the approval request as JSON." });
    }
    const body = await readJson(4096);
    if (typeof body?.id !== "string" || !/^[a-z0-9_-]{1,100}$/.test(body.id)) {
      return json(res, 400, { ok: false, refused: "approval-invalid-id", why: "Choose an extension from the review list." });
    }
    const r = url.pathname.endsWith("/approval-request")
      ? extensions.requestApproval(body.id)
      : (!body.code && !body.requestId && hasExtensionAuthority(req))
        ? extensions.approveInRoom(body.id, req.headers["x-voicebox-session-token"] || "room-ui")
        : extensions.approveWithCode(body.id, body.requestId, body.code);
    return json(res, r.ok ? 200 : 403, r);
  }
  if (req.method === "POST" && url.pathname === "/api/extensions/admit") {
    // Admission is the HOST's act (bead voicebox-beads-m2i): the route requires
    // the host token (docs/02 §1.5's mechanism — a 0600 file in the host's own
    // directory, readable by the person's shell, by neither the page nor the
    // model). Driven finding, 2026-09-20: without this the page admitted its
    // own proposal in two fetches. The refusal is named, like every other one.
    if (!extensions.hostTokenOk(req.headers["x-voicebox-host-token"])) {
      return json(res, 403, { ok: false, refused: "host-token-required", why: "admission is the host's act — this route requires the host token (x-voicebox-host-token); the page cannot hold it" });
    }
    const body = await readJson();
    if (!body?.id) return json(res, 400, { error: "body must be JSON with an id" });
    const plan = extensions.proposalPlan(body.id);
    if (!plan) return json(res, 404, { error: `no proposal '${body.id}'` });
    if (body.confirm !== true) {
      // Confirm-first: the Tier 2 review act whose resolved plan is the source.
      return json(res, 200, { confirmFirst: true, plan, note: "nothing decided — repeat with confirm:true and decision 'admit'|'deny' to decide" });
    }
    const r = extensions.admitProposal(body.id, body.decision === "deny" ? "deny" : "admit");
    return json(res, 200, r);
  }

  if (req.method === "POST" && url.pathname === "/api/extensions/revoke") {
    // REVOCATION is a protected act (voicebox-beads-qg1, voicebox-beads-5jl):
    // Authorized via in-room session token, local room origin, or the host token.
    if (!hasExtensionAuthority(req)) {
      return json(res, 403, { ok: false, refused: "host-token-required", why: "revocation is a protected host act — this route requires an authorized in-room session or host token (x-voicebox-host-token)" });
    }
    const body = await readJson();
    if (!body?.id) return json(res, 400, { error: "body must be JSON with an id" });
    if (body.confirm !== true) {
      const inv = extensions.inventory();
      const row = inv.extensions.find((e) => e.id === body.id);
      if (!row) return json(res, 404, { ok: false, refused: "extension-not-admitted", why: `'${body.id}' is not a running extension — nothing to revoke` });
      return json(res, 200, { confirmFirst: true, id: body.id, plan: { enforced: row.enforced, gets: row.gets, bounds: row.bounds, tools: row.tools },
        whatStopsWorking: { tools: row.tools, may: row.gets, bounds: row.bounds }, note: "nothing decided — repeat with confirm:true to revoke; the extension's tools stop being callable at once" });
    }
    const r = extensions.revokeExtension(body.id, body.actor ?? "host");
    return json(res, r.ok ? 200 : 404, r);
  }

  // POST /api/extensions/refuse or POST /api/extensions/:id/refuse (voicebox-beads-36ul):
  // Refuse a pending proposal without admitting anything — authorized via in-room session or host token.
  const refuseExtMatch = req.method === "POST" && url.pathname.match(/^\/api\/extensions\/([a-z0-9_-]+)\/refuse$/);
  if (refuseExtMatch || (req.method === "POST" && url.pathname === "/api/extensions/refuse")) {
    if (!hasExtensionAuthority(req)) {
      return json(res, 403, { ok: false, refused: "host-token-required", why: "refusing a proposal requires an authorized in-room session or host token (x-voicebox-host-token)" });
    }
    const body = refuseExtMatch ? {} : await readJson();
    const id = refuseExtMatch ? refuseExtMatch[1] : body?.id;
    if (!id) return json(res, 400, { ok: false, refused: "bad-request", why: "refusing a proposal requires an id" });
    const r = extensions.admitProposal(id, "deny");
    return json(res, r.ok ? 200 : 404, r);
  }

  // DELETE /api/extensions/:id (voicebox-beads-ud5, voicebox-beads-5jl) — REST revocation endpoint
  const deleteExtMatch = req.method === "DELETE" && url.pathname.match(/^\/api\/extensions\/([a-z0-9_-]+)$/);
  if (deleteExtMatch) {
    if (!hasExtensionAuthority(req)) {
      return json(res, 403, { ok: false, refused: "host-token-required", why: "revocation is a protected host act — this route requires an authorized in-room session or host token (x-voicebox-host-token)" });
    }
    const id = deleteExtMatch[1];
    const r = extensions.revokeExtension(id, "host");
    return json(res, r.ok ? 200 : 404, r);
  }

  // POST /api/extensions/reconfigure (voicebox-beads-ud5, voicebox-beads-5jl) — confirm-first or apply reconfigured bounds
  if (req.method === "POST" && url.pathname === "/api/extensions/reconfigure") {
    if (!hasExtensionAuthority(req)) {
      return json(res, 403, { ok: false, refused: "host-token-required", why: "reconfiguring an extension is a protected host act — this route requires an authorized in-room session or host token (x-voicebox-host-token)" });
    }
    const body = await readJson();
    if (!body?.id) return json(res, 400, { ok: false, refused: "bad-request", why: "reconfiguration requires an extension id" });
    const inv = extensions.inventory();
    const row = inv.extensions.find((e) => e.id === body.id);
    if (!row) return json(res, 404, { ok: false, refused: "extension-not-admitted", why: `'${body.id}' is not a running extension — nothing to reconfigure` });

    if (body.bounds !== undefined) {
      if (typeof body.bounds !== "object" || body.bounds === null) {
        return json(res, 400, { ok: false, refused: "bounds-invalid", why: "bounds must be an object with parameters" });
      }
      if (body.bounds.maxRequests !== undefined) {
        const parsed = Number(body.bounds.maxRequests);
        if (!Number.isInteger(parsed) || parsed < 0) {
          return json(res, 400, { ok: false, refused: "bounds-invalid", why: `maxRequests must be a non-negative integer (received ${body.bounds.maxRequests})` });
        }
      }
      if (body.bounds.maxBytes !== undefined) {
        const parsed = Number(body.bounds.maxBytes);
        if (!Number.isInteger(parsed) || parsed < 0) {
          return json(res, 400, { ok: false, refused: "bounds-invalid", why: `maxBytes must be a non-negative integer (received ${body.bounds.maxBytes})` });
        }
      }
      if (body.bounds.hosts !== undefined && !Array.isArray(body.bounds.hosts) && typeof body.bounds.hosts !== "string") {
        return json(res, 400, { ok: false, refused: "bounds-invalid", why: "hosts must be an array of hostnames or a comma-separated string" });
      }
    }

    if (body.confirm !== true) {
      return json(res, 200, {
        confirmFirst: true,
        id: body.id,
        current: { bounds: row.bounds, declared: row.declared, tools: row.tools },
        proposed: { bounds: body.bounds ?? row.bounds },
        note: "nothing decided — repeat with confirm:true to apply reconfiguration",
      });
    }
    const r = extensions.reconfigureExtension(body.id, { bounds: body.bounds, tools: body.tools, params: body.params }, body.actor ?? "host");
    return json(res, r.ok ? 200 : 400, r);
  }

  // PATCH /api/extensions/:id (voicebox-beads-ud5, voicebox-beads-5jl) — REST reconfiguration endpoint
  const patchExtMatch = req.method === "PATCH" && url.pathname.match(/^\/api\/extensions\/([a-z0-9_-]+)$/);
  if (patchExtMatch) {
    if (!hasExtensionAuthority(req)) {
      return json(res, 403, { ok: false, refused: "host-token-required", why: "reconfiguring an extension is a protected host act — this route requires an authorized in-room session or host token (x-voicebox-host-token)" });
    }
    const id = patchExtMatch[1];
    const body = await readJson();
    const r = extensions.reconfigureExtension(id, { bounds: body?.bounds, tools: body?.tools, params: body?.params }, body?.actor ?? "host");
    return json(res, r.ok ? 200 : 400, r);
  }

    })();
    return true;
  };
}
