// tests/openai-provider.test.mjs — the SECOND live provider, driven against the facade it must live behind.
//
// This file is the evidence for the seam: a provider that needed no interface change would prove the seam
// was right the first time. OpenAI Realtime needed one — the facade carried no way to authenticate — and
// that pinch is asserted here as well as described, because a finding should be pinned by a test and not
// only by a paragraph.
//
// Protocol names below are from the current documentation (verified, not recalled): the 2025 beta→GA
// migration renamed `response.audio.delta` to `response.output_audio.delta`, and input PCM is 24 kHz.
//
//   node --test tests/openai-provider.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { createLiveSession, registerLiveProvider, availableLiveProviders } from "../lib/live-session.mjs";
import { createOpenAIProvider, OPENAI_INPUT_RATE, OPENAI_OUTPUT_RATE } from "../lib/live-providers/openai.mjs";

registerLiveProvider("openai", createOpenAIProvider);

/** A facade-shaped recorder: the provider gets `connect`/`send`/`close` and nothing else. */
function makeFacade() {
  const sent = [];
  let handlers = null;
  const facade = {
    refused: { audioBeforeReady: 0, afterClose: 0 },
    connect(url, next = {}) { handlers = next; facade.url = url; facade.headers = next.headers; return true; },
    send(kind, payload) { sent.push({ kind, payload }); return true; },
    close() { facade.closed = true; },
    // test-only driver
    fire(event) { handlers?.onEvent(event); },
    frames: sent,
  };
  return facade;
}

test("seam: the registry now has TWO providers — the claim 'pluggable' has an implementation count", () => {
  const names = availableLiveProviders();
  assert.ok(names.includes("gemini") && names.includes("openai"), `both must be registered: ${names}`);
  assert.equal(names.length >= 2, true, "a seam with one implementation is a claim");
});

test("openai: the GA protocol shapes — session.update, 24 kHz PCM, ready on session.updated", () => {
  process.env.OPENAI_API_KEY = "test-key";
  try {
    const facade = makeFacade();
    const events = [];
    createOpenAIProvider({ emit: (e) => events.push(e), log: () => {}, transport: facade });
    assert.match(facade.url, /^wss:\/\/api\.openai\.com\/v1\/realtime\?model=/, `url: ${facade.url}`);
    assert.ok(facade.headers?.Authorization?.startsWith("Bearer "), "the provider must request auth headers");

    facade.fire({ kind: "open" });
    const setup = JSON.parse(facade.frames.find((f) => f.kind === "handshake").payload);
    assert.equal(setup.type, "session.update", "the GA event is session.update");
    assert.deepEqual(setup.session.output_modalities, ["audio"]);
    assert.equal(setup.session.audio.input.format.rate, OPENAI_INPUT_RATE, "input PCM is 24 kHz — NOT Gemini's 16");
    assert.equal(facade.frames.some((f) => f.kind === "audio"), false, "no audio before ready");

    facade.fire({ kind: "message", data: JSON.stringify({ type: "session.updated" }) });
    assert.ok(events.some((e) => e.type === "ready"), `ready comes from session.updated: ${JSON.stringify(events)}`);
  } finally { delete process.env.OPENAI_API_KEY; }
});

test("openai: the renamed GA events are normalised — output_audio.delta carries the declared rate", () => {
  process.env.OPENAI_API_KEY = "test-key";
  try {
    const facade = makeFacade();
    const events = [];
    createOpenAIProvider({ emit: (e) => events.push(e), log: () => {}, transport: facade });
    facade.fire({ kind: "open" });
    facade.fire({ kind: "message", data: JSON.stringify({ type: "session.updated" }) });
    facade.fire({ kind: "message", data: JSON.stringify({ type: "response.output_audio.delta", delta: "AQACAA==" }) });
    facade.fire({ kind: "message", data: JSON.stringify({ type: "response.output_audio_transcript.delta", delta: "hello" }) });
    facade.fire({ kind: "message", data: JSON.stringify({ type: "response.done" }) });
    const audio = events.find((e) => e.type === "output-audio");
    assert.equal(audio.pcm16, "AQACAA==");
    // The rate is DECLARED, not assumed by the client — the interface carries it because the two providers differ.
    assert.equal(audio.rate, OPENAI_OUTPUT_RATE, "the provider declares its output rate on the event");
    assert.ok(events.some((e) => e.type === "output-text" && e.kind === "model-transcript"));
    assert.ok(events.some((e) => e.type === "turn-complete"));
    // and the pre-GA name is still understood, because deployments differ
    facade.fire({ kind: "message", data: JSON.stringify({ type: "response.audio_transcript.delta", delta: "old" }) });
    assert.equal(events.filter((e) => e.type === "output-text").length, 2, "both the GA and pre-GA transcript names normalise");
  } finally { delete process.env.OPENAI_API_KEY; }
});

test("openai: a null frame and a bad frame cost a frame, not the conversation", () => {
  process.env.OPENAI_API_KEY = "test-key";
  try {
    const facade = makeFacade();
    const events = [];
    createOpenAIProvider({ emit: (e) => events.push(e), log: () => {}, transport: facade });
    facade.fire({ kind: "open" });
    assert.doesNotThrow(() => facade.fire({ kind: "message", data: "null" }));
    assert.doesNotThrow(() => facade.fire({ kind: "message", data: "{not json" }));
    facade.fire({ kind: "message", data: JSON.stringify({ type: "session.updated" }) });
    assert.ok(events.some((e) => e.type === "ready"), "the session still reaches ready after both bad frames");
  } finally { delete process.env.OPENAI_API_KEY; }
});

test("PINCHE: the facade CARRIES this provider's headers to the socket it dials (corrected)", () => {
  // THE FINDING, still pinned — but the other way round from how it was first written.
  //
  // Before this round, `connect(url, { onEvent })` carried no headers at all, so this provider could not
  // authenticate: the facade handed over a URL and nothing to authenticate with, and one provider hid it
  // because Gemini's key rides in the query string. `connect(url, { headers })` closed that.
  //
  // And the old version of THIS TEST asserted the WRONG HALF: it expected a refusal on the grounds that the
  // runtime could not carry headers — a belief this file's own comment stated as fact, from
  // `typeof Deno !== "undefined"`. astra drove the unmodified global on the Node the fleet runs and the header
  // ARRIVED at an owned loopback server, so the refusal was refusing for a reason that was not true. A suite
  // that carries the wrong assumption as an assertion is how a wrong assumption survives.
  //
  // WHAT THIS TEST WITNESSES: the headers reach the constructor the facade dials with. WHAT IT DOES NOT: that
  // the runtime carries them on the wire — a stub constructor would accept anything. That half is astra's
  // loopback drive, and it is cited rather than re-asserted here.
  process.env.OPENAI_API_KEY = "test-key";
  const realWS = globalThis.WebSocket;
  const dialled = [];
  globalThis.WebSocket = class { constructor(url, opts) { dialled.push({ url, opts }); } send() {} close() {} };
  try {
    const states = [];
    const session = createLiveSession({ provider: "openai", onState: (n) => states.push(n), log: () => {} });
    assert.ok(session, "the session must be created — the runtime guess that refused it is gone");
    assert.ok(dialled.length > 0, "the provider must have dialled");
    assert.equal(
      dialled[0].opts?.headers?.Authorization,
      "Bearer test-key",
      `the Authorization header must reach the constructor the facade dials with; got ${JSON.stringify(dialled[0].opts)}`,
    );
    assert.match(dialled[0].url, /^wss:\/\/api\.openai\.com\/v1\/realtime/, "and to the vendor's endpoint");
    session.close();
  } finally { globalThis.WebSocket = realWS; delete process.env.OPENAI_API_KEY; }
});

