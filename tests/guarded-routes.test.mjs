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
import { createAgentRoutes } from "../lib/routes/agents.mjs";
import { createPermissionRoutes } from "../lib/routes/permissions.mjs";
import { createTransportRoutes } from "../lib/routes/transport.mjs";
import { createCommandRoutes } from "../lib/routes/commands.mjs";
import { createPairingRoutes } from "../lib/routes/pairing.mjs";

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
  assert.throws(() => defineRoutes("t", [{ key: "POST /api/x", guard: "csrf", maxBytes: 10, handler: noop }]), /only applies to a route that reads a JSON body/);
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

// ── 3b. path parameters, a body after a caller check, and a route's own refusal ───────────────────────
test("defineRoutes: body and refusal only attach to a caller-check guard, and parameter keys cannot collide", () => {
  assert.throws(() => defineRoutes("t", [{ key: "POST /api/x", guard: "json", body: "json", handler: noop }]), /body must be "json" and only applies/);
  assert.throws(() => defineRoutes("t", [{ key: "POST /api/x", guard: "authority", body: "form", handler: noop }]), /body must be "json"/);
  assert.throws(() => defineRoutes("t", [{ key: "POST /api/x", guard: "wall", because: "x", refusal: { refused: "a", why: "b" }, handler: noop }]), /refusal is \{ refused, why \}/);
  assert.throws(() => defineRoutes("t", [{ key: "POST /api/x", guard: "authority", refusal: { refused: "a" }, handler: noop }]), /refusal is \{ refused, why \}/);
  assert.throws(() => defineRoutes("t", [{ key: "POST /api/x/:a/:a", guard: "json", handler: noop }]), /parameter name is used twice/);
  assert.throws(() => defineRoutes("t", [{ key: "POST /api/x/:", guard: "json", handler: noop }]), /key must look like/);
  assert.throws(
    () => defineRoutes("t", [{ key: "PATCH /api/x/:id", guard: "json", handler: noop }, { key: "PATCH /api/x/:name", guard: "json", handler: noop }]),
    /matches the same requests as another parameterised route/,
  );
  defineRoutes("t", [{ key: "POST /api/x", guard: "host-token", body: "json", maxBytes: 10, handler: noop }]);
});

test("dispatch: a ':name' segment matches one safe path segment and arrives as ctx.params", async () => {
  const seen = [];
  const { call } = harness([
    { key: "PATCH /api/things/:id", guard: "json", handler: (_q, _s, _u, ctx) => { seen.push(["param", ctx.params.id]); } },
    { key: "PATCH /api/things/all", guard: "json", handler: (_q, _s, _u, ctx) => { seen.push(["literal", ctx.params]); } },
    { key: "GET /api/things/:id/parts/:part", guard: "read", handler: (_q, _s, _u, ctx) => { seen.push(["two", ctx.params]); } },
  ]);
  assert.equal(await call("PATCH", "/api/things/a_b-9"), true);
  assert.equal(await call("PATCH", "/api/things/all"), true, "a literal key wins over a parameterised one");
  assert.equal(await call("GET", "/api/things/7/parts/lid"), true);
  assert.deepEqual(seen, [["param", "a_b-9"], ["literal", {}], ["two", { id: "7", part: "lid" }]]);
  for (const pathname of ["/api/things/", "/api/things/a/b", "/api/things/a.b", "/api/things/a%2Fb", "/api/things/..", "/api/thingsX/a"]) {
    assert.equal(await call("PATCH", pathname), false, `${pathname} must not match one segment`);
  }
  assert.equal(await call("DELETE", "/api/things/a"), false, "the METHOD is part of a parameterised key too");
});

test("createGuardedDispatcher: two areas cannot declare parameterised keys that match the same requests", () => {
  const a = defineRoutes("a", [{ key: "PATCH /api/x/:id", guard: "json", handler: noop }]);
  const b = defineRoutes("b", [{ key: "PATCH /api/x/:key", guard: "csrf", handler: noop }]);
  const checks = { browserMutationRefused: noop, hostTokenOk: noop, hasAuthority: noop, hasRoomAuthority: noop };
  assert.throws(() => createGuardedDispatcher({ routes: [...a, ...b], checks, json: noop, readJsonBody: noop }), /declared by 'a' and 'b'/);
});

test("dispatch: body:'json' reads the body only AFTER the caller check passes, and a route's own refusal is what it answers", async () => {
  let got;
  const route = {
    key: "POST /api/x", guard: "host-token", body: "json", maxBytes: 99,
    refusal: { refused: "host-token-required", why: "only the host may do this" },
    handler: (_q, _s, _u, ctx) => { got = ctx.body; },
  };
  const closed = harness([route]);
  await closed.call("POST", "/api/x");
  assert.deepEqual(closed.doorCalls, [], "an unauthorised caller's body is never read");
  assert.deepEqual(closed.answers, [{ code: 403, body: { ok: false, refused: "host-token-required", why: "only the host may do this" } }]);
  assert.equal(got, undefined);

  const open = harness([route], { allow: { hostToken: true } });
  await open.call("POST", "/api/x");
  assert.deepEqual(open.doorCalls, [99]);
  assert.deepEqual(got, { fromDoor: true });
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
      // The registration route declares its BODY as well as its guard since voicebox-beads-gesp: the CSRF guard
      // answers first, then the shared door reads it at this route's own 64 KiB bound.
      ["POST /api/mini-app/tools", "csrf", 65536],
    ],
  );
  for (const route of routes) {
    assert.ok(GUARDS.includes(route.guard));
    assert.equal(route.area, "mini-apps");
    if (!READ_METHODS.has(route.method)) assert.notEqual(route.guard, "read", `${route.key} mutates and must not be a read`);
  }
});

// ── 5. the agent and permission areas ────────────────────────────────────────────────────────────────
function agentHarness({ authority = false, hostToken = false, body = {} } = {}) {
  const answers = [];
  const calls = [];
  const registry = {
    register: (b) => { calls.push(["register", b]); return b?.name ? { ok: true, agent: { id: "a1", ...b } } : { ok: false, refused: "bad-request" }; },
    rename: (id, name) => { calls.push(["rename", id, name]); return id === "a1" ? { ok: true, agent: { id, name } } : { ok: false, refused: "agent-not-found" }; },
    update: (id, b) => { calls.push(["update", id, b]); return id === "a1" ? { ok: true, agent: { id, ...b } } : { ok: false, refused: "agent-not-found" }; },
  };
  const permissions = {
    pending: () => [{ requestId: "r1" }],
    resolve: (id, decision) => { calls.push(["resolve", id, decision]); return id === "r1" ? { ok: true } : { ok: false, refused: "unknown-request" }; },
  };
  const json = (_res, code, payload) => { answers.push({ code, body: payload }); };
  const agentRoutes = createAgentRoutes({
    agentRegistry: registry, publicAgentProjection: (a) => ({ id: a.id, name: a.name }),
    onRegistered: (a) => { calls.push(["onRegistered", a.id]); },
    harnessState: () => ({ activeHarness: "pi", activeHarnesses: ["pi"] }), json,
  });
  const permissionRoutes = createPermissionRoutes({ permissions, json });
  const dispatch = createGuardedDispatcher({
    routes: [...agentRoutes, ...permissionRoutes],
    checks: { browserMutationRefused: () => false, hostTokenOk: () => hostToken, hasAuthority: () => authority, hasRoomAuthority: () => false },
    json, readJsonBody: async () => body,
  });
  return { agentRoutes, permissionRoutes, answers, calls, call: (method, pathname) => dispatch({ method }, {}, { pathname }) };
}

test("agents + permissions: every route's guard is declared, and this is the list", () => {
  const { agentRoutes, permissionRoutes } = agentHarness();
  assert.deepEqual(
    [...agentRoutes, ...permissionRoutes].map((r) => [r.key, r.guard, r.body ?? null, r.refusal?.refused ?? null]),
    [
      ["POST /api/agents", "authority", "json", "host-token-required"],
      ["PATCH /api/agents/:id", "authority", "json", "host-token-required"],
      ["GET /api/permissions/pending", "read", null, null],
      ["POST /api/permissions/resolve", "host-token", "json", "host-token-required"],
    ],
  );
});

test("agents: without authority nothing is registered or updated, and the refusal keeps its wire name", async () => {
  const h = agentHarness({ body: { name: "Pi" } });
  await h.call("POST", "/api/agents");
  await h.call("PATCH", "/api/agents/a1");
  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.answers.map((a) => [a.code, a.body.refused]), [[403, "host-token-required"], [403, "host-token-required"]]);
  assert.match(h.answers[0].body.why, /^configuring an agent is the host's act/);
  assert.match(h.answers[1].body.why, /^updating an agent is the host's act/);
});

test("agents: registering reports the harness state, a name-only PATCH renames, anything else updates", async () => {
  const created = agentHarness({ authority: true, body: { name: "Pi", harness: "pi" } });
  await created.call("POST", "/api/agents");
  assert.deepEqual(created.calls.map((c) => c[0]), ["register", "onRegistered"]);
  assert.deepEqual(created.answers, [{ code: 201, body: { ok: true, agent: { id: "a1", name: "Pi" }, activeHarness: "pi", activeHarnesses: ["pi"] } }]);

  const renamed = agentHarness({ authority: true, body: { name: "New" } });
  await renamed.call("PATCH", "/api/agents/a1");
  assert.deepEqual(renamed.calls, [["rename", "a1", "New"]]);

  const updated = agentHarness({ authority: true, body: { name: "New", model: "m" } });
  await updated.call("PATCH", "/api/agents/a1");
  await updated.call("PATCH", "/api/agents/nope");
  assert.deepEqual(updated.calls.map((c) => c.slice(0, 2)), [["update", "a1"], ["update", "nope"]]);
  assert.deepEqual(updated.answers.map((a) => a.code), [200, 404]);

  const bad = agentHarness({ authority: true, body: null });
  await bad.call("POST", "/api/agents");
  assert.deepEqual(bad.calls.map((c) => c[0]), ["register"], "a refused registration activates nothing");
  assert.equal(bad.answers[0].code, 400);
});

test("permissions: anyone behind the wall reads the queue, only the host token answers it", async () => {
  const page = agentHarness({ authority: true, body: { requestId: "r1", allow: true } });
  await page.call("GET", "/api/permissions/pending");
  await page.call("POST", "/api/permissions/resolve");
  assert.deepEqual(page.answers.map((a) => a.code), [200, 403], "page authority is not the host token");
  assert.deepEqual(page.calls, []);

  const host = agentHarness({ hostToken: true, body: { requestId: "r1", allow: 1, reason: 7 } });
  await host.call("POST", "/api/permissions/resolve");
  assert.deepEqual(host.calls, [["resolve", "r1", { allow: true, optionId: undefined, reason: undefined }]]);
  assert.equal(host.answers[0].code, 200);

  const unnamed = agentHarness({ hostToken: true, body: null });
  await unnamed.call("POST", "/api/permissions/resolve");
  assert.deepEqual(unnamed.answers.map((a) => [a.code, a.body.refused]), [[400, "bad-request"]]);
});

// ── transport + commands (voicebox-beads-cwx5.1) ─────────────────────────────────────────────────────────────

function commandHarness({ hostToken = false, crossOrigin = false, active = { root: { kind: "machine", path: "/w" } }, body = {} } = {}) {
  const answers = [];
  const calls = [];
  const json = (_res, code, payload) => { answers.push({ code, body: payload }); };
  const transportRoutes = createTransportRoutes({
    getActive: () => active,
    noRootDeclared: () => ({ ok: false, refused: "no-root-declared" }),
    exportBundle: (dir, options) => { calls.push(["export", dir, options.files]); return { ok: true, bundle: { files: [] } }; },
    importBundle: (dir, bundle, options) => { calls.push(["import", dir, options.overwrite]); return { ok: true, written: [] }; },
    selfEnvironment: "env_self", json, contentJsonBodyMaxBytes: 1024,
  });
  const commandRoutes = createCommandRoutes({
    execute: async (action) => { calls.push(["execute", action]); return action.command === "bad" ? { ok: false, refused: "no-root-declared" } : { ok: true }; },
    getActive: () => active,
    noRootDeclared: () => ({ ok: false, refused: "no-root-declared" }),
    undoStackFor: () => [{ verb: "write", name: "a.txt", at: 1 }],
    taskStatus: (address) => (address === "task_1" ? { ok: true, state: "done" } : { ok: false, refused: "unknown-task" }),
    recordWorkActivity: (entry) => { calls.push(["activity", entry.summary]); },
    json,
  });
  const dispatch = createGuardedDispatcher({
    routes: [...transportRoutes, ...commandRoutes],
    checks: { browserMutationRefused: () => crossOrigin, hostTokenOk: () => hostToken, hasAuthority: () => false, hasRoomAuthority: () => false },
    json, readJsonBody: async () => body,
  });
  const call = (method, pathname, search = "") => dispatch({ method }, {}, { pathname, searchParams: new URLSearchParams(search) });
  return { transportRoutes, commandRoutes, answers, calls, call };
}

test("transport + commands: every route's guard is declared, and this is the list", () => {
  const { transportRoutes, commandRoutes } = commandHarness();
  assert.deepEqual(
    [...transportRoutes, ...commandRoutes].map((r) => [r.key, r.guard, r.body ?? null, r.refusal?.refused ?? null]),
    [
      ["GET /api/transport/export", "host-token", null, "host-token-required"],
      ["POST /api/transport/import", "host-token", "json", "host-token-required"],
      ["GET /api/undo", "read", null, null],
      ["POST /api/undo", "csrf", null, null],
      ["POST /api/delegate", "json", null, null],
      ["POST /api/exec", "json", null, null],
      ["GET /api/task", "read", null, null],
    ],
  );
});

test("transport: both directions take the host token before anything is read or written", async () => {
  const page = commandHarness({ hostToken: false });
  await page.call("GET", "/api/transport/export");
  await page.call("POST", "/api/transport/import");
  assert.deepEqual(page.answers.map((a) => [a.code, a.body.refused]), [[403, "host-token-required"], [403, "host-token-required"]]);
  assert.deepEqual(page.calls, [], "a refused caller reaches neither the export nor the import");

  const host = commandHarness({ hostToken: true, body: { bundle: { files: [] } } });
  await host.call("GET", "/api/transport/export", "files=a.md,%20b.md");
  await host.call("POST", "/api/transport/import");
  assert.deepEqual(host.calls, [["export", "/w", ["a.md", "b.md"]], ["import", "/w", false]], "overwrite is false unless the caller says true");

  const noRoot = commandHarness({ hostToken: true, active: null });
  await noRoot.call("GET", "/api/transport/export");
  assert.equal(noRoot.answers[0].body.refused, "no-root-declared");
  const browserRoot = commandHarness({ hostToken: true, active: { root: { kind: "browser" } } });
  await browserRoot.call("POST", "/api/transport/import");
  assert.equal(browserRoot.answers[0].body.refused, "root-not-reachable-from-here");
  assert.deepEqual(browserRoot.calls, []);
});

test("commands: undo refuses a cross-origin browser, and each door hands one verb to execute", async () => {
  const hostile = commandHarness({ crossOrigin: true });
  await hostile.call("POST", "/api/undo");
  assert.equal(hostile.answers[0].code, 403);
  assert.deepEqual(hostile.calls, [], "a cross-origin undo runs nothing");

  const room = commandHarness({ body: { agent: "pi", task: "tidy", command: "ls", cwd: " src " } });
  await room.call("GET", "/api/undo");
  await room.call("POST", "/api/undo");
  await room.call("POST", "/api/delegate");
  await room.call("POST", "/api/exec");
  await room.call("GET", "/api/task", "address=task_1");
  await room.call("GET", "/api/task", "address=nope");
  assert.deepEqual(room.answers.map((a) => a.code), [200, 200, 200, 200, 200, 404]);
  assert.deepEqual(room.answers[0].body.last, { verb: "write", name: "a.txt", at: 1 });
  assert.deepEqual(room.calls.map((c) => c[1]), [
    { verb: "undo" },
    { verb: "delegate_task", agent: "pi", task: "tidy" },
    { verb: "exec", command: "ls", cwd: "src" },
  ]);

  // A refusal the executor did not itself record is recorded here, so the activity log still shows it.
  const refused = commandHarness({ body: { command: "bad" } });
  await refused.call("POST", "/api/exec");
  assert.equal(refused.answers[0].code, 400);
  assert.deepEqual(refused.calls.at(-1), ["activity", "exec: bad"]);
});

// ── pairing (voicebox-beads-cwx5.1) ──────────────────────────────────────────────────────────────────────────

function pairingHarness({ hostToken = false, body = {} } = {}) {
  const answers = [];
  const calls = [];
  const json = (_res, code, payload) => { answers.push({ code, body: payload }); };
  const routes = createPairingRoutes({
    mintBearer: () => "vbx_minted",
    storeBearer: (envKey, bearer) => { calls.push(["store", envKey, bearer]); },
    recordCallBearer: (envKey, bearer) => { calls.push(["record", envKey, bearer]); },
    resolveEnvironment: async (envKey) => (envKey === "env_known" ? { ok: true } : { ok: false, refused: "unknown-environment" }),
    revokePairing: (envKey) => { calls.push(["revoke", envKey]); return envKey === "env_known" ? { ok: true } : { ok: false, refused: "not-paired" }; },
    json,
  });
  const dispatch = createGuardedDispatcher({
    routes,
    checks: { browserMutationRefused: () => false, hostTokenOk: () => hostToken, hasAuthority: () => true, hasRoomAuthority: () => true },
    json, readJsonBody: async () => body,
  });
  const call = (method, pathname, search = "") => dispatch({ method }, {}, { pathname, searchParams: new URLSearchParams(search) });
  return { routes, answers, calls, call };
}

test("pairing: every route takes the host token, and room authority is not enough", async () => {
  const { routes } = pairingHarness();
  assert.deepEqual(
    routes.map((r) => [r.key, r.guard, r.body ?? null, r.refusal?.refused ?? null]),
    [
      ["POST /api/pair", "host-token", "json", "host-token-required"],
      ["POST /api/pair/complete", "host-token", "json", "host-token-required"],
      ["DELETE /api/pair", "host-token", "json", "host-token-required"],
    ],
  );
  // hasAuthority and hasRoomAuthority both say yes in this harness: a page still cannot mint or revoke.
  const page = pairingHarness({ hostToken: false, body: { envKey: "env_known", bearer: "vbx_x" } });
  await page.call("POST", "/api/pair");
  await page.call("POST", "/api/pair/complete");
  await page.call("DELETE", "/api/pair");
  assert.deepEqual(page.answers.map((a) => [a.code, a.body.refused]), Array(3).fill([403, "host-token-required"]));
  assert.deepEqual(page.calls, [], "a refused caller creates, records and revokes nothing");
  for (const answer of page.answers) assert.equal(JSON.stringify(answer.body).includes("vbx_"), false, "a refusal never carries a bearer");
});

test("pairing: the host mints, records and revokes, and each refusal is named", async () => {
  const host = pairingHarness({ hostToken: true, body: { envKey: "env_known", bearer: "vbx_theirs" } });
  await host.call("POST", "/api/pair");
  await host.call("POST", "/api/pair/complete");
  await host.call("DELETE", "/api/pair");
  assert.deepEqual(host.answers.map((a) => a.code), [200, 200, 200]);
  assert.deepEqual(host.answers[0].body, { ok: true, envKey: "env_known", bearer: "vbx_minted" });
  assert.deepEqual(host.calls, [["store", "env_known", "vbx_minted"], ["record", "env_known", "vbx_theirs"], ["revoke", "env_known"]]);

  const empty = pairingHarness({ hostToken: true, body: {} });
  await empty.call("POST", "/api/pair");
  await empty.call("POST", "/api/pair/complete");
  await empty.call("DELETE", "/api/pair");
  await empty.call("DELETE", "/api/pair", "envKey=env_other");
  assert.deepEqual(empty.answers.map((a) => [a.code, a.body.refused]), [[400, "bad-request"], [400, "bad-request"], [400, "bad-request"], [404, "not-paired"]]);
  assert.deepEqual(empty.calls, [["revoke", "env_other"]], "the key may ride the query string");

  // An EMPTY body key is a bad request; it must not fall through to the query string and revoke that instead.
  const emptyKey = pairingHarness({ hostToken: true, body: { envKey: "" } });
  await emptyKey.call("DELETE", "/api/pair", "envKey=env_known");
  assert.deepEqual([emptyKey.answers[0].code, emptyKey.answers[0].body.refused], [400, "bad-request"]);
  assert.deepEqual(emptyKey.calls, [], "nothing is revoked");

  const unknown = pairingHarness({ hostToken: true, body: { envKey: "env_nope", bearer: "vbx_theirs" } });
  await unknown.call("POST", "/api/pair/complete");
  assert.deepEqual([unknown.answers[0].code, unknown.answers[0].body.refused], [404, "unknown-environment"]);
  assert.deepEqual(unknown.calls, [], "a bearer for an unknown environment is not recorded");
});
