import test from "node:test";
import assert from "node:assert/strict";
import { createExtensionRoutes } from "../lib/routes/extensions.mjs";

function fixture(body = {}) {
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
  };
  const routes = createExtensionRoutes({
    json: (_res, status, payload) => { replies.push({ status, payload }); },
    readJsonBody: async (_req, _res, maxBytes) => { caps.push(maxBytes); return body; },
    contentJsonBodyMaxBytes: 8 * 1024 * 1024,
    extensionRuntime: runtime,
  });
  const request = (method, pathname, headers = {}) => routes({ method, headers }, {}, new URL(`http://localhost${pathname}`));
  return { request, replies, caps, calls };
}

test("only the six inventory/staging route shapes are owned; host decisions fall through", async () => {
  const f = fixture();
  for (const [method, path] of [["POST", "/api/extensions/admit"], ["POST", "/api/extensions/approve"], ["DELETE", "/api/extensions/known"], ["GET", "/api/extensions/proposals/UPPER/plan"], ["GET", "/api/permissions/pending"]]) {
    assert.equal(await f.request(method, path), false, `${method} ${path} must remain with the host`);
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
