// tests/live-hello-auth.test.mjs — bead voicebox-beads-eet.
//
// THE DEFECT, stated as its consequence: today a /live socket causes a PROVIDER SESSION to be created — and
// paid for — before anything asks whether the connection is entitled to one. So an unauthenticated peer can
// open a real provider session and be refused afterwards, which makes the refusal a cleanup rather than a
// gate. (The rate frame is sent BEFORE the session is built, so a peer that receives one has already reached
// the point of spend.)
//
// WHAT THIS FILE ASSERTS, and why each half is needed:
//   * a refusal, NAMED, with a remedy in this system's existing vocabulary; and
//   * that NO provider session was created — asserted separately, because "refused" alone is satisfied by
//     the broken version too, which is exactly how the defect survived.
//
// THE WITNESS FOR THE SECOND HALF is the server's own count, read from /api/health: `live.created`. It is
// monotonic — a session that is created and then fails still counts, because the attempt is the spend.
//
// MUTATION CHECK (documented here because the test is only worth its red): swap the gate and the session
// creation so the session is built first, and the first test below must go red on `live.created === 0` and on
// the absence of a rate frame. If it stays green, the test is describing the code rather than checking it.
//
// THE LOCAL PAGE IS A DIFFERENT PEER, and it must keep working: a page served by this process connects with
// its own Origin, and this project's host does not hand credentials to a page. So same-origin is entitled to
// the local session; anything else authenticates with the pairing bearer its host issued.
//
//   node --test tests/live-hello-auth.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { startServer } from "./lib/server.mjs";

/** A server whose host directory is scratch, so the pairing store belongs to this test alone. */
async function scratchServer() {
  const host = mkdtempSync(path.join(tmpdir(), "vb-hello-auth-"));
  const extensions = path.join(host, "extensions");
  const started = await startServer({ env: { VOICEBOX_EXTENSIONS_DIR: extensions } });
  return {
    ...started,
    extensions,
    hostToken: () => readFileSync(path.join(extensions, ".host-token"), "utf8").trim(),
  };
}

/**
 * Open /live and collect what comes back.
 *
 * `origin` is how a LOCAL page announces itself: a browser sets Origin on the upgrade, and the browser is
 * the peer this host is allowed to treat as its own. Omitting it makes this client what an unauthenticated
 * peer looks like on the wire — which is the case under test.
 */
function openLive(base, { origin = null } = {}) {
  const ws = origin
    ? new WebSocket(`${base.replace(/^http/, "ws")}/live`, { headers: { origin } })
    : new WebSocket(`${base.replace(/^http/, "ws")}/live`);
  const frames = [];
  ws.onmessage = (e) => {
    try { frames.push(typeof e.data === "string" ? JSON.parse(e.data) : e.data); } catch { frames.push({ unparsed: true }); }
  };
  const opened = new Promise((res) => { ws.onopen = res; });
  const closed = new Promise((res) => { ws.onclose = res; ws.onerror = res; });
  return { ws, frames, opened, closed };
}

async function waitFor(predicate, { what, boundMs = 6000 } = {}) {
  const started = Date.now();
  while (!predicate() && Date.now() - started < boundMs) await new Promise((r) => setTimeout(r, 40));
  const ok = predicate();
  console.log(`  [hello-auth] ${what}: ${ok ? `observed after ${Date.now() - started}ms` : `NOT within ${boundMs}ms`}`);
  return ok;
}

const liveCreated = async (base) => (await (await fetch(`${base}/api/health`)).json())?.live?.created ?? null;

test("an UNAUTHENTICATED peer is refused BY NAME and no provider session is created", async () => {
  const server = await scratchServer();
  try {
    const before = await liveCreated(server.base);
    assert.equal(before, 0, `a fresh server must have created no provider sessions; health said ${before}`);

    const peer = openLive(server.base); // no Origin, no hello: an unauthenticated peer
    await peer.opened;
    const refused = await waitFor(() => peer.frames.some((f) => f?.type === "refused" || f?.refused), {
      what: "a named refusal",
    });
    const frame = peer.frames.find((f) => f?.type === "refused" || f?.refused);
    assert.ok(refused, `an unauthenticated peer must be refused by name, got ${JSON.stringify(peer.frames)}`);
    assert.ok(
      ["unauthenticated-call", "bearer-refused", "environment-not-paired"].includes(frame.refused),
      `the refusal must come from this system's vocabulary, got '${frame.refused}'`,
    );
    assert.ok(typeof frame.why === "string" && frame.why.length > 20, `a refusal must carry a remedy, got '${frame.why}'`);

    // THE SECOND HALF, WHICH IS THE POINT: refused is not enough — nothing may have been created.
    assert.ok(
      !peer.frames.some((f) => f?.type === "rate"),
      "a refused peer must NEVER receive the rate frame: that frame is the server announcing it is about to hand this socket to a provider",
    );
    const after = await liveCreated(server.base);
    assert.equal(after, 0, `refusing must cost a close, never provider spend — health says ${after} session(s) created`);
  } finally {
    await server.stop();
  }
});

test("a hello carrying a bearer THIS HOST NEVER ISSUED is refused, and still nothing is created", async () => {
  const server = await scratchServer();
  try {
    const peer = openLive(server.base);
    await peer.opened;
    peer.ws.send(JSON.stringify({ type: "hello", bearer: "vbx_not-a-bearer-this-host-issued" }));
    const refused = await waitFor(() => peer.frames.some((f) => f?.refused), { what: "a refusal for a wrong bearer" });
    assert.ok(refused, `a bearer that matches nothing must be refused, got ${JSON.stringify(peer.frames)}`);
    assert.equal(peer.frames.find((f) => f?.refused).refused, "bearer-refused", "and the refusal names the bearer, not the peer's honesty");
    assert.equal(await liveCreated(server.base), 0, "a wrong bearer must not buy a session either");
  } finally {
    await server.stop();
  }
});

test("a PAIRED peer authenticates in the first frame and then gets its session", async () => {
  const server = await scratchServer();
  try {
    // The remote side of pairing: the host issues the bearer it will accept. This is a host act, so it
    // carries the host token — the page cannot do it, which is the whole reason the check can be trusted.
    const pair = await fetch(`${server.base}/api/pair`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-voicebox-host-token": server.hostToken() },
      body: JSON.stringify({ envKey: "this-host" }),
    });
    const issued = await pair.json();
    assert.equal(issued.ok, true, `pairing must issue a bearer, got ${JSON.stringify(issued)}`);
    assert.match(issued.bearer, /^vbx_/, "the credential is a pairing bearer");

    const peer = openLive(server.base);
    await peer.opened;
    peer.ws.send(JSON.stringify({ type: "hello", bearer: issued.bearer }));
    const admitted = await waitFor(() => peer.frames.some((f) => f?.type === "rate"), { what: "the rate frame (the gate opened)" });
    assert.ok(admitted, `an authenticated peer must be admitted to a session, got ${JSON.stringify(peer.frames)}`);
    assert.ok(!peer.frames.some((f) => f?.refused), "and must not be refused on the way in");
    // The session is created here — with the default live provider and no API key in this environment it
    // will fail to CONNECT, and that is fine: the attempt is what the count records, and the gate is what
    // this test is about.
    const created = await liveCreated(server.base);
    assert.equal(created, 1, `the authenticated peer is the one that gets the session; health says ${created}`);
  } finally {
    await server.stop();
  }
});

test("the LOCAL PAGE is still entitled without a hello — same origin is the peer this host serves", async () => {
  const server = await scratchServer();
  try {
    const peer = openLive(server.base, { origin: server.base }); // exactly what the served page sends
    await peer.opened;
    const announced = await waitFor(() => peer.frames.some((f) => f?.type === "rate"), { what: "the rate frame for the local page" });
    assert.ok(announced, `the page this server serves must keep working, got ${JSON.stringify(peer.frames)}`);
    assert.ok(!peer.frames.some((f) => f?.refused), "the local page is not asked for a credential it cannot hold");
  } finally {
    await server.stop();
  }
});
