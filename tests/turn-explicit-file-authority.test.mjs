// An explicit action skips transcript resolution: file mutations need a host or room-session credential.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { startServer } from "./lib/server.mjs";

test("explicit /api/turn file changes refuse headerless and forged-Origin callers, but accept room and host tokens", async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "voicebox-turn-file-auth-"));
  const server = await startServer({ env: { VOICEBOX_WORKSPACE: path.join(dir, "workspace"), VOICEBOX_RESOLVER: "script" } });
  t.after(async () => {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  assert.ok(server.hostToken, "fixture must mint a host token");
  const post = async (payload, headers = {}) => {
    const response = await fetch(`${server.base}/api/turn`, {
      method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(payload),
    });
    return { status: response.status, body: await response.json() };
  };
  const root = await fetch(`${server.base}/api/root`, {
    method: "POST", headers: { "content-type": "application/json", "x-voicebox-host-token": server.hostToken },
    body: JSON.stringify({ project: "turn-file-authority", root: { kind: "machine", path: dir } }),
  });
  assert.equal(root.status, 200, await root.text());
  const page = await fetch(`${server.base}/`).then((response) => response.text());
  const sessionToken = page.match(/name="voicebox-session-token" content="([^"]+)"/)?.[1];
  assert.ok(sessionToken && sessionToken !== "__VOICEBOX_SESSION_TOKEN__", "room token must exist for positive control");
  const room = { "x-voicebox-session-token": sessionToken };
  const host = { "x-voicebox-host-token": server.hostToken };
  const file = path.join(dir, "explicit.txt");
  const write = { action: { verb: "write", name: "explicit.txt", content: "original" } };
  for (const headers of [{}, { origin: server.base, "sec-fetch-site": "same-origin" }, { "x-voicebox-session-token": "invalid" }]) {
    const denied = await post(write, headers);
    assert.equal(denied.status, 403, JSON.stringify(denied.body));
    assert.equal(denied.body.refused, "room-session-required");
    assert.equal(existsSync(file), false, "denied write must not create the file");
  }
  const roomWrite = await post(write, room);
  assert.equal(roomWrite.status, 200, JSON.stringify(roomWrite.body));
  assert.equal(roomWrite.body.result?.ok, true);
  assert.equal(readFileSync(file, "utf8"), "original");

  const edit = { action: { verb: "edit", name: "explicit.txt", oldText: "original", newText: "updated" } };
  const refusedEdit = await post(edit, { origin: server.base });
  assert.equal(refusedEdit.status, 403);
  assert.equal(readFileSync(file, "utf8"), "original", "denied edit preserved contents");
  const hostEdit = await post(edit, host);
  assert.equal(hostEdit.status, 200, JSON.stringify(hostEdit.body));
  assert.equal(hostEdit.body.result?.ok, true);
  assert.equal(readFileSync(file, "utf8"), "updated");

  const remove = { action: { verb: "delete", name: "explicit.txt" } };
  const refusedDelete = await post(remove);
  assert.equal(refusedDelete.status, 403);
  assert.equal(existsSync(file), true, "denied delete left the file intact");
  const roomDelete = await post(remove, room);
  assert.equal(roomDelete.status, 200, JSON.stringify(roomDelete.body));
  assert.equal(roomDelete.body.result?.ok, true);
  assert.equal(existsSync(file), false);

  // The page posts transcripts, not explicit actions, and its room-token request still writes.
  const roomTurn = await post({ transcript: "create a file called room-turn.txt with hello" }, room);
  assert.equal(roomTurn.status, 200, JSON.stringify(roomTurn.body));
  assert.equal(roomTurn.body.result?.ok, true);
  const roomFile = path.join(dir, "room-turn.txt");
  assert.equal(readFileSync(roomFile, "utf8"), "hello");
  const refusedUndo = await post({ action: { verb: "undo" } }, { origin: server.base });
  assert.equal(refusedUndo.status, 403, "explicit undo also changes files and needs a credential");
  assert.equal(existsSync(roomFile), true, "denied undo must not alter the last file mutation");
  const roomUndo = await post({ action: { verb: "undo" } }, room);
  assert.equal(roomUndo.status, 200, JSON.stringify(roomUndo.body));
  assert.equal(roomUndo.body.result?.ok, true);
  assert.equal(existsSync(roomFile), false);
});
