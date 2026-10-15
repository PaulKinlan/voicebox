// tests/vision-controls-extraction.test.mjs — the Room's Live Vision and Push to talk surface is a module
// now (voicebox-beads-uei2.12), and this file holds the ways that extraction can be wrong while the suite
// stays green.
//
// WHY THIS FILE EXISTS AT ALL. tests/ptt-and-thinking-settings.test.mjs pins the prefs wiring, and
// tests/environment-integrated-ui.test.mjs drives the room end to end, so parts of this surface are already
// covered. What none of them cover is the SEAM, and the seam is where an extraction rots: the host's copy of
// a handler can survive (so every click counts twice), a dependency can be handed over as a VALUE instead of
// a LIVE read (the voicebox-beads-w1f9 shape), or the surface's state can be split across two owners. None of
// those shows up as a red behaviour test.
//
// WHAT THIS FILE PROVES, and how:
//
//   A. THE RULES, DRIVEN WITH NOTHING REAL (unit arms, injected media/timers/storage/session callbacks): the
//      initial paint from saved preferences; camera and screen start; the track-ended teardown; the
//      snapshot's preview-vs-send split and its one-encode-in-flight guard; stop and the same-mode toggle;
//      the fps/resolution/thinking-level preference writes and the timer restart; PTT's enable/disable and
//      its click; a refused capture; and a DOUBLE INITIALISATION, where one PTT click must still send exactly
//      ONE activity control.
//
//   B. THE LIVE CALLBACKS ARE LIVE (unit arm 3, and the static arm): the module asks the session whether it
//      is active AT THE MOMENT of a start or a thinking-level change, so flipping that answer between calls
//      changes the behaviour. The host must pass a closure over the global, never a captured value — the
//      static arm refuses a snapshot wiring by name.
//
//   C. WHAT DID NOT MOVE STAYED PUT: the debug / offline-speech / doctor handlers were between this surface's
//      two discontiguous blocks and are NOT part of it.
//
//   D. THE REAL PAGE, ON A REAL STREAM (browser arm): navigator.mediaDevices is replaced with one that
//      returns a genuine MediaStream from a canvas, and the room's own buttons are clicked — camera on
//      (card shown, stream attached, tracks stopped and card hidden on stop), a live snapshot reaching
//      __voiceboxSendLiveVideo and a preview snapshot reaching nobody, PTT sending start/end, and a
//      LISTENER-FREE CLONE of the camera button doing nothing at all — which is what makes A-D evidence
//      about the module's wiring rather than about the markup existing.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "./lib/server.mjs";
import { launch } from "./lib/cdp.mjs";
import { createVisionControls } from "../public/components/vision-controls.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FUSED = readFileSync(path.join(ROOT, "public", "fused.js"), "utf8");
const MODULE_TEXT = readFileSync(path.join(ROOT, "public", "components", "vision-controls.mjs"), "utf8");

// ── the fakes: no browser, no camera, no clock ────────────────────────────────────────────────────────────
function fakeEl(id) {
  const el = {
    id, hidden: false, value: "", textContent: "", checked: false, dataset: {},
    attrs: {}, listeners: {},
    setAttribute(k, v) { el.attrs[k] = String(v); },
    getAttribute(k) { return el.attrs[k] ?? null; },
    addEventListener(type, fn) { (el.listeners[type] ??= []).push(fn); },
    dispatch(type, event = {}) { for (const fn of el.listeners[type] ?? []) fn({ target: el, ...event }); },
    click() { el.dispatch("click"); },
  };
  return el;
}

function fakeStream() {
  const track = { stopped: false, ended: null, stop() { track.stopped = true; }, addEventListener(type, fn) { if (type === "ended") track.ended = fn; } };
  return { tracks: [track], getTracks: () => [track], getVideoTracks: () => [track] };
}

/** Everything the module was handed, with every observable recorded. */
function harness({ stored = {}, live = false } = {}) {
  const els = {};
  for (const name of [
    "settingVisionResolution", "settingVisionFps", "settingThinkingLevel", "settingThinkingLevelState",
    "settingPttEnabled", "settingPttState", "visionPttBtn", "visionCoreVideo", "visionCoreCanvas",
    "visionCoreMeta", "visionCoreCard", "visionCameraBtn", "visionScreenBtn", "visionSnapshotBtn",
    "visionStopBtn", "settingStartCamera", "settingStartScreen", "mic",
  ]) els[name] = fakeEl(name);
  for (const name of ["settingVisionResolution", "settingVisionFps", "settingThinkingLevel", "visionCoreVideo", "visionCoreCard"]) {
    if (name === "visionCoreVideo") continue;
    els[name].value = "";
  }
  els.visionCoreVideo.play = async () => {};
  els.mic.attrs["aria-pressed"] = "false";
  const micClicks = { n: 0 };
  els.mic.click = () => { micClicks.n += 1; };

  const store = new Map(Object.entries(stored));
  const storage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    written: () => (store.has("voicebox:vision-prefs") ? JSON.parse(store.get("voicebox:vision-prefs")) : null),
  };
  const media = {
    streams: [],
    calls: [],
    async getUserMedia(constraints) { media.calls.push({ kind: "user", constraints }); const s = fakeStream(); media.streams.push(s); return s; },
    async getDisplayMedia(constraints) { media.calls.push({ kind: "display", constraints }); const s = fakeStream(); media.streams.push(s); return s; },
  };
  const intervals = [];
  const cleared = [];
  const timers = {
    setInterval(fn, ms) { intervals.push({ fn, ms }); return intervals.length; },
    clearInterval(id) { cleared.push(id); },
  };
  const encodes = [];
  const grounding = { cleared: 0, resized: [], clearCallouts() { grounding.cleared += 1; }, resizeOverlay(w, h) { grounding.resized.push([w, h]); } };
  const warned = [];
  const session = { restarts: 0, activity: [], videos: [], pip: [], live };
  const controls = createVisionControls({
    els,
    encodeVisionFrame: async (video, w, h, q, canvas) => { encodes.push({ w, h, q, canvasMatchesEls: canvas === els.visionCoreCanvas }); return { base64: "ENCODED" }; },
    visionGroundingController: grounding,
    setState: (text, tone) => warned.push({ text, tone }),
    isLiveSessionActive: () => session.live,
    sendLiveVideo: (base64, mime) => { session.videos.push({ base64, mime }); return true; },
    restartLiveSession: () => { session.restarts += 1; },
    sendActivityControl: (action) => session.activity.push(action),
    setPipVisionStream: (stream) => session.pip.push(stream),
    storage, media, timers,
  });
  return { els, storage, media, intervals, cleared, encodes, grounding, warned, session, controls, micClicks };
}

// ── A/B. the rules, driven ───────────────────────────────────────────────────────────────────────────────
test("the initial paint reads the saved preferences and words the state lines", () => {
  const h = harness({ stored: { "voicebox:vision-prefs": JSON.stringify({ resolution: "MEDIA_RESOLUTION_HIGH", fps: 2, thinkingLevel: "high", pttEnabled: true }) } });
  assert.equal(h.els.settingVisionResolution.value, "MEDIA_RESOLUTION_HIGH", "resolution is restored");
  assert.equal(h.els.settingVisionFps.value, "2", "fps is restored as a string, as the select wants");
  assert.equal(h.els.settingThinkingLevel.value, "high");
  assert.match(h.els.settingThinkingLevelState.textContent, /^High depth — applies to Gemini 3\.8 Live Extended Thinking \(audio & vision\)$/);
  assert.equal(h.els.settingPttEnabled.checked, true);
  assert.equal(h.els.visionPttBtn.hidden, false, "PTT is saved on, so the button is shown");
  assert.equal(h.els.settingPttState.textContent, "Shown — manual Push to talk button visible");
});

test("camera start attaches the stream, runs the timer at the saved fps, and asks about the session LIVE", async () => {
  const h = harness({ stored: { "voicebox:vision-prefs": JSON.stringify({ fps: 2 }) } });
  await h.controls.startVisionStream("camera");
  assert.equal(h.media.calls.length, 1);
  assert.deepEqual(h.media.calls[0], { kind: "user", constraints: { video: { facingMode: "environment" }, audio: false } }, "camera is the environment-facing request");
  assert.equal(h.els.visionCoreVideo.srcObject, h.media.streams[0], "the stream is attached to the video element");
  assert.equal(h.els.visionCoreCard.hidden, false, "the preview card is shown");
  assert.equal(h.els.visionCameraBtn.getAttribute("aria-pressed"), "true");
  // The start paints the mode line and then captures a first frame, which refines the SAME line — so the
  // settled text is the frame's, and "Camera active" is only visible inside that window.
  assert.match(h.els.visionCoreMeta.textContent, /^Camera (active|preview ready)/, `got ${h.els.visionCoreMeta.textContent}`);
  assert.equal(h.session.pip.at(-1), h.media.streams[0], "the PiP companion is handed the stream");
  assert.equal(h.micClicks.n, 1, "the microphone is auto-started while no live session is running");
  assert.equal(h.intervals.length, 1);
  assert.equal(h.intervals[0].ms, 500, "fps 2 means a 500ms interval");

  // B. LIVE, NOT CAPTURED: flip the session answer and start again — this time the microphone must NOT be
  //    touched, which is only true if the module asked at the moment of the start rather than at init.
  h.session.live = true;
  await h.controls.startVisionStream("screen"); // a DIFFERENT mode, because the same one toggles the stream off
  assert.equal(h.micClicks.n, 1, "a live session must not have its microphone clicked a second time");
  assert.equal(h.media.calls.length, 2, "the second start really did run");
  assert.equal(h.media.calls[1].kind, "display", "and it took the screen path");
});

test("the track ending tears the stream down: tracks stopped, timer cleared, overlay and PiP released", async () => {
  const h = harness();
  await h.controls.startVisionStream("screen");
  assert.equal(h.media.calls[0].kind, "display", "screen share uses getDisplayMedia");
  const [stream] = h.media.streams;
  stream.tracks[0].ended(); // the browser does this when a person stops sharing from Chrome's own bar
  assert.equal(stream.tracks[0].stopped, true, "every track is stopped");
  assert.equal(h.els.visionCoreVideo.srcObject, null);
  assert.equal(h.els.visionCoreCard.hidden, true);
  assert.equal(h.els.visionScreenBtn.getAttribute("aria-pressed"), "false");
  assert.equal(h.els.visionCoreMeta.textContent, "Camera off");
  // TWO clears: starting a stream stops whatever was running first, and the track ending stops it again.
  assert.equal(h.grounding.cleared, 2, "the grounding overlay's callouts are cleared on every teardown, including the one inside the start");
  assert.equal(h.session.pip.at(-1), null, "and the PiP companion is told there is no stream");
  assert.equal(h.cleared.length >= 1, true, "the frame timer is stopped with the stream");
});

test("a snapshot previews without a live session and SENDS with one, with one encode in flight", async () => {
  const h = harness();
  await h.controls.startVisionStream("camera");
  h.session.live = false;
  const encodedBefore = h.encodes.length; // the start already captured one frame of its own
  await h.controls.captureAndSendVisionFrame();
  assert.equal(h.session.videos.length, 0, "no live session: nothing is sent");
  assert.equal(h.encodes.length, encodedBefore + 1, "but the frame is still encoded, because the preview needs it");
  assert.match(h.els.visionCoreMeta.textContent, /^Camera preview ready \(start mic to stream\)$/);
  assert.deepEqual({ w: h.encodes[0].w, q: h.encodes[0].q, canvasMatchesEls: h.encodes[0].canvasMatchesEls }, { w: 640, q: 0.78, canvasMatchesEls: true }, "the encoder is called with the medium size, quality 0.78 and the room's own canvas");

  h.session.live = true;
  await h.controls.captureAndSendVisionFrame();
  assert.deepEqual(h.session.videos.at(-1), { base64: "ENCODED", mime: "image/jpeg" });
  assert.match(h.els.visionCoreMeta.textContent, /^Camera live \(640×480\)$/);

  // THE ONE-IN-FLIGHT GUARD, asserted as an ENCODE COUNT rather than as the second call's return value: a
  // refused call and a call that returned early for want of a stream both answer `false`, so a "returns false"
  // arm is vacuous — driven RED by removing the guard, and it stayed GREEN, which is how this was found.
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let encodeCalls = 0;
  const slow = createVisionControls({
    els: h.els, storage: h.storage, media: h.media, timers: { setInterval: () => 1, clearInterval: () => {} },
    encodeVisionFrame: async () => { encodeCalls += 1; await gate; return { base64: "SLOW" }; },
    isLiveSessionActive: () => true, sendLiveVideo: () => true,
    visionGroundingController: h.grounding, setState: () => {}, sendActivityControl: () => {}, restartLiveSession: () => {}, setPipVisionStream: () => {},
  });
  await slow.startVisionStream("camera"); // its own stream, and its first frame is now encoding (call 1 of 1)
  // NOT awaited: with the guard the refusal resolves at once, and WITHOUT it this call blocks on the gate — so
  // awaiting it here would turn a red mutant into a hang (found the honest way: the first version of this arm
  // was worse, asserting only that the second call returned false, which a call with no stream also does).
  const refused = slow.captureAndSendVisionFrame();
  await new Promise((resolve) => setTimeout(resolve, 0));
  try {
    assert.equal(encodeCalls, 1, `the encoder must have been entered ONCE: with the guard removed the refused call encodes too, making this 2 (got ${encodeCalls})`);
  } finally {
    release(); // the gate must open either way, so nothing is left pending behind a failed assertion
  }
  assert.equal(await refused, false, "and the refused capture answers false");
});

test("stop, and the same-mode toggle, release the timer and the tracks", async () => {
  const h = harness();
  await h.controls.startVisionStream("camera");
  const first = h.media.streams[0];
  await h.controls.startVisionStream("camera"); // clicking the active mode again turns it off
  assert.equal(first.tracks[0].stopped, true, "the same-mode toggle stops the stream it was showing");
  assert.equal(h.els.visionCoreCard.hidden, true);
  assert.equal(h.media.calls.length, 1, "and it does not ask for a new one");

  await h.controls.startVisionStream("screen");
  h.controls.stopVisionStream();
  assert.equal(h.media.streams[1].tracks[0].stopped, true, "an explicit stop stops the tracks too");
  assert.equal(h.els.visionCoreMeta.textContent, "Camera off");
});

test("the preference changes write through, repaint, and restart only an ACTIVE session", async () => {
  const h = harness();
  h.els.settingVisionResolution.value = "MEDIA_RESOLUTION_LOW";
  h.els.settingVisionResolution.dispatch("change");
  assert.equal(h.storage.written().resolution, "MEDIA_RESOLUTION_LOW");

  await h.controls.startVisionStream("camera");
  const before = h.intervals.length;
  h.els.settingVisionFps.value = "4";
  h.els.settingVisionFps.dispatch("change");
  assert.equal(h.storage.written().fps, 4, "the fps preference is stored as a number");
  assert.equal(h.intervals.length, before + 1);
  assert.equal(h.intervals.at(-1).ms, 250);

  // The thinking level writes, repaints, and restarts the live session — asked LIVE, so the flip matters.
  h.session.live = false;
  h.els.settingThinkingLevel.value = "low";
  h.els.settingThinkingLevel.dispatch("change");
  assert.equal(h.storage.written().thinkingLevel, "low");
  assert.match(h.els.settingThinkingLevelState.textContent, /^Low depth/);
  assert.equal(h.session.restarts, 0, "no live session: nothing is restarted");
  h.session.live = true;
  h.els.settingThinkingLevel.value = "high";
  h.els.settingThinkingLevel.dispatch("change");
  assert.equal(h.session.restarts, 1, "an active session is restarted at the moment of the change");
});

test("Push to talk: the enable switch paints and ends a live turn, and the button sends start then end", () => {
  const h = harness({ stored: { "voicebox:vision-prefs": JSON.stringify({ pttEnabled: true }) } });
  h.els.visionPttBtn.click();
  assert.equal(h.els.visionPttBtn.getAttribute("aria-pressed"), "true");
  assert.equal(h.els.visionPttBtn.textContent, "End turn");
  assert.deepEqual(h.session.activity, ["start"]);
  h.els.visionPttBtn.click();
  assert.deepEqual(h.session.activity, ["start", "end"], "a second click ends the turn");
  assert.equal(h.els.visionPttBtn.textContent, "Push to talk");

  // Disabling PTT while a turn is open must END it rather than leave the session talking.
  h.els.visionPttBtn.click();
  h.els.settingPttEnabled.checked = false;
  h.els.settingPttEnabled.dispatch("change");
  assert.deepEqual(h.session.activity, ["start", "end", "start", "end"], "disabling ends the open turn");
  assert.equal(h.els.visionPttBtn.hidden, true);
  assert.equal(h.els.visionPttBtn.getAttribute("aria-pressed"), "false");
  assert.equal(h.els.settingPttState.textContent, "Hidden — automatic voice detection active");
  assert.equal(h.storage.written().pttEnabled, false);
});

test("a refused capture warns through setState and leaves nothing running", async () => {
  const h = harness();
  h.media.getUserMedia = async () => { throw new Error("NotAllowedError: permission denied"); };
  await h.controls.startVisionStream("camera");
  // The warning is the module's own verbatim text: an Error's message does not carry a second "Error:" prefix.
  assert.deepEqual(h.warned.at(-1), { text: "Video capture unavailable: NotAllowedError: permission denied", tone: "warn" });
  assert.equal(h.els.visionCoreCard.hidden, true, "the card is not left showing a stream that does not exist");
  assert.equal(h.intervals.length, 0, "and no timer is left running");
});

test("the PTT click count is sensitive enough to catch a doubled listener", () => {
  // THE INSTRUMENT MUST BE PROVEN LIVE BEFORE ITS "exactly once" IS TRUSTED (the same shape as the changelog
  // extraction's fetch counter). One initialisation is what the host does; a second one is what a LEFTOVER
  // wiring site would look like, and the click count is the only thing that sees it — every behaviour
  // assertion in this file would still pass with two listeners attached.
  const h = harness({ stored: { "voicebox:vision-prefs": JSON.stringify({ pttEnabled: true }) } });
  h.els.visionPttBtn.click();
  assert.deepEqual(h.session.activity, ["start"], "one initialisation: one press sends exactly one activity control");
  const before = h.session.activity.length;

  createVisionControls({
    els: h.els, storage: h.storage, media: h.media, timers: { setInterval: () => 1, clearInterval: () => {} },
    encodeVisionFrame: async () => ({ base64: "x" }), visionGroundingController: h.grounding, setState: () => {},
    isLiveSessionActive: () => false, sendLiveVideo: () => true, restartLiveSession: () => {},
    sendActivityControl: (a) => h.session.activity.push(a), setPipVisionStream: () => {},
  });
  h.els.visionPttBtn.click();
  assert.equal(h.session.activity.length, before + 2, `a doubled listener sends TWO controls for that one press, so this counter would have seen the host's leftover copy (got ${JSON.stringify(h.session.activity)})`);
});

// ── C. the seam, statically ──────────────────────────────────────────────────────────────────────────────
test("the surface lives in the module, the host keeps the handlers that were only NEAR it, and the callbacks are closures", () => {
  for (const marker of ["VISION_PREFS_KEY", "captureAndSendVisionFrame", 'visionPttBtn?.addEventListener', "navigator.mediaDevices.getUserMedia", "voicebox:vision-prefs"]) {
    assert.equal(FUSED.includes(marker), false, `fused.js must no longer carry ${marker} — a leftover copy is the double-wiring this arm exists to catch`);
  }
  for (const marker of ["voicebox:vision-prefs", "createVisionControls", "startVisionStream", "captureAndSendVisionFrame"]) {
    assert.equal(MODULE_TEXT.includes(marker), true, `the module must own ${marker}`);
  }
  const listeners = MODULE_TEXT.match(/addEventListener\("(click|change)"/g) ?? [];
  assert.equal(listeners.length, 11, `the module owns all eleven listeners the host used to attach inline, found ${listeners.length}`);

  // THE HANDLERS THAT WERE BETWEEN THE TWO BLOCKS STAY IN THE HOST: they are settings, not vision.
  for (const marker of ['if (els.settingDebugEnabled)', "if (els.settingOfflineSpeechEnabled)", "els.settingsRunDoctor?.addEventListener"]) {
    assert.equal(FUSED.includes(marker), true, `${marker} is not part of this slice and must stay in fused.js`);
  }

  // LIVE WIRING, REFUSED AS A SNAPSHOT: each injected dependency must be a closure over the global, because a
  // captured value freezes the answer the module asks about (the voicebox-beads-w1f9 shape).
  for (const wiring of [
    /isLiveSessionActive: \(\) => window\.__voiceboxIsLiveSessionActive\?\.\(\)/,
    /sendLiveVideo: \(base64, mimeType\) => window\.__voiceboxSendLiveVideo\?\.\(base64, mimeType\)/,
    /restartLiveSession: \(\) => window\.__voiceboxRestartLiveSession\?\.\(\)/,
    /sendActivityControl: \(action\) => window\.__voiceboxSendActivityControl\?\.\(action\)/,
    /setPipVisionStream: \(stream\) => window\.__voiceboxPipCompanion\?\.setVisionStream\(stream\)/,
  ]) {
    assert.match(FUSED, wiring, `fused.js must hand the module a live closure for ${wiring}`);
  }
});

test("the move is verbatim: every moved line survives, in order, apart from the named seams only", () => {
  // READ THE REGION BACK OUT OF THE IMMUTABLE BLOB IT WAS CUT FROM (the same arm the audio-device slice
  // carries). Prose claiming a verbatim move is worth nothing; this compares against the tree the extraction
  // was taken from, so a statement quietly rewritten while "moving" fails here by name.
  const BASE = "0083140"; // the main tip this slice branched from
  const pre = execFileSync("git", ["show", `${BASE}:public/fused.js`], { cwd: ROOT, encoding: "utf8" }).split("\n");
  const region = [...pre.slice(4224, 4409), ...pre.slice(4490, 4496)].join("\n");

  // THE NAMED SEAMS, and nothing else is allowed to differ. Each pair is old text -> new text, and the SITE
  // COUNT is asserted so a hand edit that deviates from the region cannot pass itself off as a seam.
  const SEAMS = [
    ["localStorage.getItem(", "storage.getItem("],
    ["localStorage.setItem(", "storage.setItem("],
    ["navigator.mediaDevices.getDisplayMedia(", "media.getDisplayMedia("],
    ["navigator.mediaDevices.getUserMedia(", "media.getUserMedia("],
    ["window.__voiceboxIsLiveSessionActive?.()", "isLiveSessionActive?.()"],
    ["window.__voiceboxSendLiveVideo?.(", "sendLiveVideo?.("],
    ["window.__voiceboxRestartLiveSession?.()", "restartLiveSession?.()"],
    ["window.__voiceboxSendActivityControl?.(", "sendActivityControl?.("],
    ["window.__voiceboxPipCompanion?.setVisionStream(", "setPipVisionStream?.("],
    ["setInterval(captureAndSendVisionFrame,", "timers.setInterval(captureAndSendVisionFrame,"],
    ["clearInterval(visionTimer)", "timers.clearInterval(visionTimer)"],
  ];
  let transformed = region;
  let sites = 0;
  for (const [before, after] of SEAMS) {
    sites += transformed.split(before).length - 1;
    transformed = transformed.split(before).join(after);
  }
  assert.equal(sites, 16, `the region carries exactly 16 seam sites across ${SEAMS.length} named kinds, found ${sites}`);

  const codeLines = transformed.split("\n").filter((line) => line.trim() && !line.trim().startsWith("//"));
  assert.equal(codeLines.length, 183, `the moved region's code lines, got ${codeLines.length}`);
  let at = 0;
  for (const line of codeLines) {
    const found = MODULE_TEXT.indexOf(line, at);
    assert.ok(found >= at, `this line was MOVED OR REWRITTEN, which no named seam allows: ${JSON.stringify(line.trim().slice(0, 90))}`);
    at = found + line.length;
  }

  // AND THE OLD HOME NO LONGER CARRIES ANY OF IT: the host keeps the wiring call, not the surface.
  assert.match(FUSED, /createVisionControls\(\{/, "the host wires the module at one site");
  assert.equal(FUSED.split("storage.getItem(").length - 1, 0, "no seam's new form may appear in the host either — the surface is not half-here");
  assert.equal(FUSED.split("isLiveSessionActive?.()").length - 1, 0, "and the module's own accessor calls are the module's");
});

// ── D. the real page, on Chrome's OWN fake camera ───────────────────────────────────────────────────────
test("the real room: camera on and off with the tracks really released, preview vs live send, PTT, and a listener-free clone", { timeout: 90000 }, async () => {
  let server;
  let page;
  try {
    server = await startServer({
      env: { VOICEBOX_WORKSPACE: undefined, VOICEBOX_SANDBOX_HOMES: undefined, VOICEBOX_INSTANCE: "vision-controls-extraction" },
    });
    // Chrome's own fake capture device, so the module's REAL path runs: nothing here replaces getUserMedia
    // with a stand-in stream, and the track states asserted at the end are the browser's own.
    page = await launch({ width: 1280, height: 900, fakeMedia: true });
    await page.goto(server.base);
    await page.waitFor(() => typeof window.__voiceboxOnToolCalls === "function", {
      label: "the room's own wiring to finish (sqehWire's last statement before installWindowManager)",
      timeout: 30000,
    });

    // Wrapping, not replacing: the real calls run, and the wrapper counts them and keeps the stream so its
    // tracks can be inspected AFTER the module has released them.
    const prepared = await page.evaluate(() => {
      const realUser = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      const realDisplay = navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices);
      window.__vision = { video: 0, audio: 0, display: 0, videos: [], activity: [], liveCalls: 0, live: false, streams: [] };
      // Counted by KIND: the module auto-starts the microphone when no session is live, and how long that
      // capture takes is not this test's business — only the CAMERA request count is asserted.
      navigator.mediaDevices.getUserMedia = async (c) => {
        window.__vision[c?.video ? "video" : "audio"] += 1;
        const stream = await realUser(c);
        window.__vision.streams.push(stream);
        return stream;
      };
      navigator.mediaDevices.getDisplayMedia = async (c) => { window.__vision.display += 1; const stream = await realDisplay(c); window.__vision.streams.push(stream); return stream; };
      // The call COUNT is an observable this test can wait on: the module asks once per frame it captures, so
      // an absence (nothing was sent) is anchored to the frame path having really run.
      window.__voiceboxIsLiveSessionActive = () => { window.__vision.liveCalls += 1; return window.__vision.live; };
      window.__voiceboxSendLiveVideo = (base64, mime) => { window.__vision.videos.push({ len: base64.length, mime }); return true; };
      window.__voiceboxSendActivityControl = (action) => { window.__vision.activity.push(action); };
      return { hasCapture: typeof realUser === "function" };
    });
    assert.equal(prepared.hasCapture, true, "the browser must expose getUserMedia for this drive to mean anything");

    // PTT on through the room's own Settings switch: this is the module's preference handler running.
    await page.evaluate(() => {
      const box = document.getElementById("setting-ptt-enabled");
      box.checked = true;
      box.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const pttShown = await page.evaluate(() => !document.getElementById("vision-ptt-btn").hidden);
    assert.equal(pttShown, true, "enabling PTT shows the button, so the module's handler reached the same element the host used to reach");

    // CAMERA ON, from the room's own button.
    await page.click("#vision-camera-btn");
    // THE WAIT COVERS EVERY OBSERVABLE ASSERTED. `srcObject` is attached BEFORE the card is shown (an awaited
    // play() sits between them, and the metadata handler after that), so waiting on the stream alone can
    // return while the button is still unpressed and the card still hidden — the card and the pressed state
    // are what this arm asserts, so they are what it waits for.
    await page.waitFor(() => document.getElementById("vision-core-card")?.hidden === false
      && document.getElementById("vision-camera-btn")?.getAttribute("aria-pressed") === "true", {
      label: "the preview card to appear and the camera button to be pressed",
      timeout: 30000,
    });
    await page.waitFor(() => document.getElementById("vision-core-meta")?.textContent?.startsWith("Camera"), { label: "the metadata line to be painted", timeout: 15000 });
    const on = await page.evaluate(() => ({
      video: window.__vision.video,
      pressed: document.getElementById("vision-camera-btn").getAttribute("aria-pressed"),
      hidden: document.getElementById("vision-core-card").hidden,
      hasStream: Boolean(document.getElementById("vision-core-video").srcObject),
      tracks: window.__vision.streams.at(-1).getVideoTracks().map((t) => t.readyState),
      meta: document.getElementById("vision-core-meta").textContent,
    }));
    assert.deepEqual({ video: on.video, pressed: on.pressed, hidden: on.hidden, hasStream: on.hasStream, tracks: on.tracks }, { video: 1, pressed: "true", hidden: false, hasStream: true, tracks: ["live"] }, "one CAMERA request, the button pressed, the card shown, the stream attached and a LIVE track");
    assert.match(on.meta, /^Camera (active|preview ready)/, `the metadata line names the mode: ${on.meta}`);

    // SNAPSHOT with no live session: the frame is encoded for the preview and sent to NOBODY. The wait is on
    // the observable the claim depends on (the frame path repaints that line when it finishes), not a guess.
    const framesBefore = await page.evaluate(() => window.__vision.liveCalls);
    await page.click("#vision-snapshot-btn");
    await page.waitFor((before) => window.__vision.liveCalls > before, {
      label: "the snapshot's frame to reach the session check",
      args: [framesBefore],
      timeout: 20000,
    });
    const preview = await page.evaluate(() => ({ videos: window.__vision.videos.length, meta: document.getElementById("vision-core-meta").textContent }));
    assert.equal(preview.videos, 0, "with no live session the snapshot must not reach __voiceboxSendLiveVideo");
    assert.match(preview.meta, /preview ready/, `and the line must say it is only a preview: ${preview.meta}`);

    // SNAPSHOT live: the same click now sends a real encoded frame.
    await page.evaluate(() => { window.__vision.live = true; });
    await page.click("#vision-snapshot-btn");
    await page.waitFor(() => window.__vision.videos.length > 0, { label: "the live frame to be sent", timeout: 30000 });
    const sent = await page.evaluate(() => ({ videos: window.__vision.videos, meta: document.getElementById("vision-core-meta").textContent }));
    assert.equal(sent.videos.at(-1).mime, "image/jpeg", "the live frame goes out as JPEG");
    assert.equal(sent.videos.at(-1).len > 100, true, `the payload must be a real encoded frame, got ${sent.videos.at(-1).len} characters`);
    assert.match(sent.meta, /^Camera live \(\d+×\d+\)$/, `the metadata line reports the frame size: ${sent.meta}`);

    // PTT, from the room's own button.
    await page.click("#vision-ptt-btn");
    await page.click("#vision-ptt-btn");
    const ptt = await page.evaluate(() => ({ activity: window.__vision.activity, text: document.getElementById("vision-ptt-btn").textContent }));
    assert.deepEqual(ptt.activity, ["start", "end"], "the PTT button sends start then end to the live session");
    assert.equal(ptt.text, "Push to talk");

    // STOP: the tracks the browser handed over must be RELEASED, which is what turns the camera light off.
    await page.click("#vision-stop-btn");
    await page.waitFor(() => document.getElementById("vision-core-meta")?.textContent === "Camera off", { label: "the metadata line to report the stop", timeout: 20000 });
    const off = await page.evaluate(() => ({
      tracks: window.__vision.streams.at(-1).getVideoTracks().map((t) => t.readyState),
      hidden: document.getElementById("vision-core-card").hidden,
      src: document.getElementById("vision-core-video").srcObject,
    }));
    assert.deepEqual(off.tracks, ["ended"], `stopping must END the camera track, not merely hide the card, got ${JSON.stringify(off.tracks)}`);
    assert.equal(off.hidden, true);
    assert.equal(off.src, null, "and the element must let go of the stream");

    // NEGATIVE CONTROL: a clone of the camera button carries the markup and none of the listeners, so nothing
    // may happen — which is what makes every assertion above evidence about the module's wiring.
    const cloned = await page.evaluate(async () => {
      const button = document.getElementById("vision-camera-btn");
      const clone = button.cloneNode(true);
      button.replaceWith(clone);
      const before = window.__vision.video;
      clone.click();
      await new Promise((resolve) => setTimeout(resolve, 400));
      return { before, after: window.__vision.video, hidden: document.getElementById("vision-core-card").hidden };
    });
    assert.equal(cloned.after, cloned.before, `a listener-free clone must not start a capture, got ${cloned.after} calls`);
    assert.equal(cloned.hidden, true, "and must not paint a card");
  } finally {
    try { if (page) await page.close(); } catch {}
    try { await server?.stop(); } catch {}
  }
});
