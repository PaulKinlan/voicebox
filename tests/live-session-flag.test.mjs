// A FLAG THAT OUTLIVED ITS FACT: `runningSession` used to be set when a live session started and never
// cleared, so /api/health reported `running: true` for the life of the process after the first session —
// with nobody attached — and the settings endpoint told a person their change was deferred to a session
// they did not have.
//
// THE INSTRUMENT: a real server, the real /live route, the real provider code, and a local vendor socket
// (tests/fixtures/live-vendor-redirect.mjs) so no vendor is dialled. A session is started by opening the
// socket, then the socket is CLOSED — which is the moment the flag must stop being true.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { startServer } from "./lib/server.mjs";
import { upgrade } from "../lib/ws-server.mjs";

// WHY THIS EXISTS (found the hard way): a mutation run of this file HUNG instead of failing. The mutation
// made an assertion fail, the failure ran the teardown, and the teardown awaited `vendor.close()` while a
// live socket was still attached — so the test never reported. A mutation has THREE outcomes, not two:
// RED (the check works), GREEN (the check is weak), and HUNG (the INSTRUMENT is broken). A hung run tells
// you nothing about the code and everything about the test, so every socket a test opens is closed before
// the server is stopped, and no teardown waits on a peer that may never leave.
function trackSockets(t) {
  const open = new Set();
  t.after(async () => {
    for (const ws of open) { try { ws.close(); } catch { /* already gone */ } }
    await sleep(50);
  });
  return (ws) => { open.add(ws); ws.addEventListener("close", () => open.delete(ws)); return ws; };
}

async function until(check, label, ms = 8000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { const r = await check(); if (r) return r; await sleep(25); }
  assert.fail(`No ${label} within ${ms}ms`);
}

test("health stops reporting a live session once the socket that started it is gone", async (t) => {
  const scratch = mkdtempSync(path.join(os.tmpdir(), "vb-runflag-"));
  const workspace = path.join(scratch, "workspace");
  const host = path.join(scratch, "host");
  mkdirSync(workspace); mkdirSync(host);

  // The vendor, redirected: accept the upgrade and hold it. Nothing authenticated is claimed — the point
  // of this test is the HOST's own state, not what a vendor said.
  const vendor = createServer();
  const vendorPeers = new Set();
  vendor.on("upgrade", (req, raw) => { const peer = upgrade(req, raw); vendorPeers.add(peer); peer.on("close", () => vendorPeers.delete(peer)); });
  await new Promise((resolve) => vendor.listen(0, "127.0.0.1", resolve));

  let server;
  t.after(async () => {
    if (server?.child.exitCode === null && server.child.signalCode === null) {
      const exited = once(server.child, "exit"); await server.stop(); await exited;
    }
    for (const peer of vendorPeers) { try { peer.close(); } catch { /* already gone */ } }
    vendor.closeAllConnections?.();
    await new Promise((resolve) => vendor.close(resolve));
    rmSync(scratch, { recursive: true, force: true });
  });

  server = await startServer({ env: {
    VOICEBOX_WORKSPACE: workspace,
    VOICEBOX_EXTENSIONS_DIR: host,
    VOICEBOX_RESOLVER: "script",
    GEMINI_API_KEY: "synthetic-fixture-only",
    OPENAI_API_KEY: "synthetic-fixture-only",
    NODE_OPTIONS: `--import=${fileURLToPath(new URL("./fixtures/live-vendor-redirect.mjs", import.meta.url))}`,
    FIXTURE_VENDOR: `ws://127.0.0.1:${vendor.address().port}`,
  } });

  const health = async () => (await fetch(`${server.base}/api/health`)).json();

  // NOTHING HAS RUN YET — the state a person meets on a fresh process.
  const before = await health();
  assert.equal(before.live.created, 0, "a fresh process has created no session");
  assert.equal(before.live.running, false, "a fresh process reports no running session");

  // A session, started the way the page starts one: a socket that claims this server's own origin.
  const ws = trackSockets(t)(new WebSocket(`${server.base.replace("http:", "ws:")}/live`, { headers: { origin: server.base } }));
  const frames = [];
  ws.addEventListener("message", (e) => { if (typeof e.data === "string") frames.push(JSON.parse(e.data)); });
  await until(async () => (await health()).live.created === 1, "a created session");

  const during = await health();
  assert.equal(during.live.running, true, "with a live socket attached, running must be true");

  // AND THE MOMENT THAT MATTERS: the socket goes away.
  const closed = once(ws, "close");
  ws.close();
  await closed;

  const after = await until(async () => {
    const h = await health();
    return h.live.running === false ? h : null;
  }, "health to stop reporting a running session after the socket closed");
  assert.equal(after.live.created, 1, "the count of what was created must not be rewritten — spend happened");

  // THE OTHER SURFACE THAT LIED: changing the provider told a person a running session would keep its
  // provider, when no session was running. With none running there is nothing for the change to wait on.
  const res = await fetch(`${server.base}/api/agent-settings`, {
    method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: "openai" }),
  });
  const payload = await res.json();
  assert.equal(payload.requested.provider, "openai", "the change itself must still be stored");
  assert.equal(payload.runningSession, null, "the payload still carries a session that is over");
  assert.doesNotMatch(payload.note ?? "", /already running/, `the note still claims a running session: ${payload.note}`);
  assert.match(payload.note ?? "", /no live session is running/, `the note should say what is true instead: ${payload.note}`);
});

// TWO PEERS, ONE CLOSE: the guard must clear only the session its own socket owned. Without it, the first
// peer to leave reports the second as gone — the same lie as the flag never clearing, told the other way.
test("closing one of two live sockets does not report the other as finished", async (t) => {
  const scratch = mkdtempSync(path.join(os.tmpdir(), "vb-runflag-two-"));
  const workspace = path.join(scratch, "workspace");
  const host = path.join(scratch, "host");
  mkdirSync(workspace); mkdirSync(host);
  const vendor = createServer();
  const vendorPeers = new Set();
  vendor.on("upgrade", (req, raw) => { const peer = upgrade(req, raw); vendorPeers.add(peer); peer.on("close", () => vendorPeers.delete(peer)); });
  await new Promise((resolve) => vendor.listen(0, "127.0.0.1", resolve));
  let server;
  t.after(async () => {
    if (server?.child.exitCode === null && server.child.signalCode === null) {
      const exited = once(server.child, "exit"); await server.stop(); await exited;
    }
    for (const peer of vendorPeers) { try { peer.close(); } catch { /* already gone */ } }
    vendor.closeAllConnections?.();
    await new Promise((resolve) => vendor.close(resolve));
    rmSync(scratch, { recursive: true, force: true });
  });
  server = await startServer({ env: {
    VOICEBOX_WORKSPACE: workspace, VOICEBOX_EXTENSIONS_DIR: host, VOICEBOX_RESOLVER: "script",
    GEMINI_API_KEY: "synthetic-fixture-only", OPENAI_API_KEY: "synthetic-fixture-only",
    NODE_OPTIONS: `--import=${fileURLToPath(new URL("./fixtures/live-vendor-redirect.mjs", import.meta.url))}`,
    FIXTURE_VENDOR: `ws://127.0.0.1:${vendor.address().port}`,
  } });
  const health = async () => (await fetch(`${server.base}/api/health`)).json();
  const track = trackSockets(t);
  const open = () => track(new WebSocket(`${server.base.replace("http:", "ws:")}/live`, { headers: { origin: server.base } }));

  const first = open();
  await until(async () => (await health()).live.created === 1, "the first session");
  const second = open();
  await until(async () => (await health()).live.created === 2, "the second session");

  // While a session IS running, the settings note must say so — the other half of the note fix.
  const whileRes = await fetch(`${server.base}/api/agent-settings`, {
    method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: "gemini" }),
  });
  const whilePayload = await whileRes.json();
  assert.match(whilePayload.note ?? "", /the live session already running keeps the provider/, `with two peers attached the note must say a session is running: ${whilePayload.note}`);

  const firstGone = once(first, "close");
  first.close();
  await firstGone;
  await sleep(400); // give a wrong implementation every chance to clear it
  assert.equal((await health()).live.running, true, "the first peer's exit reported the second peer's session as gone");

  const secondGone = once(second, "close");
  second.close();
  await secondGone;
  const after = await until(async () => {
    const h = await health();
    return h.live.running === false ? h : null;
  }, "the flag to clear once the last peer left");
  assert.equal(after.live.created, 2, "the created count is history, not a live-session claim");
});
