import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { startServer } from "./lib/server.mjs";

test("activity exact HTTP routes share the host producer and clear in place", async () => {
  const scratch = mkdtempSync(path.join(os.tmpdir(), "vb-activity-route-"));
  const server = await startServer({ env: { VOICEBOX_LOOPBACK_AUTH: undefined } });
  try {
    const fetchActivity = async () => {
      const response = await fetch(server.base + "/api/activity");
      return { status: response.status, body: await response.json() };
    };
    const initial = await fetchActivity();
    assert.equal(initial.status, 200);
    assert.deepEqual(initial.body, { ok: true, entries: [] });
    const root = await fetch(server.base + "/api/root", {
      method: "POST",
      headers: { "content-type": "application/json", "x-voicebox-host-token": server.hostToken },
      body: JSON.stringify({ project: "activity-route-test", root: { kind: "machine", path: scratch } }),
    });
    assert.equal(root.status, 200, "the host producer must receive a real write");
    const populated = await fetchActivity();
    assert.ok(populated.body.entries.some((entry) => entry.kind === "project" && entry.detail === "activity-route-test"));
    const cleared = await fetch(server.base + "/api/activity", { method: "DELETE" });
    assert.equal(cleared.status, 200);
    assert.deepEqual(await cleared.json(), { ok: true, entries: [] });
    assert.deepEqual((await fetchActivity()).body, { ok: true, entries: [] });
    for (const [route, method] of [["/api/activity/", "GET"], ["/api/activity/", "DELETE"], ["/api/activity", "POST"]]) {
      const response = await fetch(server.base + route, { method });
      assert.equal(response.status, 404, `${method} ${route} must fall through`);
    }
  } finally { await server.stop(); rmSync(scratch, { recursive: true, force: true }); }
});

test("global loopback wall refuses both extracted activity routes before dispatch", async () => {
  const server = await startServer({ env: { VOICEBOX_LOOPBACK_AUTH: "1" } });
  try {
    for (const method of ["GET", "DELETE"]) {
      const response = await fetch(server.base + "/api/activity", { method });
      assert.equal(response.status, 401, `${method} must stay behind the host's wall`);
      assert.equal((await response.json()).refused, "loopback-unauthenticated");
    }
  } finally { await server.stop(); }
});
