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
    ["close", "gatedFrames", "interrupt", "provider", "ready", "sendAudio", "sendText"],
    `the page's surface must be exactly the contract: ${exposed.join(", ")}`,
  );
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
