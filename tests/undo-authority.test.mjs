// POST /api/undo changes the machine root: an Origin claim alone cannot grant room authority.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { startServer } from "./lib/server.mjs";

test("direct undo refuses headerless, forged-Origin and guessed-token requests without consuming the undo stack", async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "voicebox-undo-authority-"));
  const server = await startServer({ env: { VOICEBOX_WORKSPACE: path.join(dir, "workspace") } });
  t.after(async () => {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  assert.ok(server.hostToken, "fixture must mint host token for the positive control");
  const declared = await fetch(`${server.base}/api/root`, {
    method: "POST", headers: { "content-type": "application/json", "x-voicebox-host-token": server.hostToken },
    body: JSON.stringify({ project: "undo-authority", root: { kind: "machine", path: dir } }),
  });
  assert.equal(declared.status, 200, await declared.text());
  const file = path.join(dir, "preserved.txt");
  const write = async (content) => {
    const response = await fetch(`${server.base}/api/file`, {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "preserved.txt", content }),
    });
    assert.equal(response.status, 200, await response.text());
  };
  const undo = async (headers = {}) => {
    const response = await fetch(`${server.base}/api/undo`, { method: "POST", headers });
    return { status: response.status, body: await response.json() };
  };
  await write("original");
  for (const headers of [
    {},
    { origin: server.base, "sec-fetch-site": "same-origin" },
    { origin: server.base.replace("127.0.0.1", "localhost") },
    { origin: server.base, "x-voicebox-session-token": "guessed" },
  ]) {
    const refused = await undo(headers);
    assert.equal(refused.status, 403, JSON.stringify(refused.body));
    assert.equal(refused.body.refused, "room-session-required");
    assert.equal(readFileSync(file, "utf8"), "original", "refusal must not undo the write");
  }
  const pending = await fetch(`${server.base}/api/undo`).then((response) => response.json());
  assert.equal(pending.canUndo, true, "refused requests did not consume the undo stack");
  const html = await fetch(`${server.base}/`).then((response) => response.text());
  const roomToken = html.match(/name="voicebox-session-token" content="([^"]+)"/)?.[1];
  assert.ok(roomToken && roomToken !== "__VOICEBOX_SESSION_TOKEN__");
  const room = await undo({ origin: server.base, "x-voicebox-session-token": roomToken });
  assert.equal(room.status, 200, JSON.stringify(room.body));
  assert.equal(room.body.ok, true);
  assert.equal(existsSync(file), false, "the authorized room request undid the write");
  await write("host-created");
  const host = await undo({ "x-voicebox-host-token": server.hostToken });
  assert.equal(host.status, 200, JSON.stringify(host.body));
  assert.equal(host.body.ok, true);
  assert.equal(existsSync(file), false, "the authorized host request undid its write");
});
