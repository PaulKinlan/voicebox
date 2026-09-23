// tests/pairing-revocation.test.mjs — I3: Bearer revocation & authority cancellation (voicebox-beads-yo1).
//
// WHAT THIS FILE ASSERTS (driven end to end):
//   1. Authority can be revoked: DELETE /api/pair (gated by x-voicebox-host-token) revokes the pairing for an environment.
//   2. CURRENTLY OPEN connections are terminated immediately:
//      - The active /channel executor socket receives `pairing-revoked`, closes with WS 1008, and pageSocket is cleared.
//      - The active /live voice session receives `pairing-revoked`, closes with WS 1008, AND the underlying provider
//        session socket is closed (driven with loopback stub vendor redirect, proving the provider session ended).
//   3. Audit trail reporting:
//      - With no machine root declared: response reports `logged: null` and `logRefused: "root-not-declared"`.
//      - With a declared machine root: response reports `logged: <seq>` and an act entry is written to .audit/.
//   4. Subsequent connections presenting the revoked bearer are refused BY NAME:
//      - /channel hello refuses `pairing-revoked`
//      - /live hello refuses `pairing-revoked`
//      - POST /api/execute refuses `pairing-revoked`
//      - POST /api/call refuses `pairing-revoked`
//   5. Restart survival:
//      - A new server process on the same store continues to refuse the revoked bearer as `pairing-revoked`.
//      - An unknown bearer (never issued) refuses `bearer-refused`, preserving the distinct diagnosis across restarts.
//
//   node --test tests/pairing-revocation.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { startServer } from "./lib/server.mjs";
import { upgrade } from "../lib/ws-server.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VENDOR_REDIRECT = path.join(ROOT, "tests/fixtures/live-vendor-redirect.mjs");

async function scratchServer(options = {}) {
  const host = options.extensionsDir ?? mkdtempSync(path.join(tmpdir(), "vb-revocation-test-"));
  const extensions = path.join(host, "extensions");
  const started = await startServer({
    extensionsDir: extensions,
    env: {
      VOICEBOX_EXTENSIONS_DIR: extensions,
      ...options.env,
    },
  });
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

async function waitFor(predicate, { boundMs = 6000 } = {}) {
  const started = Date.now();
  while (!predicate() && Date.now() - started < boundMs) await new Promise((r) => setTimeout(r, 30));
  return predicate();
}

test("revoking a pairing immediately terminates active /channel and /live sockets, ends provider sessions, and blocks fresh calls", async () => {
  // ── Setup stub vendor for live session redirect ────────────────────────────
  const vendor = createServer();
  const vendorPeers = [];
  vendor.on("upgrade", (req, raw) => {
    const peer = upgrade(req, raw);
    vendorPeers.push(peer);
    peer.on("close", () => { peer.__closed = true; });
    peer.on("message", () => {});
  });
  await new Promise((resolve) => vendor.listen(0, "127.0.0.1", resolve));
  const vendorPort = vendor.address().port;

  const server = await scratchServer({
    env: {
      GEMINI_API_KEY: "synthetic-gemini-test-key",
      NODE_OPTIONS: `--import=${VENDOR_REDIRECT}`,
      FIXTURE_VENDOR: `ws://127.0.0.1:${vendorPort}`,
    },
  });

  try {
    const hostToken = server.hostToken();

    // Declare environment in registry
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

    // 3. Connect an active session socket on /live (dials stub vendor)
    const livePeer = openSocket(`${server.base.replace(/^http/, "ws")}/live`);
    await livePeer.opened;
    livePeer.ws.send(JSON.stringify({ type: "hello", bearer }));

    // Wait for /live to receive rate frame and connect to stub vendor
    const gotRate = await waitFor(() => livePeer.frames.some((f) => f.type === "rate"));
    const vendorConnected = await waitFor(() => vendorPeers.length > 0);
    assert.ok(gotRate, "live socket must receive rate frame");
    assert.ok(vendorConnected, "underlying provider session must dial the vendor");
    assert.equal(channelPeer.ws.readyState, WebSocket.OPEN, "executor socket must be admitted and open");
    assert.equal(livePeer.ws.readyState, WebSocket.OPEN, "live socket must be admitted and open");

    // 4. Verify authority over execute works
    const execBefore = await fetch(`${server.base}/api/execute`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${bearer}` },
      body: JSON.stringify({ envKey, tool: "unknown-tool", args: {} }),
    });
    const execBeforeData = await execBefore.json();
    assert.equal(execBeforeData.refused, "unknown-tool", "authenticated call reaches tool dispatcher");
    assert.notEqual(execBeforeData.refused, "pairing-revoked");

    // ── 5. REVOCATION: Host revokes the pairing (with no root declared) ────────
    // Refusal when token missing
    const unauthDelete = await fetch(`${server.base}/api/pair`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ envKey }),
    });
    assert.equal(unauthDelete.status, 403);
    assert.equal((await unauthDelete.json()).refused, "host-token-required");

    // Acceptance with host token (finding 1: reports logged: null and logRefused when root is not declared)
    const deleteRes = await fetch(`${server.base}/api/pair`, {
      method: "DELETE",
      headers: { "content-type": "application/json", "x-voicebox-host-token": hostToken },
      body: JSON.stringify({ envKey }),
    });
    assert.equal(deleteRes.status, 200);
    const deleteData = await deleteRes.json();
    assert.equal(deleteData.ok, true);
    assert.equal(deleteData.revoked, true);
    assert.equal(deleteData.logged, null, "finding 1: logged must be null when no root is declared");
    assert.equal(deleteData.logRefused, "root-not-declared", "finding 1: logRefused must state why logging was omitted");

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

    // Instrument requirement: verify the PROVIDER session ended, not just the door!
    const vendorClosed = await waitFor(() => vendorPeers.every((p) => p.__closed), { boundMs: 3000 });
    assert.ok(vendorClosed, "provider session itself must end when pairing is revoked");

    // ── 7. FRESH CONNECTIONS WITH REVOKED BEARER ──────────────────────────────
    const freshChannel = openSocket(`${server.base.replace(/^http/, "ws")}/channel`);
    await freshChannel.opened;
    freshChannel.ws.send(JSON.stringify({ type: "hello", role: "environment", bearer }));
    const freshChannelClose = await freshChannel.closed;
    assert.equal(freshChannelClose.code, 1008);
    assert.equal(freshChannelClose.reason, "pairing-revoked");
    assert.equal(freshChannel.frames.find((f) => f.type === "refused")?.refused, "pairing-revoked");

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
    vendor.close();
    server.cleanup();
  }
});

test("revocation writes to audit trail when a machine root is declared", async () => {
  const server = await scratchServer();
  const rootDir = mkdtempSync(path.join(tmpdir(), "vb-audit-root-"));
  try {
    const hostToken = server.hostToken();
    const envKey = "worker-beta";

    // 1. Declare machine root
    await fetch(`${server.base}/api/root`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-voicebox-host-token": hostToken },
      body: JSON.stringify({ project: "audit-test-project", root: { kind: "machine", path: rootDir } }),
    });

    // 2. Declare & pair environment
    await fetch(`${server.base}/api/environments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: "Worker Beta", kind: "server", origin: "http://127.0.0.1:9998" }),
    });
    await fetch(`${server.base}/api/pair`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-voicebox-host-token": hostToken },
      body: JSON.stringify({ envKey }),
    });

    // 3. Revoke pairing
    const deleteRes = await fetch(`${server.base}/api/pair`, {
      method: "DELETE",
      headers: { "content-type": "application/json", "x-voicebox-host-token": hostToken },
      body: JSON.stringify({ envKey }),
    });
    assert.equal(deleteRes.status, 200);
    const deleteData = await deleteRes.json();
    assert.equal(deleteData.ok, true);
    assert.equal(typeof deleteData.logged, "number", "finding 1: logged sequence number must be returned when root is declared");

    // 4. Verify audit file on disk carries the revocation act
    const auditDir = path.join(rootDir, ".audit");
    assert.ok(existsSync(auditDir), "audit directory must exist in declared root");
    const auditFiles = readdirSync(auditDir);
    assert.ok(auditFiles.length > 0, "audit file must exist");
    const auditContent = readFileSync(path.join(auditDir, auditFiles[0]), "utf8");
    const entries = auditContent.trim().split("\n").map(JSON.parse);
    const revokeEntry = entries.find((e) => e.act?.kind === "pairing" && e.act?.target === envKey);
    assert.ok(revokeEntry, "revocation entry must exist in audit log");
    assert.equal(revokeEntry.rule, "pairing-revoked");
    assert.equal(revokeEntry.result, "ok");
  } finally {
    await server.stop();
    rmSync(rootDir, { recursive: true, force: true });
    server.cleanup();
  }
});

test("revocation state survives server restart on the same store", async () => {
  const hostDir = mkdtempSync(path.join(tmpdir(), "vb-restart-host-"));
  const envKey = "worker-gamma";
  let bearer = null;
  let hostToken = null;

  // Process 1: Pair and then revoke
  {
    const server1 = await scratchServer({ extensionsDir: hostDir });
    hostToken = server1.hostToken();
    try {
      await fetch(`${server1.base}/api/environments`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label: "Worker Gamma", kind: "server", origin: "http://127.0.0.1:9997" }),
      });
      const pairData = await (await fetch(`${server1.base}/api/pair`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-voicebox-host-token": hostToken },
        body: JSON.stringify({ envKey }),
      })).json();
      bearer = pairData.bearer;

      // Revoke in process 1
      const del = await (await fetch(`${server1.base}/api/pair`, {
        method: "DELETE",
        headers: { "content-type": "application/json", "x-voicebox-host-token": hostToken },
        body: JSON.stringify({ envKey }),
      })).json();
      assert.equal(del.revoked, true);
    } finally {
      await server1.stop();
    }
  }

  // Process 2: Start NEW process on the SAME store
  {
    const server2 = await scratchServer({ extensionsDir: hostDir });
    try {
      // Connect to /channel with the revoked bearer
      const wsRevoked = openSocket(`${server2.base.replace(/^http/, "ws")}/channel`);
      await wsRevoked.opened;
      wsRevoked.ws.send(JSON.stringify({ type: "hello", role: "environment", bearer }));
      const closeRevoked = await wsRevoked.closed;
      assert.equal(closeRevoked.code, 1008);
      assert.equal(closeRevoked.reason, "pairing-revoked", "revoked bearer must still answer pairing-revoked after server restart");

      // Connect with stranger bearer
      const wsStranger = openSocket(`${server2.base.replace(/^http/, "ws")}/channel`);
      await wsStranger.opened;
      wsStranger.ws.send(JSON.stringify({ type: "hello", role: "environment", bearer: "vbx_stranger" }));
      const closeStranger = await wsStranger.closed;
      assert.equal(closeStranger.code, 1008);
      assert.equal(closeStranger.reason, "bearer-refused", "unknown bearer must still answer bearer-refused after server restart");
    } finally {
      await server2.stop();
      server2.cleanup();
    }
  }
});
