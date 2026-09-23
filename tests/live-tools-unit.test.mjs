// tests/live-tools-unit.test.mjs — the tool-call seam, pinned without a
// network: the Gemini provider's setup carries the declarations, a toolCall
// frame becomes a host event, and sendToolResponse answers in the vendor's
// shape. A fake transport stands in for the socket, so nothing dials out.
import test from "node:test";
import assert from "node:assert/strict";
import { createGeminiProvider } from "../lib/live-providers/gemini.mjs";
import { createLiveSession, registerLiveProvider } from "../lib/live-session.mjs";
import { functionDeclarations, liveSystemInstruction } from "../lib/commands.mjs";

process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || "unit-test-key";

// A transport that records instead of dialing: connect() captures the event
// handler, send() captures frames, and the test drives vendor frames in.
function fakeTransport() {
  const sent = [];
  let onEvent = null;
  return {
    sent,
    connect(url, next = {}) { onEvent = next.onEvent; return true; },
    send(kind, payload) { sent.push({ kind, payload: JSON.parse(payload) }); return true; },
    close() {},
    get connected() { return true; },
    // test drives:
    open() { onEvent({ kind: "open" }); },
    frame(msg) { onEvent({ kind: "message", data: JSON.stringify(msg) }); },
  };
}

test("the agent's voice and instruction ride the Gemini setup — voice in speechConfig, instruction before the tools text", () => {
  const transport = fakeTransport();
  createGeminiProvider({
    emit() {}, log() {}, transport,
    instruction: "BASE + tone", systemInstruction: "the tools instruction", voice: "Kore",
  });
  transport.open();
  const setup = transport.sent.find((s) => s.kind === "handshake").payload.setup;
  assert.equal(setup.generationConfig.speechConfig?.voiceConfig?.prebuiltVoiceConfig?.voiceName, "Kore");
  const parts = setup.systemInstruction?.parts ?? [];
  assert.equal(parts.length, 2, "the agent instruction and the tools instruction are both there");
  assert.equal(parts[0].text, "BASE + tone", "the agent's instruction comes first — the base the tone cannot replace");
  assert.equal(parts[1].text, "the tools instruction");
});

test("no voice and no instruction means no fields are invented", () => {
  const transport = fakeTransport();
  createGeminiProvider({ emit() {}, log() {}, transport });
  transport.open();
  const setup = transport.sent.find((s) => s.kind === "handshake").payload.setup;
  assert.equal(setup.generationConfig.speechConfig, undefined);
  assert.equal(setup.systemInstruction, undefined);
});

test("the setup handshake declares the tools and the system instruction", () => {
  const transport = fakeTransport();
  const provider = createGeminiProvider({
    emit() {}, log() {}, transport,
    tools: functionDeclarations(),
    systemInstruction: liveSystemInstruction(),
  });
  assert(provider);
  transport.open();
  const handshake = transport.sent.find((s) => s.kind === "handshake");
  assert(handshake, "no handshake was sent");
  const decls = handshake.payload.setup.tools?.[0]?.functionDeclarations;
  assert(decls, "the setup block declares no tools — the model has no hands");
  assert(decls.some((d) => d.name === "write_file"), "write_file is declared");
  const sys = handshake.payload.setup.systemInstruction?.parts?.[0]?.text;
  assert.match(sys ?? "", /root-not-declared/, "the instruction carries the refusal vocabulary");
});

test("a provider with NO tools declared still handshakes (the gate stays optional)", () => {
  const transport = fakeTransport();
  createGeminiProvider({ emit() {}, log() {}, transport });
  transport.open();
  const handshake = transport.sent.find((s) => s.kind === "handshake");
  assert.equal(handshake.payload.setup.tools, undefined, "no tools given — no tools field invented");
});

test("a toolCall frame becomes a tool-call event with id, name and args", () => {
  const transport = fakeTransport();
  const events = [];
  createGeminiProvider({ emit: (e) => events.push(e), log() {}, transport, tools: functionDeclarations() });
  transport.open();
  transport.frame({ toolCall: { functionCalls: [{ id: "fc-1", name: "write_file", args: { name: "a.txt", content: "hi" } }] } });
  const call = events.find((e) => e.type === "tool-call");
  assert(call, "the toolCall frame was not emitted as an event");
  assert.deepEqual(call.calls, [{ id: "fc-1", name: "write_file", args: { name: "a.txt", content: "hi" } }]);
});

test("sendToolResponse answers in the vendor's shape, ids echoed", () => {
  const transport = fakeTransport();
  const provider = createGeminiProvider({ emit() {}, log() {}, transport });
  provider.sendToolResponse([{ id: "fc-1", name: "write_file", response: { result: { ok: true } } }]);
  const answer = transport.sent.find((s) => s.kind === "control");
  assert(answer, "no toolResponse was sent");
  assert.deepEqual(answer.payload, {
    toolResponse: { functionResponses: [{ id: "fc-1", name: "write_file", response: { result: { ok: true } } }] },
  });
});

test("the host routes a provider's tool-call to onToolCall, and sendToolResponse reaches the provider", async () => {
  const received = [];
  const answered = [];
  registerLiveProvider("unit-fake", ({ emit }) => ({
    start() {
      emit({ type: "ready" });
      emit({ type: "tool-call", calls: [{ id: "x", name: "list_files", args: {} }] });
    },
    sendToolResponse(responses) { answered.push(...responses); return true; },
  }));
  const session = createLiveSession({ provider: "unit-fake", onToolCall: (calls) => received.push(...calls), log() {} });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(received.length, 1, "the host did not route the tool call");
  assert.equal(received[0].name, "list_files");
  assert.equal(session.sendToolResponse([{ id: "x", name: "list_files", response: { result: { ok: true } } }]), true);
  assert.equal(answered.length, 1, "the answer did not reach the provider");
  session.close();
});

test("a provider WITHOUT sendToolResponse gets a named log, not silence", async () => {
  const logs = [];
  registerLiveProvider("unit-mute", ({ emit }) => ({ start() { emit({ type: "ready" }); } }));
  const session = createLiveSession({ provider: "unit-mute", log: (l) => logs.push(l) });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(session.sendToolResponse([{ id: "x", name: "list_files", response: {} }]), false);
  assert(logs.some((l) => l.includes("cannot answer a tool call")), "the incapacity is named in the log");
  session.close();
});

test("a tool-call BEFORE ready is NOT routed — an act that cannot be answered must not start", async () => {
  const logs = [];
  const received = [];
  registerLiveProvider("unit-early", ({ emit }) => ({
    start() {
      // The review's case: a call routed pre-ready would run its side effect and the
      // toolResponse would refuse — the act happened and the model never heard.
      emit({ type: "tool-call", calls: [{ id: "early", name: "write_file", args: { name: "x", content: "y" } }] });
      emit({ type: "ready" });
    },
  }));
  const session = createLiveSession({ provider: "unit-early", onToolCall: (calls) => received.push(...calls), log: (l) => logs.push(l) });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(received.length, 0, "a pre-ready tool call was routed — its side effect would have run unanswered");
  assert(logs.some((l) => l.includes("before ready")), "the gate's refusal is named in the log");
  session.close();
});

test("a malformed toolCall frame costs a frame WITH A NAME — never a throw, never silence", () => {
  const transport = fakeTransport();
  const events = [];
  const logs = [];
  createGeminiProvider({ emit: (e) => events.push(e), log: (l) => logs.push(l), transport, tools: functionDeclarations() });
  transport.open();
  transport.frame({ toolCall: { functionCalls: { not: "an array" } } });
  transport.frame({ toolCall: { functionCalls: [] } });
  transport.frame({ toolCall: {} });
  assert.equal(events.filter((e) => e.type === "tool-call").length, 0, "a malformed tool-call was emitted");
  assert.equal(logs.filter((l) => l.includes("dropped") || l.includes("not an array") || l.includes("no function calls")).length, 3, `each malformed frame was named in the log: ${JSON.stringify(logs)}`);
});

test("a tool call with non-object args is answered with {}, not a throw downstream", () => {
  const transport = fakeTransport();
  const events = [];
  createGeminiProvider({ emit: (e) => events.push(e), log() {}, transport, tools: functionDeclarations() });
  transport.open();
  transport.frame({ toolCall: { functionCalls: [{ id: "fc-9", name: "list_files", args: "oops" }] } });
  const call = events.find((e) => e.type === "tool-call");
  assert(call, "a well-formed call with junk args should still arrive — the door refuses by rule, not by crash");
  assert.deepEqual(call.calls[0].args, {});
});
