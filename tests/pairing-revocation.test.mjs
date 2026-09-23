// tests/pairing-revocation.test.mjs — I3: Bearer revocation & authority cancellation (voicebox-beads-yo1).
//
// WHAT THIS FILE ASSERTS (driven end to end):
//   1. Authority can be revoked: DELETE /api/pair (gated by x-voicebox-host-token) revokes the pairing for an environment.
//   2. CURRENTLY OPEN connections are terminated immediately:
//      - The active /channel executor socket receives `pairing-revoked`, closes with WS 1008, and pageSocket is cleared.
//      - The active /live voice session receives `pairing-revoked`, closes with WS 1008, and session is closed.
//   3. Subsequent connections presenting the revoked bearer are refused BY NAME:
//      - /channel hello refuses `pairing-revoked`
//      - /live hello refuses `pairing-revoked`
//      - POST /api/execute refuses `pairing-revoked`
//      - POST /api/call refuses `pairing-revoked`
//   4. Distinction preserved: An unknown bearer (never issued) refuses `bearer-refused`, not `pairing-revoked`.
//
//   node --test tests/pairing-revocation.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { startServer } from "./lib/server.mjs";

async function scratchServer() {
  const host = mkdtempSync(path.join(tmpdir(), "vb-revocation-test-"));
  const extensions = path.join(host, "extensions");
  const started = await startServer({ env: { VOICEBOX_EXTENSIONS_DIR: extensions } });
  return {
    ...started,
    extensions,
    hostToken: () => readFileSync(path.join(extensions, ".host-token"), "utf8").trim(),
    cleanup: () => rmSync(host, { recursive: true, force: true }),
  };
}

function openSocket(url, { origin = "http://remote-env.internal:9000" } = {}) {
  const ws = new WebSocket(url, { headers: { origin } });
  const frames = [];
  ws.onmessage = (e) => {
    try {
      frames.push(typeof e.data === "string" ? JSON.parse(e.data) : e.data);
    } catch {
      frames.push({ unparsed: e.data });
    }
  };
  const opened = new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });
  const closed = new Promise((res) => {
    ws.onclose = res;
  });
  return { ws, frames, opened, closed };
}

test("revoking a pairing immediately terminates active /channel and /live sockets, and blocks fresh calls", async () => {
  const server = await scratchServer();
  try {
    const hostToken = server.hostToken();

    // Declare environment in registry so it is known
    const declRes = await fetch(`${server.base}/api/environments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: "Worker Alpha", kind: "server", origin: "http://127.0.0.1:9999" }),
    });
    const declData = await declRes.json();
    assert.equal(declData.ok, true);
    const envKey = declData.environment.key;

    // 1. Pair the environment
    const pairRes = await fetch(`${server.base}/api/pair`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-voicebox-host-token": hostToken },
      body: JSON.stringify({ envKey }),
    });
    const pairData = await pairRes.json();
    assert.equal(pairData.ok, true);
    const bearer = pairData.bearer;
    assert.match(bearer, /^vbx_/);

    // 2. Connect an active executor socket on /channel
    const channelPeer = openSocket(`${server.base.replace(/^http/, "ws")}/channel`);
    await channelPeer.opened;
    channelPeer.ws.send(JSON.stringify({ type: "hello", role: "environment", bearer }));

    // 3. Connect an active session socket on /live
    const livePeer = openSocket(`${server.base.replace(/^http/, "ws")}/live`);
    await livePeer.opened;
    livePeer.ws.send(JSON.stringify({ type: "hello", bearer }));

    // Wait for both to be admitted and registered
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(channelPeer.ws.readyState, WebSocket.OPEN, "executor socket must be admitted and open");
    assert.equal(livePeer.ws.readyState, WebSocket.OPEN, "live socket must be admitted and open");

    // 4. Verify authority over execute works (authenticated caller reaches tool execution)
    const execBefore = await fetch(`${server.base}/api/execute`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${bearer}` },
      body: JSON.stringify({ envKey, tool: "unknown-tool", args: {} }),
    });
    const execBeforeData = await execBefore.json();
    assert.equal(execBeforeData.refused, "unknown-tool", "authenticated call reaches tool dispatcher, not auth refusal");
    assert.notEqual(execBeforeData.refused, "unauthenticated-call");
    assert.notEqual(execBeforeData.refused, "pairing-revoked");

    // ── 5. REVOCATION: Host revokes the pairing ───────────────────────────────
    // Without token: refused
    const unauthDelete = await fetch(`${server.base}/api/pair`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ envKey }),
    });
    assert.equal(unauthDelete.status, 403);
    assert.equal((await unauthDelete.json()).refused, "host-token-required");

    // With host token: accepted
    const deleteRes = await fetch(`${server.base}/api/pair`, {
      method: "DELETE",
      headers: { "content-type": "application/json", "x-voicebox-host-token": hostToken },
      body: JSON.stringify({ envKey }),
    });
    assert.equal(deleteRes.status, 200);
    const deleteData = await deleteRes.json();
    assert.equal(deleteData.ok, true);
    assert.equal(deleteData.revoked, true);

    // ── 6. EXISTING CONNECTIONS OBSERVED FIRST ────────────────────────────────
    // The active /channel executor socket MUST be terminated immediately
    const channelClose = await channelPeer.closed;
    assert.equal(channelClose.code, 1008, "/channel socket must be closed with WS 1008");
    assert.equal(channelClose.reason, "pairing-revoked");
    assert.ok(channelPeer.frames.some((f) => f.refused === "pairing-revoked"), "refusal frame must be delivered to executor socket");

    // The active /live session socket MUST be terminated immediately
    const liveClose = await livePeer.closed;
    assert.equal(liveClose.code, 1008, "/live socket must be closed with WS 1008");
    assert.equal(liveClose.reason, "pairing-revoked");
    assert.ok(livePeer.frames.some((f) => f.refused === "pairing-revoked"), "refusal frame must be delivered to live socket");

    // ── 7. FRESH CONNECTIONS WITH REVOKED BEARER ──────────────────────────────
    // Fresh /channel connection: refused pairing-revoked
    const freshChannel = openSocket(`${server.base.replace(/^http/, "ws")}/channel`);
    await freshChannel.opened;
    freshChannel.ws.send(JSON.stringify({ type: "hello", role: "environment", bearer }));
    const freshChannelClose = await freshChannel.closed;
    assert.equal(freshChannelClose.code, 1008);
    assert.equal(freshChannelClose.reason, "pairing-revoked");
    assert.equal(freshChannel.frames.find((f) => f.type === "refused")?.refused, "pairing-revoked");

    // Fresh /live connection: refused pairing-revoked
    const freshLive = openSocket(`${server.base.replace(/^http/, "ws")}/live`);
    await freshLive.opened;
    freshLive.ws.send(JSON.stringify({ type: "hello", bearer }));
    const freshLiveClose = await freshLive.closed;
    assert.equal(freshLiveClose.code, 1008);
    assert.equal(freshLiveClose.reason, "pairing-revoked");
    assert.equal(freshLive.frames.find((f) => f.type === "refused")?.refused, "pairing-revoked");

    // Fresh POST /api/execute with revoked bearer: HTTP 403 pairing-revoked
    const execAfter = await fetch(`${server.base}/api/execute`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${bearer}` },
      body: JSON.stringify({ envKey, tool: "unknown-tool", args: {} }),
    });
    assert.equal(execAfter.status, 403);
    const execAfterData = await execAfter.json();
    assert.equal(execAfterData.refused, "pairing-revoked");

    // Fresh POST /api/call for revoked environment: HTTP 403 pairing-revoked
    const callAfter = await fetch(`${server.base}/api/call`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ envKey, tool: "now", args: {} }),
    });
    assert.equal(callAfter.status, 403);
    const callAfterData = await callAfter.json();
    assert.equal(callAfterData.refused, "pairing-revoked");
    assert.match(callAfterData.why, /was revoked/);

    // ── 8. RE-PAIRING ISSUES A FRESH BEARER, OLD BEARER REMAINS REVOKED ─────
    const rePairRes = await fetch(`${server.base}/api/pair`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-voicebox-host-token": hostToken },
      body: JSON.stringify({ envKey }),
    });
    const rePairData = await rePairRes.json();
    assert.equal(rePairData.ok, true);
    const freshBearer = rePairData.bearer;
    assert.notEqual(freshBearer, bearer);

    // Fresh bearer connects to /channel
    const reConnectedChannel = openSocket(`${server.base.replace(/^http/, "ws")}/channel`);
    await reConnectedChannel.opened;
    reConnectedChannel.ws.send(JSON.stringify({ type: "hello", role: "environment", bearer: freshBearer }));
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(reConnectedChannel.ws.readyState, WebSocket.OPEN, "new bearer is admitted after re-pairing");
    reConnectedChannel.ws.close();

    // Old bearer is STILL refused as pairing-revoked!
    const oldBearerLive = openSocket(`${server.base.replace(/^http/, "ws")}/live`);
    await oldBearerLive.opened;
    oldBearerLive.ws.send(JSON.stringify({ type: "hello", bearer }));
    const oldClose = await oldBearerLive.closed;
    assert.equal(oldClose.code, 1008);
    assert.equal(oldClose.reason, "pairing-revoked", "historical revoked bearer must still refuse pairing-revoked");

    // ── 9. UNKNOWN BEARER DISTINCTION (NEGATIVE CONTROL) ──────────────────────
    const strangerLive = openSocket(`${server.base.replace(/^http/, "ws")}/live`);
    await strangerLive.opened;
    strangerLive.ws.send(JSON.stringify({ type: "hello", bearer: "vbx_never-issued-stranger-token" }));
    const strangerClose = await strangerLive.closed;
    assert.equal(strangerClose.code, 1008);
    assert.equal(strangerClose.reason, "bearer-refused", "unknown bearer must be refused as bearer-refused, NOT pairing-revoked");
  } finally {
    await server.stop();
    server.cleanup();
  }
});
