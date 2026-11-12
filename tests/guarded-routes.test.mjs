// tests/guarded-routes.test.mjs — the declared-guard route table (voicebox-beads-cwx5.1).
//
// A route's boundary used to be a line inside its handler, proved present by regex-scanning server.mjs
// (tests/csrf-route-seam.test.mjs). lib/routes/guarded.mjs makes it DATA that one dispatcher enforces. These
// tests are about that mechanism, driven for real: no source text is read here.
//
//   1. defineRoutes() refuses, at definition time, every way a route could arrive without a boundary.
//   2. The dispatcher enforces each guard BEFORE the handler runs — the handler is observed not to be called.
//   3. The json guard hands the handler the body the host's door read, with the route's own cap.
//   4. The Mini-App area's table says what its routes are guarded by. Changing a guard is a visible diff here.
import test from "node:test";
import assert from "node:assert/strict";
import { defineRoutes, createGuardedDispatcher, GUARDS, READ_METHODS } from "../lib/routes/guarded.mjs";
import { createMiniAppRoutes } from "../lib/routes/mini-apps.mjs";

const noop = () => {};

// ── 1. definition-time refusals ──────────────────────────────────────────────────────────────────────
test("defineRoutes: a mutating route with no guard, or an unknown one, cannot be defined", () => {
  assert.throws(() => defineRoutes("t", [{ key: "POST /api/x", handler: noop }]), /guard must be one of/);
  assert.throws(() => defineRoutes("t", [{ key: "POST /api/x", guard: "trust-me", handler: noop }]), /guard must be one of/);
});

test("defineRoutes: 'read' is refused for every mutating verb and accepted for every read verb", () => {
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    assert.throws(
      () => defineRoutes("t", [{ key: `${method} /api/x`, guard: "read", handler: noop }]),
      new RegExp(`a ${method} route changes state and cannot declare the 'read' guard`),
    );
  }
  for (const method of READ_METHODS) {
    assert.equal(defineRoutes("t", [{ key: `${method} /api/x`, guard: "read", handler: noop }])[0].method, method);
  }
});

test("defineRoutes: a 'wall' route must say why it has no boundary of its own", () => {
  assert.throws(() => defineRoutes("t", [{ key: "DELETE /api/x", guard: "wall", handler: noop }]), /must say why in 'because'/);
  assert.throws(() => defineRoutes("t", [{ key: "DELETE /api/x", guard: "wall", because: "  ", handler: noop }]), /must say why/);
  defineRoutes("t", [{ key: "DELETE /api/x", guard: "wall", because: "clears a log that holds no secrets", handler: noop }]);
});

test("defineRoutes: malformed keys, duplicates, a missing handler and a misplaced maxBytes are refused", () => {
  assert.throws(() => defineRoutes("t", [{ key: "post /api/x", guard: "json", handler: noop }]), /key must look like/);
  assert.throws(() => defineRoutes("t", [{ key: "POST /x", guard: "json", handler: noop }]), /key must look like/);
  assert.throws(() => defineRoutes("t", [{ key: "POST /api/x", guard: "json", handler: noop }, { key: "POST /api/x", guard: "json", handler: noop }]), /declared twice/);
  assert.throws(() => defineRoutes("t", [{ key: "POST /api/x", guard: "json" }]), /handler must be a function/);
  assert.throws(() => defineRoutes("t", [{ key: "POST /api/x", guard: "csrf", maxBytes: 10, handler: noop }]), /only applies to the 'json' guard/);
  assert.throws(() => defineRoutes("t", [{ key: "POST /api/x", guard: "json", maxBytes: 0, handler: noop }]), /positive integer/);
});

test("defineRoutes: the result is frozen, so a guard cannot be swapped after definition", () => {
  const routes = defineRoutes("t", [{ key: "POST /api/x", guard: "json", handler: noop }]);
  assert.throws(() => { "use strict"; routes[0].guard = "read"; }, TypeError);
  assert.throws(() => { "use strict"; routes.push({}); }, TypeError);
});

// ── 2 + 3. the dispatcher ────────────────────────────────────────────────────────────────────────────
function harness(routeList, { allow = {} } = {}) {
  const answers = [];
  const doorCalls = [];
  const dispatch = createGuardedDispatcher({
    routes: defineRoutes("t", routeList),
    checks: {
      browserMutationRefused: () => !allow.csrf,
      hostTokenOk: () => Boolean(allow.hostToken),
      hasAuthority: () => Boolean(allow.authority),
      hasRoomAuthority: () => Boolean(allow.roomAuthority),
    },
    json: (_res, code, body) => { answers.push({ code, body }); },
    readJsonBody: async (_req, _res, maxBytes) => { doorCalls.push(maxBytes); return { fromDoor: true }; },
  });
  const call = (method, pathname) => dispatch({ method }, {}, { pathname });
  return { dispatch, call, answers, doorCalls };
}

test("dispatch: an unknown key is not handled, so the host's other routes still get the request", async () => {
  const { call, answers } = harness([{ key: "GET /api/x", guard: "read", handler: noop }]);
  assert.equal(await call("GET", "/api/y"), false);
  assert.equal(await call("POST", "/api/x"), false, "the METHOD is part of the key");
  assert.deepEqual(answers, []);
});

for (const [guard, allowKey, refused] of [
  ["csrf", "csrf", "cross-origin-request-refused"],
  ["host-token", "hostToken", "host-authority-required"],
  ["authority", "authority", "authority-required"],
  ["room-authority", "roomAuthority", "authority-required"],
]) {
  test(`dispatch: '${guard}' refuses 403 ${refused} WITHOUT calling the handler, and calls it when the check passes`, async () => {
    let ran = 0;
    const route = { key: "POST /api/x", guard, handler: () => { ran += 1; } };

    const closed = harness([route]);
    assert.equal(await closed.call("POST", "/api/x"), true, "a refusal is an answer: the request is handled");
    assert.equal(ran, 0, "the handler must not run when its guard fails");
    assert.equal(closed.answers.length, 1);
    assert.equal(closed.answers[0].code, 403);
    assert.equal(closed.answers[0].body.ok, false);
    assert.equal(closed.answers[0].body.refused, refused);
    assert.match(closed.answers[0].body.why, /[Nn]othing was run/);

    const open = harness([route], { allow: { [allowKey]: true } });
    assert.equal(await open.call("POST", "/api/x"), true);
    assert.equal(ran, 1);
    assert.deepEqual(open.answers, [], "a passing guard writes nothing itself");
  });
}

test("dispatch: one guard passing does not open another — each route is checked by ITS guard", async () => {
  let ran = 0;
  const { call } = harness([{ key: "POST /api/x", guard: "host-token", handler: () => { ran += 1; } }], {
    allow: { csrf: true, authority: true, roomAuthority: true },
  });
  await call("POST", "/api/x");
  assert.equal(ran, 0, "an Origin or session-token pass is not the host token");
});

test("dispatch: 'json' reads the body through the host's door, with the route's cap, before the handler", async () => {
  const seen = [];
  const { call, doorCalls } = harness([
    { key: "POST /api/small", guard: "json", handler: (_q, _s, _u, ctx) => { seen.push(ctx.body); } },
    { key: "POST /api/big", guard: "json", maxBytes: 8 * 1024 * 1024, handler: (_q, _s, _u, ctx) => { seen.push(ctx.body); } },
    { key: "GET /api/r", guard: "read", handler: (_q, _s, _u, ctx) => { seen.push(ctx.body); } },
  ]);
  await call("POST", "/api/small");
  await call("POST", "/api/big");
  await call("GET", "/api/r");
  assert.deepEqual(doorCalls, [undefined, 8 * 1024 * 1024], "the default cap is the door's own; a content route passes its larger one");
  assert.deepEqual(seen, [{ fromDoor: true }, { fromDoor: true }, undefined], "a read route gets no body and the door is not opened for it");
});

test("dispatch: a refusal the door answers stops the route and reaches the host's catch", async () => {
  let ran = 0;
  class BodyRefusal extends Error {}
  const dispatch = createGuardedDispatcher({
    routes: defineRoutes("t", [{ key: "POST /api/x", guard: "json", handler: () => { ran += 1; } }]),
    checks: { browserMutationRefused: () => false, hostTokenOk: () => true, hasAuthority: () => true, hasRoomAuthority: () => true },
    json: noop,
    readJsonBody: async () => { throw new BodyRefusal("unsupported-content-type"); },
  });
  await assert.rejects(dispatch({ method: "POST" }, {}, { pathname: "/api/x" }), BodyRefusal);
  assert.equal(ran, 0);
});

test("createGuardedDispatcher: two areas cannot declare the same key, and the host must supply every check", () => {
  const a = defineRoutes("a", [{ key: "POST /api/x", guard: "json", handler: noop }]);
  const b = defineRoutes("b", [{ key: "POST /api/x", guard: "csrf", handler: noop }]);
  const checks = { browserMutationRefused: noop, hostTokenOk: noop, hasAuthority: noop, hasRoomAuthority: noop };
  assert.throws(() => createGuardedDispatcher({ routes: [...a, ...b], checks, json: noop, readJsonBody: noop }), /declared by 'a' and 'b'/);
  assert.throws(() => createGuardedDispatcher({ routes: a, checks: { ...checks, hostTokenOk: undefined }, json: noop, readJsonBody: noop }), /checks\.hostTokenOk/);
});

// ── 4. the Mini-App area's declarations ──────────────────────────────────────────────────────────────
test("mini-apps: every route's guard is declared, and this is the list", () => {
  const routes = createMiniAppRoutes({
    getRootPath: () => "/nonexistent", registry: {}, sendToRoom: noop, json: noop, contentJsonBodyMaxBytes: 8 * 1024 * 1024,
  });
  assert.deepEqual(
    routes.map((r) => [r.key, r.guard, r.maxBytes ?? null]),
    [
      ["GET /api/mini-apps", "read", null],
      ["POST /api/mini-apps", "json", 8 * 1024 * 1024],
      ["PUT /api/mini-apps", "json", 8 * 1024 * 1024],
      ["DELETE /api/mini-apps", "json", null],
      ["GET /api/mini-app/tools", "read", null],
      ["POST /api/mini-app/tools", "csrf", null],
    ],
  );
  for (const route of routes) {
    assert.ok(GUARDS.includes(route.guard));
    assert.equal(route.area, "mini-apps");
    if (!READ_METHODS.has(route.method)) assert.notEqual(route.guard, "read", `${route.key} mutates and must not be a read`);
  }
});
