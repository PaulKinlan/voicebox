// tests/extensions-management-authority.test.mjs — voicebox-beads-nxpq (TM-EXT-014, the residual of 93kz).
//
//   node --test tests/extensions-management-authority.test.mjs
//
// 93kz drew the line at admission: an Origin header is a claim, not a credential, so /api/extensions/approve takes
// the room's own session token or the host token. The five OTHER management routes kept `hasExtensionAuthority`,
// whose third arm accepts a bare Origin — so anything that could write an Origin header on a raw socket could widen
// an admitted extension's network bounds, or revoke the extension entirely. Widening bounds is the interesting half:
// an extension's bounds are what the host enforces on its behalf.
//
// Driven against the REAL server, per route: an Origin claim is refused by name and nothing happens; the room's own
// session token (the one the page is served) gets past the door; the host token does too.
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
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "voicebox-nxpq-"));
  const server = await startServer({ cwd: scratch, env: { VOICEBOX_WORKSPACE: scratch } });
  try {
    return await fn(server, scratch);
  } finally {
    await server.stop();
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * The five management doors, each as a (method, path, body) a caller would use. The id is one no extension has, so a
 * request that gets PAST the door answers 404 extension-not-admitted — which is exactly how the positive arms below
 * prove the door opened without needing a live extension.
 */
const DOORS = [
  { what: "revoke (confirm-first)", method: "POST", path: "/api/extensions/revoke", body: { id: "ghost_ext" } },
  { what: "refuse", method: "POST", path: "/api/extensions/refuse", body: { id: "ghost_ext" } },
  { what: "refuse (REST)", method: "POST", path: "/api/extensions/ghost_ext/refuse", body: {} },
  { what: "DELETE", method: "DELETE", path: "/api/extensions/ghost_ext", body: undefined },
  { what: "reconfigure", method: "POST", path: "/api/extensions/reconfigure", body: { id: "ghost_ext", bounds: { maxRequests: 5000 }, confirm: true } },
  { what: "PATCH", method: "PATCH", path: "/api/extensions/ghost_ext", body: { bounds: { maxRequests: 5000 } } },
];

const call = (base, door, headers) =>
  fetch(`${base}${door.path}`, {
    method: door.method,
    headers: { ...(door.body ? { "content-type": "application/json" } : {}), ...headers },
    ...(door.body ? { body: JSON.stringify(door.body) } : {}),
  });

test("an Origin claim alone cannot revoke, refuse, reconfigure or PATCH an extension (voicebox-beads-nxpq)", async () => {
  await withServer(async (server) => {
    const token = await roomSessionToken(server.base);
    for (const door of DOORS) {
      // The claim: whatever a local process can write — the page's own origin, and a same-site one.
      for (const headers of [{ origin: server.base }, { origin: server.base, "sec-fetch-site": "same-origin" }]) {
        const refused = await call(server.base, door, headers);
        assert.equal(refused.status, 403, `${door.what} must not accept an Origin claim: ${JSON.stringify(headers)}`);
        const body = await refused.json();
        assert.equal(body.refused, "room-session-required", `${door.what} must refuse by name`);
        assert.match(body.why, /x-voicebox-session-token/, `${door.what} must name the credential it wants`);
      }
      // And the room's own token — the one the page is served — gets past the door. 404 is the door OPENING on an id
      // that does not exist; a 403 here would mean the page itself was locked out, which is the failure mode this arm
      // exists to catch.
      const admitted = await call(server.base, door, { "x-voicebox-session-token": token });
      assert.notEqual(admitted.status, 403, `${door.what} must admit the room's own session token, got ${admitted.status}`);
      // The host token is the other legitimate holder.
      const byHost = await call(server.base, door, { "x-voicebox-host-token": server.hostToken });
      assert.notEqual(byHost.status, 403, `${door.what} must admit the host token, got ${byHost.status}`);
    }
  });
});

test("a GUESSED session token is not the room's token (voicebox-beads-nxpq)", async () => {
  await withServer(async (server) => {
    const token = await roomSessionToken(server.base);
    const wrong = token.replace(/.$/, (c) => (c === "0" ? "1" : "0"));
    for (const door of DOORS) {
      const refused = await call(server.base, door, { "x-voicebox-session-token": wrong, origin: server.base });
      assert.equal(refused.status, 403, `${door.what} must refuse a token that is not this room's`);
      assert.equal((await refused.json()).refused, "room-session-required");
    }
  });
});
