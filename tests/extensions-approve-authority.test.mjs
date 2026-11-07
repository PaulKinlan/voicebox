// tests/extensions-approve-authority.test.mjs — voicebox-beads-93kz (TM-EXT-014).
//
//   node --test tests/extensions-approve-authority.test.mjs
//
// /api/extensions/approve ran approveInRoom whenever `hasExtensionAuthority(req)` — and one of that function's
// arms accepts a bare `Origin` in localPageOrigins(), a header any local process can write on a raw socket
// (docs/13 §1) and any same-origin page context can present. Admission INSTALLS an extension, and an installed
// extension interpolates $ENV_VAR at run time (voicebox-beads-izu7), so the claim reached machine credentials.
//
// Driven against the REAL server: the Origin-only door is refused by name and nothing is installed, while the
// room's own session token (the one served into the page) still admits in room, and a console code still works.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startServer } from "./lib/server.mjs";

async function roomSessionToken(base) {
  const html = await (await fetch(`${base}/`)).text();
  const match = /<meta name="voicebox-session-token" content="([0-9a-f]{8,})"/.exec(html);
  assert.ok(match, "the room's session token is no longer served in the page; this test's premise changed");
  return match[1];
}

async function withServer(fn) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "voicebox-93kz-"));
  const server = await startServer({ cwd: scratch, env: { VOICEBOX_WORKSPACE: scratch } });
  try {
    return await fn(server);
  } finally {
    await server.stop();
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

const approve = (base, headers, body = { id: "not-a-real-extension" }) =>
  fetch(`${base}/api/extensions/approve`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

test("an Origin claim alone cannot admit in room, and the refusal names the door (voicebox-beads-93kz)", async () => {
  await withServer(async (server) => {
    // Exactly the claim the finding describes: this server's own page origin, nothing else.
    const res = await approve(server.base, { origin: server.base });
    assert.equal(res.status, 403, `an Origin claim reached admission: ${await res.clone().text()}`);
    const body = await res.json();
    assert.equal(body.refused, "room-session-required");
    assert.match(body.why, /session token/);
    assert.match(body.why, /host token/);
    // A forged Origin that is not this server's page origin is refused too, for the same reason.
    const forged = await approve(server.base, { origin: "https://attacker.example" });
    assert.equal(forged.status, 403);
  });
});

test("the room's own session token still admits in room (positive control, voicebox-beads-93kz)", async () => {
  await withServer(async (server) => {
    const token = await roomSessionToken(server.base);
    const res = await approve(server.base, { "x-voicebox-session-token": token });
    // The id does not exist, so approveInRoom refuses — the POINT is that the request got past the door to the
    // in-room path at all, which the Origin-only request above did not.
    const body = await res.json();
    assert.notEqual(body.refused, "room-session-required", `the room's own token was refused: ${JSON.stringify(body)}`);
  });
});

test("a console code is still a door of its own: no room token needed (voicebox-beads-93kz)", async () => {
  await withServer(async (server) => {
    const res = await approve(server.base, {}, { id: "not-a-real-extension", code: "000000", requestId: "req-xyz" });
    const body = await res.json();
    assert.notEqual(body.refused, "room-session-required", "the code path was wrongly gated behind the room token");
  });
});
