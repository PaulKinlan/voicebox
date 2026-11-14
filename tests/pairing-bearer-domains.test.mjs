// tests/pairing-bearer-domains.test.mjs — voicebox-beads-cns4 (TM-FENCE-002).
//
//   node --test tests/pairing-bearer-domains.test.mjs
//
// The finding said the fence is handed a bearer the host ACCEPTS as an executor on /channel and as a live
// session on /live, so a sandbox sharing the host network namespace could drive the host with the credential it
// already holds. Measured, that is not what happens: the host keeps TWO credentials per environment —
//   callBearer   what THIS host sends when it calls the environment (a fence is booted with one of these),
//   acceptBearer what THIS host accepts from a peer that calls back.
// and the fence is booted with the call side only (server.mjs mint: recordCallBearer; fence boot: bearerFor()).
// checkBearerAccepted() reads acceptBearer and nothing else, so the fence's bearer is refused by both doors.
//
// This file turns that separation from a claim into a GATE: it drives the real writers (POST /api/pair/complete
// for the call side, POST /api/pair for the accept side) and then the real doors, and it fails if either door
// ever starts admitting a call bearer — which is exactly what the finding assumed was already true.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { startServer } from "./lib/server.mjs";

/** Open a door, send the hello frame with `bearer`, and collect what comes back before the socket closes. */
function hello(base, kind, bearer) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${base.replace(/^http/, "ws")}/${kind}`);
    const frames = [];
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch { /* already gone */ }
      // A half-open socket keeps the event loop alive; terminate behind close().
      try { ws.onmessage = null; ws.onopen = null; ws.onerror = null; } catch { /* gone */ }
      resolve(frames);
    };
    ws.onmessage = (event) => {
      try { frames.push(JSON.parse(event.data)); } catch { frames.push({ unparsed: true }); }
      // A refusal is final; an admitted peer gets a session frame and we stop collecting there.
      if (frames.at(-1)?.refused || frames.length > 2) done();
    };
    ws.onopen = () => ws.send(JSON.stringify({ type: "hello", bearer }));
    ws.onerror = done;
    setTimeout(done, 2000);
  });
}

/** A server with its own host directory, so the pairing store belongs to this test alone. */
async function scratchServer() {
  const host = mkdtempSync(path.join(os.tmpdir(), "vb-bearer-domains-"));
  const server = await startServer({ env: { VOICEBOX_EXTENSIONS_DIR: path.join(host, "extensions") } });
  const hostHeaders = { "content-type": "application/json", "x-voicebox-host-token": server.hostToken };
  const declared = await fetch(`${server.base}/api/environments`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    // A server environment needs an origin; nothing here ever dials it — the pairing store is the subject.
    body: JSON.stringify({ label: "bearer domains", kind: "server", origin: "http://127.0.0.1:1" }),
  }).then((r) => r.json());
  assert.equal(declared.ok, true, JSON.stringify(declared));
  return {
    server,
    hostHeaders,
    key: declared.environment.key,
    stop: async () => {
      await server.stop();
      rmSync(host, { recursive: true, force: true });
    },
  };
}

test("the bearer a fence is booted with is a CALL bearer the host refuses on /live and /channel (voicebox-beads-cns4)", async () => {
  const s = await scratchServer();
  try {
    // The real writer for the call side — the same function a fence boot uses to mint its bearer.
    const callBearer = `vbx_${"c".repeat(48)}`;
    const complete = await fetch(`${s.server.base}/api/pair/complete`, {
      method: "POST",
      headers: s.hostHeaders,
      body: JSON.stringify({ envKey: s.key, bearer: callBearer }),
    }).then((r) => r.json());
    assert.equal(complete.ok, true, `pairing the call side: ${JSON.stringify(complete)}`);

    for (const kind of ["live", "channel"]) {
      const frames = await hello(s.server.base, kind, callBearer);
      const refusal = frames.find((f) => f?.refused);
      assert.ok(refusal, `/${kind} must REFUSE the fence's call bearer, got ${JSON.stringify(frames)}`);
      assert.equal(refusal.refused, "bearer-refused", `/${kind} must refuse it by name`);
    }
  } finally {
    await s.stop();
  }
});

test("the ACCEPT bearer is admitted — the positive control that the probe can see an open door (voicebox-beads-cns4)", async () => {
  const s = await scratchServer();
  try {
    // The real writer for the accept side: the host issues a bearer it will accept from a paired peer.
    const issued = await fetch(`${s.server.base}/api/pair`, {
      method: "POST",
      headers: s.hostHeaders,
      body: JSON.stringify({ envKey: s.key }),
    }).then((r) => r.json());
    assert.equal(issued.ok, true, JSON.stringify(issued));
    assert.match(issued.bearer, /^vbx_/, "the credential is a pairing bearer");

    const frames = await hello(s.server.base, "live", issued.bearer);
    assert.ok(!frames.some((f) => f?.refused), `the accept bearer must be admitted, got ${JSON.stringify(frames)}`);
    assert.ok(frames.length > 0, "the door answered at all");
  } finally {
    await s.stop();
  }
});

test("the two credentials are DIFFERENT fields, and the fence path mints only the call side (voicebox-beads-cns4)", async () => {
  // A source pin, deliberately narrow: if a refactor ever makes the fence boot store the accept side (or pass
  // acceptBearer into the unit), the test above would still pass on a paired peer and this one would fail.
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("../server.mjs", import.meta.url), "utf8");
  const fenceBoot = source.slice(source.indexOf('if (parsed.fence === "l15" && !bearerFor(candidate.value.key))'), source.indexOf("const booted = parsed.fence"));
  assert.match(fenceBoot, /recordCallBearer\(/, "a fence boot mints a CALL bearer");
  assert.equal(/storeBearer\(/.test(fenceBoot), false, "a fence boot must never record an ACCEPT bearer — that is what a peer is given, not a sandbox");
});
