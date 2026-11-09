// Exec needs the host token; delegation accepts the room's session authority. Both check before reading bodies.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { startServer } from "./lib/server.mjs";

test("POST /api/exec requires the host token; /api/delegate accepts room authority before parsing", async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "voicebox-exec-authority-"));
  const server = await startServer({ env: { VOICEBOX_WORKSPACE: path.join(dir, "workspace") } });
  t.after(async () => {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  const post = async (route, body, headers = {}) => {
    const response = await fetch(`${server.base}${route}`, {
      method: "POST", headers, body,
    });
    return { status: response.status, body: await response.json() };
  };
  assert.ok(server.hostToken, "the fixture must mint a host token for the positive control");
  const hostHeaders = { "content-type": "application/json", "x-voicebox-host-token": server.hostToken };
  const root = await post("/api/root", JSON.stringify({ project: "authority-test", root: { kind: "machine", path: dir } }), hostHeaders);
  assert.equal(root.status, 200, JSON.stringify(root.body));

  const marker = path.join(dir, "executed");
  const command = `${process.execPath} -e 'require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ok")'`;
  const execBody = JSON.stringify({ command });
  for (const route of ["/api/exec", "/api/delegate"]) {
    const body = route === "/api/exec" ? execBody : JSON.stringify({ agent: "missing-agent", task: "should not run" });
    for (const headers of [
      { "content-type": "application/json" },
      { "content-type": "application/json", "x-voicebox-host-token": "invalid" },
      { "content-type": "application/json", origin: "https://attacker.example", "sec-fetch-site": "cross-site" },
    ]) {
      const refused = await post(route, body, headers);
      assert.equal(refused.status, 403, `${route}: ${JSON.stringify(refused.body)}`);
      assert.equal(refused.body.ok, false);
      assert.equal(refused.body.refused, "host-token-required");
    }
    const untyped = await post(route, "not json", { "content-type": "text/plain" });
    assert.equal(untyped.status, 403, `${route}: authority must precede JSON content-type validation`);
    assert.equal(untyped.body.refused, "host-token-required");
  }
  for (const origin of [server.base, server.base.replace("127.0.0.1", "localhost"), `http://[::1]:${server.port}`]) {
    const forgedOrigin = await post("/api/exec", execBody, {
      "content-type": "application/json", origin, "sec-fetch-site": "same-origin",
    });
    assert.equal(forgedOrigin.status, 403, `${origin}: a local Origin claim cannot grant host command authority`);
    assert.equal(forgedOrigin.body.refused, "host-token-required");
  }
  const page = await fetch(`${server.base}/`).then((response) => response.text());
  const sessionToken = page.match(/name="voicebox-session-token" content="([^"]+)"/)?.[1];
  assert.ok(sessionToken && sessionToken !== "__VOICEBOX_SESSION_TOKEN__", "page carries an in-room token");
  const roomExec = await post("/api/exec", execBody, {
    "content-type": "application/json", "x-voicebox-session-token": sessionToken,
  });
  assert.equal(roomExec.status, 403, "the readable room token cannot grant host command authority");
  assert.equal(roomExec.body.refused, "host-token-required");
  const combinedClaims = await post("/api/exec", execBody, {
    "content-type": "application/json", origin: server.base,
    "x-voicebox-session-token": sessionToken, "x-voicebox-host-token": "invalid",
  });
  assert.equal(combinedClaims.status, 403, "multiple public room claims cannot substitute for the host token");
  assert.equal(combinedClaims.body.refused, "host-token-required");
  assert.equal(existsSync(marker), false, "neither unauthorized nor forged-local command ran");

  const authorizedExec = await post("/api/exec", execBody, hostHeaders);
  assert.equal(authorizedExec.status, 200, JSON.stringify(authorizedExec.body));
  assert.equal(authorizedExec.body.ok, true);
  assert.equal(readFileSync(marker, "utf8"), "ok", "the same command executes with host authority");

  const authorizedDelegate = await post("/api/delegate", JSON.stringify({ agent: "missing-agent", task: "no-op" }), hostHeaders);
  assert.notEqual(authorizedDelegate.status, 403, "host token must pass the delegate authority check");
  assert.notEqual(authorizedDelegate.body.refused, "host-token-required");
  const inRoom = await post("/api/delegate", JSON.stringify({ agent: "missing-agent", task: "no-op" }), {
    "content-type": "application/json", "x-voicebox-session-token": sessionToken,
  });
  assert.notEqual(inRoom.status, 403, "room session must retain delegate authority");
  assert.notEqual(inRoom.body.refused, "host-token-required");
  const localOriginDelegate = await post("/api/delegate", JSON.stringify({ agent: "missing-agent", task: "no-op" }), {
    "content-type": "application/json", origin: server.base,
  });
  assert.notEqual(localOriginDelegate.status, 403, "delegation retains its current room-Origin entitlement");
  assert.notEqual(localOriginDelegate.body.refused, "host-token-required");
});
