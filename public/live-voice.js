// public/live-voice.js — the page adapter for the client audio path.
//
// It owns #mic, #voice-state, #voice-ring-wrap and #interrupt while a live
// session is running, and it is deliberately NOT a simulation: every state it
// prints comes from the client's real capture/playback state. If the server
// has no /live route, it says so and does not pretend to listen.
//
// It sets window.__voiceboxLive before the page's other scripts run, so the
// old SpeechRecognition dictation handler (public/fused.js) does not attach,
// and app.js's scripted captions stop while live.
import { createAudioClient } from "./audio-client.js";

window.__voiceboxLive = true;

const $ = (id) => document.getElementById(id);
const mic = $("mic");
const voiceState = $("voice-state");
const ring = $("voice-ring-wrap");
const interrupt = $("interrupt");

let client = null;
let socket = null;
let capturing = false;

function setVoice(next) {
  if (ring) ring.dataset.voice = next;
}

/** The live adapter owns the button's accessible name as soon as it loads. */
function renderMic(snap) {
  if (!mic) return;
  mic.setAttribute("aria-pressed", String(Boolean(snap.capture)));
  mic.setAttribute("aria-label", snap.capture ? "Stop listening (live voice)" : "Start listening (live voice)");
}

const audioClient = createAudioClient({
  workletUrl: "pcm-worklet.js",
  onState: (phase, snap) => {
    if (voiceState) voiceState.textContent = snap.label;
    setVoice(phase === "agent-speaking" ? "speaking" : snap.capture ? "listening" : "off");
    renderMic(snap);
    if (interrupt) interrupt.disabled = phase !== "agent-speaking";
  },
  onText: (text) => {
    // Live means live: the transcript replaces the scripted caption.
    const caption = $("caption");
    if (caption) caption.textContent = text;
  },
  onError: (error, info) => {
    if (voiceState) voiceState.textContent = info?.fatal ? `Live voice failed: ${error.message}` : `Ignored a malformed frame: ${error.message}`;
  },
  onDiagnostic: (d) => {
    if (d?.kind === "socket-closed" && voiceState) voiceState.textContent = "Live voice disconnected · mic off";
  },
});

client = audioClient;

async function startLive() {
  const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/live`;
  if (voiceState) voiceState.textContent = "Connecting to the live session…";
  try {
    socket = new WebSocket(url);
  } catch (error) {
    if (voiceState) voiceState.textContent = `Live voice unavailable: ${error.message}`;
    return;
  }
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no response from the server's /live route")), 4000);
    socket.onopen = () => { clearTimeout(timer); resolve(); };
    socket.onerror = () => { clearTimeout(timer); reject(new Error("the server's /live route is not available")); };
  }).then(
    () => {
      audioClient.attachSocket(socket);
      return audioClient.startCapture();
    },
    (error) => {
      if (voiceState) voiceState.textContent = `Live voice unavailable: ${error.message}. The mic stays off.`;
      setVoice("off");
      renderMic(audioClient.snapshot());
    },
  );
}

renderMic(audioClient.snapshot());
if (voiceState) voiceState.textContent = audioClient.label();

mic?.addEventListener("click", async () => {
  if (!capturing) {
    try {
      await startLive();
    } catch (error) {
      // A refused microphone is a real state, not a silent one: reported here
      // rather than escaping as an unhandled rejection (voicebox-ui's fix,
      // kept). The client also holds a sticky label with the same sentence, so
      // the next state emit re-renders the refusal instead of clobbering it.
      if (voiceState) voiceState.textContent = `The microphone is not available: ${error?.message ?? error}. The text path still works.`;
      setVoice("off");
      renderMic(audioClient.snapshot());
      capturing = false;
      return;
    }
    capturing = audioClient.snapshot().capture;
    return;
  }
  await audioClient.stopCapture();
  try { socket?.close(); } catch { /* already closed */ }
  capturing = false;
  if (voiceState) voiceState.textContent = "Mic off · press to speak";
  setVoice("off");
});

interrupt?.addEventListener("click", () => {
  // Flushes playback only; capture keeps running (that is the tested boundary).
  audioClient.stopReply();
});

window.__voiceboxLiveClient = audioClient;
