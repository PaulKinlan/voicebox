/**
 * @summary Declared-guard route table: each route states its boundary as data and one dispatcher enforces it.
 */
// THE GUARDED ROUTE TABLE (voicebox-beads-cwx5.1).
//
// Before this, a route's security boundary was a line somewhere inside its handler — `readJson(...)`, a
// `hostTokenOk(...)` test, a key in the host's `browserSensitive` list — and tests/csrf-route-seam.test.mjs
// proved it was still there by regex-scanning the SOURCE TEXT of server.mjs. Moving a handler to its own file
// meant hand-editing that scan, and forgetting a guard on a new route was a thing only the scan could notice.
//
// Here a route is a record: { key, guard, handler }. The guard is DATA, the dispatcher below ENFORCES it before
// the handler is called, and defineRoutes() refuses at import time a mutating route that declares none. So:
//   · a new route cannot exist without a guard — the module fails to load;
//   · a handler cannot forget its guard — it is never called until the guard has passed;
//   · moving a route between files changes no test, because the tests read the table, not the text.
//
// What each guard means, and what the dispatcher does for it:
//   read            A READ verb (GET/HEAD/OPTIONS) with no boundary of its own. Refused for a mutating verb.
//   json            The bounded JSON door reads the body BEFORE the handler runs and hands it over as
//                   `ctx.body` (null when malformed, exactly as the door resolves it). A missing or non-JSON
//                   Content-Type and an oversized body are answered by the door and stop the route. `maxBytes`
//                   on the route picks the cap.
//   csrf            A browser request from outside this local page is refused; unheaded machine callers and a
//                   valid host token pass. For routes that cannot use the JSON door.
//   host-token      Only the host token passes.
//   authority       The host token, the room session token, or this page's own Origin.
//   room-authority  The host token or the room session token — never a bare Origin claim.
//   wall            DELIBERATELY no boundary of its own on a mutating route: reachable only behind the host's
//                   auth wall. The route must say why in `because`.
//
// The host supplies the checks (they close over its tokens and origins); this module owns the order.

/** The verbs that answer a READ. Everything else is a mutation and must declare a real guard. */
export const READ_METHODS = Object.freeze(new Set(["GET", "HEAD", "OPTIONS"]));
export const GUARDS = Object.freeze(["read", "json", "csrf", "host-token", "authority", "room-authority", "wall"]);

const KEY = /^(GET|HEAD|OPTIONS|POST|PUT|PATCH|DELETE) (\/api\/[A-Za-z0-9/_-]+)$/;

/**
 * Validate and freeze one area's routes. Throws — at import, so the server cannot start — on a malformed key, an
 * unknown guard, a duplicate key, a mutating route declared `read`, or a `wall` with no stated reason.
 */
export function defineRoutes(area, routes) {
  if (typeof area !== "string" || !area) throw new Error("defineRoutes: an area name is required");
  if (!Array.isArray(routes)) throw new Error(`defineRoutes(${area}): routes must be an array`);
  const seen = new Set();
  return Object.freeze(routes.map((route) => {
    const where = `defineRoutes(${area}) ${route?.key ?? "<no key>"}`;
    const match = typeof route?.key === "string" ? route.key.match(KEY) : null;
    if (!match) throw new Error(`${where}: key must look like "POST /api/thing"`);
    if (seen.has(route.key)) throw new Error(`${where}: declared twice`);
    seen.add(route.key);
    if (!GUARDS.includes(route.guard)) {
      throw new Error(`${where}: guard must be one of ${GUARDS.join(", ")} — a route without a declared boundary cannot be registered`);
    }
    const method = match[1];
    if (route.guard === "read" && !READ_METHODS.has(method)) {
      throw new Error(`${where}: a ${method} route changes state and cannot declare the 'read' guard`);
    }
    if (route.guard === "wall" && (typeof route.because !== "string" || !route.because.trim())) {
      throw new Error(`${where}: a 'wall' route has no boundary of its own and must say why in 'because'`);
    }
    if (route.maxBytes !== undefined && (route.guard !== "json" || !Number.isSafeInteger(route.maxBytes) || route.maxBytes < 1)) {
      throw new Error(`${where}: maxBytes is a positive integer and only applies to the 'json' guard`);
    }
    if (typeof route.handler !== "function") throw new Error(`${where}: handler must be a function`);
    return Object.freeze({ ...route, area, method, path: match[2] });
  }));
}

/** The named refusal a failed check answers with. One sentence per guard, so every route refuses the same way. */
const REFUSALS = Object.freeze({
  csrf: {
    refused: "cross-origin-request-refused",
    why: "a browser request from outside this local page cannot trigger this action; nothing was run. " +
      "Machine callers without browser headers are unaffected. VOICEBOX_LOOPBACK_AUTH=1 is " +
      "the separate boundary against other local processes.",
  },
  "host-token": {
    refused: "host-authority-required",
    why: "this action needs the host token (x-voicebox-host-token); nothing was run.",
  },
  authority: {
    refused: "authority-required",
    why: "this action needs the host token, the room session token, or a request from this local page; nothing was run.",
  },
  "room-authority": {
    refused: "authority-required",
    why: "this action needs the host token or the room session token; an Origin header alone is not enough. Nothing was run.",
  },
});

/**
 * Build the dispatcher for a set of defined routes.
 *
 * `checks` come from the host: { browserMutationRefused(req), hostTokenOk(req), hasAuthority(req),
 * hasRoomAuthority(req) }. `readJsonBody(req, res, maxBytes)` is the host's bounded JSON door; a refusal it
 * answers is thrown as the host's BodyRefusal and propagates to the host's own catch, as it always has.
 *
 * Returns `dispatch(req, res, url) -> Promise<boolean>`: false when no route here matches, true when one was
 * answered (by its guard or by its handler).
 */
export function createGuardedDispatcher({ routes, checks, json, readJsonBody }) {
  const table = new Map();
  for (const route of routes) {
    if (table.has(route.key)) throw new Error(`createGuardedDispatcher: ${route.key} is declared by '${table.get(route.key).area}' and '${route.area}'`);
    table.set(route.key, route);
  }
  for (const name of ["browserMutationRefused", "hostTokenOk", "hasAuthority", "hasRoomAuthority"]) {
    if (typeof checks?.[name] !== "function") throw new Error(`createGuardedDispatcher: the host must supply checks.${name}`);
  }
  const passes = {
    read: () => true,
    wall: () => true,
    json: () => true, // enforced by the door below, which answers its own refusals
    csrf: (req) => !checks.browserMutationRefused(req),
    "host-token": (req) => checks.hostTokenOk(req),
    authority: (req) => checks.hasAuthority(req),
    "room-authority": (req) => checks.hasRoomAuthority(req),
  };

  async function dispatch(req, res, url) {
    const route = table.get(`${req.method} ${url.pathname}`);
    if (!route) return false;
    if (!passes[route.guard](req)) {
      json(res, 403, { ok: false, ...REFUSALS[route.guard] });
      return true;
    }
    const ctx = {};
    if (route.guard === "json") ctx.body = await readJsonBody(req, res, route.maxBytes);
    await route.handler(req, res, url, ctx);
    return true;
  }
  dispatch.routes = Object.freeze([...table.values()]);
  return dispatch;
}
