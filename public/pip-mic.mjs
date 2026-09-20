// public/pip-mic.mjs — the microphone in a Document Picture-in-Picture window.
//
// WHAT THIS IS: a small always-on-top window carrying the mic control, a truthful listening state, a quick
// off that really stops the audio, the conversation log, and the command box. One click opens it; it stays.
//
// WHAT I WILL NOT PROMISE, and the research is why. Chrome has an "automatic" PiP, but it is NOT a general
// "open when the tab blurs" permission: it is a Media Session `enterpictureinpicture` action, and a page is
// only eligible when the platform decides it is — the video-conferencing route (Chrome 120+) needs a
// conferencing state, and the media-playback route (Chrome 134+, browser-initiated from 142) needs media
// playing. This app is a microphone that is sometimes playing model audio, so it may be eligible *while a
// reply is playing* and is certainly not eligible while idle. So this module REGISTERS the action (we are a
// well-behaved participant, and if the platform ever offers it, it works), and what we ship and tell the
// user is: **it opens when you press the mic button, and stays** — which is a promise the platform keeps.
//
// THE STATE IS THE TRUTH, painted every frame from the live client: a stale frame claiming "listening" is
// the defect this file exists to avoid (the meters had it once — a frozen last frame pretending to be
// live). When capture is false the level is forced to zero, the dot goes grey, and the words say so.
//
// COMMANDS COME FROM THE ONE LIST. The window does not have its own command set: its mic button CLICKS the
// page's mic button, its stop CLICKS the page's stop, and its composer submits the page's form. Same
// handlers, same verbs, no second surface to drift.
//
//   opened by: the "Keep on top" button this module adds beside the mic
//   requires:  Chromium desktop 116+, secure context (http://127.0.0.1 counts), a user gesture to open

const SUPPORTED = typeof window !== "undefined" && "documentPictureInPicture" in window;

/** The page's own controls — the single source of truth for every action. */
function pageControls() {
  return {
    mic: document.getElementById("mic"),
    interrupt: document.getElementById("interrupt"),
    form: document.getElementById("text-form"),
    utterance: document.getElementById("utterance"),
    voiceState: document.getElementById("voice-state"),
    sessionLog: document.getElementById("session-log"),
  };
}

const client = () => window.__voiceboxLiveClient ?? null;

/** The one place a level is read, defensively: the meter is the client's, not ours. */
function readLevel() {
  const c = client();
  try {
    // THE STATE IS THE TRUTH, and the meter is only a picture of it. `level().capture` is a DECAYING
    // ENVELOPE for drawing — it decays per animation frame, so when frames stop it FREEZES at its last
    // value. My first version used it as the listening state, and the window went on saying "Listening —
    // the mic is live" indefinitely after the capture had stopped. Found by driving; the fix is to read the
    // authoritative `state.capture` and treat the meter purely as amplitude.
    const capturing = Boolean(c?.state?.capture);
    const m = typeof c?.level === "function" ? c.level() : null;
    const newest = (v) => {
      if (Array.isArray(v)) return Number(v[v.length - 1]) || 0;
      if (v && typeof v === "object") {
        const keys = Object.keys(v).map(Number).filter((n) => !Number.isNaN(n)).sort((a, b) => a - b);
        if (keys.length) return Number(v[keys[keys.length - 1]]) || 0;
      }
      return Number(v) || 0;
    };
    return { capturing, input: capturing ? newest(m?.input) : 0, output: capturing ? newest(m?.output) : 0 };
  } catch {
    return { capturing: false, input: 0, output: 0 };
  }
}

function addKeepOnTopButton(controls) {
  if (!controls.mic || document.getElementById("pip-open")) return;
  const button = document.createElement("button");
  button.id = "pip-open";
  button.type = "button";
  button.className = "quiet pip-open";
  button.textContent = SUPPORTED ? "Keep on top" : "Keep on top (unsupported here)";
  button.title = SUPPORTED
    ? "Open the microphone in an always-on-top window"
    : "This browser has no Document Picture-in-Picture; the mic stays on this page";
  button.disabled = !SUPPORTED;
  button.addEventListener("click", () => { void openPipWindow(); });
  (controls.mic.parentElement ?? controls.mic).insertAdjacentElement("afterend", button);
}

/** The window's markup: mic, state, quick off, the log, the composer. Built once, per window. */
function buildPip(pip, controls) {
  pip.document.title = "voicebox — microphone";
  const style = pip.document.createElement("style");
  style.textContent = `
    :root { color-scheme: dark; }
    body { margin: 0; font: 14px/1.4 system-ui, sans-serif; background: #14161a; color: #e8eaf0;
           display: flex; flex-direction: column; gap: .75rem; padding: .9rem; height: 100vh; box-sizing: border-box; }
    .row { display: flex; align-items: center; gap: .6rem; }
    #pip-mic { width: 3.4rem; height: 3.4rem; border-radius: 50%; border: 1px solid #3a3f4b;
               background: #1d2026; color: inherit; font-size: 1.3rem; cursor: pointer; }
    #pip-mic[data-listening="true"] { background: #2b6b4b; border-color: #4fbf8b; }
    #pip-state { font-weight: 600; }
    #pip-state[data-listening="false"] { color: #9aa1ae; font-weight: 400; }
    #pip-hint { color: #9aa1ae; font-size: 12px; }
    .meters { display: grid; gap: 3px; }
    .meter { height: 6px; background: #23262d; border-radius: 3px; overflow: hidden; }
    .meter > i { display: block; height: 100%; width: 0%; background: #4fbf8b; transition: width 60ms linear; }
    .meter.out > i { background: #5b8def; }
    #pip-log { flex: 1; overflow: auto; border: 1px solid #262a33; border-radius: 8px; padding: .5rem;
               white-space: pre-wrap; font-size: 13px; }
    form { display: flex; gap: .4rem; }
    input { flex: 1; padding: .5rem .6rem; border-radius: 8px; border: 1px solid #3a3f4b; background: #1d2026; color: inherit; }
    button.quiet { padding: .5rem .7rem; border-radius: 8px; border: 1px solid #3a3f4b; background: #1d2026; color: inherit; cursor: pointer; }
  `;
  pip.document.head.append(style);

  const body = pip.document.body;
  const row = pip.document.createElement("div");
  row.className = "row";

  const micButton = pip.document.createElement("button");
  micButton.id = "pip-mic";
  micButton.type = "button";
  micButton.setAttribute("aria-label", "Speak a turn");
  micButton.textContent = "🎙";
  // SAME HANDLER: the page's mic button owns the behaviour; this clicks it.
  micButton.addEventListener("click", () => controls.mic?.click());

  const state = pip.document.createElement("div");
  const stateText = pip.document.createElement("div");
  stateText.id = "pip-state";
  const hint = pip.document.createElement("div");
  hint.id = "pip-hint";
  state.append(stateText, hint);

  row.append(micButton, state);

  const meters = pip.document.createElement("div");
  meters.className = "meters";
  const inBar = pip.document.createElement("div");
  inBar.className = "meter";
  const inFill = pip.document.createElement("i");
  inBar.append(inFill);
  const outBar = pip.document.createElement("div");
  outBar.className = "meter out";
  const outFill = pip.document.createElement("i");
  outBar.append(outFill);
  meters.append(inBar, outBar);

  const actions = pip.document.createElement("div");
  actions.className = "row";
  const stop = pip.document.createElement("button");
  stop.className = "quiet";
  stop.id = "pip-stop";
  stop.type = "button";
  stop.textContent = "Stop listening";
  // SAME HANDLER, and it only makes sense when capturing — the painter disables it otherwise.
  stop.addEventListener("click", () => controls.mic?.click());
  const stopReply = pip.document.createElement("button");
  stopReply.className = "quiet";
  stopReply.type = "button";
  stopReply.textContent = "Stop reply";
  stopReply.addEventListener("click", () => controls.interrupt?.click());
  actions.append(stop, stopReply);

  const log = pip.document.createElement("div");
  log.id = "pip-log";
  log.textContent = controls.sessionLog?.textContent?.trim() || "No conversation yet.";

  const form = pip.document.createElement("form");
  const input = pip.document.createElement("input");
  input.type = "text";
  input.placeholder = "Say something to it…";
  input.setAttribute("aria-label", "Your turn");
  const send = pip.document.createElement("button");
  send.className = "quiet";
  send.type = "submit";
  send.textContent = "Send";
  form.append(input, send);
  // SAME COMMAND LIST: the page's form is the one that runs; this fills it and submits it.
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text || !controls.utterance || !controls.form) return;
    controls.utterance.value = text;
    input.value = "";
    controls.form.requestSubmit();
  });

  body.append(row, meters, actions, log, form);
  return { micButton, stateText, hint, stop, inFill, outFill, log, input };
}

async function openPipWindow() {
  const controls = pageControls();
  if (!SUPPORTED) {
    controls.voiceState && (controls.voiceState.textContent =
      "This browser has no Document Picture-in-Picture — the mic stays on this page.");
    return null;
  }
  if (window.__voiceboxPip) { window.__voiceboxPip.focus?.(); return window.__voiceboxPip; }

  // Transient activation comes from the user's click on "Keep on top" — the call is lawful by construction.
  const pip = await window.documentPictureInPicture.requestWindow({ width: 400, height: 560 });
  const ui = buildPip(pip, controls);
  window.__voiceboxPip = pip;

  // Mirror the page's log as it grows, rather than taking a copy that goes stale.
  const logSource = controls.sessionLog;
  const syncLog = () => { ui.log.textContent = logSource?.textContent?.trim() || "No conversation yet."; };
  const observer = logSource ? new MutationObserver(syncLog) : null;
  observer?.observe(logSource, { childList: true, subtree: true, characterData: true });

  // THE STATE PAINTER. It runs on a TIMER, not requestAnimationFrame — and that is a bug fix, found by
  // driving: a PiP window that is not being rendered (hidden, minimised, headless) does not fire rAF, so
  // the first paint froze and the window went on saying "Listening — the mic is live" a second after the
  // capture had stopped, with its stop button still enabled. That is precisely the defect this file exists
  // to avoid — a frozen last frame pretending to be live — and it was in this file.
  let timer = 0;
  let lastText = "";
  const paint = () => {
    const { capturing, input, output } = readLevel();
    const listening = capturing && !(controls.voiceState?.dataset?.voice === "paused");
    ui.micButton.dataset.listening = String(listening);
    ui.micButton.setAttribute("aria-pressed", String(listening));
    ui.stop.disabled = !capturing;
    const text = capturing
      ? "Listening — the mic is live"
      : "Not listening — the mic is off";
    if (text !== lastText) { ui.stateText.textContent = text; lastText = text; }
    ui.stateText.dataset.listening = String(capturing);
    ui.hint.textContent = capturing
      ? (output > 0.02 ? "It is speaking." : "Speak whenever you like.")
      : "Press the mic to start. Text still works.";
    // A stale level would be a lie: when not capturing, zero, always.
    // A level that is not being measured is not a level: zero, always, when capture is off.
    ui.inFill.style.width = `${capturing ? Math.min(100, Math.round(input * 100)) : 0}%`;
    ui.outFill.style.width = `${capturing ? Math.min(100, Math.round(output * 100)) : 0}%`;
  };
  paint();
  timer = setInterval(paint, 200); // timers fire in an unrendered window; rAF does not

  // Closing the window stops the painting and the mirror; it changes NOTHING about the microphone — the
  // page's control remains the truth, and this window never held a second capture.
  pip.addEventListener("pagehide", () => {
    observer?.disconnect();
    try { clearInterval(timer); } catch { /* gone */ }
    window.__voiceboxPip = null;
  });

  return pip;
}

/** Media Session: the platform's own controls, and the honest auto-PiP story. */
function registerMediaSession() {
  if (!navigator.mediaSession?.setActionHandler) return;
  try {
    // If the platform decides we are eligible for automatic PiP, this is what it calls. Registering it
    // makes us a participant; it does NOT make us eligible, and nothing here claims it does.
    navigator.mediaSession.setActionHandler("enterpictureinpicture", () => { void openPipWindow(); });
    // Mute/unmute in the OS media controls are the natural quick-off — SAME handler as the mic button.
    navigator.mediaSession.setActionHandler("mute", () => { const c = pageControls(); if (readLevel().capturing) c.mic?.click(); });
    navigator.mediaSession.setActionHandler("unmute", () => { const c = pageControls(); if (!readLevel().capturing) c.mic?.click(); });
  } catch { /* a browser that does not know an action throws; that is not an error worth surfacing */ }
}

function start() {
  const controls = pageControls();
  if (!controls.mic) return;
  addKeepOnTopButton(controls);
  registerMediaSession();
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
else start();

// Exported for the acceptance drive: it must be able to open the window without hunting for a button.
window.__voiceboxPip = null;
window.__voiceboxPipOpen = openPipWindow;
