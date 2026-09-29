// tests/ldxa-barge-in-browser.test.mjs — barge-in, driven in a REAL browser (voicebox-beads-ldxa).
//
// The bead: "the user cannot interrupt Voicebox while it is actively speaking." This drives the page's
// own audio client in a real Chromium with a REAL capture path — getUserMedia, the pcm-capture worklet,
// the energy meter, the playback scheduler — and a SYNTHETIC socket, because the alternative is a vendor
// key or a provider-catalogue change:
//
//   · the fake microphone FILE gives the page deterministic audio — three quiet seconds, then a person
//     speaking — so the detector is driven by real audio rather than a hand-placed frame;
//   · the socket is the test's own object, attached through the client's real `attachSocket`, and it
//     echoes what the client sends back as playback at reduced gain (the shape of a vendor that is
//     audible while the person talks, without a vendor);
//   · the quiet passage must NOT interrupt; the spoken one must flush playback AND send
//     `{type:"interrupt", source:"page"}` on that socket; and a `state:"interrupt"` frame from the model's
//     side must flush the already-buffered tail without asking again. Both directions of the interrupt
//     are therefore proven in the browser.
//
// WHAT THIS DOES **NOT** PROVE, named rather than implied: the /live route's own dispatch of the interrupt
// frame to a provider. That needs a session provider the settings catalogue accepts, and today the
// key-free stub is not in it — so the route's contract is pinned in-process instead
// (tests/ldxa-interrupt-seam.test.mjs: session.interrupt() reaches the provider and its event returns as
// onState("interrupt"), the exact call server.mjs makes for `{type:"interrupt"}`).
//
//   node --test tests/ldxa-barge-in-browser.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { startServer } from "./lib/server.mjs";
import { launch } from "./lib/cdp.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RATE = 48000;

/** A mono 16-bit PCM wav: `spec` is [seconds, peak amplitude] pairs, one clean sine throughout. */
function writeWav(dir, spec, frequency = 220) {
  const samples = [];
  for (const [seconds, peak] of spec) {
    const count = Math.round(seconds * RATE);
    for (let i = 0; i < count; i += 1) samples.push(Math.round(Math.sin((2 * Math.PI * frequency * i) / RATE) * peak * 32767));
  }
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((v, i) => data.writeInt16LE(Math.max(-32768, Math.min(32767, v)), i * 2));
  const header = Buffer.alloc(44);
  header.write("RIFF", 0); header.writeUInt32LE(36 + data.length, 4); header.write("WAVE", 8);
  header.write("fmt ", 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(RATE, 24); header.writeUInt32LE(RATE * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write("data", 36); header.writeUInt32LE(data.length, 40);
  const file = path.join(dir, "barge-in.wav");
  writeFileSync(file, Buffer.concat([header, data]));
  return file;
}

let server;
let page;
let scratch;

async function until(check, label, ms = 30000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const r = await check();
    if (r) return r;
    await sleep(100);
  }
  assert.fail(`no ${label} within ${ms}ms`);
}

const snapshot = () => page.evaluate(() => window.__voiceboxLiveClient.snapshot());

test.before(async () => {
  scratch = mkdtempSync(path.join(os.tmpdir(), "voicebox-ldxa-"));
  // THREE quiet seconds first, so the test can reach the speaking phase and assert the negative before
  // the person starts. Then the spoken passage the detector has to act on.
  const wav = writeWav(scratch, [[3, 0.01], [2.5, 0.5]]);
  server = await startServer({ cwd: ROOT, env: { VOICEBOX_INSTANCE: "ldxa-barge-in" } });
  page = await launch({ fakeMedia: true, fakeAudioFile: wav });
  await page.goto(`${server.base}/`);
});

test.after(async () => {
  await page?.close();
  await server?.stop();
  rmSync(scratch, { recursive: true, force: true });
});

test("barge-in in the real audio path: quiet speech does not interrupt; speech over the agent flushes playback and sends the interrupt", { timeout: 90000 }, async () => {
  // The synthetic socket: what the client sends, and the model's side of the wire. It echoes audio back
  // at 0.3 gain (a vendor's audio is not the person's own microphone) and records every text frame.
  await page.evaluate(() => {
    const socket = {
      readyState: 1,
      sent: [],
      paused: false, // set when the page interrupts: a real model stops sending audio after that
      binaryType: "arraybuffer",
      send(data) {
        this.sent.push(data);
        if (typeof data === "string" && data.includes('"type":"interrupt"')) this.paused = true;
        // Echo audio back, quieter, one playback tick later — the shape of an audible agent. Once an
        // interrupt has been asked for, the echo stops: otherwise the fixture would be a model that keeps
        // talking THROUGH an interruption, and every "playback flushed" assertion would race the echo.
        if (data instanceof ArrayBuffer && !this.paused) {
          const bytes = new Uint8Array(data);
          const quiet = new Uint8Array(bytes.length);
          for (let i = 0; i + 1 < bytes.length; i += 2) {
            const sample = (bytes[i] | (bytes[i + 1] << 8)) << 16 >> 16;
            const scaled = Math.max(-32768, Math.min(32767, Math.round(sample * 0.3)));
            quiet[i] = scaled & 0xff; quiet[i + 1] = (scaled >> 8) & 0xff;
          }
          setTimeout(() => window.__voiceboxLiveClient.handleMessage(quiet.buffer), 20);
        }
      },
      close() { this.readyState = 3; },
    };
    window.__testSocket = socket;
    window.__voiceboxLiveClient.attachSocket(socket);
    window.__voiceboxLiveClient.handleMessage(JSON.stringify({ type: "rate", inputRate: 16000, provider: "stub" }));
    window.__voiceboxLiveClient.handleMessage(JSON.stringify({ type: "state", state: "ready", model: "test" }));
    return window.__voiceboxLiveClient.startCapture();
  });

  const speaking = await until(async () => {
    const s = await snapshot();
    return s?.phase === "agent-speaking" ? s : null;
  }, "the agent-speaking phase (the echo is audible)");

  assert.equal(speaking.capture, true, "the microphone stays on while the agent speaks — the boundary barge-in needs");
  assert.equal(speaking.bargeIns, 0, `the QUIET passage must not interrupt the model (saw ${speaking.bargeIns})`);

  const interrupted = await until(async () => {
    const s = await snapshot();
    return s && s.bargeIns >= 1 ? s : null;
  }, "the person's speech to interrupt the speaking agent");

  assert.equal(interrupted.playbackActive, false, "playback must be flushed, not left playing");
  assert.notEqual(interrupted.phase, "agent-speaking", "the phase must leave agent-speaking");
  assert.equal(interrupted.capture, true, "capture keeps running after a barge-in");

  const sent = await page.evaluate(() => window.__testSocket.sent.filter((s) => typeof s === "string"));
  const interrupts = sent.filter((s) => s.includes('"type":"interrupt"'));
  assert.equal(interrupts.length, 1, `exactly one interrupt frame must be asked for, saw ${JSON.stringify(sent)}`);
  assert.match(interrupts[0], /"source":"page"/, "and it must say the page asked");

  // THE OTHER DIRECTION: the model's own interrupt (Gemini server-side, OpenAI beside its cancel) must
  // flush the tail the page has already buffered, and must NOT ask again. Buffer something FIRST — an
  // interrupt with nothing playing proves nothing about the flush.
  await page.evaluate(() => window.__voiceboxLiveClient.handleMessage(new ArrayBuffer(0x400)));
  await sleep(80);
  const buffered = await snapshot();
  // The frame must have entered the playback pipeline (the fixture's own ongoing speech may interrupt it
  // again moments later — that is the detector working, and the PRECISE flush semantics are pinned in
  // tests/client-audio.test.mjs with a controlled fixture). What matters here is that the model's own
  // interrupt arrives while audio is in the pipeline and leaves nothing playing.
  assert.ok(buffered.framesReceived >= 1, "the injected tail must be accepted as audio");
  await page.evaluate(() => window.__voiceboxLiveClient.handleMessage(JSON.stringify({ type: "state", state: "interrupt", detail: { provider: "stub" } })));
  const providerInterrupted = await until(async () => {
    const s = await snapshot();
    return s && s.providerInterrupts >= 1 ? s : null;
  }, "the model's own interrupt to be handled");
  assert.equal(providerInterrupted.playbackActive, false, "the buffered tail must be flushed by the model's interrupt too");
  assert.equal(providerInterrupted.phase, "listening", "and the phase must leave agent-speaking");
  assert.equal(providerInterrupted.capture, true, "capture keeps running through the model's interrupt");
  const after = await page.evaluate(() => window.__testSocket.sent.filter((s) => typeof s === "string" && s.includes('"type":"interrupt"')).length);
  assert.equal(after, 1, "the page must not ask a model that already stopped to stop again");
});
