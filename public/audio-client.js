// public/audio-client.js — the browser's audio path, framework-free and
// DOM-free so it can be driven by a fake AudioContext in tests.
//
// Responsibilities (coord's split, 2026-09-19): capture the microphone to
// PCM16 16 kHz and send it; play the model's PCM16 24 kHz back; keep a mic
// state that TELLS THE TRUTH. The readiness gate lives server-side (the
// session counts audio received before setupComplete — isocan's 192/208
// lesson); this client never hides the wait and never claims readiness it
// has not seen.
//
// Two properties are deliberately decoupled, and the tests assert it:
//   * stopReply() flushes PLAYBACK and nothing else — capture keeps running.
//   * the label is derived from the real capture/playback state; when the
//     agent speaks and the microphone is still on, it says so ("you can
//     interrupt") rather than printing "microphone is off" for a track that
//     is live. Two true statements beat one convenient false one.
import { floatToPcm16, pcm16ToFloat, isPcm16 } from "./pcm.js";

const PLAYBACK_RATE = 24000; // provider output, PCM16 (Gemini Live)
const CAPTURE_RATE = 16000; // what we send; the browser resamples the device

export function createAudioClient({
  socket = null,
  mediaDevices = globalThis.navigator?.mediaDevices ?? null,
  AudioContextCtor = globalThis.AudioContext ?? globalThis.webkitAudioContext ?? null,
  AudioWorkletNodeCtor = globalThis.AudioWorkletNode ?? null,
  workletUrl = "pcm-worklet.js",
  onState = () => {},
  onText = () => {},
  onError = () => {},
  onDiagnostic = () => {},
  logger = console,
} = {}) {
  const state = {
    phase: "idle", // idle | starting | listening | agent-speaking | error
    ready: false, // the server said setupComplete
    sessionEnded: false, // the upstream (model) session is gone
    model: "",
    gatedFrames: 0, // how many frames the server held before the gate opened
    capture: false,
    playbackActive: false,
    framesSent: 0,
    framesReceived: 0,
    framesRejected: 0,
    framesIgnoredAfterEnd: 0,
    captureError: "", // sticky refusal: survives later state emits until the next user action
    lastError: "",
  };
  let captureCtx = null;
  let captureNode = null;
  let captureSource = null;
  let stream = null;
  let playCtx = null;
  let nextStart = 0;
  const sources = new Set();
  let ws = socket;

  const snapshot = () => ({ ...state, label: label() });

  function label() {
    // A refused microphone STAYS on screen until the next user action. A later
    // state emit (ready/listening) must not overwrite the explanation a moment
    // after the user was told the truth (found by voicebox-ui, 2026-09-19).
    if (state.captureError) return state.captureError;
    if (state.phase === "error") return state.lastError || "Audio error";
    if (state.phase === "starting") return state.capture ? "Connecting…" : "Press to speak";
    if (state.phase === "agent-speaking") {
      return state.capture
        ? "Agent speaking · your microphone is on (interrupt any time)"
        : "Agent speaking · your microphone is off";
    }
    // listening / idle: the mic state is the truth, and so is the gate.
    if (!state.capture) return "Mic off · press to speak";
    if (!state.ready) return `Waiting for the model · ${state.gatedFrames} frame(s) held until setup completes`;
    return "Listening — speak now";
  }

  function emit(phase, detail = {}) {
    if (phase) state.phase = phase;
    onState(state.phase, snapshot(), detail);
  }

  /** A frame or control message we refuse without dropping the connection. */
  function reject(message, detail = {}) {
    state.framesRejected += 1;
    state.lastError = message;
    logger.warn?.(`[audio-client] refused: ${message}`);
    onError(new Error(message), { fatal: false, ...detail });
    onDiagnostic({ kind: "refused", message, ...detail });
  }

  function handleControl(text) {
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      reject(`control frame is not JSON (${text.slice(0, 60)})`, { frameKind: "text" });
      return;
    }
    if (msg?.type === "state") {
      if (msg.state === "ready") {
        state.ready = true;
        state.model = msg.model ?? "";
        state.gatedFrames = Number(msg.detail?.gatedFrames ?? 0);
        emit(state.playbackActive ? "agent-speaking" : "listening", { ready: true, model: state.model, gatedFrames: state.gatedFrames });
        return;
      }
      if (msg.state === "upstream-closed" || msg.state === "error") {
        endSession(msg.state, msg.detail);
        return;
      }
      onDiagnostic({ kind: "state", state: msg.state, detail: msg.detail });
      return;
    }
    if (msg?.type === "text") {
      onText(String(msg.text ?? ""), msg.kind ?? "model");
      return;
    }
    if (msg?.type === "error") {
      reject(String(msg.message ?? "server error"), { frameKind: "control-error" });
      return;
    }
    reject(`unrecognised control frame type ${JSON.stringify(msg?.type ?? null)}`, { frameKind: "control-unknown" });
  }

  function enqueuePcm16(bytes) {
    if (state.sessionEnded) {
      // Audio from a session that has ended is stale; never play it silently.
      state.framesIgnoredAfterEnd += 1;
      return;
    }
    if (!AudioContextCtor) {
      reject("no AudioContext: cannot play model audio", { frameKind: "binary" });
      return;
    }
    state.framesReceived += 1;
    playCtx ??= new AudioContextCtor({ sampleRate: PLAYBACK_RATE });
    const floats = pcm16ToFloat(bytes);
    const buffer = playCtx.createBuffer(1, floats.length, PLAYBACK_RATE);
    buffer.copyToChannel(floats, 0);
    const source = playCtx.createBufferSource();
    source.buffer = buffer;
    source.connect(playCtx.destination);
    const when = Math.max(playCtx.currentTime + 0.02, nextStart);
    source.start(when);
    nextStart = when + buffer.duration;
    sources.add(source);
    source.onended = () => {
      sources.delete(source);
      if (sources.size === 0) {
        state.playbackActive = false;
        emit(state.capture ? "listening" : "idle");
      }
    };
    if (!state.playbackActive) {
      state.playbackActive = true;
      emit("agent-speaking");
    }
  }

  /** One frame from the socket: string = control, binary = model audio. */
  function handleMessage(data) {
    if (typeof data === "string") {
      handleControl(data);
      return;
    }
    const bytes = data instanceof ArrayBuffer
      ? data
      : ArrayBuffer.isView(data)
      ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
      : null;
    if (bytes === null) {
      reject(`unsupported frame type ${Object.prototype.toString.call(data)}`);
      return;
    }
    if (bytes.byteLength === 0) {
      // An empty frame is data we cannot use; count it, do not crash, stay open.
      reject("empty binary frame", { frameKind: "binary", bytes: 0 });
      return;
    }
    if (!isPcm16(bytes)) {
      reject(`binary frame is not even-length PCM16 (${bytes.byteLength} bytes)`, { frameKind: "binary", bytes: bytes.byteLength });
      return;
    }
    // A control frame that arrived in the BINARY slot would otherwise be played
    // as noise: a JSON object's first byte is "{". Name it; keep the socket.
    if (new Uint8Array(bytes)[0] === 0x7b) {
      let text = "";
      try { text = new TextDecoder().decode(bytes); } catch { /* not text after all */ }
      if (text.trimStart().startsWith("{")) {
        reject(`control frame arrived in the binary slot (${text.slice(0, 60)})`, { frameKind: "binary-as-json", bytes: bytes.byteLength });
        return;
      }
    }
    enqueuePcm16(bytes);
  }

  /** The upstream session is gone. Say so; never keep claiming "connected". */
  function endSession(kind, detail) {
    state.sessionEnded = true;
    state.ready = false;
    const reason = String(detail?.reason ?? detail?.message ?? kind);
    state.lastError =
      `Live session ended (${reason}). ` +
      (state.capture ? "Your microphone is still on, but nothing is listening. " : "") +
      "Press the mic to start a new session.";
    // A dead session must not keep playing queued audio.
    for (const source of sources) {
      try { source.onended = null; source.stop(); } catch { /* already stopped */ }
    }
    sources.clear();
    nextStart = 0;
    state.playbackActive = false;
    emit("error", { sessionEnded: true, kind, detail });
    onDiagnostic({ kind: "session-ended", state: kind, detail });
  }

  function attachSocket(next) {
    // A new socket is a new session: clear the ended state from the last one.
    state.sessionEnded = false;
    state.lastError = "";
    ws = next;
    if (!ws) return;
    ws.binaryType = "arraybuffer";
    ws.onmessage = (event) => handleMessage(event.data);
    ws.onerror = () => reject("websocket error", { frameKind: "socket" });
    ws.onclose = (event) => {
      state.ready = false;
      if (!state.sessionEnded) {
        // The page's own socket is gone: that is also not "listening".
        endSession("socket-closed", { reason: `connection closed${event?.code ? ` (${event.code})` : ""}` });
      }
      onDiagnostic({ kind: "socket-closed", code: event?.code, reason: event?.reason });
    };
  }

  /** Gesture-driven: the caller invokes this from a real user action. */
  async function startCapture() {
    if (state.capture) return;
    state.captureError = ""; // a new user action clears the sticky refusal
    emit("starting");
    try {
      if (!mediaDevices?.getUserMedia || !AudioContextCtor || !AudioWorkletNodeCtor) {
        throw new Error("this browser has no microphone capture (getUserMedia/AudioContext/AudioWorklet unavailable)");
      }
      stream = await mediaDevices.getUserMedia({ audio: true });
      captureCtx = new AudioContextCtor({ sampleRate: CAPTURE_RATE });
      await captureCtx.audioWorklet.addModule(workletUrl);
      captureNode = new AudioWorkletNodeCtor(captureCtx, "pcm-capture");
      captureSource = captureCtx.createMediaStreamSource(stream);
      captureSource.connect(captureNode);
      captureNode.port.onmessage = (event) => {
        const frame = event.data;
        if (!(frame instanceof Float32Array) || frame.length === 0) return;
        try {
          ws?.send(floatToPcm16(frame));
          state.framesSent += 1;
        } catch (error) {
          reject(`could not send a captured frame: ${error?.message ?? error}`, { frameKind: "capture" });
        }
      };
      state.capture = true;
      emit(state.playbackActive ? "agent-speaking" : "listening");
    } catch (error) {
      // Report it here, not as an unhandled rejection: the same sentence is
      // written by the page adapter's catch, so both paths agree.
      state.captureError = `The microphone is not available: ${error?.message ?? error}. The text path still works.`;
      state.lastError = state.captureError;
      emit("error", { captureFailed: true });
    }
  }

  /** The user turns the microphone off (or the page unloads). */
  async function stopCapture() {
    state.capture = false;
    try { captureNode?.disconnect(); } catch { /* already gone */ }
    try { captureSource?.disconnect(); } catch { /* already gone */ }
    for (const track of stream?.getTracks?.() ?? []) track.stop();
    stream = null;
    try { await captureCtx?.close?.(); } catch { /* already closed */ }
    captureCtx = null;
    captureNode = null;
    captureSource = null;
    emit(state.playbackActive ? "agent-speaking" : "idle");
  }

  /** "Stop reply": flush QUEUED PLAYBACK only. Capture is never touched. */
  function stopReply() {
    for (const source of sources) {
      try { source.onended = null; source.stop(); } catch { /* already stopped */ }
    }
    sources.clear();
    nextStart = 0;
    state.playbackActive = false;
    emit(state.capture ? "listening" : "idle", { flushed: true });
    return { flushed: true, captureRunning: state.capture };
  }

  return {
    attachSocket,
    handleMessage,
    startCapture,
    stopCapture,
    stopReply,
    snapshot,
    label,
    get state() { return snapshot(); },
  };
}
