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
// The stimulus the detector is driven by. The spoken passage is what a barge-in needs; its END is what
// makes the interrupt counts below deterministic, so it is derived rather than repeated as prose.
const WAV_SPEC = [[3, 0.01], [2.5, 0.2]];
const UTTERANCE_MS = WAV_SPEC.reduce((ms, [seconds]) => ms + seconds * 1000, 0);
// Measured on this fixture: the app's `inputFloor` (public/audio-client.js, which tracks the captured
// input) sits at room tone ~0.0064 while the WAV plays its quiet passage, stands above 0.06 once the
// 0.2-peak voice is being tracked, and falls below 0.015 the moment the voice stops. Room tone is the
// signal this test needs: it says the person has stopped talking, and unlike a wall clock it cannot be
// fooled by the audio device lagging under load. The voice needs roughly ten frames (~0.4s) to lift the
// floor off room tone, which is what INPUT_FLOOR_MIN_RISE_MS guards against.
const INPUT_FLOOR_ROOM_TONE = 0.02;

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
  // the person starts; then a NORMAL voice (0.20 peak ≈ 0.13 mean-abs), which the review measured as the
  // case a source-side margin made impossible to hear over a loud agent.
  const wav = writeWav(scratch, WAV_SPEC);
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
        if (typeof data === "string" && data.includes('"type":"interrupt"')) {
          this.paused = true;
          if (this.timer) clearInterval(this.timer);
          return;
        }
        // THE AGENT'S LOUDNESS IS INJECTED, DECOUPLED FROM THE MICROPHONE (the review's probe shape): a loud
        // passage plays regardless of what the person's voice is doing, so the detector is exercised on the
        // case that matters — a normal voice over a loud agent — rather than on an echo of the same voice.
        if (!this.timer && !this.paused) {
          const loud = new ArrayBuffer(0x400);
          const view = new DataView(loud);
          for (let i = 0; i < 0x200; i += 1) view.setInt16(i * 2, i % 2 ? 13107 : -13107, true); // ±0.40
          this.timer = setInterval(() => {
            if (!this.paused) window.__voiceboxLiveClient.handleMessage(loud.slice(0));
          }, 120);
        }
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
  const speechOnsetAt = Date.now();
  // The floor climbs at most 0.004 per captured frame (public/audio-client.js), so ~0.4s of voice lifts it
  // off room tone; 1200ms is a comfortable multiple of that and still well inside the 2.5s passage.
  const INPUT_FLOOR_MIN_RISE_MS = 1200;

  assert.equal(interrupted.playbackActive, false, "playback must be flushed, not left playing");
  assert.notEqual(interrupted.phase, "agent-speaking", "the phase must leave agent-speaking");
  assert.equal(interrupted.capture, true, "capture keeps running after a barge-in");

  const sent = await page.evaluate(() => window.__testSocket.sent.filter((s) => typeof s === "string"));
  const interrupts = sent.filter((s) => s.includes('"type":"interrupt"'));
  assert.ok(interrupts.length >= 1, `the page must ask the model to stop, saw ${JSON.stringify(sent)}`);
  for (const frame of interrupts) assert.match(frame, /"source":"page"/, "and it must say the page asked");

  // Let the fixture's own utterance END before anything below counts frames. While the person is still
  // talking, a stale or in-flight model frame that restarts playback is indistinguishable from a new turn:
  // the client arms its detector again for every new speaking phase by design (tests/client-audio.test.mjs,
  // "one utterance sends ONE interrupt, and a new speaking phase arms the detector again"), so a second
  // {type:"interrupt",source:"page"} there is the detector working, not a fault. Counting across that window
  // is what failed under load as "2 !== 1".
  //
  // The end of the utterance is read from the APP's own view of the input, not from the clock. A wall clock
  // was wrong here in exactly the direction that matters: Chromium's fake-audio device lags its file under
  // load (measured +76ms idle, +366ms at 4-core load, and the flake this bead records happened at load ~8),
  // so `UTTERANCE_MS + 400` could expire while the person was still speaking and the baseline below would be
  // taken mid-utterance. The floor is a lower bound (it can only make this wait longer), so it cannot cause
  // that; the wait is still bounded, at the fixture's own duration plus a grace, so it cannot hang either.
  await until(
    async () => {
      const s = await snapshot();
      if (!s) return null;
      if (Date.now() - speechOnsetAt < INPUT_FLOOR_MIN_RISE_MS) return null;
      return s.inputFloor < INPUT_FLOOR_ROOM_TONE ? s : null;
    },
    "the person to stop talking (the app's own input floor back to room tone)",
    UTTERANCE_MS + 8000,
  );

  // The baseline for the comparison below is taken HERE, after the person has stopped talking: while the
  // utterance is still running the detector may legitimately fire again for a new speaking phase, and a
  // baseline taken before that window would blame the detector's own work on the provider's interrupt.
  const pageInterruptsBeforeProvider = await page.evaluate(
    () => window.__testSocket.sent.filter((s) => typeof s === "string" && s.includes('"type":"interrupt"')).length,
  );

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
  assert.equal(
    after,
    pageInterruptsBeforeProvider,
    "the page must not ask a model that already stopped to stop again: the model's own interrupt must not add a frame",
  );
});
