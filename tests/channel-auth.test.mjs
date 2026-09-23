// tests/channel-auth.test.mjs — /channel executor authentication & entitlement gate.
//
// THE DEFECT, demonstrated: /channel previously accepted any incoming WebSocket connection without
// checking Origin or requiring any credentials. An untrusted webpage (via Cross-Site WebSocket Hijacking)
// or local process could connect to /channel, become `pageSocket`, intercept routed file operations for
// page-owned roots (OPFS or picked folders), and forge "ok" answers with `via: "page"`.
//
// WHAT THIS FILE ASSERTS:
//   1. An unauthenticated peer (foreign origin, e.g. http://evil.com, or no credentials) is refused by name
//      ("executor-unauthenticated"), closed with WS 1008, and NEVER assigned as pageSocket.
//   2. A peer presenting an unissued/fake bearer is refused by name ("bearer-refused") and closed with WS 1008.
//   3. A peer that remains silent on an untrusted origin times out and is refused ("executor-unauthenticated").
//   4. A paired peer presenting a valid pairing bearer (issued via POST /api/pair with the host token) is
//      admitted, becomes the executor, and can answer routed acts.
//   5. The local page (Origin matching the server's served origin) is admitted without credentials.
//
//   node --test tests/channel-auth.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { startServer } from "./lib/server.mjs";

async function scratchServer() {
  const host = mkdtempSync(path.join(tmpdir(), "vb-channel-auth-"));
  const extensions = path.join(host, "extensions");
  const started = await startServer({ env: { VOICEBOX_EXTENSIONS_DIR: extensions } });
  return {
    ...started,
    extensions,
    hostToken: () => readFileSync(path.join(extensions, ".host-token"), "utf8").trim(),
    cleanup: () => rmSync(host, { recursive: true, force: true }),
  };
}

function openChannel(base, { origin = null } = {}) {
  const ws = origin
    ? new WebSocket(`${base.replace(/^http/, "ws")}/channel`, { headers: { origin } })
    : new WebSocket(`${base.replace(/^http/, "ws")}/channel`);
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
  while (!(await predicate()) && Date.now() - started < boundMs) await new Promise((r) => setTimeout(r, 30));
  return await predicate();
}

async function executorConnected(base) {
  const res = await fetch(`${base}/api/root`);
  const body = await res.json();
  return body.executor?.connected ?? false;
}

test("an unauthenticated peer on a foreign origin is REFUSED by name and cannot become executor", async () => {
  const server = await scratchServer();
  try {
    const peer = openChannel(server.base, { origin: "http://evil.com" });
    await peer.opened;
    peer.ws.send(JSON.stringify({ type: "hello", role: "rogue-executor" }));

    const closeEv = await peer.closed;
    assert.equal(closeEv.code, 1008, "unauthenticated peer must be closed with WS 1008");
    assert.equal(closeEv.reason, "executor-unauthenticated", "close reason must name the refusal");

    const refusalFrame = peer.frames.find((f) => f.type === "refused");
    assert.ok(refusalFrame, `refusal frame must be delivered before close: ${JSON.stringify(peer.frames)}`);
    assert.equal(refusalFrame.refused, "executor-unauthenticated");
    assert.match(refusalFrame.why, /this connection did not present the executor entitlement/);

    // Assert the rogue connection never registered as executor
    assert.equal(await executorConnected(server.base), false, "refused connection must not become executor");
  } finally {
    await server.stop();
    server.cleanup();
  }
});

test("a hello carrying an unknown bearer is REFUSED by name and rejected", async () => {
  const server = await scratchServer();
  try {
    const peer = openChannel(server.base, { origin: "http://untrusted.internal" });
    await peer.opened;
    peer.ws.send(JSON.stringify({ type: "hello", role: "environment", bearer: "vbx_not-a-valid-bearer" }));

    const closeEv = await peer.closed;
    assert.equal(closeEv.code, 1008, "invalid bearer must be closed with WS 1008");
    assert.equal(closeEv.reason, "bearer-refused", "close reason must name bearer-refused");

    const refusalFrame = peer.frames.find((f) => f.type === "refused");
    assert.ok(refusalFrame, "refusal frame must be received");
    assert.equal(refusalFrame.refused, "bearer-refused");
    assert.match(refusalFrame.why, /that bearer is not one this host issued/);
    assert.equal(await executorConnected(server.base), false);
  } finally {
    await server.stop();
    server.cleanup();
  }
});

test("a paired peer with a valid pairing bearer IS ADMITTED as executor and can answer routed acts", async () => {
  const server = await scratchServer();
  try {
    // 1. Issue a pairing bearer using the host token
    const pairRes = await fetch(`${server.base}/api/pair`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-voicebox-host-token": server.hostToken() },
      body: JSON.stringify({ envKey: "paired-remote-env" }),
    });
    const pairData = await pairRes.json();
    assert.equal(pairData.ok, true);
    assert.match(pairData.bearer, /^vbx_/);

    // 2. Connect from non-local origin presenting the pairing bearer
    const peer = openChannel(server.base, { origin: "http://paired-remote.internal:9000" });
    await peer.opened;

    peer.ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.tool === "write") {
          peer.ws.send(JSON.stringify({
            v: 1,
            callId: msg.callId,
            ok: true,
            observed: { name: msg.args.name, bytes: 12, content: msg.args.content },
          }));
        }
      } catch {}
    };

    peer.ws.send(JSON.stringify({ type: "hello", role: "environment", bearer: pairData.bearer }));

    // Wait for registration
    const admitted = await waitFor(async () => await executorConnected(server.base), { boundMs: 2000 });
    assert.ok(admitted, "paired peer must be admitted as the connected executor");

    // 3. Declare a page root and perform an act
    const declRes = await fetch(`${server.base}/api/root`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-voicebox-host-token": server.hostToken() },
      body: JSON.stringify({ project: "test-proj", root: { kind: "opfs", project: "test-proj" } }),
    });
    assert.equal((await declRes.json()).ok, true);

    const turnRes = await fetch(`${server.base}/api/turn`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ transcript: "create doc.txt with hello" }),
    });
    const turnBody = await turnRes.json();
    assert.equal(turnBody.result?.ok, true);
    assert.equal(turnBody.result?.via, "page");
    assert.equal(turnBody.result?.observed?.name, "doc.txt");

    peer.ws.close();
  } finally {
    await server.stop();
    server.cleanup();
  }
});

test("the local page is entitled by origin without needing a bearer", async () => {
  const server = await scratchServer();
  try {
    const peer = openChannel(server.base, { origin: server.base });
    await peer.opened;

    const admitted = await waitFor(async () => await executorConnected(server.base), { boundMs: 2000 });
    assert.ok(admitted, "local page origin must be admitted immediately without credentials");
    assert.equal(peer.frames.some((f) => f.type === "refused"), false, "local page must not be refused");

    peer.ws.close();
  } finally {
    await server.stop();
    server.cleanup();
  }
});

test("a silent connection on an untrusted origin times out and is refused", async () => {
  const host = mkdtempSync(path.join(tmpdir(), "vb-channel-auth-"));
  const extensions = path.join(host, "extensions");
  const server = await startServer({
    env: {
      VOICEBOX_EXTENSIONS_DIR: extensions,
      VOICEBOX_HELLO_BOUND_MS: "150",
    },
  });
  try {
    const peer = openChannel(server.base, { origin: "http://silent-peer.internal" });
    await peer.opened;

    const closeEv = await peer.closed;
    assert.equal(closeEv.code, 1008);
    assert.equal(closeEv.reason, "executor-unauthenticated");

    const refusal = peer.frames.find((f) => f.type === "refused");
    assert.ok(refusal);
    assert.equal(refusal.refused, "executor-unauthenticated");
    assert.match(refusal.why, /nothing arrived within 150ms/);
  } finally {
    await server.stop();
    rmSync(host, { recursive: true, force: true });
  }
});

test("refused rogue connection cannot intercept routed acts or spoof file writes", async () => {
  const server = await scratchServer();
  try {
    // 1. Rogue client on foreign origin attempts to hijack /channel
    const rogue = openChannel(server.base, { origin: "http://evil.com" });
    await rogue.opened;
    rogue.ws.send(JSON.stringify({ type: "hello", role: "evil-executor" }));

    // Verify rogue client is refused and disconnected
    const closeEv = await rogue.closed;
    assert.equal(closeEv.code, 1008);

    // 2. Declare an OPFS page-owned root
    await fetch(`${server.base}/api/root`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-voicebox-host-token": server.hostToken() },
      body: JSON.stringify({ project: "secure-opfs", root: { kind: "opfs", project: "secure-opfs" } }),
    });

    // 3. Attempt a turn that writes to the OPFS root
    const turnRes = await fetch(`${server.base}/api/turn`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ transcript: "create private.txt with secret" }),
    });
    const turnBody = await turnRes.json();

    // Must answer no-page (absence of executor), NOT success
    assert.equal(turnBody.result?.ok, false);
    assert.equal(turnBody.result?.refused, "no-page");
    assert.match(turnBody.result?.why, /no page is connected/);
    assert.equal(rogue.frames.filter((f) => f.tool === "write").length, 0, "rogue client must NEVER receive routed acts");
  } finally {
    await server.stop();
    server.cleanup();
  }
});
