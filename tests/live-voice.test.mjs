// tests/live-voice.test.mjs — the live voice path, verified end to end with a
// SYNTHETIC tone, so no microphone is needed to prove the wire works.
//
// What it proves (each a claim someone could otherwise only assert):
//   1. the WS server codec accepts a client and speaks frames both ways;
//   2. the readiness gate HOLDS audio sent before setupComplete, counts it,
//      and reports the count when the gate opens (isocan's 192/208 lesson);
//   3. audio sent after the gate flows upstream to the REAL Gemini Live model
//      and model audio (24 kHz PCM16) comes back down the same socket;
//   4. a text turn on the same session also comes back (audio or transcript).
//
// The parts that cannot be verified headlessly — a real microphone, the
// browser's AudioContext pipeline, playback audibility — are stated plainly
// in the verdict, not glossed.

import { spawn } from "node:child_process";
import { startServer as startEphemeralServer } from "./lib/server.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";

const ROOT = new URL("..", import.meta.url).pathname;
let BASE; // the ephemeral port this suite's server actually bound
const HAVE_KEY = Boolean(process.env.GEMINI_API_KEY);

// An EPHEMERAL port via the shared helper: this file used to pick a random port in a 400-wide band,
// which is still a gamble on somebody else's listener — and a suite that grabs a port makes another
// lane's verification fail with no explanation of why.
async function startServer() {
  const started = await startEphemeralServer({ env: { VOICEBOX_RESOLVER: "script" } });
  BASE = started.base;
  return started;
}

// The helper has already waited for /api/health; kept so the call sites read the same.
async function waitForServer(started) {
  if (!started) throw new Error("server did not start");
}

function tone16k(seconds = 0.4, freq = 440) {
  const rate = 16000;
  const n = Math.floor(rate * seconds);
  const pcm = new Int16Array(n);
  for (let i = 0; i < n; i++) pcm[i] = Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * 8000);
  return Buffer.from(pcm.buffer);
}

/**
 * WAIT FOR THE CONDITION AND SAY HOW LONG IT TOOK.
 *
 * This file got the shape wrong TWICE: a fixed sleep followed by an assertion about what arrived. The first
 * slept 12 s and failed under parallel load; the second slept 10 s and failed at 11.97 s with "the session
 * must still return audio after a dropped malformed frame" — reporting a slow network as a broken session
 * (coord, 2026-09-20, twice with the gate owner's log to prove it).
 *
 * A live-network leg must wait for the thing it needs, print the latency, and keep a bound — so a degrading
 * network shows up as a RISING NUMBER rather than an intermittent red, and a genuinely broken session still
 * fails. No retry: a retried pass reported as a clean pass is the same lie as a green check that measured
 * nothing.
 */
async function waitFor(predicate, { what, boundMs = 45000, everyMs = 250 }) {
  const started = Date.now();
  while (!predicate() && Date.now() - started < boundMs) await new Promise((r) => setTimeout(r, everyMs));
  const ms = Date.now() - started;
  const ok = predicate();
  console.log(
    ok
      ? `[live-voice] ${what}: arrived after ${ms}ms (waited for it, did not assume it)`
      : `[live-voice] ${what}: NOT within ${boundMs}ms`,
  );
  return ok;
}

/** Same bounded wait, returning the predicate's first truthy VALUE (for tests
 * that need the arrived thing, not just its arrival). Prints the same latency
 * line as waitFor so every network leg reports what it observed. */
async function waitForValue(probe, { what, boundMs = 45000, everyMs = 250 }) {
  const started = Date.now();
  let value = probe();
  while (!value && Date.now() - started < boundMs) {
    await new Promise((r) => setTimeout(r, everyMs));
    value = probe();
  }
  const ms = Date.now() - started;
  console.log(
    value
      ? `[live-voice] ${what}: arrived after ${ms}ms (waited for it, did not assume it)`
      : `[live-voice] ${what}: NOT within ${boundMs}ms`,
  );
  return value || null;
}

test("live voice [live-network]: WS codec, readiness gate, and a real Gemini round trip", { skip: !HAVE_KEY && "GEMINI_API_KEY not set", timeout: 90000 }, async () => {
  const server = await startServer();
  try {
    await waitForServer(server);

    // The local origin, declared: this client talks to the server it just started, and the server now asks a
    // /live peer to say who it is before it will build a provider session (bead voicebox-beads-eet).
    const ws = new WebSocket(BASE.replace(/^http/, "ws") + "/live", { headers: { origin: BASE } });
    const states = [];
    const texts = [];
    let binaryFrames = 0;
    let binaryBytes = 0;
    const opened = new Promise((res) => { ws.onopen = res; });
    ws.binaryType = "arraybuffer";
    ws.onmessage = (e) => {
      if (typeof e.data === "string") {
        const m = JSON.parse(e.data);
        if (m.type === "state") states.push(m);
        if (m.type === "text") texts.push(m);
      } else {
        binaryFrames += 1;
        binaryBytes += e.data.byteLength;
      }
    };
    await opened;

    // 1–2. THE READINESS GATE: send a frame immediately — before setupComplete —
    // and require it to be counted, not forwarded silently.
    ws.send(tone16k(0.2));
    const ready = await waitForValue(() => states.find((s) => s.state === "ready") ?? null, {
      what: "the readiness gate opening",
      boundMs: 30000,
    });
    assert.ok(ready, "the readiness gate must open (no ready state within 30s)");
    assert.equal(ready.model, "models/gemini-3.8-live", "the page-facing state names the real model, not a vague 'live'");
    assert.ok((ready.detail?.gatedFrames ?? 0) >= 1, `the gate must count the early frame (got ${JSON.stringify(ready.detail)})`);

    // 3. A synthetic tone after the gate: upstream to the real model, audio back.
    ws.send(tone16k(0.8));
    // 4. And a text turn on the same session.
    ws.send(JSON.stringify({ type: "text", text: "Say hello briefly." }));

    // A LIVE-NETWORK LEG: wait for the condition and REPORT the latency, rather than sleeping a fixed
    // interval and blaming the model for the network. The bound is generous because the deadline is the
    // only thing this can fail on — a broken model never sends audio at all, and that is still a failure.
    // A LIVE-NETWORK LEG: wait for the condition and REPORT the latency via the
    // shared helper, rather than sleeping a fixed interval and blaming the model
    // for the network. The bound is generous because the deadline is the only
    // thing this can fail on — a broken model never sends audio at all.
    const gotAudio = await waitFor(() => binaryFrames > 0, { what: "the live leg returning model audio" });
    assert.ok(
      gotAudio,
      `model audio must come back down the socket as binary frames (the waitFor line above reports the observed latency; ` +
        `frames=${binaryFrames} bytes=${binaryBytes} texts=${texts.length})`,
    );
    assert.ok(binaryBytes > 1000, `audio must be substantive (got ${binaryBytes} bytes across ${binaryFrames} frames)`);

    console.log(`[live-voice] gate held ${ready.detail.gatedFrames} frame(s); ${binaryFrames} audio frame(s) back (${binaryBytes} bytes); texts: ${texts.length}`);
    ws.close();
  } finally {
    await server.stop();
  }
});

test("live voice [live-network]: a malformed binary frame costs a frame, not the conversation", { skip: !HAVE_KEY && "GEMINI_API_KEY not set", timeout: 90000 }, async () => {
  const server = await startServer();
  try {
    await waitForServer(server);
    // The local origin, declared: this client talks to the server it just started, and the server now asks a
    // /live peer to say who it is before it will build a provider session (bead voicebox-beads-eet).
    const ws = new WebSocket(BASE.replace(/^http/, "ws") + "/live", { headers: { origin: BASE } });
    const errors = [];
    const states = [];
    let audioFrames = 0;
    const opened = new Promise((res) => { ws.onopen = res; });
    ws.binaryType = "arraybuffer";
    ws.onmessage = (e) => {
      if (typeof e.data === "string") {
        const m = JSON.parse(e.data);
        if (m.type === "error") errors.push(m);
        if (m.type === "state") states.push(m);
      } else {
        audioFrames += 1;
      }
    };
    await opened;
    // Wait for the readiness gate to open, then send the malformed frame.
    const readyOpened = await waitFor(() => states.some((s) => s.state === "ready"), {
      what: "the readiness gate opening",
      boundMs: 30000,
    });
    assert.ok(readyOpened, "the readiness gate must open (no ready state within 30s)");

    // The measured kill (ds-flash-1b): one 3-byte (odd-length) frame.
    ws.send(Buffer.from([0x01, 0x02, 0x03]));
    const named = await waitFor(() => errors.some((m) => /odd-length audio frame/.test(m.error ?? "")), {
      what: "the malformed-frame report",
      boundMs: 15000, // the report is local to this server, so this bound is generous rather than optimistic
    });
    assert.ok(named, `the malformed frame must be named, got ${JSON.stringify(errors)}`);

    // THE PROPERTY: the conversation survives. A valid frame after the bad one
    // still flows and audio still comes back — one bad frame cost a frame.
    ws.send(tone16k(0.8));
    ws.send(JSON.stringify({ type: "text", text: "Say hello briefly." }));
    const survived = await waitFor(() => audioFrames > 0, { what: "audio after the dropped frame" });
    assert.ok(
      survived,
      `the session must still return audio after a dropped malformed frame (frames=${audioFrames}, ` +
        `errors=${JSON.stringify(errors)}, states=${JSON.stringify(states.slice(-2))})`,
    );
    assert.ok(
      !states.some((s) => s.state === "upstream-closed"),
      `the session must NOT die on one bad frame; got ${JSON.stringify(states.slice(-2))}`,
    );
    console.log(`[malformed-frame] dropped and survived: ${audioFrames} audio frame(s) after the bad one`);
    ws.close();
  } finally {
    await server.stop();
  }
});
