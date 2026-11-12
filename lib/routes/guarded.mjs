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
// Three things a route may add to its guard:
//   body: "json"    On a csrf / host-token / authority / room-authority route: AFTER the guard passes, read the
//                   body through the same JSON door into `ctx.body`. The guard answers first, so an unauthorised
//                   caller is refused before a byte of its body is read. (`json` routes read it already.)
//   refusal         { refused, why } the route answers with when its guard fails, in place of the standard
//                   sentence — for routes whose refusal is already part of the wire contract.
//   :name in a key  "PATCH /api/agents/:id" matches one path segment of [A-Za-z0-9_-]+ and hands it over as
//                   `ctx.params.id`. A literal key always wins over a parameterised one.
//
// The host supplies the checks (they close over its tokens and origins); this module owns the order.

/** The verbs that answer a READ. Everything else is a mutation and must declare a real guard. */
export const READ_METHODS = Object.freeze(new Set(["GET", "HEAD", "OPTIONS"]));
export const GUARDS = Object.freeze(["read", "json", "csrf", "host-token", "authority", "room-authority", "wall"]);

const KEY = /^(GET|HEAD|OPTIONS|POST|PUT|PATCH|DELETE) (\/api(?:\/(?:[A-Za-z0-9_-]+|:[A-Za-z][A-Za-z0-9]*))+)$/;
/** One path segment a `:name` stands for. Deliberately narrow: no dots, no slashes, no percent-escapes. */
const PARAM_SEGMENT = "([A-Za-z0-9_-]+)";
/** Guards that may add `body: "json"` — a caller check first, then the door. */
const BODY_GUARDS = Object.freeze(["csrf", "host-token", "authority", "room-authority"]);

/** The parameter names in a path, and the anchored pattern that matches it; null for a literal path. */
function compilePath(routePath) {
  const params = [];
  const pattern = routePath.split("/").map((segment) => {
    if (!segment.startsWith(":")) return segment;
    params.push(segment.slice(1));
    return PARAM_SEGMENT;
  }).join("\\/");
  return params.length ? { params: Object.freeze(params), pattern: new RegExp(`^${pattern}$`) } : null;
}

/**
 * Validate and freeze one area's routes. Throws — at import, so the server cannot start — on a malformed key, an
 * unknown guard, a duplicate key, a mutating route declared `read`, a `wall` with no stated reason, a body or
 * refusal option on a guard it cannot apply to, or two parameterised keys that would match the same request.
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
    if (route.body !== undefined && (route.body !== "json" || !BODY_GUARDS.includes(route.guard))) {
      throw new Error(`${where}: body must be "json" and only applies to the ${BODY_GUARDS.join(", ")} guards`);
    }
    const readsJson = route.guard === "json" || route.body === "json";
    if (route.maxBytes !== undefined && (!readsJson || !Number.isSafeInteger(route.maxBytes) || route.maxBytes < 1)) {
      throw new Error(`${where}: maxBytes is a positive integer and only applies to a route that reads a JSON body`);
    }
    if (route.refusal !== undefined) {
      const { refused, why } = route.refusal ?? {};
      if (!BODY_GUARDS.includes(route.guard) || typeof refused !== "string" || !refused || typeof why !== "string" || !why) {
        throw new Error(`${where}: refusal is { refused, why } and only applies to the ${BODY_GUARDS.join(", ")} guards`);
      }
    }
    if (typeof route.handler !== "function") throw new Error(`${where}: handler must be a function`);
    const compiled = compilePath(match[2]);
    if (compiled && new Set(compiled.params).size !== compiled.params.length) {
      throw new Error(`${where}: a parameter name is used twice`);
    }
    // Two keys that differ only in their parameter NAMES match the same requests.
    const shape = `${method} ${match[2].replace(/:[A-Za-z][A-Za-z0-9]*/g, ":")}`;
    if (compiled) {
      if (seen.has(shape)) throw new Error(`${where}: matches the same requests as another parameterised route`);
      seen.add(shape);
    }
    return Object.freeze({
      ...route,
      ...(route.refusal ? { refusal: Object.freeze({ refused: route.refusal.refused, why: route.refusal.why }) } : {}),
      area, method, path: match[2], shape,
      params: compiled?.params ?? Object.freeze([]),
      pattern: compiled?.pattern ?? null,
    });
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
 * Order, for every request: match (a literal key first, then a parameterised one) → guard → body → handler.
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
  const literal = new Map();
  const parameterised = [];
  for (const route of routes) {
    const clash = table.get(route.shape);
    if (clash) throw new Error(`createGuardedDispatcher: ${route.key} is declared by '${clash.area}' and '${route.area}'`);
    table.set(route.shape, route);
    if (route.pattern) parameterised.push(route);
    else literal.set(route.key, route);
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
    let route = literal.get(`${req.method} ${url.pathname}`);
    let matched = null;
    if (!route) {
      for (const candidate of parameterised) {
        if (candidate.method !== req.method) continue;
        matched = url.pathname.match(candidate.pattern);
        if (matched) { route = candidate; break; }
      }
    }
    if (!route) return false;
    if (!passes[route.guard](req)) {
      json(res, 403, { ok: false, ...(route.refusal ?? REFUSALS[route.guard]) });
      return true;
    }
    const ctx = { params: Object.freeze(Object.fromEntries(route.params.map((name, i) => [name, matched[i + 1]]))) };
    if (route.guard === "json" || route.body === "json") ctx.body = await readJsonBody(req, res, route.maxBytes);
    await route.handler(req, res, url, ctx);
    return true;
  }
  dispatch.routes = Object.freeze([...table.values()]);
  return dispatch;
}
