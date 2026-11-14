import test from "node:test";
import assert from "node:assert/strict";
import { createExtensionRoutes } from "../lib/routes/extensions.mjs";

function fixture(body = {}, { authorized = false, explicitRoom = false, runtime: overrides = {} } = {}) {
  const replies = [], caps = [], calls = [];
  const runtime = {
    inventory: () => ({ extensions: [] }),
    catalogue: () => [{ id: "known" }],
    proposalPlan: (id) => id === "known" ? { id } : null,
    cataloguePlan: (id) => id === "known" ? { id } : null,
    propose: () => { calls.push("propose"); return { ok: true }; },
    createExtension: () => { calls.push("stage"); return { ok: true }; },
    createAndAdmitExtension: () => { calls.push("admit"); return { ok: true }; },
    sideload: () => { calls.push("sideload"); return { ok: true }; },
    hostTokenOk: (token) => token === "host",
    requestApproval: () => { calls.push("requestApproval"); return { ok: true }; },
    approveInRoom: () => { calls.push("approveInRoom"); return { ok: true }; },
    approveWithCode: () => { calls.push("approveWithCode"); return { ok: true }; },
    admitProposal: () => { calls.push("admitProposal"); return { ok: true }; },
    revokeExtension: () => { calls.push("revokeExtension"); return { ok: true }; },
    reconfigureExtension: () => { calls.push("reconfigureExtension"); return { ok: true }; },
    ...overrides,
  };
  const routes = createExtensionRoutes({
    json: (_res, status, payload) => { replies.push({ status, payload }); },
    readJsonBody: async (_req, _res, maxBytes) => { caps.push(maxBytes); return body; },
    contentJsonBodyMaxBytes: 8 * 1024 * 1024,
    extensionRuntime: runtime,
    hasExtensionAuthority: () => authorized,
    hasExplicitRoomAuthority: () => explicitRoom,
  });
  const request = (method, pathname, headers = {}) => routes({ method, headers }, {}, new URL(`http://localhost${pathname}`));
  return { request, replies, caps, calls };
}

test("extension routes own only exact paths; unknown and sibling permission paths fall through", async () => {
  const f = fixture();
  for (const [method, path] of [["POST", "/api/agents"], ["GET", "/api/permissions/pending"], ["POST", "/api/permissions/resolve"], ["PUT", "/api/extensions/known"], ["GET", "/api/extensions/proposals/UPPER/plan"], ["DELETE", "/api/extensions/UPPER"]]) {
    assert.equal(await f.request(method, path), false, `${method} ${path} must remain with the host or 404`);
  }
  assert.equal(f.replies.length, 0);
  assert.equal(await f.request("GET", "/api/extensions"), true);
  assert.deepEqual(f.replies.at(-1), { status: 200, payload: { extensions: [] } });
  assert.equal(await f.request("GET", "/api/extensions/proposals/known/plan"), true);
  assert.deepEqual(f.replies.at(-1), { status: 200, payload: { id: "known" } });
});

test("content-carrying staging keeps the 8 MiB door; local direct admission stays host-only", async () => {
  const f = fixture({ descriptor: { id: "one" }, admit: true });
  assert.equal(await f.request("POST", "/api/extensions/proposals"), true);
  assert.equal(f.caps.at(-1), 8 * 1024 * 1024);
  assert.deepEqual(f.calls, ["propose"]);
  assert.equal(await f.request("POST", "/api/extensions/local"), true);
  assert.equal(f.replies.at(-1).status, 403);
  assert.equal(f.replies.at(-1).payload.refused, "host-token-required");
  assert.deepEqual(f.calls, ["propose"], "the refused request cannot admit anything");
  assert.equal(await f.request("POST", "/api/extensions/create", { "x-voicebox-host-token": "host" }), true);
  assert.deepEqual(f.calls, ["propose", "admit"]);
  assert.equal(f.caps.at(-1), 8 * 1024 * 1024);
});

test("a refused body propagates untouched to the host's BodyRefusal catch", async () => {
  const refused = new Error("already answered 413");
  const f = fixture();
  const routes = createExtensionRoutes({
    json: () => assert.fail("route must not answer a refused body again"),
    readJsonBody: async () => { throw refused; },
    contentJsonBodyMaxBytes: 8 * 1024 * 1024,
    extensionRuntime: { propose: () => assert.fail("route must not stage a refused body") },
  });
  await assert.rejects(routes({ method: "POST", headers: {} }, {}, new URL("http://localhost/api/extensions/proposals")), (error) => error === refused);
  assert.equal(f.calls.length, 0);
});

test("sideload previews without mutation and uses the default JSON cap", async () => {
  const f = fixture({ id: "known" });
  assert.equal(await f.request("POST", "/api/extensions/sideload"), true);
  assert.equal(f.caps.at(-1), undefined);
  assert.equal(f.replies.at(-1).payload.confirmFirst, true);
  assert.deepEqual(f.calls, []);
  const confirmed = fixture({ id: "known", confirm: true });
  assert.equal(await confirmed.request("POST", "/api/extensions/sideload"), true);
  assert.deepEqual(confirmed.calls, ["sideload"]);
});

test("host-only admission refuses an authorized room without a host token before reading a body", async () => {
  const f = fixture({ id: "known", confirm: true }, { authorized: true });
  assert.equal(await f.request("POST", "/api/extensions/admit", { "x-voicebox-session-token": "room" }), true);
  assert.equal(f.replies.at(-1).status, 403);
  assert.equal(f.replies.at(-1).payload.refused, "host-token-required");
  assert.deepEqual(f.caps, [], "a refused admission does not read or act on the request body");
  assert.deepEqual(f.calls, []);
});

test("approval requires JSON, a 4096-byte body door and a valid ID before asking the runtime", async () => {
  const wrongType = fixture({ id: "known" });
  assert.equal(await wrongType.request("POST", "/api/extensions/approval-request", { "content-type": "application/x-www-form-urlencoded" }), true);
  assert.deepEqual(wrongType.replies.at(-1), { status: 415, payload: { ok: false, refused: "approval-json-required", why: "Send the approval request as JSON." } });
  assert.deepEqual(wrongType.caps, []);
  const invalid = fixture({ id: "../outside" });
  await invalid.request("POST", "/api/extensions/approval-request", { "content-type": "application/json" });
  assert.equal(invalid.caps.at(-1), 4096);
  assert.equal(invalid.replies.at(-1).payload.refused, "approval-invalid-id");
  assert.deepEqual(invalid.calls, []);
  const refused = new Error("already answered 413");
  const routes = createExtensionRoutes({
    json: () => assert.fail("approval must not answer a refused body twice"),
    readJsonBody: async (_req, _res, cap) => { assert.equal(cap, 4096); throw refused; },
    extensionRuntime: { requestApproval: () => assert.fail("refused body must not reach approval") },
  });
  await assert.rejects(routes({ method: "POST", headers: { "content-type": "application/json" } }, {}, new URL("http://localhost/api/extensions/approval-request")), (error) => error === refused);
});

test("an ORIGIN-only authority claim cannot admit in room, and nothing is installed (voicebox-beads-93kz)", async () => {
  // TM-EXT-014. `hasExtensionAuthority` is true for a bare page-Origin claim, which any local process can write on
  // a raw socket and any same-origin page context can present. That used to be enough to run approveInRoom — i.e. to
  // INSTALL an extension, which interpolates $ENV_VAR at run time (voicebox-beads-izu7). The room's own session
  // token, or the host token, is now required for the in-room path.
  const originOnly = fixture({ id: "known" }, { authorized: true, explicitRoom: false });
  assert.equal(
    await originOnly.request("POST", "/api/extensions/approve", { "content-type": "application/json" }),
    true,
  );
  assert.deepEqual(originOnly.calls, [], "an Origin claim admitted an extension");
  assert.equal(originOnly.replies.at(-1).status, 403);
  assert.equal(originOnly.replies.at(-1).payload.refused, "room-session-required");
  assert.match(originOnly.replies.at(-1).payload.why, /host token/);

  // The room itself, holding its own token, still takes the in-room path.
  const room = fixture({ id: "known" }, { explicitRoom: true });
  await room.request("POST", "/api/extensions/approve", { "content-type": "application/json", "x-voicebox-session-token": "room" });
  assert.deepEqual(room.calls, ["approveInRoom"]);

  // And a console code still authorizes a specific plan without any room token.
  const coded = fixture({ id: "known", code: "abc123", requestId: "req-1" });
  await coded.request("POST", "/api/extensions/approve", { "content-type": "application/json" });
  assert.deepEqual(coded.calls, ["approveWithCode"]);

  // Requesting an approval code is not an installing act, so it needs no room token.
  const ask = fixture({ id: "known" });
  await ask.request("POST", "/api/extensions/approval-request", { "content-type": "application/json" });
  assert.deepEqual(ask.calls, ["requestApproval"]);
});

test("an ORIGIN CLAIM alone cannot revoke or reconfigure: management needs the room's own credential (voicebox-beads-nxpq)", async () => {
  // Every fixture below that expects the act to PROCEED sets explicitRoom: true — the room's own session token or the
  // host token. `authorized: true` (hasExtensionAuthority, which accepts a bare Origin) is no longer enough for any
  // extension management route: that was the finding, and it is what these arms would have passed before.
  const row = { id: "known", enforced: {}, gets: [], bounds: {}, tools: [] };
  for (const [method, path, body] of [
    ["POST", "/api/extensions/revoke", { id: "known", confirm: true }],
    ["POST", "/api/extensions/revoke", { id: "known" }],
    ["DELETE", "/api/extensions/known", {}],
    ["POST", "/api/extensions/reconfigure", { id: "known", bounds: { maxRequests: 5 }, confirm: true }],
    ["PATCH", "/api/extensions/known", { bounds: { maxRequests: 5 } }],
    ["POST", "/api/extensions/refuse", { id: "known" }],
    ["POST", "/api/extensions/known/refuse", {}],
  ]) {
    const claimOnly = fixture(body, { authorized: true, runtime: { inventory: () => ({ extensions: [row] }) } });
    assert.equal(await claimOnly.request(method, path), true);
    assert.equal(claimOnly.replies.at(-1).status, 403, `${method} ${path} must not accept an Origin claim`);
    assert.equal(claimOnly.replies.at(-1).payload.refused, "room-session-required", `${method} ${path} must refuse by name`);
    assert.deepEqual(claimOnly.calls, [], `${method} ${path} must not reach the runtime`);
    const withRoom = fixture(body, { authorized: true, explicitRoom: true, runtime: { inventory: () => ({ extensions: [row] }) } });
    assert.equal(await withRoom.request(method, path), true);
    assert.notEqual(withRoom.replies.at(-1)?.status, 403, `${method} ${path} must proceed with the room's own credential: ${JSON.stringify(withRoom.replies.at(-1))}`);
  }
  const preview = fixture({ id: "known" }, { authorized: true, explicitRoom: true, runtime: { inventory: () => ({ extensions: [row] }) } });
  assert.equal(await preview.request("POST", "/api/extensions/revoke"), true);
  assert.equal(preview.replies.at(-1).payload.confirmFirst, true);
  assert.deepEqual(preview.calls, [], "a preview cannot revoke anything");
  const denied = fixture({ id: "known", confirm: true });
  await denied.request("POST", "/api/extensions/revoke");
  assert.equal(denied.replies.at(-1).status, 403);
  assert.deepEqual(denied.calls, []);
  const badBounds = fixture({ id: "known", bounds: { maxRequests: -1 }, confirm: true }, { authorized: true, explicitRoom: true, runtime: { inventory: () => ({ extensions: [row] }) } });
  await badBounds.request("POST", "/api/extensions/reconfigure");
  assert.equal(badBounds.replies.at(-1).status, 400);
  assert.equal(badBounds.replies.at(-1).payload.refused, "bounds-invalid");
  assert.deepEqual(badBounds.calls, [], "invalid bounds cannot reach reconfigureExtension");
});
