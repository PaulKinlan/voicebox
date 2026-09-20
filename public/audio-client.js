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
import { floatToPcm16, pcm16ToFloat, isPcm16, energy } from "./pcm.js";

const PLAYBACK_RATE = 24000; // provider output, PCM16 (Gemini Live)
const CAPTURE_RATE = 16000; // what we send; the browser resamples the device

// The two meters the page draws — the person's own voice, and the agent's.
// 28 bars of recent input energy, 64 samples around the circle for the output,
// both taken from the PCM already in hand rather than an AnalyserNode, so the
// visual tracks what was actually captured and what is actually playing.
const INPUT_BARS = 28;
const OUTPUT_BARS = 64;
const LEVEL_HOLD_MS = 120; // after this, a meter with no new data starts falling

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
  onLevel = () => {},
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
    sinkId: "", // the output actually in use, once a route has been applied
    providerError: null, // a NONTERMINAL provider error: recorded, never treated as an end
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
  // Meter state. `capture` is the newest input energy; `output` is one energy
  // per sample around the circle. Both are smoothed before they are read, so a
  // level reads as a level and not as a flicker.
  const meter = {
    input: new Float32Array(INPUT_BARS),
    output: new Float32Array(OUTPUT_BARS),
    smoothInput: new Float32Array(INPUT_BARS),
    smoothOutput: new Float32Array(OUTPUT_BARS),
    capture: 0,
    lastAt: 0,
    lastEmit: 0,
    // Playback timeline: [{ start, end, value }] in playCtx time. The output
    // meter follows what is PLAYING, never the queue — a buffered chunk the
    // person has not heard yet must not move the picture (astra's review,
    // 2026-09-19: "never driven by future buffered chunks").
    playing: [],
    lastPlayed: null,
  };

  function shiftInto(ring, value) {
    ring.copyWithin(0, 1);
    ring[ring.length - 1] = value;
  }

  function smooth(ring, display, blend) {
    for (let i = 0; i < ring.length; i++) display[i] += (ring[i] - display[i]) * blend;
  }

  /** Called when new audio arrives, from either direction. */
  function noteInput(value) {
    const now = Date.now();
    shiftInto(meter.input, value);
    smooth(meter.input, meter.smoothInput, 0.35);
    meter.capture = Math.max(value, meter.capture * 0.7);
    meter.lastAt = now;
    if (now - meter.lastEmit > 33) {
      meter.lastEmit = now;
      onLevel(level());
    }
  }

  /** A buffer the person WILL hear, recorded against when it is due. */
  function scheduleOutput(start, duration, value) {
    meter.playing.push({ start, end: start + duration, value });
    if (meter.playing.length > 24) meter.playing.shift();
  }

  /** Move the output ring only for audio that has actually started playing. */
  function followPlayback() {
    const now = playCtx ? playCtx.currentTime : 0;
    while (meter.playing.length && meter.playing[0].end <= now) meter.playing.shift();
    const current = meter.playing[0];
    if (!current || current.start > now) return;
    if (current === meter.lastPlayed) return;
    meter.lastPlayed = current;
    shiftInto(meter.output, current.value);
    smooth(meter.output, meter.smoothOutput, 0.3);
    meter.lastAt = Date.now();
    onLevel(level());
  }

  /** Playback was flushed or died: the ring stops with it. */
  function forgetPlayback() {
    meter.playing.length = 0;
    meter.lastPlayed = null;
  }

  /** The current meter reading. Decays on read, so silence falls away. */
  function level() {
    followPlayback();
    const idle = Date.now() - meter.lastAt > LEVEL_HOLD_MS;
    if (idle) {
      const fall = 0.86;
      for (let i = 0; i < meter.smoothInput.length; i++) meter.smoothInput[i] *= fall;
      for (let i = 0; i < meter.smoothOutput.length; i++) meter.smoothOutput[i] *= fall;
      meter.capture *= fall;
    }
    return { capture: meter.capture, input: meter.smoothInput, output: meter.smoothOutput };
  }
  let ws = socket;

  const snapshot = () => ({ ...state, label: label() });

  function label() {
    // A refused microphone STAYS on screen until the next user action. A later
    // state emit (ready/listening) must not overwrite the explanation a moment
    // after the user was told the truth (found by voicebox-ui, 2026-09-19).
    if (state.captureError) return state.captureError;
    // A provider error does NOT mean the session is over — the host keeps it
    // live, so the sentence has to say what is still true rather than the
    // reassuring thing. Which of the two sentences applies is read from the
    // host-reported state (ready + capture), never assumed.
    if (state.providerError && state.ready) {
      return state.capture
        ? `The model reported an error (${state.providerError.reason}) · your microphone is still on and its audio is still being sent`
        : `The model reported an error (${state.providerError.reason}) · your microphone is off, so nothing is being sent`;
    }
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
        state.providerError = null; // recovered: the model answered again
        state.model = msg.model ?? "";
        state.gatedFrames = Number(msg.detail?.gatedFrames ?? 0);
        emit(state.playbackActive ? "agent-speaking" : "listening", { ready: true, model: state.model, gatedFrames: state.gatedFrames });
        return;
      }
      if (msg.state === "upstream-closed") {
        endSession(msg.state, msg.detail);
        return;
      }
      if (msg.state === "error") {
        // NONTERMINAL, by the host's own contract. lib/live-session.mjs's event
        // set says "error — { message } — reported, not fatal" and "closed —
        // terminal, and the only terminal event".
        //
        // This branch used to call endSession() and print "Your microphone is
        // still on, but nothing is listening" — while the host's ready state
        // stayed true and the vendor KEPT RECEIVING the microphone's frames
        // (measured: host ready=true, vendorFrames still climbing, label
        // claiming otherwise; astra's browser receipt, 2026-09-20). That is a
        // privacy claim contradicted by the system's own behaviour, shown to
        // someone at the moment they are deciding whether to trust a live mic.
        //
        // The sentence below is derived from the host's state, not guessed:
        // the error is recorded, the session is left running exactly as the
        // host leaves it, and label() says which of the two true things applies.
        const reason = String(msg.detail?.message ?? msg.detail?.reason ?? "the model reported an error");
        state.providerError = { reason, provider: String(msg.detail?.provider ?? state.model ?? ""), at: Date.now() };
        state.lastError = reason;
        onError(new Error(reason), { fatal: false, providerError: true });
        onDiagnostic({ kind: "provider-error", reason, provider: state.providerError.provider });
        emit(state.playbackActive ? "agent-speaking" : state.capture ? "listening" : "idle", { providerError: true, reason });
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
    scheduleOutput(when, buffer.duration, energy(floats));
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
    // NO payload-byte heuristic here. A previous version refused any binary frame
    // whose first byte was "{" (0x7B) as a control frame in the wrong slot — but
    // that byte is the low byte of the first sample, so ~1 frame in 256 is
    // legitimate audio, and `TextDecoder` is lossy by default (U+FFFD), so the
    // "decode and look" guess could never be checked. The WebSocket opcode
    // already distinguishes text from binary and the dispatch above branches on
    // it; a control frame in the binary slot is a server bug, not something the
    // client should guess about by discarding good audio. (Paul, 2026-09-19.)
    enqueuePcm16(bytes);
  }

  /** The upstream session is gone. Say so; never keep claiming "connected". */
  function endSession(kind, detail) {
    state.sessionEnded = true;
    state.ready = false;
    state.providerError = null;
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
    forgetPlayback();
    state.playbackActive = false;
    emit("error", { sessionEnded: true, kind, detail });
    onDiagnostic({ kind: "session-ended", state: kind, detail });
  }

  function attachSocket(next) {
    // A new socket is a new session: clear the ended state from the last one.
    state.sessionEnded = false;
    state.providerError = null;
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

  /**
   * Gesture-driven: the caller invokes this from a real user action. A
   * preferred device id is a CONSTRAINT, never a silent fallback: if the chosen
   * microphone is gone, `deviceId: { exact }` makes getUserMedia refuse, and the
   * page names the missing device instead of quietly capturing from another one.
   */
  async function startCapture({ deviceId = null } = {}) {
    if (state.capture) return;
    state.captureError = ""; // a new user action clears the sticky refusal
    emit("starting");
    try {
      if (!mediaDevices?.getUserMedia || !AudioContextCtor || !AudioWorkletNodeCtor) {
        throw new Error("this browser has no microphone capture (getUserMedia/AudioContext/AudioWorklet unavailable)");
      }
      stream = await mediaDevices.getUserMedia({ audio: deviceId ? { deviceId: { exact: deviceId } } : true });
      captureCtx = new AudioContextCtor({ sampleRate: CAPTURE_RATE });
      await captureCtx.audioWorklet.addModule(workletUrl);
      captureNode = new AudioWorkletNodeCtor(captureCtx, "pcm-capture");
      captureSource = captureCtx.createMediaStreamSource(stream);
      captureSource.connect(captureNode);
      captureNode.port.onmessage = (event) => {
        const frame = event.data;
        if (!(frame instanceof Float32Array) || frame.length === 0) return;
        try {
          noteInput(energy(frame));
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

  /** True when this browser can route output at all. */
  function canChooseOutput() {
    return Boolean(AudioContextCtor?.prototype?.setSinkId);
  }

  /**
   * Route playback to a chosen output, or report that it could not be done.
   * Returns { ok, sinkId } — the CALLER decides what to say when it fails; this
   * never falls back to another device on its own, because a private reply
   * moving to the speakers without being asked is the audible version of a
   * label that lies.
   */
  async function setOutputDevice(deviceId) {
    if (!canChooseOutput()) return { ok: false, reason: "this browser cannot choose an output" };
    try {
      playCtx ??= new AudioContextCtor({ sampleRate: PLAYBACK_RATE });
      await playCtx.setSinkId(deviceId ?? "");
      state.sinkId = playCtx.sinkId ?? deviceId ?? "";
      emit(state.playbackActive ? "agent-speaking" : state.capture ? "listening" : "idle");
      return { ok: true, sinkId: state.sinkId };
    } catch (error) {
      return { ok: false, reason: `${error?.name ?? "Error"}: ${error?.message ?? error}` };
    }
  }

  /** Stop playback without touching capture (used when a chosen output leaves). */
  function stopPlayback() {
    return stopReply();
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
    forgetPlayback();
    state.playbackActive = false;
    emit(state.capture ? "listening" : "idle", { flushed: true });
    return { flushed: true, captureRunning: state.capture };
  }

  return {
    attachSocket,
    handleMessage,
    startCapture,
    canChooseOutput,
    setOutputDevice,
    stopPlayback,
    level,
    stopCapture,
    stopReply,
    snapshot,
    label,
    get state() { return snapshot(); },
  };
}
