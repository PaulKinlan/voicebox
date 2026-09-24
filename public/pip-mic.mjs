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

/** The namespace every element this module builds with `createElementNS` needs (the icons). */
const SVG_NS = "http://www.w3.org/2000/svg";

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

/**
 * GIVE THE PiP DOCUMENT THE PAGE'S CLOTHES.
 *
 * A Document Picture-in-Picture window gets a FRESH document — the opener's styles do NOT come with the DOM —
 * so a window that only appends its own rules renders with default UA styles. Paul saw exactly that: an
 * unstyled grey button, in the one control whose meaning depends on being read at a glance from another
 * application. Copying the opener's sheets rather than restating a lookalike list is also why the two can no
 * longer drift: they are the same sheets.
 *
 * `<link rel="stylesheet">` and `<style>` elements are cloned; `document.adoptedStyleSheets` is assigned,
 * because constructable sheets do not appear in the DOM at all and a copy that ignores them silently loses
 * whatever used them.
 */
function copyStylesInto(target) {
  let copied = 0;
  // THE BASE FIRST, AND BEFORE ANY LINK (voicebox-beads-9d3). This document is `about:blank`, so a
  // relative URL in it has no origin to resolve against: the cloned `<link href="style.css">` asked for
  // a file sitting next to `about:blank`, loaded nothing, and the window opened as bare HTML in the
  // browser's default font. The base makes every relative URL in this document resolve exactly as it
  // does in the opener — including the `@font-face` src inside the sheet, which is the other half of
  // why an unstyled window looked *nothing* like the product. Added once: the re-copy path below only
  // replaces links and styles, and a second <base> would be a second answer to the same question.
  if (!target.head.querySelector("base")) {
    const base = target.createElement("base");
    base.href = document.baseURI;
    target.head.prepend(base);
  }
  // The explicit theme choice travels with the window. Nothing sets this attribute today — the product
  // follows the OS scheme through `light-dark()` — so this is a guard rather than a live feature: when a
  // theme control lands, the PiP window must not be the one surface that ignores it.
  if (document.documentElement.dataset.theme) {
    target.documentElement.dataset.theme = document.documentElement.dataset.theme;
  }
  for (const node of document.querySelectorAll('link[rel="stylesheet"], style')) {
    const clone = node.cloneNode(true);
    // AN ABSOLUTE href ON THE CLONE. The clone still carries the string the opener wrote (`/style.css`),
    // and this document has no business guessing what that is relative to.
    if (clone.tagName === "LINK") clone.href = node.href;
    target.head.append(clone);
    copied += 1;
  }
  if (document.adoptedStyleSheets?.length) {
    // APPEND, never replace. The window adopts its OWN sheet after this call (buildPip: an inline <style>
    // is inert in this document), and assigning the opener's list wholesale would drop it again on every
    // re-copy — the same class of bug as the re-copy deleting the window's own rules.
    for (const sheet of document.adoptedStyleSheets) {
      if (!target.adoptedStyleSheets.includes(sheet)) {
        target.adoptedStyleSheets = [...target.adoptedStyleSheets, sheet];
        copied += 1;
      }
    }
  }
  return copied;
}

/**
 * One icon, imported from the page's own symbol sprite (voicebox-beads-9d3): a `<use href="#i-mic">`
 * resolves against the DOCUMENT it lives in, so a symbol that stayed behind in the opener's sprite
 * renders as nothing at all — which is how a mic button becomes an empty circle.
 */
function icon(doc, id) {
  const svg = doc.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "icon");
  svg.setAttribute("aria-hidden", "true");
  const use = doc.createElementNS(SVG_NS, "use");
  use.setAttribute("href", `#${id}`);
  svg.append(use);
  return svg;
}

/**
 * KEEP THEM IN SYNC. The dev server hot-swaps CSS, so a window that copies once keeps the stylesheet it was
 * born with — a second way to look broken later, and indistinguishable from having no styles at all. Watch the
 * opener's head for the swap and re-copy; Vite replaces the node rather than editing it, which is why
 * watching the DOM is enough for HMR.
 *
 * Returns a disposer, and the caller runs it when the window goes away: this observer watches the OPENER's
 * document while holding the PiP document, so leaving it attached outlives the thing it is for.
 */
function keepStylesInSync(pip) {
  let pending = false;
  const recopy = () => {
    if (pending) return;
    pending = true;
    // Coalesce: a swap can touch several nodes, and one re-copy per burst is enough.
    setTimeout(() => {
      pending = false;
      // ONLY THE SHEETS THIS WINDOW COPIED. The first version matched every `style` in the head, which
      // includes THIS WINDOW'S OWN RULES — and the observer fires on the very append that installs them,
      // so the window deleted its own styling moments after opening and the re-copy restored only the
      // opener's sheets. That is a window that looks unstyled however good its rules are (voicebox-beads-9d3:
      // found by driving, because the DOM still showed a full set of copied stylesheets).
      const live = pip.document.head.querySelectorAll('link[rel="stylesheet"]');
      for (const node of live) node.remove();
      copyStylesInto(pip.document);
    }, 50);
  };
  const observer = new MutationObserver(recopy);
  observer.observe(document.head, { childList: true, subtree: true, attributes: true, attributeFilter: ["href", "media"] });
  const onViteUpdate = () => recopy();
  if (import.meta.hot) import.meta.hot.on("vite:afterUpdate", onViteUpdate);
  return () => {
    observer.disconnect();
    if (import.meta.hot) import.meta.hot.off?.("vite:afterUpdate", onViteUpdate);
  };
}

/** The window's markup: mic, state, quick off, the log, the composer. Built once, per window. */
function buildPip(pip, controls) {
  pip.document.title = "voicebox — microphone";

  // THE PAGE'S SHEETS FIRST, so the window starts from the same tokens the page uses, and then our own rules
  // layer on top of them. The order matters and is the point: this window is a surface that shows state, and
  // it should read as the same product, not as a lookalike.
  const copied = copyStylesInto(pip.document);
  const stopSync = keepStylesInSync(pip);
  pip.addEventListener("pagehide", stopSync);

  // THE WINDOW'S OWN RULES RIDE A CONSTRUCTABLE SHEET, NOT AN INLINE <style> — measured, not assumed
  // (voicebox-beads-9d3): in a Document-PiP document a `<style>` appended to the head, even a brand-new one
  // carrying a marker rule, reports `sheet === null` and applies NOTHING, while a copied `<link>` applies
  // normally and an adopted CSSStyleSheet applies normally. So the window had the page's sheet and none of
  // its own rules: it read as unstyled however good those rules were, and no selector work would fix it.
  const own = new (pip.CSSStyleSheet ?? CSSStyleSheet)();
  // THE SAME TOKENS THE PAGE USES, not a lookalike palette. The copied sheet above already declares
  // them, so everything here reads `var(--…)` and follows the theme with it — the hardcoded greys this
  // replaced were a second theme that agreed with the product only by coincidence (voicebox-beads-9d3).
  own.replaceSync(`
    body { margin: 0; font: 14px/1.5 Inter, system-ui, sans-serif; background: var(--ground); color: var(--ink);
           display: flex; flex-direction: column; gap: .7rem; padding: .9rem; block-size: 100vh; box-sizing: border-box; }
    .icon { inline-size: 1.15em; block-size: 1.15em; fill: none; stroke: currentColor; stroke-width: 2;
            stroke-linecap: round; flex: none; }
    .lead { display: flex; flex-direction: column; align-items: center; gap: .45rem; text-align: center; }
    #pip-mic { position: relative; inline-size: 3.6rem; block-size: 3.6rem; border-radius: 50%;
               border: 1px solid var(--line); background: var(--card); color: var(--ink); font-size: 1.35rem;
               display: grid; place-items: center; cursor: pointer;
               transition: border-color 150ms ease, color 150ms ease, background 150ms ease; }
    #pip-mic:hover { border-color: var(--accent); color: var(--accent); }
    #pip-mic[data-listening="true"] { border-color: var(--good); color: var(--good); background: color-mix(in srgb, var(--good) 12%, var(--card));
               animation: pip-breathe 1.8s ease-in-out infinite; }
    @keyframes pip-breathe {
      0%, 100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--good) 55%, transparent); }
      50%      { box-shadow: 0 0 0 .6rem color-mix(in srgb, var(--good) 0%, transparent); }
    }
    @media (prefers-reduced-motion: reduce) { #pip-mic[data-listening="true"] { animation: none; } }
    #pip-state { font-weight: 600; }
    #pip-state[data-listening="false"] { color: var(--muted); font-weight: 400; }
    #pip-hint { color: var(--muted); font-size: 12px; }
    .meters { display: grid; gap: 4px; }
    .meter { block-size: 6px; background: var(--line); border-radius: 3px; overflow: hidden; }
    .meter > i { display: block; block-size: 100%; inline-size: 0%; background: var(--good);
                 transition: inline-size 60ms linear; }
    .meter.out > i { background: var(--accent); }
    #pip-log { flex: 1; overflow: auto; overscroll-behavior: contain; scrollbar-gutter: stable;
               border: 1px solid var(--line); border-radius: 10px; padding: .55rem .65rem; background: var(--card);
               white-space: pre-wrap; font-size: 13px; }
    form { display: flex; gap: .4rem; }
    input { flex: 1; min-inline-size: 0; padding: .5rem .6rem; border-radius: 8px; border: 1px solid var(--line);
            background: var(--card); color: var(--ink); font: inherit; }
    input::placeholder { color: var(--muted); }
    button.quiet { display: inline-flex; align-items: center; gap: .35rem; padding: .5rem .7rem; border-radius: 8px;
                   border: 1px solid var(--line); background: var(--card); color: var(--ink); font: inherit; cursor: pointer; }
    button.quiet:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); }
    button.quiet:disabled { opacity: .5; cursor: default; }
    .actions { display: flex; flex-wrap: wrap; gap: .4rem; }
  `);
  pip.document.adoptedStyleSheets = [...pip.document.adoptedStyleSheets, own];
  // Reported rather than assumed: if the opener had no sheets to copy, this window is unstyled and the number
  // says so instead of the difference being something a person has to notice by eye.
  if (copied === 0) console.warn("[pip-mic] the opener had no stylesheets to copy — this window will render unstyled");

  const body = pip.document.body;
  // THE SPRITE TRAVELS WITH THE WINDOW (voicebox-beads-9d3). `<use href="#i-mic">` resolves against the
  // document it lives in, so the symbols must be IN this document — a copy that leaves them behind draws
  // an empty circle where the mic should be, which is exactly how the window looked.
  const defs = document.querySelector(".icon-definitions");
  if (defs) body.append(pip.document.importNode(defs, true));
  else console.warn("[pip-mic] the opener has no .icon-definitions — the icons in this window will be blank");

  // The mic leads, centred: it is the one control a person presses here, and the state belongs under it.
  const lead = pip.document.createElement("div");
  lead.className = "lead";

  const micButton = pip.document.createElement("button");
  micButton.id = "pip-mic";
  micButton.type = "button";
  micButton.setAttribute("aria-label", "Speak a turn");
  micButton.append(icon(pip.document, "i-mic"));
  // SAME HANDLER: the page's mic button owns the behaviour; this clicks it.
  micButton.addEventListener("click", () => controls.mic?.click());

  const state = pip.document.createElement("div");
  const stateText = pip.document.createElement("div");
  stateText.id = "pip-state";
  const hint = pip.document.createElement("div");
  hint.id = "pip-hint";
  state.append(stateText, hint);

  lead.append(micButton, state);

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
  actions.className = "actions";
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
  const close = pip.document.createElement("button");
  close.className = "quiet";
  close.id = "pip-close";
  close.type = "button";
  close.title = "Close this window — the microphone stays under the page's control";
  close.append(icon(pip.document, "i-close"), pip.document.createTextNode("Close"));
  // Closing changes NOTHING about the microphone: the page's control is the truth, and this window never
  // held a second capture.
  close.addEventListener("click", () => pip.close());
  actions.append(stop, stopReply, close);

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

  body.append(lead, meters, actions, log, form);
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
