// public/live-voice.js — the page adapter for the client audio path.
//
// It owns #mic, #voice-state, #voice-ring-wrap and #interrupt while a live
// session is running, and it is deliberately NOT a simulation: every state it
// prints comes from the client's real capture/playback state. If the server
// has no /live route, it says so and does not pretend to listen.
//
// It sets window.__voiceboxLive before the page's other scripts run, so the
// old SpeechRecognition dictation handler (public/fused.js) does not attach,
// and the page's scripted captions stop while live.
import { createAudioClient } from "./audio-client.js";
import { createCaptionFade } from "./caption-fade.mjs";
import { debugEnabled, recordDebug, observeDebugSocket } from "./debug-transcript.js";

window.__voiceboxLive = true;

// The live caption fades out after the turn has been quiet for the dwell
// (voicebox-beads-drcy): visible while the user speaks and while the model
// replies, then smoothly gone. New text resets the fade; clearing the caption
// (a new session) cancels it entirely.
const captionFade = createCaptionFade(() => document.getElementById("caption"));

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

function formatLiveErrorMessage(raw) {
  const msg = String(raw ?? "").trim();
  if (!msg) return "Live voice encountered an unexpected error.";
  if (/is not found for API version|not supported for bidiGenerateContent/i.test(msg)) {
    return `Selected model is unavailable for live audio (${msg}). Open Settings to pick a supported live model.`;
  }
  return msg;
}

const audioClient = createAudioClient({
  workletUrl: "pcm-worklet.js",
  onState: (phase, snap) => {
    if (voiceState) voiceState.textContent = snap.label;
    setVoice(phase === "agent-speaking" ? "speaking" : snap.capture ? "listening" : "off");
    renderMic(snap);
    if (interrupt) interrupt.disabled = phase !== "agent-speaking";
  },
  onToolCalls: (calls, frame) => {
    // THE ROOM OWNS THE LISTING, so the frame goes to a hook rather than to an import — and the hook is
    // called at FRAME TIME, so whichever of these two scripts loads first does not matter. A tool call is
    // the only event that can change the folder without the page asking (voicebox-beads-a93).
    // The RESULT frame (type "tool") rides the second argument: it carries the execution latency the
    // room's shelf rows show (voicebox-beads-rgvi).
    window.__voiceboxOnToolCalls?.(calls, frame);
  },
  onTask: (task) => {
    // THE TASK CARD: forward the live task handle to the room component (voicebox-beads-8fv.4)
    window.__voiceboxOnTask?.(task);
  },
  onMiniApp: (miniApp) => {
    // THE MINI-APP CONTAINER: mount the interactive mini-app in the room (voicebox-beads-5h1)
    window.__voiceboxOnMiniApp?.(miniApp);
  },
  onMiniAppCall: async (msg) => {
    if (window.__voiceboxMiniApp?.callTool) {
      return await window.__voiceboxMiniApp.callTool(msg.name, msg.args ?? {});
    }
    return { ok: false, error: "no active mini-app in the room" };
  },
  onText: (text, role) => {
    // Live means live: the transcript replaces the scripted caption.
    const caption = $("caption");
    if (caption) caption.textContent = text;
    captionFade.reset();
    window.__voiceboxOnLiveText?.(text, role);
  },
  onError: (error, info) => {
    const friendly = formatLiveErrorMessage(error?.message ?? error);
    recordDebug({ type: "audio.error", error: friendly, info });
    if (voiceState) voiceState.textContent = info?.fatal ? `Live voice failed: ${friendly}` : `Ignored a malformed frame: ${friendly}`;
  },
  onDiagnostic: (d) => {
    recordDebug({ type: "audio.diagnostic", detail: d });
    if (d?.kind === "state" && (d?.state === "turn-complete" || d?.state === "interrupt")) {
      window.__voiceboxOnLiveTurnComplete?.();
    }
    if (d?.kind === "socket-closed" && voiceState) {
      window.__voiceboxOnLiveTurnComplete?.();
      voiceState.textContent = capturing
        ? "Live voice disconnected: machine-closed · mic off"
        : "Live voice disconnected · mic off";
    }
  },
});

client = audioClient;

/**
 * WHY did the upgrade fail? Three causes, and one message for all of them named
 * the wrong one: on 2026-09-19 the API server was mid-restart, the page said
 * "the server's /live route is not available", and Paul reasonably read that as
 * keys or models. The health route is what tells the cases apart — if the server
 * answers it, the server is up and the upgrade itself was refused; if it does
 * not, the server is down or restarting and the honest advice is "try again".
 */
async function explainFailedUpgrade() {
  try {
    const response = await fetch("/api/health", { cache: "no-store" });
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      if (body?.refused) return { text: `${body.refused} (fix the file)`, transient: false };
      return { text: `the server answered ${response.status} for /api/health (machine-refused)`, transient: false };
    }
    return { text: "the server is running but refused the /live upgrade (machine-refused)", transient: false };
  } catch {
    return { text: "the local server is not answering (machine-unreachable — fix the host)", transient: true };
  }
}

async function startLive() {
  const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/live${debugEnabled ? "?debug=1" : ""}`;
  const caption = $("caption");
  if (caption) caption.textContent = "";
  captionFade.clear();
  if (voiceState) voiceState.textContent = "Connecting to the live session…";
  try {
    socket = new WebSocket(url);
    observeDebugSocket(socket);
  } catch (error) {
    recordDebug({ type: "live.connect.error", error: error.message });
    if (voiceState) voiceState.textContent = `Live voice unavailable: ${error.message}`;
    return;
  }
  // The server's answer about the folder's instruction. It is a STATE, not speech: record it for the
  // debug transcript and put it on the document so the acceptance harness can read what was applied
  // without inferring it from the file on disk.
  socket.addEventListener("message", (event) => {
    if (typeof event.data !== "string") return;
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }
    if (msg?.type !== "state" || msg.state !== "project-instruction") return;
    const detail = msg.detail ?? {};
    document.documentElement.dataset.projectInstruction = detail.file ?? "none";
    document.documentElement.dataset.projectInstructionDir = detail.dir ?? "";
    document.documentElement.dataset.projectInstructionApplied = detail.applied ? "live" : (detail.applies ?? "next-session");
    recordDebug({ type: "project-instruction", ...detail });
  });

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("machine-timeout (no response to the /live upgrade within 4s)")), 4000);
    socket.onopen = () => {
      clearTimeout(timer);
      // THE FOLDER THE VOICE IS WORKING IN (voicebox-beads-0zi4): the page owns navigation, so it
      // reports; the server answers with a `project-instruction` state naming which file it read and
      // whether it could apply it. Re-registered on every connection, so a reconnect re-reports.
      // The folder reporter lives in fused.js; the window hook keeps this file loadable on pages that do
      // not include it (the rate fixtures, for one), which is why it is not an import (voicebox-beads-0zi4).
      window.__voiceboxProjectContext?.setSender((payload) => {
        if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
      });
      resolve();
    };
    socket.onerror = () => { clearTimeout(timer); reject(new Error("machine-unreachable (the /live upgrade failed)")); };
  }).then(
    async () => {
      audioClient.attachSocket(socket);
      // The preferred microphone is read at press time, not at load: choosing a
      // device must not start capture, and a chosen device that has gone is a
      // refusal the page names rather than a silent switch to another one.
      await audioClient.startCapture({ deviceId: window.__voiceboxDevices?.micId() ?? null });
      const preferredOutput = window.__voiceboxDevices?.outputId() ?? null;
      if (preferredOutput) {
        await audioClient.setOutputDevice?.(preferredOutput);
      }
      await window.__voiceboxDevices?.refresh?.();
    },
    async (error) => {
      // The socket is dead; do not leave it half-open.
      try { socket?.close(); } catch { /* already closed */ }
      const why = await explainFailedUpgrade();
      if (voiceState) {
        voiceState.textContent = why.transient
          ? `Live voice is not connected: ${why.text}. Try the mic again in a moment; the text path still works.`
          : `Live voice unavailable: ${why.text}. The mic stays off.`;
      }
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
window.__voiceboxSetPlaybackVolume = (v) => audioClient.setPlaybackVolume(v);
window.__voiceboxIsLiveSessionActive = () =>
  Boolean(capturing || (socket && socket.readyState === WebSocket.OPEN));
window.__voiceboxRestartLiveSession = async () => {
  await audioClient.stopCapture();
  try {
    if (socket) {
      socket.onclose = null;
      socket.onerror = null;
      socket.close();
    }
  } catch { /* already closed */ }
  socket = null;
  capturing = false;
  try {
    await startLive();
    capturing = Boolean(audioClient.snapshot().capture);
    return { restarted: true, capturing };
  } catch (error) {
    capturing = false;
    setVoice("off");
    renderMic(audioClient.snapshot());
    if (voiceState) {
      voiceState.textContent = `Live voice reconnect failed: ${formatLiveErrorMessage(error?.message ?? error)}`;
    }
    return { restarted: false, capturing: false, error: String(error?.message ?? error) };
  }
};
window.__voiceboxSendLiveVideo = (jpegBase64, mimeType = "image/jpeg") => {
  if (socket && socket.readyState === WebSocket.OPEN && typeof jpegBase64 === "string" && jpegBase64) {
    socket.send(JSON.stringify({ type: "video", data: jpegBase64, mimeType }));
    return true;
  }
  return false;
};
window.__voiceboxSendActivityControl = (kind = "start") => {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: "activity_control", kind: kind === "end" ? "end" : "start" }));
    return true;
  }
  return false;
};

