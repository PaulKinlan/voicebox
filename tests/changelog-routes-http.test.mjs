import test from "node:test";
import assert from "node:assert/strict";
import { startServer } from "./lib/server.mjs";

test("exact changelog GET serves parsed git commits without capturing methods or adjacent health", async () => {
  const server = await startServer({ env: { VOICEBOX_LOOPBACK_AUTH: undefined } });
  try {
    const response = await fetch(server.base + "/api/changelog");
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.repo, "https://github.com/PaulKinlan/voicebox");
    assert.ok(body.commits.length > 0);
    assert.match(body.commits[0].url, /^https:\/\/github\.com\/PaulKinlan\/voicebox\/commit\/[0-9a-f]{40}$/);
    for (const [method, pathname] of [["GET", "/api/changelog-extra"], ["POST", "/api/changelog"]]) {
      assert.equal((await fetch(server.base + pathname, { method })).status, 404, `${method} ${pathname} must fall through`);
    }
    const head = await fetch(server.base + "/api/health", { method: "HEAD" });
    assert.equal(head.status, 200, "the following HEAD health handler remains reachable");
  } finally { await server.stop(); }
});

test("global loopback wall still runs before changelog GET", async () => {
  const server = await startServer({ env: { VOICEBOX_LOOPBACK_AUTH: "1" } });
  try {
    const response = await fetch(server.base + "/api/changelog");
    assert.equal(response.status, 401);
    assert.equal((await response.json()).refused, "loopback-unauthenticated");
    assert.equal((await fetch(server.base + "/api/health", { method: "HEAD" })).status, 200,
      "the health exception must remain open even when auth is enabled");
  } finally { await server.stop(); }
});
