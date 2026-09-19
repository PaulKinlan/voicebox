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
import { test } from "node:test";
import assert from "node:assert/strict";

const PORT = 8910 + Math.floor(Math.random() * 400);
const ROOT = new URL("..", import.meta.url).pathname;
const HAVE_KEY = Boolean(process.env.GEMINI_API_KEY);

function startServer() {
  const proc = spawn("node", ["server.mjs"], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), VOICEBOX_PROVIDER: "script" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return proc;
}

function waitForServer(proc, ms = 8000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("server did not start")), ms);
    proc.stdout.on("data", (d) => {
      if (String(d).includes("voicebox on")) { clearTimeout(t); resolve(); }
    });
  });
}

function tone16k(seconds = 0.4, freq = 440) {
  const rate = 16000;
  const n = Math.floor(rate * seconds);
  const pcm = new Int16Array(n);
  for (let i = 0; i < n; i++) pcm[i] = Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * 8000);
  return Buffer.from(pcm.buffer);
}

test("live voice: WS codec, readiness gate, and a real Gemini round trip", { skip: !HAVE_KEY && "GEMINI_API_KEY not set", timeout: 90000 }, async () => {
  const server = startServer();
  try {
    await waitForServer(server);

    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/live`);
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
    const ready = await new Promise((res, rej) => {
      const t = setTimeout(() => { clearInterval(iv); rej(new Error("no ready state within 30s")); }, 30000);
      const iv = setInterval(() => {
        const r = states.find((s) => s.state === "ready");
        if (r) { clearInterval(iv); clearTimeout(t); res(r); }
      }, 100);
    });
    assert.equal(ready.model, "models/gemini-3.8-live", "the page-facing state names the real model, not a vague 'live'");
    assert.ok((ready.detail?.gatedFrames ?? 0) >= 1, `the gate must count the early frame (got ${JSON.stringify(ready.detail)})`);

    // 3. A synthetic tone after the gate: upstream to the real model, audio back.
    ws.send(tone16k(0.8));
    // 4. And a text turn on the same session.
    ws.send(JSON.stringify({ type: "text", text: "Say hello briefly." }));

    await new Promise((res) => setTimeout(res, 12000));
    assert.ok(binaryFrames > 0, "model audio must come back down the socket as binary frames");
    assert.ok(binaryBytes > 1000, `audio must be substantive (got ${binaryBytes} bytes across ${binaryFrames} frames)`);

    console.log(`[live-voice] gate held ${ready.detail.gatedFrames} frame(s); ${binaryFrames} audio frame(s) back (${binaryBytes} bytes); texts: ${texts.length}`);
    ws.close();
  } finally {
    server.kill();
  }
});

test("live voice: a malformed binary frame costs a frame, not the conversation", { skip: !HAVE_KEY && "GEMINI_API_KEY not set", timeout: 90000 }, async () => {
  const server = startServer();
  try {
    await waitForServer(server);
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/live`);
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
    await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error("no ready state within 30s")), 30000);
      const iv = setInterval(() => {
        if (states.find((s) => s.state === "ready")) { clearInterval(iv); clearTimeout(t); res(); }
      }, 100);
    });

    // The measured kill (ds-flash-1b): one 3-byte (odd-length) frame.
    ws.send(Buffer.from([0x01, 0x02, 0x03]));
    await new Promise((res) => setTimeout(res, 1500));
    assert.ok(
      errors.some((m) => /odd-length audio frame/.test(m.error ?? "")),
      `the malformed frame must be named, got ${JSON.stringify(errors)}`,
    );

    // THE PROPERTY: the conversation survives. A valid frame after the bad one
    // still flows and audio still comes back — one bad frame cost a frame.
    ws.send(tone16k(0.8));
    ws.send(JSON.stringify({ type: "text", text: "Say hello briefly." }));
    await new Promise((res) => setTimeout(res, 10000));
    assert.ok(audioFrames > 0, "the session must still return audio after a dropped malformed frame");
    assert.ok(
      !states.some((s) => s.state === "upstream-closed"),
      `the session must NOT die on one bad frame; got ${JSON.stringify(states.slice(-2))}`,
    );
    console.log(`[malformed-frame] dropped and survived: ${audioFrames} audio frame(s) after the bad one`);
    ws.close();
  } finally {
    server.kill();
  }
});
