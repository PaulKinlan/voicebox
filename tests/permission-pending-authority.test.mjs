// Pending permission requests contain tool call arguments. A forged loopback Origin is not a read credential.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { startServer } from "./lib/server.mjs";

test("pending permission details require the host token or the room session token", async (t) => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "voicebox-pending-authority-"));
  let server;
  t.after(async () => {
    if (server) await server.stop();
    rmSync(cwd, { recursive: true, force: true });
  });
  server = await startServer({ cwd });
  const endpoint = `${server.base}/api/permissions/pending`;
  const html = await fetch(server.base).then((response) => response.text());
  const roomToken = /<meta name="voicebox-session-token" content="([0-9a-f]+)"/.exec(html)?.[1];
  assert.ok(roomToken, "the served page holds the in-room token");
  assert.ok(server.hostToken, "the test server minted a host token");

  for (const [name, headers] of [
    ["no credentials", {}],
    ["forged local Origin", { origin: server.base, "sec-fetch-site": "same-origin" }],
    ["cross-origin request", { origin: "https://attacker.example", "sec-fetch-site": "cross-site" }],
    ["wrong room token", { "x-voicebox-session-token": `${roomToken.slice(0, -1)}${roomToken.endsWith("0") ? "1" : "0"}` }],
    ["wrong host token", { "x-voicebox-host-token": "invalid" }],
  ]) {
    const response = await fetch(endpoint, { headers });
    const body = await response.json();
    assert.equal(response.status, 403, name);
    assert.equal(body.refused, "room-session-required", name);
    assert.equal(Object.hasOwn(body, "pending"), false, `${name}: no permission details are disclosed`);
  }

  for (const [name, headers] of [
    ["room token", { "x-voicebox-session-token": roomToken }],
    ["host token", { "x-voicebox-host-token": server.hostToken }],
  ]) {
    const response = await fetch(endpoint, { headers });
    assert.equal(response.status, 200, name);
    assert.deepEqual(await response.json(), { ok: true, pending: [] }, name);
  }

  // Resolution remains a host-only act; the room may read but cannot decide a permission.
  const resolve = await fetch(`${server.base}/api/permissions/resolve`, {
    method: "POST", headers: { "content-type": "application/json", "x-voicebox-session-token": roomToken },
    body: JSON.stringify({ requestId: "not-pending", allow: true }),
  });
  assert.equal(resolve.status, 403);
  assert.equal((await resolve.json()).refused, "host-token-required");
});
