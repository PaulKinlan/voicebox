import test from "node:test";
import assert from "node:assert/strict";
import { startServer } from "./lib/server.mjs";

// The table uses exact verb + pathname keys, not a path prefix. Drive the real server so an
// extracted GET cannot accidentally swallow contact, a near-prefix, or a different verb.
test("fleet GET dispatches at its old position; contact and near-prefix are not captured", async (t) => {
  const server = await startServer();
  t.after(() => server.stop());

  const get = await fetch(`${server.base}/api/fleet?environment=nonexistent`);
  assert.equal(get.status, 200);
  const payload = await get.json();
  assert.equal(payload.ok, true);
  assert.ok(Array.isArray(payload.fleet));

  const contact = await fetch(`${server.base}/api/fleet/contact`, {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}",
  });
  assert.equal(contact.status, 400);
  assert.equal((await contact.json()).refused, "bad-request");

  for (const [method, pathname] of [["GET", "/api/fleetX"], ["POST", "/api/fleet"]]) {
    const res = await fetch(`${server.base}${pathname}`, { method });
    assert.equal(res.status, 404, `${method} ${pathname} must not match GET /api/fleet`);
  }
});
