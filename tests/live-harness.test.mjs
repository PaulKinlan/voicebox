import test from "node:test";
import assert from "node:assert/strict";
import { createLiveSession, registerLiveProvider, inputRateRequiredBy } from "../lib/live-harness.mjs";
import { functionDeclarations, commandToAction } from "../lib/commands.mjs";
import { PROVIDERS, DEFAULT_AGENT_SETTINGS, validateAgentSettings } from "../core/agent-settings.ts";

test("live-harness: custom providers declare rates without editing the host; mismatches never forward", () => {
  const audio = [], errors = [];
  const factory = ({ emit }) => ({
    start() { emit({ type: "ready" }); },
    sendAudio(...args) { audio.push(args); },
    close() {},
  });
  registerLiveProvider("custom-rate", factory, { inputRate: 48000 });
  assert.equal(inputRateRequiredBy("custom-rate"), 48000);
  const session = createLiveSession({ provider: "custom-rate", onState: (name, detail) => {
    if (name === "error") errors.push(detail.message);
  } });
  try {
    for (const rate of [16000, 0, NaN, null, "48000"]) assert.equal(session.sendAudio("AQACAA==", rate), false);
    assert.equal(audio.length, 0);
    assert.equal(errors.length, 5);
    assert.equal(session.sendAudio("AQACAA==", 48000), true);
    assert.equal(session.sendAudio("AQACAA=="), true);
    assert.deepEqual(audio, [["AQACAA==", 48000], ["AQACAA==", 48000]]);
  } finally { session.close(); }
  assert.equal(session.sendAudio("AQACAA==", 48000), false);
  assert.throws(() => registerLiveProvider("bad-rate", factory, { inputRate: -1 }), /positive integer/);
  registerLiveProvider("custom-rate", factory);
  assert.throws(() => inputRateRequiredBy("custom-rate"), /has not declared/);
});

test("live-harness: Gemini 3.8 settings only, Thinking budget, and tool failover remains on 3.8", (t) => {
  t.mock.property(process, "env", { ...process.env, GEMINI_API_KEY: "test-key" });
  const sockets = [];
  t.mock.property(globalThis, "WebSocket", class {
    frames = [];
    constructor() { sockets.push(this); }
    send(frame) { this.frames.push(JSON.parse(frame)); }
    close() {}
    frame(data) { this.onmessage({ data: JSON.stringify(data) }); }
  });
  assert.deepEqual(PROVIDERS.gemini.models.map(m => m.id), [
    "models/gemini-3.8-live", "models/gemini-3.8-thinking", "models/gemini-3.8-flash",
  ]);
  for (const model of ["models/gemini-2.0-flash-exp", "models/gemini-2.0-flash"]) {
    assert.equal(validateAgentSettings({ model }, DEFAULT_AGENT_SETTINGS).ok, false);
  }
  for (const { id: model } of PROVIDERS.gemini.models) {
    assert.equal(validateAgentSettings({ model }, DEFAULT_AGENT_SETTINGS).ok, true);
    const session = createLiveSession({ provider: "gemini", model, log() {} });
    try {
      const socket = sockets.at(-1);
      socket.onopen();
      assert.equal(socket.frames[0].setup.model, model);
      assert.equal(socket.frames[0].setup.generationConfig.thinkingConfig.thinkingBudget,
        model === "models/gemini-3.8-thinking" ? 2048 : -1);
    } finally { session.close(); }
  }
  const session = createLiveSession({ provider: "gemini", tools: functionDeclarations(), log() {} });
  try {
    const first = sockets.at(-1);
    first.onopen(); first.frame({ setupComplete: {} });
    session.sendText("list files");
    first.onclose({ code: 1011, reason: "tool turn failed" });
    const fallback = sockets.at(-1);
    assert.notEqual(first, fallback);
    fallback.onopen(); fallback.frame({ setupComplete: {} });
    assert.equal(fallback.frames[0].setup.model, "models/gemini-3.8-flash");
    assert.deepEqual(fallback.frames[1], first.frames[1], "pending turn is replayed");
    fallback.onclose({ code: 1011, reason: "failed again" });
    assert.equal(session.ready, false, "only one failover attempt");
  } finally { session.close(); }
});

test("live-harness: OpenAI catalogue roundtrip, readiness gate, audio rate and interruption through public entry", (t) => {
  t.mock.property(process, "env", { ...process.env, OPENAI_API_KEY: "test-key" });
  let socket;
  t.mock.property(globalThis, "WebSocket", class {
    frames = [];
    constructor(url, options) { socket = this; this.url = url; this.options = options; }
    send(frame) { this.frames.push(JSON.parse(frame)); }
    close() {}
    frame(data) { this.onmessage({ data: JSON.stringify(data) }); }
  });
  const actions = [], audio = [], states = [];
  const session = createLiveSession({ provider: "openai", voice: "coral", tools: functionDeclarations(), log() {},
    onAudioOut: (pcm, mime) => audio.push({ pcm: pcm.toString("base64"), mime }),
    onState: (state) => states.push(state),
    onToolCall(calls) {
      const responses = calls.map(call => {
        const action = commandToAction(call.name, call.args);
        actions.push(action);
        const result = action ? { ok: true, files: [] } : { ok: false, refused: "unknown-command" };
        return { id: call.id, name: call.name, response: { result } };
      });
      assert.equal(session.sendToolResponse(responses), true);
    },
  });
  try {
    assert.equal(socket.options.headers.Authorization, "Bearer test-key");
    assert.match(socket.url, /model=gpt-realtime$/);
    socket.onopen();
    assert.deepEqual(socket.frames[0].session.tools, functionDeclarations().map(tool => ({ type: "function", ...tool })));
    assert.equal(socket.frames[0].session.audio.output.voice, "coral");
    session.sendAudio("AQACAA==", 24000);
    assert.equal(socket.frames.length, 1, "audio gated before ready");
    socket.frame({ type: "session.updated" });
    assert.equal(session.sendAudio("AQACAA==", 16000), false);
    assert.equal(session.sendAudio("AQACAA==", 24000), true);
    assert.deepEqual(socket.frames.at(-1), { type: "input_audio_buffer.append", audio: "AQACAA==" });
    socket.frame({ type: "response.created" });
    socket.frame({ type: "response.function_call_arguments.done", call_id: "call-1", name: "list_files", arguments: "{}" });
    assert.deepEqual(actions, [{ verb: "list", name: "" }]);
    assert.deepEqual(socket.frames.at(-1).item, {
      type: "function_call_output", call_id: "call-1", output: JSON.stringify({ result: { ok: true, files: [] } }),
    });
    socket.frame({ type: "response.done" });
    assert.deepEqual(socket.frames.at(-1), { type: "response.create" });
    for (const type of ["response.output_audio.delta", "response.audio.delta"]) socket.frame({ type, delta: "AQACAA==" });
    assert.deepEqual(audio, Array(2).fill({ pcm: "AQACAA==", mime: "audio/pcm;rate=24000" }));
    session.interrupt();
    assert.deepEqual(socket.frames.at(-1), { type: "response.cancel" });
  } finally { session.close(); }
  assert.equal(states.filter(s => s === "upstream-closed").length, 1);
});
