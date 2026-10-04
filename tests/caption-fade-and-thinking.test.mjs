import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAudioClient } from "../public/audio-client.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC = path.join(ROOT, "public");

class FakeAudioContext {
  constructor({ sampleRate }) {
    this.sampleRate = sampleRate;
    this.currentTime = 0;
    this.destination = { name: "destination" };
    this.audioWorklet = { addModule: async () => {} };
  }
  createBuffer(_channels, length, rate) {
    return { length, rate, duration: length / rate, copyToChannel() {} };
  }
  createBufferSource() {
    return {
      buffer: null,
      connect() {},
      start() {},
      stop() {},
    };
  }
  createMediaStreamSource() {
    return { connect() {}, disconnect() {} };
  }
  async close() {}
}

test("audio-client: ws.send is never called on sockets in CLOSING (2) or CLOSED (3) readyState", async () => {
  let lastWorkletNode = null;
  class FakeWorkletNode {
    constructor() {
      this.port = { onmessage: null, postMessage() {} };
      lastWorkletNode = this;
    }
    disconnect() {}
  }

  const sent = [];
  const socket = {
    readyState: 1,
    binaryType: "",
    send(data) {
      if (this.readyState >= 2) {
        throw new Error(`WebSocket is already in CLOSING or CLOSED state (readyState=${this.readyState})`);
      }
      sent.push(data);
    },
    close() {
      this.readyState = 3;
    },
  };

  const track = { stop() {} };
  const mediaDevices = {
    getUserMedia: async () => ({ getTracks: () => [track] }),
  };

  const client = createAudioClient({
    socket,
    mediaDevices,
    AudioContextCtor: FakeAudioContext,
    AudioWorkletNodeCtor: FakeWorkletNode,
    onMiniAppCall: () => ({ ok: true, result: { echoed: true } }),
    logger: { warn() {} },
  });

  client.attachSocket(socket);
  client.handleMessage(JSON.stringify({ type: "rate", inputRate: 16000, provider: "gemini" }));
  client.handleMessage(JSON.stringify({ type: "state", state: "ready", model: "gemini-live" }));
  await client.startCapture();
  assert.ok(lastWorkletNode?.port?.onmessage, "worklet onmessage handler attached");

  // While OPEN (readyState = 1), PCM frames, sendText, and sendAudioStreamEnd succeed
  lastWorkletNode.port.onmessage({ data: new Float32Array([0.1, -0.1, 0.05, -0.05]) });
  assert.equal(client.state.framesSent, 1);
  assert.equal(client.sendText("hello"), true);
  assert.equal(client.sendAudioStreamEnd(), true);
  const countWhileOpen = sent.length;
  assert.equal(countWhileOpen, 3);

  // Transition socket to CLOSING (readyState = 2)
  socket.readyState = 2;
  lastWorkletNode.port.onmessage({ data: new Float32Array([0.2, -0.2, 0.2, -0.2]) });
  assert.equal(client.state.framesSent, 1, "framesSent must not increment when socket is CLOSING");
  assert.equal(client.sendText("should not send"), false);
  assert.equal(client.sendAudioStreamEnd(), false);

  // Transition socket to CLOSED (readyState = 3)
  socket.readyState = 3;
  lastWorkletNode.port.onmessage({ data: new Float32Array([0.25, -0.25, 0.25, -0.25]) });
  assert.equal(client.state.framesSent, 1, "framesSent must not increment when socket is CLOSED");
  assert.equal(client.sendText("still closed"), false);
  assert.equal(client.sendAudioStreamEnd(), false);

  // Mini-app result callback also guards against CLOSED socket
  client.handleMessage(JSON.stringify({ type: "mini_app_call", callId: "call_1", name: "ping" }));
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(sent.length, countWhileOpen, "no frames sent while socket is CLOSING or CLOSED");
});

test("markup and styles: #thinking-trace and [data-fading='true'] transitions exist in index.html and style.css", () => {
  const html = readFileSync(path.join(PUBLIC, "index.html"), "utf8");
  const css = readFileSync(path.join(PUBLIC, "style.css"), "utf8");

  assert.match(html, /id="thinking-trace"/, "index.html must include #thinking-trace");
  assert.match(html, /id="thinking-trace-body"/, "index.html must include #thinking-trace-body");
  assert.match(html, /id="thinking-trace-label"/, "index.html must include #thinking-trace-label");

  assert.match(css, /\.thinking-trace\[data-fading="true"\]/, "style.css must style .thinking-trace[data-fading=\"true\"]");
  assert.match(css, /\.caption\[data-fading="true"\]/, "style.css must style .caption[data-fading=\"true\"]");
  assert.match(css, /\.turn-report\[data-fading="true"\]/, "style.css must style .turn-report[data-fading=\"true\"]");
});

test("live-voice: routes thought chunks to #thinking-trace without overwriting #caption, shows user/model transcripts, and fades them out", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });

  const elements = new Map();
  const makeEl = (id, initialHidden = false) => ({
    id,
    hidden: initialHidden,
    textContent: "",
    dataset: {},
    attributes: new Map(),
    listeners: new Map(),
    setAttribute(k, v) {
      this.attributes.set(k, String(v));
    },
    getAttribute(k) {
      return this.attributes.get(k) ?? null;
    },
    addEventListener(type, fn) {
      this.listeners.set(type, fn);
    },
  });

  elements.set("mic", makeEl("mic"));
  elements.set("voice-state", makeEl("voice-state"));
  elements.set("voice-ring-wrap", makeEl("voice-ring-wrap"));
  elements.set("interrupt", makeEl("interrupt"));
  elements.set("caption", makeEl("caption"));
  elements.set("thinking-trace", makeEl("thinking-trace", true));
  elements.set("thinking-trace-body", makeEl("thinking-trace-body"));
  elements.set("thinking-trace-label", makeEl("thinking-trace-label"));

  const liveTexts = [];
  globalThis.window = globalThis;
  globalThis.location = { protocol: "http:", host: "127.0.0.1:8787", search: "" };
  globalThis.document = {
    getElementById: (id) => elements.get(id) ?? null,
    documentElement: { dataset: {} },
  };
  globalThis.__voiceboxOnLiveText = (text, role) => liveTexts.push({ text, role });

  await import(`../public/live-voice.js?test=${Date.now()}`);
  const client = globalThis.__voiceboxLiveClient;
  assert.ok(client, "live-voice attaches __voiceboxLiveClient");

  const caption = elements.get("caption");
  const thinkingTrace = elements.get("thinking-trace");
  const thinkingBody = elements.get("thinking-trace-body");

  // 1. User input-transcript appears in #caption with role="user"
  client.handleMessage(JSON.stringify({ type: "text", role: "input-transcript", text: "How does" }));
  client.handleMessage(JSON.stringify({ type: "text", role: "input-transcript", text: "this work?" }));
  assert.equal(caption.textContent, "How does this work?");
  assert.equal(caption.dataset.role, "user");
  assert.equal(thinkingTrace.hidden, true);

  // 2. Assistant thought chunks reveal #thinking-trace and do NOT overwrite #caption
  client.handleMessage(JSON.stringify({ type: "text", role: "thought", text: "Analyzing the project structure." }));
  client.handleMessage(JSON.stringify({ type: "text", role: "thought", text: "Checking module boundaries." }));
  assert.equal(thinkingTrace.hidden, false, "#thinking-trace becomes visible on thought chunk");
  assert.equal(thinkingTrace.dataset.active, "true");
  assert.equal(thinkingBody.textContent, "Analyzing the project structure. Checking module boundaries.");
  assert.equal(caption.textContent, "How does this work?", "thought chunk must not overwrite #caption");
  assert.ok(liveTexts.some((item) => item.role === "thought"), "thought role forwarded to __voiceboxOnLiveText");

  // 3. Assistant model reply replaces user caption with model caption and schedules thinking trace fade
  client.handleMessage(JSON.stringify({ type: "text", role: "model", text: "Here is the overview." }));
  assert.equal(caption.textContent, "Here is the overview.");
  assert.equal(caption.dataset.role, "model");
  assert.equal(thinkingTrace.dataset.active, "false", "thinking trace deactivates once model speaks");

  // Advance timers 2500ms -> thinking trace enters fading state; +400ms -> hidden & cleared
  t.mock.timers.tick(2500);
  assert.equal(thinkingTrace.dataset.fading, "true", "thinking trace sets data-fading=true after 2.5s");
  t.mock.timers.tick(400);
  assert.equal(thinkingTrace.hidden, true, "thinking trace hides after fade completes");
  assert.equal(thinkingBody.textContent, "", "thinking trace body clears after fade completes");

  // Advance timers so caption reaches 6000ms total -> caption enters fading state; +800ms -> cleared
  t.mock.timers.tick(3100);
  assert.equal(caption.dataset.fading, "true", "caption sets data-fading=true after 6s of inactivity");
  t.mock.timers.tick(800);
  assert.equal(caption.textContent, "", "caption text clears after fade transition");
  assert.equal(caption.dataset.fading, undefined);

  // 4. interaction-status IN_PROGRESS / IDLE also toggles #thinking-trace
  client.handleMessage(JSON.stringify({ type: "state", state: "interaction-status", detail: { status: "IN_PROGRESS" } }));
  assert.equal(thinkingTrace.hidden, false);
  assert.equal(thinkingTrace.dataset.active, "true");
  client.handleMessage(JSON.stringify({ type: "state", state: "interaction-status", detail: { status: "IDLE" } }));
  assert.equal(thinkingTrace.dataset.active, "false");
});

test("fused.js: preserves Reconnected live session status across re-renders, fades #turn-report, and auto-starts #mic on vision start", () => {
  const fused = readFileSync(path.join(PUBLIC, "fused.js"), "utf8");

  assert.match(
    fused,
    /let reconnectedLiveModel = null;/,
    "fused.js tracks reconnectedLiveModel across settings re-renders",
  );
  assert.match(
    fused,
    /reconnectedLiveModel === currentModel\s*\?\s*`Reconnected live session with \$\{currentModel\}\.`/,
    "renderAgentSettings preserves 'Reconnected live session with X.' when reconnectedLiveModel matches currentModel",
  );
  assert.match(
    fused,
    /const REPORT_FADE_DELAY_MS = 8000;/,
    "fused.js defines REPORT_FADE_DELAY_MS for fading out #turn-report",
  );
  assert.match(
    fused,
    /els\.report\.dataset\.fading = "true";/,
    "setReport marks #turn-report with data-fading=\"true\" before clearing",
  );
  assert.match(
    fused,
    /if \(!window\.__voiceboxIsLiveSessionActive\?\.\(\) && els\.mic && els\.mic\.getAttribute\("aria-pressed"\) !== "true"\)\s*\{\s*els\.mic\.click\(\);\s*\}/,
    "startVisionStream auto-triggers els.mic.click() when starting camera or screen share while live session is inactive",
  );
});
