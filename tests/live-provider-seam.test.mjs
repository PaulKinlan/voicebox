// tests/live-provider-seam.test.mjs — the falsifier for the live-session seam.
//
// THE CLAIM: a live provider can be swapped by configuration, and the host's guarantees still hold.
//
// THE INSTRUMENT: lib/live-providers/stub.mjs — a provider with NO READINESS GATE OF ITS OWN. It opens,
// waits, and only then says `ready`. If audio is held and counted across that window, the gate is
// demonstrably HOST-SIDE, because the stub has nothing to do the holding. If it is not held, the seam is
// at the wrong level and that is a finding about the DESIGN, not a bug to patch.
//
// Needs no API key, no network, no browser:
//   node --test tests/live-provider-seam.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { createLiveSession, registerLiveProvider, availableLiveProviders } from "../lib/live-session.mjs";
import { createStubProvider } from "../lib/live-providers/stub.mjs";

registerLiveProvider("stub", createStubProvider);

const frame = (n) => Buffer.alloc(2 * n, 0).toString("base64");

// A stub we can INSPECT: the factory keeps the instance, so the test can ask what actually reached the
// "vendor". Without this, the gate test's own name ("the stub never sees it") was a claim with no
// assertion behind it — an instrument that cannot fail, which is the lesson this week keeps teaching.
let lastStub = null;
registerLiveProvider("stub-recording", (opts) => {
  lastStub = createStubProvider(opts);
  return lastStub;
});

function wire(provider = "stub-recording") {
  const states = [];
  const audio = [];
  const texts = [];
  const lines = [];
  lastStub = null;
  const session = createLiveSession({
    provider,
    onState: (name, meta) => states.push({ name, ...meta }),
    onAudioOut: (buf) => audio.push(buf.length),
    onText: (t) => texts.push(t),
    log: (l) => lines.push(l),
  });
  return { session, states, audio, texts, lines, stub: () => lastStub };
}

test("seam: the provider registry answers, and an unknown provider is refused by name", () => {
  const names = availableLiveProviders();
  assert.ok(names.includes("gemini"), `gemini must be registered: ${names}`);
  assert.ok(names.includes("stub"), `stub must be registered for the falsifier: ${names}`);
  assert.throws(
    () => createLiveSession({ provider: "nope", log: () => {} }),
    /no live provider registered for 'nope'.*gemini.*stub/s,
    "an unknown provider must be refused with the list of what exists",
  );
});

test("seam: THE GATE IS HOST-SIDE — audio before ready is held and counted, and the stub never sees it", async () => {
  const { session, states, audio, lines, stub } = wire();
  const stubInstance = stub();
  const before = 5;
  for (let i = 0; i < before; i++) session.sendAudio(frame(8)); // the stub has NO gate; if these arrive, the gate is not host-side
  assert.equal(session.ready, false, "the gate must not be open yet — the stub delays ready");
  assert.equal(session.gatedFrames, before, "every early frame must be counted");
  // `stub()` is the accessor; the instance it returns is what holds `received`. My first version wrote
  // `stub.received` — a property on a FUNCTION — so it compared `undefined` to `[]` and reported the
  // gate broken when the gate was fine. The falsifier caught its own instrument, which is the point.
  assert.deepEqual(stubInstance.received, [], "THE ASSERTION THE TEST IS NAMED FOR: not one early frame reached the vendor");

  await new Promise((r) => setTimeout(r, 500)); // the stub's ready window
  assert.equal(session.ready, true, "the session must reach ready when the provider says so");
  assert.ok(states.some((s) => s.name === "ready" && s.gatedFrames === before), "ready must report the held count");
  assert.ok(lines.some((l) => /readiness gate held 5 frame/.test(l)), `the hold must be logged with its number: ${lines.join(" | ")}`);

  // The positive control: after ready, audio flows.
  session.sendAudio(frame(8));
  assert.equal(audio.length, 1, "audio sent after ready must reach the page (a gate that never opens is not a gate)");
  session.close();
});

test("seam: one malformed frame costs a frame — dropped by the provider, and the session still reaches ready", () => {
  const { session, lines } = wire();
  assert.ok(
    lines.some((l) => /dropped one unparseable frame/.test(l)),
    `the stub's bad frame must be dropped and said so: ${lines.join(" | ")}`,
  );
  assert.equal(session.ready, false, "still not ready at this instant — the drop did not kill the session");
  session.close();
});

test("seam: the host ignores an UNKNOWN EVENT and keeps the conversation (the host's half of the frame rule)", () => {
  // A provider that raises an event the host has never heard of. It must cost an event, not the session.
  registerLiveProvider("misbehaving", ({ emit }) => ({
    start() { emit({ type: "transport-open" }); emit({ type: "totally-made-up", payload: 1 }); emit({ type: "ready" }); },
    sendAudio() {},
    close() { emit({ type: "closed", code: 1000, reason: "done" }); },
  }));
  const states = [];
  const lines = [];
  const session = createLiveSession({
    provider: "misbehaving",
    onState: (name) => states.push(name),
    log: (l) => lines.push(l),
  });
  assert.ok(
    lines.some((l) => /unknown provider event 'totally-made-up'/.test(l)),
    `the unknown event must be reported, not swallowed silently: ${lines.join(" | ")}`,
  );
  assert.equal(session.ready, true, "and the session must carry on: the provider said ready");
  session.close();
});

test("seam: THE TRUTHFUL STATE MACHINE — closed is terminal, and ready never survives it", async () => {
  const { session, states } = wire();
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(session.ready, true);
  session.close();
  assert.equal(session.ready, false, "after close, ready MUST be false — disconnected cannot read as listening");
  assert.ok(states.some((s) => s.name === "upstream-closed" && s.code === 1000), `close must carry its code: ${JSON.stringify(states)}`);
  session.close(); // idempotent
});

test("seam: THE BOUNDARY — the page holds no vendor handle, so the gate cannot be walked around from above", () => {
  const { session } = wire();
  const exposed = Object.keys(session).sort();
  for (const method of ["sendAudio", "sendText", "interrupt", "close"]) {
    assert.equal(typeof session[method], "function", `the page must be able to ${method}`);
  }
  // Nothing that talks to a vendor: no socket, no raw send, no frame writer, no inner handle.
  for (const forbidden of ["ws", "socket", "send", "write", "emit", "inner"]) {
    assert.ok(!(forbidden in session), `the host must not expose '${forbidden}' to the page: ${exposed.join(", ")}`);
  }
  assert.deepEqual(
    exposed,
    ["close", "gatedFrames", "interrupt", "provider", "ready", "refusedByTransport", "sendAudio", "sendText"],
    `the page's surface must be exactly the contract: ${exposed.join(", ")}`,
  );
  // `refusedByTransport` was added in the REVISE so "the gate is host-side" is a NUMBER rather than a
  // claim — and this test is why that addition was a deliberate act rather than a quiet widening. It
  // failed the moment the member appeared, which is the behaviour its comment promised.
  session.close();
});

test("seam: what the boundary proves, and what it does NOT — the honest half", () => {
  // PROVEN: a page cannot reach a vendor except through the host's sendAudio, so the gate is
  // UNCONDITIONAL AT THE PAGE BOUNDARY — there is no second door from above.
  //
  // NOT PROVEN, and not provable from here: a PROVIDER is in-process code. A provider that opened its own
  // path to its vendor, or called its own sendAudio directly, would not be stopped by this host. The gate
  // guards the page's frames, not the provider's honesty. That is the same distinction the environment
  // design draws between MEDIATED and COMPLIANT modes.
  const { session } = wire();
  assert.equal(typeof session.sendAudio, "function");
  assert.equal(session.provider, "stub-recording", "the session names its provider, so a log can say which");
  session.close();
});

// ── astra's review (voicebox-beads-xin), each finding as a test ──────────────────────────────────────

test("REVISE-1: a provider's OWN audio before ready is refused by the transport (the gate is a mechanism)", () => {
  // The refutation: with the real adapter and an inert socket, the provider sent `AQACAA==` straight to
  // the vendor, because it dialled ambiently. The fix hands the provider a TRANSPORT, so its audio goes
  // through the same gate as the page's — and this test uses a recording socket to see what got out.
  const sent = [];
  const realWS = globalThis.WebSocket;
  globalThis.WebSocket = class {
    constructor(url) { this.url = url; sent.push({ kind: "construct", url: String(url).slice(0, 24) }); }
    send(frame) { sent.push({ kind: "frame", frame: String(frame) }); }
    close() {}
  };
  try {
    registerLiveProvider("early-audio", ({ transport, emit }) => ({
      start() {
        emit({ type: "transport-open" });
        // Connect first, like a real provider — a send with no socket is refused for a different reason.
        transport.connect("wss://stub.invalid/vendor", {});
        // Then try to push audio before the handshake finished. Pre-REVISE this reached the vendor.
        transport.send("audio", "AQACAA==");
        transport.send("handshake", JSON.stringify({ setup: "pretend" }));
      },
      sendAudio() {}, close() {},
    }));
    const states = [];
    const session = createLiveSession({ provider: "early-audio", onState: (n) => states.push(n), log: () => {} });
    assert.equal(session.ready, false, "no ready was emitted — the handshake never completed");
    assert.equal(session.refusedByTransport.audioBeforeReady, 1, "the transport must refuse provider audio while not ready");
    const frames = sent.filter((s) => s.kind === "frame").map((s) => s.frame);
    assert.ok(!frames.includes("AQACAA=="), `provider audio must NOT reach the vendor: ${JSON.stringify(sent)}`);
    assert.ok(frames.some((f) => f.includes("pretend")), "the handshake itself must still pass through");
    session.close();
  } finally {
    globalThis.WebSocket = realWS;
  }
});

test("REVISE-2: a rejected start() is a cause — it emits closed, and a late ready is refused", async () => {
  registerLiveProvider("fails-to-start", ({ emit }) => ({
    async start() { throw new Error("handshake refused"); },
    sendAudio() {}, close() { emit({ type: "closed", code: 1000, reason: "closed" }); },
  }));
  const states = [];
  const session = createLiveSession({ provider: "fails-to-start", onState: (n, m) => states.push({ n, ...m }), log: () => {} });
  await new Promise((r) => setTimeout(r, 20));
  const terminal = states.find((s) => s.n === "upstream-closed");
  assert.ok(terminal, `a failed start must produce a terminal event: ${JSON.stringify(states)}`);
  assert.equal(terminal.code, 1011, "the terminal event must say the provider failed to start");
  assert.equal(session.ready, false, "and the session must not be alive");
});

test("REVISE-3: prototype keys are refused by name, like every other unknown provider", () => {
  for (const name of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
    assert.throws(
      () => createLiveSession({ provider: name, log: () => {} }),
      (err) => err instanceof Error && /no live provider registered for/.test(err.message) && /gemini/.test(err.message),
      `'${name}' must be refused by name with the list, not fall through to a prototype member`,
    );
  }
});

test("REVISE-4: a null event and a bad event cost an event, not the conversation", () => {
  registerLiveProvider("shape-abusing", ({ emit }) => ({
    start() {
      emit(null);                       // not an object
      emit("nonsense");                 // a string
      emit({ type: "totally-made-up" }); // unknown but well-shaped
      emit({ type: "ready" });          // and then a real one
    },
    sendAudio() {}, close() { emit({ type: "closed", code: 1000, reason: "done" }); },
  }));
  const lines = [];
  const session = createLiveSession({ provider: "shape-abusing", log: (l) => lines.push(l) });
  assert.equal(session.ready, true, "the session must survive all three malformed events and reach ready");
  assert.ok(lines.some((l) => /malformed provider event/.test(l)), `null/string must be reported: ${lines.join(" | ")}`);
  assert.ok(lines.some((l) => /unknown provider event/.test(l)), `unknown types must be reported: ${lines.join(" | ")}`);
  session.close();
});

test("REVISE-4b: a vendor frame of JSON `null` costs a frame (the Gemini provider's half)", async () => {
  const realWS = globalThis.WebSocket;
  let onMessage = null;
  globalThis.WebSocket = class {
    constructor() { queueMicrotask(() => this.onopen?.()); }
    send() {}
    close() {}
    set onmessage(fn) { onMessage = fn; }
    get onmessage() { return onMessage; }
  };
  try {
    const { createGeminiProvider } = await import("../lib/live-providers/gemini.mjs");
    process.env.GEMINI_API_KEY = "test-key";
    const events = [];
    // The facade's shape: the provider hands in ONE handler and receives DATA events. My first version of
    // this stub spoke the old `{ onMessage }` shape, so it tested nothing the provider now does.
    const transport = {
      connect: (_url, handlers) => {
        onMessage = (data) => handlers.onEvent({ kind: "message", data });
        return true;
      },
      send: () => true, close: () => {},
    };
    const p = createGeminiProvider({ emit: (e) => events.push(e), log: () => {}, transport });
    assert.ok(p, "the provider must construct with the injected transport");
    if (onMessage) {
      await onMessage("null");                 // parses to null — must not throw
      await onMessage("{bad");                 // unparseable — must not throw
      await onMessage('{"setupComplete":{}}');
    }
    assert.ok(events.some((e) => e.type === "ready"), `the session must still reach ready: ${JSON.stringify(events)}`);
  } finally {
    globalThis.WebSocket = realWS;
    delete process.env.GEMINI_API_KEY;
  }
});

// ── astra's RE-REVIEW of 805a0df: the caveat, demonstrated, and the terminal-state family ──────────────

test("REVISE-2-1: the facade hands back NOTHING TO SEND WITH — the raw socket is not reachable", () => {
  // The refutation: `transport.connect()` used to RETURN THE SOCKET, so a provider using only the
  // interface it was handed could call `returned.send(audio)` and reach the vendor with the gate untouched
  // — while the one-constructor grep stayed green, because the string never appeared.
  let handedBack = "not called";
  registerLiveProvider("socket-peeker", ({ transport, emit }) => ({
    start() {
      emit({ type: "transport-open" });
      handedBack = transport.connect("wss://stub.invalid/vendor", { onEvent: () => {} });
      emit({ type: "ready" });
    },
    sendAudio() {}, close() {},
  }));
  const realWS = globalThis.WebSocket;
  globalThis.WebSocket = class { send() {} close() {} onclose = null; onmessage = null; onopen = null; onerror = null; };
  try {
    const session = createLiveSession({ provider: "socket-peeker", log: () => {} });
    assert.equal(typeof session.sendAudio, "function");
    assert.notEqual(typeof handedBack, "object", `connect() must not return a socket-like object: ${handedBack}`);
    assert.equal(handedBack, true, "it returns a boolean — the fact of connecting, not a handle on the wire");
    session.close();
  } finally { globalThis.WebSocket = realWS; }
});

test("REVISE-2-2: a failing start CLOSES THE TRANSPORT — no socket outlives a terminal state", async () => {
  const closes = [];
  const wireFrames = [];
  const realWS = globalThis.WebSocket;
  globalThis.WebSocket = class {
    constructor() {}
    send(frame) { wireFrames.push(frame); }
    close() { closes.push("socket"); }
    onclose = null;
  };
  try {
    registerLiveProvider("fails-after-connecting", ({ transport, emit }) => ({
      start() {
        transport.connect("wss://stub.invalid/vendor", { onEvent: () => {} });
        return Promise.reject(new Error("handshake refused after connecting"));
      },
      sendAudio() {}, close() {},
    }));
    const session = createLiveSession({ provider: "fails-after-connecting", log: () => {} });
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(closes.length >= 1, `the transport must be closed on a failing start: ${JSON.stringify(closes)}`);
    // A WITNESS, not an absence: count what actually reaches the wire. The previous version asserted
    // `sendText(...) === undefined`, which witnesses the absence of a return value and tells a reader
    // nothing about whether the send happened. (`… > 0 || true` was worse: it cannot fail at all — the
    // third tautology tonight, after a constant compared to its own literal and a silently-skipped marker.)
    const framesBefore = wireFrames.length;
    session.sendText("hello after the terminal state");
    assert.equal(wireFrames.length, framesBefore, `nothing may reach the wire after a terminal state: ${wireFrames.length} vs ${framesBefore}`);
  } finally { globalThis.WebSocket = realWS; }
});

test("REVISE-2-3: a duplicate `closed` from the provider is ignored — terminal arrives once", () => {
  registerLiveProvider("double-terminal", ({ emit }) => ({
    start() { emit({ type: "ready" }); emit({ type: "closed", code: 1000, reason: "first" }); emit({ type: "closed", code: 1000, reason: "second" }); },
    sendAudio() {}, close() {},
  }));
  const states = [];
  const session = createLiveSession({ provider: "double-terminal", onState: (n, m) => states.push({ n, ...m }), log: () => {} });
  const terminals = states.filter((s) => s.n === "upstream-closed");
  assert.equal(terminals.length, 1, `exactly one terminal event: ${JSON.stringify(states)}`);
  assert.equal(terminals[0].reason, "first", "and it is the first cause, not the second");
});

test("REVISE-2-4: a provider whose close() THROWS still gets a terminal event", () => {
  registerLiveProvider("throws-on-close", ({ emit }) => ({
    start() { emit({ type: "ready" }); },
    sendAudio() {},
    close() { throw new Error("close exploded"); },
  }));
  const states = [];
  const session = createLiveSession({ provider: "throws-on-close", onState: (n, m) => states.push({ n, ...m }), log: () => {} });
  session.close();
  const terminal = states.find((s) => s.n === "upstream-closed");
  assert.ok(terminal, `a throwing close must still notify: ${JSON.stringify(states)}`);
  assert.equal(terminal.code, 1011);
  session.close(); // idempotent: no second terminal event
  assert.equal(states.filter((s) => s.n === "upstream-closed").length, 1, "close() must be idempotent");
});

// ── astra's third pass: the TDZ regression, the stranded transport, and cleanup idempotence ────────────

test("REVISE-3-1: a factory-time `closed` reports ONE terminal event and does not throw (the 805a0df pair)", () => {
  // The regression: as a `const`, `terminate` did not exist when `create()` ran, so a provider emitting
  // `closed` from its FACTORY threw "Cannot access 'terminate' before initialization". Parent 805a0df gave
  // exactly one 1008 event; the cut after it gave none and an exception. This is the pair.
  registerLiveProvider("terminal-in-factory", ({ emit }) => {
    emit({ type: "closed", code: 1008, reason: "refused in the factory" });
    return { start() { emit({ type: "ready" }); }, sendAudio() {}, close() { emit({ type: "closed", code: 1000, reason: "later" }); } };
  });
  const states = [];
  let threw = null;
  let session = null;
  try {
    session = createLiveSession({ provider: "terminal-in-factory", onState: (n, m) => states.push({ n, ...m }), log: () => {} });
  } catch (err) { threw = err; }
  assert.equal(threw, null, `a factory-time terminal must not throw: ${threw?.message}`);
  const terminals = states.filter((s) => s.n === "upstream-closed");
  assert.equal(terminals.length, 1, `exactly one terminal event, as the parent produced: ${JSON.stringify(states)}`);
  assert.equal(terminals[0].code, 1008, "and it carries the factory's cause");
  assert.equal(session.ready, false, "and a later `ready` from the same provider is refused (already terminal)");
  session.close();
});

test("REVISE-3-2: a factory that throws AFTER connecting closes the transport (nothing strands a socket)", () => {
  const closes = [];
  const realWS = globalThis.WebSocket;
  globalThis.WebSocket = class { send() {} close() { closes.push(1); } onclose = null; onmessage = null; onopen = null; onerror = null; };
  try {
    registerLiveProvider("throws-in-factory", ({ transport }) => {
      transport.connect("wss://stub.invalid/vendor", { onEvent: () => {} });
      throw new Error("factory exploded after connecting");
    });
    assert.throws(() => createLiveSession({ provider: "throws-in-factory", log: () => {} }));
    assert.ok(closes.length >= 1, `the acquired transport must be closed: closes=${closes.length}`);
  } finally { globalThis.WebSocket = realWS; }
});

test("REVISE-3-3: repeated public close() calls provider.close ONCE (cleanup is idempotent too)", () => {
  let closeCalls = 0;
  registerLiveProvider("counts-closes", ({ emit }) => ({
    start() { emit({ type: "ready" }); },
    sendAudio() {},
    close() { closeCalls += 1; emit({ type: "closed", code: 1000, reason: "closed" }); },
  }));
  const session = createLiveSession({ provider: "counts-closes", log: () => {} });
  session.close();
  session.close();
  session.close();
  assert.equal(closeCalls, 1, `cleanup must be idempotent as well as the notification: closeCalls=${closeCalls}`);
});
