// tests/client-audio.test.mjs — the client audio path, everything that does
// NOT need a microphone. The device half (does the real AudioContext resample
// the mic to 16 kHz, is the model audible) is a press-the-button check and is
// stated as unverified in the bead, not implied here.
//
// The failure classes this file exists for, all of which survive review:
//   * Float32 -> PCM16: rounding, clipping, endianness, odd/empty payloads.
//   * Malformed frames: a truncated frame, a JSON frame in the binary slot, an
//     empty frame, bad JSON, an unknown control type — each must ERROR and the
//     connection must SURVIVE, never a silent drop and never a dead socket.
//   * "Stop reply" must FLUSH the queue (sources stopped, state back to
//     listening), not just clear a flag while sound continues.
//   * The no-coupling negative: with playback active, CAPTURE MUST NOT STOP.
import test from "node:test";
import assert from "node:assert/strict";
import { createAudioClient } from "../public/audio-client.js";
import { floatToInt16Sample, floatToPcm16, pcm16ToFloat, isPcm16 } from "../public/pcm.js";

// ── fakes ───────────────────────────────────────────────────────────────────
function fakeSocket() {
  const sent = [];
  return {
    sent,
    binaryType: "",
    send(data) { sent.push(data); },
    close() { this.closed = true; },
  };
}

function fakeMedia() {
  const track = { stopped: false, stop() { this.stopped = true; } };
  const stream = { getTracks: () => [track] };
  return { stream, track, mediaDevices: { getUserMedia: async () => stream } };
}

/** A minimal AudioContext: real enough to schedule and to drain deterministically. */
class FakeAudioContext {
  constructor({ sampleRate }) {
    this.sampleRate = sampleRate;
    this.currentTime = 0;
    this.destination = { name: "destination" };
    this.started = [];
    this.closed = false;
    this.audioWorklet = { addModule: async (url) => { this.workletUrl = url; } };
  }
  createBuffer(_channels, length, rate) {
    return { length, rate, duration: length / rate, copyToChannel() {} };
  }
  createBufferSource() {
    const source = {
      buffer: null,
      startedAt: null,
      stopped: false,
      connected: null,
      onended: null,
      connect(node) { this.connected = node; },
      start(when) { this.startedAt = when; this.context.started.push(this); },
      stop() { this.stopped = true; },
    };
    source.context = this;
    return source;
  }
  createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
  async close() { this.closed = true; }
}

class FakeWorkletNode {
  constructor() { this.port = { onmessage: null }; }
  disconnect() {}
}

function makeClient(overrides = {}) {
  const events = { states: [], texts: [], errors: [], diagnostics: [] };
  const media = fakeMedia();
  const contexts = [];
  class Ctx extends FakeAudioContext { constructor(opts) { super(opts); contexts.push(this); } }
  const socket = fakeSocket();
  const client = createAudioClient({
    socket,
    mediaDevices: media.mediaDevices,
    AudioContextCtor: Ctx,
    AudioWorkletNodeCtor: FakeWorkletNode,
    onState: (phase, snap, detail) => events.states.push({ phase, snap, detail }),
    onText: (text, kind) => events.texts.push({ text, kind }),
    onError: (error, info) => events.errors.push({ message: error.message, ...info }),
    onDiagnostic: (d) => events.diagnostics.push(d),
    logger: { warn() {} },
    ...overrides,
  });
  return { client, media, contexts, events, socket };
}

// ── 1. PCM conversion: rounding, clipping, endianness, validation ───────────
test("pcm: float to int16 rounds, clips, and maps the extremes exactly", () => {
  assert.equal(floatToInt16Sample(0), 0);
  assert.equal(floatToInt16Sample(1), 32767, "+1 must not wrap to -32768");
  assert.equal(floatToInt16Sample(-1), -32768);
  assert.equal(floatToInt16Sample(0.5), 16384);
  assert.equal(floatToInt16Sample(-0.5), -16384);
  assert.equal(floatToInt16Sample(2), 32767, "clipped above");
  assert.equal(floatToInt16Sample(-2), -32768, "clipped below");
  assert.equal(floatToInt16Sample(NaN), 0, "NaN is silence, not a crash");
  assert.equal(floatToInt16Sample(Infinity), 0, "non-finite is silence — never full-scale noise");
});

test("pcm: the wire is little-endian, and the round trip preserves the signal", () => {
  const bytes = floatToPcm16(Float32Array.from([0.5]));
  assert.equal(bytes.byteLength, 2);
  assert.deepEqual([...new Uint8Array(bytes)], [0x00, 0x40], "16384 little-endian");
  const back = pcm16ToFloat(bytes);
  assert.equal(back.length, 1);
  assert.ok(Math.abs(back[0] - 16384 / 32768) < 1e-6);
  const many = Float32Array.from([0, 0.25, -0.25, 1, -1]);
  const rt = pcm16ToFloat(floatToPcm16(many));
  for (let i = 0; i < many.length; i++) assert.ok(Math.abs(rt[i] - many[i]) < 1e-3, `sample ${i}: ${rt[i]} vs ${many[i]}`);
});

test("pcm: odd-length and empty payloads are refused by the validator", () => {
  assert.equal(isPcm16(new ArrayBuffer(0)), false);
  assert.equal(isPcm16(new ArrayBuffer(3)), false);
  assert.equal(isPcm16(new ArrayBuffer(2)), true);
  assert.throws(() => pcm16ToFloat(new ArrayBuffer(3)), /even byte length/);
});

// ── 2. Malformed frames: error + surviving connection ───────────────────────
test("frames: malformed frames are refused loudly, and an ADDITIVE control type is ignored quietly", () => {
  const { client, events } = makeClient();
  const before = client.snapshot().framesRejected;

  client.handleMessage(new ArrayBuffer(3)); // truncated
  client.handleMessage(new ArrayBuffer(0)); // empty
  client.handleMessage(floatToPcm16(Float32Array.from([0.1]))); // valid PCM, must play
  client.handleMessage("{not json"); // bad control JSON
  client.handleMessage(JSON.stringify({ type: "wat" })); // unknown control type: additive, NOT malformed
  client.handleMessage(undefined); // unsupported type

  // Four refusals, not five: the additive type is not damage. This is the defect
  // a live-tools press found on the real page — a successful tool write printed
  // "Ignored a malformed frame: unrecognised control frame type \"tool\"".
  assert.equal(client.snapshot().framesRejected, before + 4, `expected 4 refusals, got ${client.snapshot().framesRejected}`);
  assert.equal(client.snapshot().framesReceived, 1, "only the valid frame reached playback");
  assert.equal(events.errors.length, 4, "an unknown control type must not be reported as an error");
  assert.ok(events.errors.every((e) => e.fatal === false), "none of these are fatal");
  assert.ok(
    events.diagnostics.some((d) => d.kind === "ignored-control" && d.type === "wat"),
    "the unknown control type was not recorded as an ignored diagnostic",
  );
  assert.equal(events.errors.some((e) => /unrecognised control frame type/.test(e.message)), false,
    "the client is still calling a good frame malformed");

  // The connection survives: well-formed frames after all of them still work.
  client.handleMessage(JSON.stringify({ type: "state", state: "ready", model: "models/gemini-3.8-live", detail: { gatedFrames: 2 } }));
  assert.equal(client.snapshot().ready, true);
  assert.equal(client.snapshot().model, "models/gemini-3.8-live");
  assert.equal(client.snapshot().gatedFrames, 2);
  client.handleMessage(floatToPcm16(Float32Array.from([0.1])));
  assert.equal(client.snapshot().framesReceived, 2);
});

test("frames: a PCM16 frame whose FIRST byte is 0x7B is audio, not a control frame", () => {
  // The counterfactual this guard was missing: 0x7B is the low byte of the first
  // sample ~1 frame in 256, so refusing it silently drops good audio. The opcode
  // already says binary; nothing about the payload may override that.
  const { client, contexts } = makeClient();
  const frame = new Uint8Array([0x7b, 0x00]); // +123 little-endian PCM16
  client.handleMessage(frame.buffer);
  assert.equal(client.snapshot().framesRejected, 0, "valid audio starting with '{' must be played, not refused");
  assert.equal(client.snapshot().framesReceived, 1);
  const playCtx = contexts.find((c) => c.sampleRate === 24000);
  assert.equal(playCtx?.started.length, 1, "the frame was scheduled for playback");
});

test("frames: a text control frame is delivered to onText, not played", () => {
  const { client, events } = makeClient();
  client.handleMessage(JSON.stringify({ type: "text", text: "hello there", kind: "model-transcript" }));
  assert.deepEqual(events.texts, [{ text: "hello there", kind: "model-transcript" }]);
  assert.equal(client.snapshot().framesReceived, 0);
});

// ── 3. Playback queue, scheduling, and the flush that "Stop reply" promises ──
test("playback: frames queue in order, then Stop reply flushes the sources and returns to listening", async () => {
  const { client, media, contexts } = makeClient();
  // The server's FIRST frame on /live is the rate — a test driving this client must produce the same wire
  // order, now that capture REFUSES to run without one (journal-6g0).
  client.handleMessage(JSON.stringify({ type: "rate", inputRate: 16000, provider: "gemini" }));
  await client.startCapture(); // the user pressed the mic: capture is live
  assert.equal(client.snapshot().capture, true);

  const frame = floatToPcm16(Float32Array.from(Array(240).fill(0.1))); // 10 ms at 24 kHz
  client.handleMessage(frame);
  client.handleMessage(frame);
  client.handleMessage(frame);

  const playing = client.snapshot();
  assert.equal(playing.playbackActive, true);
  assert.equal(playing.framesReceived, 3);
  assert.equal(playing.phase, "agent-speaking");
  const playCtx = contexts.find((c) => c.sampleRate === 24000);
  assert.equal(playCtx.started.length, 3, "three sources were scheduled");
  assert.ok(playCtx.started[1].startedAt >= playCtx.started[0].startedAt, "frames schedule in order");
  assert.ok(playCtx.started[2].startedAt >= playCtx.started[1].startedAt, "frames schedule in order");

  const result = client.stopReply();
  assert.equal(result.flushed, true);
  assert.equal(result.captureRunning, true, "Stop reply must not stop capture");
  assert.ok(playCtx.started.every((s) => s.stopped), "every queued source was stopped, not just forgotten");

  const after = client.snapshot();
  assert.equal(after.playbackActive, false);
  assert.equal(after.phase, "listening", "the state returns to listening after a flush");
  assert.equal(after.capture, true);
  assert.equal(media.track.stopped, false, "the microphone track is untouched by Stop reply");
});

test("playback: a drained queue returns to listening without any Stop reply", async () => {
  const { client, contexts } = makeClient();
  // The server's FIRST frame on /live is the rate — a test driving this client must produce the same wire
  // order, now that capture REFUSES to run without one (journal-6g0).
  client.handleMessage(JSON.stringify({ type: "rate", inputRate: 16000, provider: "gemini" }));
  await client.startCapture();
  client.handleMessage(floatToPcm16(Float32Array.from([0.1])));
  const playCtx = contexts.find((c) => c.sampleRate === 24000);
  assert.ok(playCtx, "a 24 kHz playback context was created");
  assert.equal(playCtx.started.length, 1);
  playCtx.started[0].onended(); // the provider's audio finished
  assert.equal(client.snapshot().phase, "listening");
  assert.equal(client.snapshot().playbackActive, false);
});

// ── 4. State machine and truthful labels ────────────────────────────────────
test("state: labels derive from the real capture/playback state, and the readiness wait is visible", async () => {
  const { client } = makeClient();
  assert.match(client.label(), /Mic off/);

  // The server's FIRST frame on /live is the rate — a test driving this client must produce the same wire
  // order, now that capture REFUSES to run without one (journal-6g0).
  client.handleMessage(JSON.stringify({ type: "rate", inputRate: 16000, provider: "gemini" }));
  await client.startCapture();
  assert.match(client.label(), /Waiting for the model · 0 frame\(s\) held/, "before setupComplete the wait is stated, not hidden");

  client.handleMessage(JSON.stringify({ type: "state", state: "ready", model: "models/gemini-3.8-live", detail: { gatedFrames: 1 } }));
  assert.equal(client.label(), "Listening — speak now");

  client.handleMessage(floatToPcm16(Float32Array.from([0.2])));
  assert.equal(client.label(), "Agent speaking · your microphone is on (interrupt any time)");
  assert.equal(client.snapshot().capture, true, "capture stays live while the agent speaks — the two are decoupled");

  await client.stopCapture();
  assert.equal(client.snapshot().capture, false);
  client.handleMessage(floatToPcm16(Float32Array.from([0.2])));
  assert.equal(client.label(), "Agent speaking · your microphone is off", "the off-label appears only when the track really is off");
});

// ── 5. Capture path: worklet -> Float32 -> PCM16 -> socket ──────────────────
test("capture: the worklet's Float32 chunks become PCM16 frames on the socket", async () => {
  let wired = null;
  class Worklet extends FakeWorkletNode {
    constructor() { super(); wired = this; }
  }
  const { client, contexts, socket } = makeClient({ AudioWorkletNodeCtor: Worklet });
  // The server's FIRST frame on /live is the rate — a test driving this client must produce the same wire
  // order, now that capture REFUSES to run without one (journal-6g0).
  client.handleMessage(JSON.stringify({ type: "rate", inputRate: 16000, provider: "gemini" }));
  await client.startCapture();

  const captureCtx = contexts.find((c) => c.sampleRate === 16000);
  assert.ok(captureCtx, "capture uses a 16 kHz AudioContext — the browser resamples, we never do");
  assert.equal(captureCtx.workletUrl, "pcm-worklet.js");
  assert.ok(wired?.port, "the client wired the worklet node's port");

  wired.port.onmessage({ data: Float32Array.from([0.5, -0.5]) });
  assert.equal(socket.sent.length, 1, "one captured chunk became one frame");
  assert.equal(socket.sent[0].byteLength, 4, "two samples -> two int16 values");
  assert.deepEqual([...new Uint8Array(socket.sent[0])], [0x00, 0x40, 0x00, 0xc0], "LE, +16384 then -16384");
  assert.equal(client.snapshot().framesSent, 1);

  // An empty chunk is not a frame.
  wired.port.onmessage({ data: new Float32Array(0) });
  assert.equal(socket.sent.length, 1);

  await client.stopCapture();
  assert.equal(client.snapshot().capture, false);
  assert.equal(client.snapshot().phase, "idle");
});

// ── 6. The session can die; the page must not keep saying "connected" ────────
test("state: an upstream-closed event ends the session truthfully, and capture stays independent", async () => {
  const { client, contexts } = makeClient();
  // The server's FIRST frame on /live is the rate — a test driving this client must produce the same wire
  // order, now that capture REFUSES to run without one (journal-6g0).
  client.handleMessage(JSON.stringify({ type: "rate", inputRate: 16000, provider: "gemini" }));
  await client.startCapture();
  client.handleMessage(JSON.stringify({ type: "state", state: "ready", model: "models/gemini-3.8-live", detail: { gatedFrames: 0 } }));
  client.handleMessage(floatToPcm16(Float32Array.from([0.1])));
  assert.equal(client.snapshot().phase, "agent-speaking");

  client.handleMessage(JSON.stringify({ type: "state", state: "upstream-closed", detail: { code: 1007, reason: "Request contains an invalid argument." } }));
  const s = client.snapshot();
  assert.equal(s.ready, false);
  assert.equal(s.phase, "error");
  assert.match(s.label, /Live session ended/);
  assert.match(s.label, /invalid argument/);
  assert.equal(s.capture, true, "the session ending must not stop the microphone track");
  assert.equal(s.playbackActive, false, "queued audio is flushed when the session dies");
  const playCtx = contexts.find((c) => c.sampleRate === 24000);
  assert.ok(playCtx.started.every((x) => x.stopped), "every queued source was stopped");

  const received = s.framesReceived;
  client.handleMessage(floatToPcm16(Float32Array.from([0.3])));
  assert.equal(client.snapshot().framesReceived, received, "stale audio from a dead session is ignored");
  assert.equal(client.snapshot().framesIgnoredAfterEnd, 1);
});

test("state: a socket close is ended, not 'listening'", async () => {
  const { client, socket } = makeClient();
  // The server's FIRST frame on /live is the rate — a test driving this client must produce the same wire
  // order, now that capture REFUSES to run without one (journal-6g0).
  client.handleMessage(JSON.stringify({ type: "rate", inputRate: 16000, provider: "gemini" }));
  await client.startCapture();
  client.handleMessage(JSON.stringify({ type: "state", state: "ready", detail: {} }));
  client.attachSocket(socket); // re-attach so the fake carries the handlers
  socket.onclose({ code: 1006 });
  const s = client.snapshot();
  assert.equal(s.phase, "error");
  assert.match(s.label, /Live session ended/);
  assert.match(s.label, /1006/);
});

// ── the rate refusal, with the witness the rate work could not write ────────
// journal-6g0: capture REFUSES to start when the server has not declared the
// input rate, because a default here silently reintroduces the defect it closes
// (the page declaring one rate and sending another). The author tried twice for
// a witness and removed both attempts rather than assert something untrue —
// because the refusal shared the device catch and therefore said "The
// microphone is not available", which is not what happened. Fixed first, then
// witnessed: the four facts below are each observable, and none of them needs a
// microphone, a socket or a real device.
// ── two absences, two sentences: a socket that ENDED is not a rate that was withheld ──────
// The owner's bug (2026-09-23) produced "the server has not said what audio rate its provider needs"
// for a socket the API's hello gate had already closed for entitlement — the sentence pointed at the
// rate work, which was correct, instead of at the connection, which was not. The client can tell the
// two apart, so it must.
test("a socket that closed before the rate frame names the CONNECTION, not the rate", async () => {
  const { client, socket, media } = makeClient();
  let getUserMediaCalls = 0;
  const nativeGetUserMedia = media.mediaDevices.getUserMedia;
  media.mediaDevices.getUserMedia = (...args) => { getUserMediaCalls += 1; return nativeGetUserMedia(...args); };

  // A socket the server has already closed: CLOSED (3), with the code its close carried.
  client.attachSocket(socket);
  socket.readyState = 3;
  socket.onclose?.({ code: 1008, reason: "local-page-required" });

  await client.startCapture();
  const s = client.snapshot();
  assert.equal(s.capture, false, "no capture on a dead socket");
  assert.equal(s.captureErrorReason, "socket-closed-before-rate", "the reason is not the connection");
  assert.match(s.label, /live connection ended/i, "the sentence does not say the connection ended");
  assert.match(s.label, /1008/, "the close code is not named");
  assert.doesNotMatch(s.label, /has not said what audio rate/, "the rate was blamed for a closed socket");
  assert.equal(getUserMediaCalls, 0, "the microphone is never opened for a connection that is gone");

  // And the OTHER absence keeps its own sentence: a live socket that stays silent.
  const live = makeClient();
  live.socket.readyState = 1;
  await live.client.startCapture();
  assert.equal(live.client.snapshot().captureErrorReason, "rate-not-declared",
    "an OPEN socket that never declared a rate must not be reported as a closed connection");
  assert.match(live.client.snapshot().label, /has not said what audio rate/, "the rate sentence is gone");
});

test("capture refuses without a declared rate, and names the RATE rather than the microphone", async () => {
  const { client, contexts, media } = makeClient();
  let getUserMediaCalls = 0;
  const nativeGetUserMedia = media.mediaDevices.getUserMedia;
  media.mediaDevices.getUserMedia = (...args) => { getUserMediaCalls += 1; return nativeGetUserMedia(...args); };

  await client.startCapture();
  const s = client.snapshot();

  assert.equal(s.capture, false, "no capture without a declared rate");
  assert.equal(s.captureErrorReason, "rate-not-declared", "the reason is named as a kind, not inferred from prose");
  assert.equal(s.ready, false, "nothing was negotiated, so nothing is ready");
  assert.equal(getUserMediaCalls, 0, "the microphone is never opened for a capture that cannot be sent");
  assert.equal(contexts.length, 0, "no AudioContext is built at an unknown rate");
  // Pinned as a property, not as prose: the sentence must name a rate, and must
  // not blame the microphone. (It said "input rate" until a plain-language pass
  // rewrote it to "audio rate" — the assertion is not a copy editor.)
  assert.match(s.label, /rate/i, "the sentence names a rate");
  assert.doesNotMatch(s.label, /microphone is not available/i, "the microphone is fine and must not be blamed");
  assert.doesNotMatch(s.label, /nothing is listening/i, "and it must not be dressed up as a session ending");

  // The POSITIVE CONTROL: once the server declares a rate, the same call works
  // and the context opens AT THAT RATE — the browser's pipeline does the
  // conversion, which is the whole point of learning the number at runtime.
  client.handleMessage(JSON.stringify({ type: "rate", inputRate: 24000, provider: "openai-realtime" }));
  await client.startCapture();
  assert.equal(client.snapshot().capture, true);
  assert.equal(client.snapshot().captureErrorReason, "", "the refusal is cleared by the user action that follows a declaration");
  assert.equal(contexts.at(-1).sampleRate, 24000, "capture opens at the declared rate, not a remembered one");

  // And a nonsense declaration is refused loudly rather than coerced.
  const other = makeClient();
  other.client.handleMessage(JSON.stringify({ type: "rate", inputRate: "sixteen thousand", provider: "bad" }));
  assert.equal(other.client.snapshot().inputRate, null, "an unusable declaration leaves the session with no rate at all");
  assert.ok(other.events.diagnostics.some((d) => d.kind === "refused" && /unusable input rate/.test(d.message)));
});

// ── the nonterminal error, pinned ───────────────────────────────────────────
// RED before 2026-09-20: the client called this ended and printed "Your
// microphone is still on, but nothing is listening" while the host's ready
// state stayed true and the vendor kept receiving frames. A privacy claim
// contradicted by the system's own behaviour, shown exactly when a person is
// deciding whether to trust a live microphone. The host's event set says it
// plainly — "error — reported, not fatal"; "closed — terminal, and the only
// terminal event" — so the page must agree with the host rather than guess.
test("state: a provider error does NOT end the session, and the page says the audio is still being sent", async () => {
  const { client } = makeClient();
  // The server's FIRST frame on /live is the rate — a test driving this client must produce the same wire
  // order, now that capture REFUSES to run without one (journal-6g0).
  client.handleMessage(JSON.stringify({ type: "rate", inputRate: 16000, provider: "gemini" }));
  await client.startCapture();
  client.handleMessage(JSON.stringify({ type: "state", state: "ready", model: "models/gemini-3.8-live", detail: { gatedFrames: 0 } }));

  client.handleMessage(JSON.stringify({ type: "state", state: "error", detail: { message: "recoverable upstream error", provider: "gemini" } }));
  const s = client.snapshot();

  assert.equal(s.sessionEnded, false, "the host keeps the session live; the page must not call it ended");
  assert.equal(s.ready, true, "the host-reported readiness is preserved, not guessed away");
  assert.equal(s.capture, true, "an error must not stop the microphone");
  assert.match(s.label, /still being sent/, "the true sentence: the mic is on and its audio is still going");
  assert.doesNotMatch(s.label, /nothing is listening/, "the false sentence must be gone from this path");
  assert.match(s.label, /recoverable upstream error/, "the reason is named, from the host's detail");
  assert.ok(client.level(), "audio handling stays alive through a nonterminal error");

  // Recovery: a fresh handshake clears the recorded error rather than leaving
  // the sentence on screen forever.
  client.handleMessage(JSON.stringify({ type: "state", state: "ready", model: "models/gemini-3.8-live", detail: { gatedFrames: 0 } }));
  assert.equal(client.snapshot().providerError, null);
  assert.match(client.label(), /Listening/, "back to the truth: listening");

  // And the TERMINAL path still says the ended sentence, because there it is
  // true: the host closed the gate and stops forwarding.
  client.handleMessage(JSON.stringify({ type: "state", state: "upstream-closed", detail: { reason: "terminal" } }));
  assert.equal(client.snapshot().sessionEnded, true);
  assert.match(client.snapshot().label, /nothing is listening/, "terminal really does stop the vendor");
});

test("state: a refused microphone is sticky — a later ready emit must not overwrite it", async () => {
  const media = fakeMedia();
  media.mediaDevices.getUserMedia = async () => { throw new Error("Permission denied"); };
  const { client } = makeClient({ mediaDevices: media.mediaDevices });
  // The server's FIRST frame on /live is the rate — a test driving this client must produce the same wire
  // order, now that capture REFUSES to run without one (journal-6g0).
  client.handleMessage(JSON.stringify({ type: "rate", inputRate: 16000, provider: "gemini" }));
  await client.startCapture(); // caught internally: no unhandled rejection
  assert.match(client.label(), /microphone is not available/i);
  assert.match(client.label(), /Permission denied/);
  assert.equal(client.snapshot().capture, false);
  // the clobber case voicebox-ui drove: a ready state arrives a moment later
  client.handleMessage(JSON.stringify({ type: "state", state: "ready", detail: { gatedFrames: 0 } }));
  assert.match(client.label(), /microphone is not available/i, "the refusal must survive the ready emit");
  assert.equal(client.snapshot().ready, true, "the session is still ready underneath");
  // the next user action clears it
  media.mediaDevices.getUserMedia = async () => media.stream;
  // The server's FIRST frame on /live is the rate — a test driving this client must produce the same wire
  // order, now that capture REFUSES to run without one (journal-6g0).
  client.handleMessage(JSON.stringify({ type: "rate", inputRate: 16000, provider: "gemini" }));
  await client.startCapture();
  assert.doesNotMatch(client.label(), /microphone is not available/i);
  assert.equal(client.snapshot().capture, true);
});

test("rate: capture REFUSES without a declared rate — it RESOLVES, ends in the idle state, and builds NO capture context", async () => {
  // WHAT THE CLIENT ACTUALLY DOES, measured with a probe (ds-flash-2, 2026-09-23) — and this is the part a
  // reader gets wrong: startCapture() on a client that has not been told a rate RESOLVES. It does NOT reject,
  // and it does NOT call onError. It moves the client's state to phase "error" and builds NO capture context.
  //
  // WHY THE ASSERTION IS SHAPED THIS WAY (do not "fix" the test if the phase name changes again): the phase is
  // a LABEL and it has already changed once between revisions (`error` in one, `idle` here), while "no context"
  // is a STRUCTURE. contexts.length === 0 means no audio can be sent at ANY rate, whatever the client does next
  // or calls the state — so the structural half is the witness and the phase assertion is only a companion.
  //
  // SO THE WITNESS IS STRUCTURAL: contexts.length === 0 means no audio can be sent at ANY rate, whatever the
  // client does next — which is why it is stronger than asserting on a rejection that never happens.
  // assert.rejects and onError both look right and are both wrong here; both were tried.
  //
  // RUNTIME, named deliberately: this witness ran under the Node named in the commit/report (v24.21.0 and
  // /usr/bin/node v26.8.1). The rate acceptance that drives a real browser lives in live-rate-browser.test.mjs,
  // and this repo's fence path invokes /usr/bin/node — a unit witness does not exercise that path.
  const { client, contexts, events } = makeClient();
  await client.startCapture(); // resolves; nothing is thrown
  assert.equal(contexts.length, 0, "no capture context may exist without a declared rate — the structural witness");
  // THE PHASE IS `idle`, NOT `error` — measured on current main, and it is the half I got wrong first: my probe
  // (a different client revision) reported `error`. The refusal is still a STATE, not a rejection, and the
  // reason travels in the state's detail (`rateNotDeclared`) and the client's own `captureErrorReason`.
  assert.ok(
    events.states.some((s) => s.phase === "idle"),
    `the refusal is reported as a STATE, not a rejection: got ${JSON.stringify(events.states.map((s) => s.phase))}`,
  );
});
