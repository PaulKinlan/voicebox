// Voicebox — the working surface.
//
// Everything this page shows comes from the local server: the file list is
// read from workspace/, a turn is posted to /api/turn, and a file is opened by
// reading its bytes back. There is no seeded content, no timer that fakes a
// state, and no claim the server has not made. Strings are rendered with
// textContent only.
const $ = (id) => document.getElementById(id);
const SVG = "http://www.w3.org/2000/svg";

// An uncaught error at module load aborts the REST of this file, so a page and
// a script from different revisions used to leave a half-dead page and a stack
// trace. A missing element is named instead, and the parts that need it stay
// inert while everything else keeps working (Paul hit this on 2026-09-19 by
// reloading across a live edit).
const WANTED = {
  files: "files", made: "made-list", samples: "samples", count: "file-count",
  where: "where-note", dot: "server-dot", refresh: "refresh", report: "turn-report", newFile: "new-file",
  rootKind: "root-kind", rootNote: "root-note", madeHeading: "made-heading",
  stage: "voice-ring-wrap", mic: "mic", state: "voice-state",
  session: "session", log: "session-log", form: "text-form", utterance: "utterance", send: "send",
  reader: "reader", readerTitle: "reader-title", readerFacts: "file-facts", readerBody: "file-body",
  copy: "file-copy", close: "reader-close", about: "about-facts", details: "reader-details",
  settingsOpen: "settings-open", settings: "settings", settingsClose: "settings-close",
  micSelect: "mic-select", outSelect: "out-select",
  micDeviceState: "mic-device-state", outDeviceState: "out-device-state", deviceNote: "device-note",
};
const els = {};
const missing = [];
for (const [key, id] of Object.entries(WANTED)) {
  const el = document.getElementById(id);
  els[key] = el;
  if (!el) missing.push(id);
}
if (missing.length) {
  console.warn(`[voicebox] this document has no ${missing.map((id) => `#${id}`).join(", ")} — the page and fused.js are not the same revision, so the features that need them stay inert. Reload the page.`);
}

/** Wire an event, or say which element is missing rather than throwing. */
function on(el, type, handler) {
  if (el) return el.addEventListener(type, handler);
  return null;
}

let shownFile = null; // the file currently in the reader panel

let entries = [];

// ── small helpers ──────────────────────────────────────────────────────────
const bytes = (text) => new TextEncoder().encode(text).length;
const size = (text) => {
  const n = typeof text === "string" ? bytes(text) : text;
  return `${n} ${n === 1 ? "byte" : "bytes"}`;
};

function setReport(outcome, tone, said) {
  if (!els.report) return;
  els.report.replaceChildren();
  if (said) {
    const quote = document.createElement("span");
    quote.textContent = `“${said}” `;
    els.report.append(quote);
  }
  const result = document.createElement("span");
  result.className = "report-outcome";
  result.textContent = outcome;
  els.report.append(result);
  els.report.dataset.tone = tone ?? "";
}

function setState(text, tone) {
  if (!els.state) return;
  els.state.textContent = text;
  els.state.dataset.tone = tone ?? "";
}

function icon(id) {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("class", "icon");
  const use = document.createElementNS(SVG, "use");
  use.setAttribute("href", `#${id}`);
  svg.append(use);
  return svg;
}

async function request(path, options) {
  const response = await fetch(path, options);
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.error ?? `the server answered ${response.status}`);
  if (!body) throw new Error("the server sent something that was not JSON");
  return body;
}

const turn = (transcript) => request("/api/turn", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ transcript }),
});

// ── what was made: a quiet name and its real size, nothing else ───────────
function card(entry) {
  const li = document.createElement("li");
  const open = document.createElement("button");
  open.type = "button";
  open.className = "file-open";
  open.dataset.file = entry.name;
  open.setAttribute("aria-label", `Read ${entry.name}`);

  const name = document.createElement("span");
  name.className = "file-name";
  name.textContent = entry.name;
  const meta = document.createElement("span");
  meta.className = "file-meta";
  meta.textContent = entry.meta;
  open.append(name, meta);

  open.addEventListener("click", () => showFile(entry.name));
  li.append(open);
  return li;
}

// An empty room still shows where the first file will land, so the promise has
// a place on screen instead of resting on copy alone.
function placeholder() {
  const li = document.createElement("li");
  li.className = "file-placeholder";
  li.textContent = "the first file appears here";
  return li;
}

function render() {
  const count = entries.length;
  if (!els.files || !els.made || !els.count) return;
  els.files.replaceChildren(...(count === 0 ? [placeholder()] : entries.map(card)));
  els.made.dataset.state = count === 0 ? "empty" : "ready";
  els.files.setAttribute("aria-busy", "false");
  els.count.textContent = count === 0 ? "nothing yet" : `${count} ${count === 1 ? "file" : "files"}`;
  if (shownFile && !entries.some((entry) => entry.name === shownFile)) shownFile = null;
  if (shownFile) showFileSelection(shownFile);
}

function showFileSelection(name) {
  for (const card of document.querySelectorAll(".file-open")) {
    card.setAttribute("aria-current", String(card.dataset.file === name));
  }
}

// The first paint is a skeleton of the real thing — a quiet name, arriving.
function showSkeleton() {
  els.made.dataset.state = "loading";
  els.files.setAttribute("aria-busy", "true");
  els.count.textContent = "reading…";
  const item = document.createElement("li");
  item.className = "skeleton skeleton-visible";
  item.setAttribute("aria-hidden", "true");
  const bar = document.createElement("span");
  bar.className = "bar";
  item.append(bar);
  els.files.replaceChildren(item);
}

// ── which root the loop writes into, and who acts on it ────────────────────
//
// Two different facts, always in this order: WHAT KIND of root it is (opfs, a
// picked folder, a folder on the machine) and only then whether anything can
// act on it from here. "There is no picked folder here" is not "permission
// denied", and a page that answers the second question with the first one's
// words is lying about the system it is looking at.
let activeRoot = undefined; // undefined = not asked yet, null = none declared

async function loadRoot() {
  try {
    const answer = await request("/api/root");
    activeRoot = answer?.declared ? answer : null;
  } catch {
    activeRoot = undefined; // an older server with no root seam: say so, do not invent one
  }
  renderRoot();
}

function renderRoot() {
  const kindEl = els.rootKind;
  const noteEl = els.rootNote;
  if (!kindEl || !noteEl) return;
  const clear = () => { noteEl.hidden = true; noteEl.textContent = ""; noteEl.dataset.tone = ""; };

  if (activeRoot === undefined) {
    kindEl.textContent = "root not reported";
    noteEl.textContent = "This server does not say which root the loop writes into, so this page cannot name it.";
    noteEl.dataset.tone = "warn";
    noteEl.hidden = false;
    return;
  }
  if (activeRoot === null) {
    kindEl.textContent = "no root declared";
    noteEl.textContent = "No project root is declared, so there is nothing for a turn to write into — the environment declares one when it opens a project.";
    noteEl.dataset.tone = "warn";
    noteEl.hidden = false;
    return;
  }

  const where = activeRoot.facts?.where ?? activeRoot.root?.kind ?? "a root";
  const name = activeRoot.root?.path ?? activeRoot.root?.name ?? activeRoot.root?.label ?? "";
  kindEl.textContent = name ? `${where} · ${name}` : where;
  kindEl.title = activeRoot.description ?? "";

  if (!activeRoot.reachableFromThisProcess) {
    // Kind first (in the chip), then reachability in the server's own words —
    // which distinguish "no root yet" from "a root this placement cannot act
    // on". Never "permission denied" for a kind that has no permission story.
    noteEl.textContent = activeRoot.why ?? activeRoot.refused ?? "this server cannot act on that root";
    noteEl.dataset.tone = "warn";
    noteEl.hidden = false;
    return;
  }
  clear();
}

async function health() {
  try {
    const answer = await request("/api/health");
    if (els.dot) els.dot.dataset.ok = "true";
    // The header answers ONE question — where the files are — so the server's
    // health is the dot, not a second label competing for the same slot. Two
    // labels describing storage in one line is what made the old header
    // ambiguous ("workspace/" and "local server ready" both looked like the
    // answer to "where are my files?").
    if (els.where) { els.where.textContent = ""; els.where.title = "the local server answered"; }
    stampBuild(answer.build ?? null);
    await loadRoot();
  } catch {
    if (els.dot) els.dot.dataset.ok = "false";
    if (els.where) { els.where.textContent = "no answer from the local server"; els.where.title = ""; }
    stampBuild(null);
    if (els.rootKind) els.rootKind.textContent = "root unknown";
    if (els.rootNote) { els.rootNote.textContent = "The local server is not answering, so which root it writes into cannot be checked."; els.rootNote.dataset.tone = "warn"; els.rootNote.hidden = false; }
  }
}

async function load() {
  if (entries.length === 0) showSkeleton();
  try {
    // One request for names AND sizes. Before the server had a read route this
    // read every file back through `POST /api/turn`, so a loaded page quietly
    // POSTed turns nobody typed — an independent verifier saw eight of them and
    // a `read alpha.txt` that was never spoken. Reading is not a turn.
    const { files: names, entries: listed } = await request("/api/files");
    const sizes = new Map((listed ?? []).map((entry) => [entry.name, entry.bytes]));
    entries = names.map((name) => ({
      name,
      meta: `${sizes.get(name) ?? 0} ${(sizes.get(name) ?? 0) === 1 ? "byte" : "bytes"}`,
    }));
    render();
  } catch (error) {
    entries = [];
    els.made.dataset.state = "failed";
    els.files.replaceChildren();
    els.files.setAttribute("aria-busy", "false");
    els.count.textContent = "could not read the folder";
  }
}

/** How to name a file's home in one string, whatever kind of root it is. */
function rootLabel() {
  const root = activeRoot?.root;
  if (!root) return "";
  const base = root.path ?? root.name ?? root.label ?? "";
  if (!base) return "";
  return `${base.replace(/\/$/, "")}/`;
}

async function showFile(name) {
  shownFile = name;
  els.copy.disabled = true;
  els.reader.dataset.state = "empty";
  els.readerTitle.textContent = name;
  els.readerFacts.textContent = "Reading…";
  els.readerBody.textContent = "";
  els.reader.dataset.state = "empty";
  showFileSelection(name);
  try {
    const answer = await request(`/api/file?name=${encodeURIComponent(name)}`);
    if (answer.ok) {
      const content = answer.content ?? "";
      // One short line: on a phone the old facts wrapped to five lines above a
      // two-line note (astra's landing review). The path is the title.
      els.readerFacts.textContent = `${size(content)} · read from disk`;
      els.readerFacts.title = `${rootLabel()}${name}, read just now`;
      els.readerBody.textContent = content;
      els.reader.dataset.state = "ready";
      els.copy.disabled = content.length === 0;
    } else {
      els.readerFacts.textContent = answer.error ?? "the server would not read this file";
      els.reader.dataset.state = "empty";
    }
  } catch (error) {
    els.readerFacts.textContent = `Could not read workspace/${name}: ${error.message}`;
  }
}

on(els.copy, "click", async () => {
  try {
    await navigator.clipboard.writeText(els.readerBody.textContent ?? "");
    els.readerFacts.textContent = `Copied ${shownFile} to the clipboard.`;
  } catch (error) {
    els.readerFacts.textContent = `The clipboard refused: ${error.message}`;
  }
});

on(els.close, "click", () => {
  shownFile = null;
  els.reader.dataset.state = "empty";
  els.readerBody.textContent = "";
  els.readerFacts.textContent = "";
  showFileSelection(null);
  document.querySelector(".file-open")?.focus();
});

// ── the turns ──────────────────────────────────────────────────────────────
function logTurn(said, outcome) {
  const li = document.createElement("li");
  const quote = document.createElement("span");
  quote.className = "said";
  quote.textContent = `“${said}”`;
  const did = document.createElement("span");
  did.className = "did";
  did.textContent = outcome;
  li.append(quote, did);
  if (!els.log || !els.session) return;
  els.log.prepend(li);
  els.session.hidden = false;
  while (els.log.children.length > 8) els.log.lastElementChild.remove();
}

function finish(said, outcome, tone) {
  setReport(outcome, tone, said);
  logTurn(said, outcome);
}

async function send(said) {
  const transcript = said.trim();
  if (!transcript) return;
  if (els.send) { els.send.disabled = true; els.send.textContent = "Sending…"; }
  setReport("Sending…");
  try {
    const answer = await turn(transcript);
    if (answer.error) return finish(transcript, answer.error, "bad");
    if (answer.note) return finish(transcript, answer.note, "bad");
    const result = answer.result ?? {};
    if (!result.ok) return finish(transcript, result.error ?? "the turn was refused", "bad");
    finish(transcript, result.action ?? "done", "good");
    if (answer.action?.verb === "read" && typeof result.content === "string") {
      els.readerTitle.textContent = result.action;
      els.readerFacts.textContent = `${size(result.content)} · read from disk`;
      els.readerFacts.title = `${rootLabel()}${result.action}, read just now`;
      els.readerBody.textContent = result.content;
      els.reader.dataset.state = "ready";
      els.copy.disabled = result.content.length === 0;
      showFileSelection(result.action);
    }
    await load();
  } catch (error) {
    finish(transcript, `the turn did not reach the server: ${error.message}`, "bad");
  } finally {
    if (els.send) { els.send.textContent = "Send"; els.send.disabled = !els.utterance.value.trim(); }
    health();
  }
}

// ── the microphone: the browser's dictation, and nothing more ─────────────
let recognition = null;

function listening(on) {
  if (els.stage) els.stage.dataset.voice = on ? "listening" : "off";
  els.mic?.setAttribute("aria-pressed", String(on));
}

function startListening() {
  // live-voice.js owns the microphone when it is on the page: dictation and a
  // live session must never both answer one click (module order is not a
  // guarantee, so this is checked at click time, not at attach time).
  if (window.__voiceboxLive) return;
  const Recognition = window.SpeechRecognition ?? window.webkitSpeechRecognition;
  if (!Recognition) {
    setState("No speech recognition in this browser — type your turn below.", "warn");
    return;
  }
  if (recognition) { recognition.stop(); return; }
  const rec = new Recognition();
  let stopped = "";
  recognition = rec;
  rec.lang = document.documentElement.lang || "en-GB";
  rec.interimResults = false;
  rec.maxAlternatives = 1;
  rec.onresult = (event) => {
    const said = event.results[0][0].transcript;
    setState("Heard it — sending your turn…");
    send(said);
  };
  rec.onerror = (event) => {
    stopped = `Speech recognition stopped: ${event.error}.`;
    setState(stopped, "warn");
  };
  rec.onend = () => {
    recognition = null;
    listening(false);
    if (!stopped) setState("Microphone off — press the circle to speak");
  };
  try {
    rec.start();
    listening(true);
    setState("Listening — speak your turn, then pause.");
  } catch (error) {
    recognition = null;
    listening(false);
    setState(`Could not start the microphone: ${error.message}`, "warn");
  }
}

on(els.mic, "click", startListening);
on(els.refresh, "click", load);
on(els.newFile, "click", () => {
  els.utterance.value = "create a file called ";
  els.utterance.focus();
  els.utterance.setSelectionRange(els.utterance.value.length, els.utterance.value.length);
  // The prefill is not a turn: Send stays off until a person adds the name, so
  // "create a file called " alone can never be sent (the script resolver would
  // read "called" as the filename and write a file by that name).
  els.send.disabled = true;
});
on(els.utterance, "input", () => { if (els.send) els.send.disabled = !els.utterance.value.trim(); });

on(els.form, "submit", (event) => {
  event.preventDefault();
  const said = els.utterance.value.trim();
  if (!said) return;
  els.utterance.value = "";
  send(said);
});

// ── devices: what was chosen, what is available, what is happening ────────
//
// Three separate facts per row, because conflating them is how a page ends up
// naming a device it is not using. The preference is stored as an id AND a
// name: the id is what getUserMedia and setSinkId take, the name is the only
// thing that can still name a device that has left the machine (isocan's
// lesson, kept). Device choice is a preference, never a grant.
const DEVICE_KEY = "voicebox.devices";

const devices = {
  prefs: { mic: { id: "", name: "" }, out: { id: "", name: "" } },
  inputs: [],
  outputs: [],
  namesVisible: false,
  canChooseOutput: true,
  // The routing decision, made explicitly rather than inherited: when the
  // chosen output disappears mid-reply this page STOPS playback and says so. It
  // does not silently move a private reply to the system speakers, because a
  // name change that implies a stop while sound keeps coming out somewhere else
  // is the audible version of a lying label.
  policy: "stop",
};

function loadPrefs() {
  try {
    const saved = JSON.parse(localStorage.getItem(DEVICE_KEY) ?? "null");
    if (saved?.mic) devices.prefs.mic = { id: String(saved.mic.id ?? ""), name: String(saved.mic.name ?? "") };
    if (saved?.out) devices.prefs.out = { id: String(saved.out.id ?? ""), name: String(saved.out.name ?? "") };
  } catch { /* no storage, or someone else's shape: start from the default */ }
}

function savePrefs() {
  try { localStorage.setItem(DEVICE_KEY, JSON.stringify(devices.prefs)); } catch { /* private mode */ }
}

async function listDevices() {
  if (!navigator.mediaDevices?.enumerateDevices) return { inputs: [], outputs: [], names: false };
  const all = await navigator.mediaDevices.enumerateDevices();
  const named = all.some((d) => d.label);
  return {
    inputs: all.filter((d) => d.kind === "audioinput").map((d) => ({ id: d.deviceId, name: d.label })),
    outputs: all.filter((d) => d.kind === "audiooutput").map((d) => ({ id: d.deviceId, name: d.label })),
    names: named,
  };
}

function fillPicker(select, list, pref, what, namesVisible) {
  if (!select) return;
  const options = [{ id: "", name: "System default" }, ...list.filter((d) => d.id !== "")];
  // An absent choice stays visible by its saved name rather than being replaced
  // by "System default": the preference is what the person set.
  if (pref.id && !options.some((option) => option.id === pref.id)) {
    // "not connected" is a CLAIM, and it is only sayable when the device list
    // can actually name devices. With names hidden the honest suffix is that
    // this is the name the person saved.
    options.push({ id: pref.id, name: `${pref.name || "chosen device"} · ${namesVisible ? "not connected" : "saved"}` });
  }
  const wanted = options.map((option) => `${option.id}\u0000${option.name}`).join("|");
  if (select.dataset.shape === wanted) return; // no rebuild of an unchanged picker
  select.dataset.shape = wanted;
  select.replaceChildren(...options.map((option) => {
    const el = document.createElement("option");
    el.value = option.id;
    el.textContent = option.name || `unnamed ${what}`;
    return el;
  }));
  select.value = pref.id ?? "";
}

function renderDevices() {
  const { prefs, inputs, outputs, canChooseOutput, namesVisible } = devices;
  fillPicker(els.micSelect, inputs, prefs.mic, "microphone", namesVisible);
  fillPicker(els.outSelect, outputs, prefs.out, "output", namesVisible);

  const micNamesHidden = !namesVisible;
  const micPresent = inputs.some((d) => d.id === prefs.mic.id);
  const outPresent = outputs.some((d) => d.id === prefs.out.id);

  const listening = els.stage?.dataset.voice === "listening";
  const speaking = els.stage?.dataset.voice === "speaking";
  const capture = Boolean(window.__voiceboxLiveClient?.state?.capture);

  const micName = prefs.mic.name || "System default";
  let mic = "";
  if (!prefs.mic.id) mic = listening ? "Listening through System default" : "Mic off";
  else if (micNamesHidden && !micPresent) mic = `${micName} · not checked yet — device names can be hidden until microphone access is allowed`;
  else if (listening) mic = `Listening through ${micName}`;
  else if (micPresent) mic = `${micName} · mic off`;
  else mic = `${micName} is not connected. Mic off.`;
  if (els.micDeviceState) els.micDeviceState.textContent = mic;

  let out = "";
  if (!canChooseOutput) out = "This browser uses system output. Change the output in your device's sound settings.";
  else if (!prefs.out.id) out = speaking ? "Reply playing through System default" : "No reply playing";
  else if (speaking && outPresent) out = `Reply playing through ${prefs.out.name || "the chosen output"}`;
  else if (!outPresent) {
    out = `${prefs.out.name || "The chosen output"} is not connected. `;
    out += speaking ? "Reply playback stopped." : "No reply playing.";
  } else out = "No reply playing";

  if (els.outDeviceState) els.outDeviceState.textContent = out;
  if (els.outSelect) els.outSelect.disabled = !canChooseOutput;

  // The client owns the voice-state line (it is derived from real capture and
  // playback); this page owns DEVICE facts, which the client cannot know. The
  // note below the line says only what the client's label cannot: a chosen
  // device missing, an output that cannot be chosen, names hidden. Two writers
  // fighting over one line is how a page ends up contradicting itself.
  const notes = [];
  const playing = Boolean(window.__voiceboxLiveClient?.state?.playbackActive);
  if (prefs.mic.id && !micPresent && !micNamesHidden) notes.push(`${micName} is not connected — connect it or choose another microphone`);
  if (prefs.mic.id && micNamesHidden && !micPresent) notes.push("Device names are hidden until microphone access is allowed — the names here are the ones you saved");
  if (!canChooseOutput) {
    // This browser cannot route output at all: the fact to say is that one, and
    // nothing about a stop it never performed.
    if (prefs.out.id) notes.push("This browser uses system output; the remembered output is not the route in use");
  } else if (prefs.out.id && !outPresent) {
    // The explicit policy: name the missing device AND say where the audio
    // actually is, because "not connected" alone can hide a fallback playing
    // out of the speakers.
    notes.push(`${prefs.out.name || "The chosen output"} is not connected — ${playing ? "reply playback stopped" : "no reply playing"}`);
  }
  if (els.deviceNote) {
    els.deviceNote.textContent = notes.join(" · ");
    els.deviceNote.hidden = notes.length === 0;
  }
}

async function refreshDevices() {
  const before = { mic: devices.prefs.mic.id, out: devices.prefs.out.id };
  const listed = await listDevices();
  devices.inputs = listed.inputs;
  devices.outputs = listed.outputs;
  devices.canChooseOutput = window.__voiceboxLiveClient?.canChooseOutput?.() ?? false;
  devices.namesVisible = listed.names === true;

  // INPUT: a chosen microphone that has left is named; capture is never moved to
  // another device silently, and the output row is untouched.
  if (before.mic && !listed.inputs.some((d) => d.id === before.mic)) {
    if (els.stage?.dataset.voice === "listening" || window.__voiceboxLiveClient?.state?.capture) {
      await window.__voiceboxLiveClient?.stopCapture?.();
    }
  }

  // OUTPUT: the decided policy is to STOP rather than fall back. Name where the
  // audio actually is, and keep Stop reply working.
  if (before.out && !listed.outputs.some((d) => d.id === before.out)) {
    if (devices.policy === "stop" && window.__voiceboxLiveClient?.state?.playbackActive) {
      window.__voiceboxLiveClient.stopPlayback?.();
    }
  }
  renderDevices();
}

on(els.micSelect, "change", async () => {
  const choice = devices.inputs.find((d) => d.id === els.micSelect.value);
  devices.prefs.mic = { id: els.micSelect.value, name: choice?.name ?? "" };
  savePrefs();
  renderDevices();
});

on(els.outSelect, "change", async () => {
  const choice = devices.outputs.find((d) => d.id === els.outSelect.value);
  const previous = { ...devices.prefs.out };
  devices.prefs.out = { id: els.outSelect.value, name: choice?.name ?? "" };
  savePrefs();
  if (els.outDeviceState) els.outDeviceState.textContent = `Switching output to ${devices.prefs.out.name || "System default"}…`;
  const applied = await window.__voiceboxLiveClient?.setOutputDevice?.(devices.prefs.out.id || "");
  if (applied && !applied.ok) {
    devices.prefs.out = previous;
    savePrefs();
    if (els.outDeviceState) els.outDeviceState.textContent = `Could not use ${choice?.name || "that output"}. ${applied.reason}.`;
    renderDevices();
    return;
  }
  renderDevices();
});

on(els.settingsOpen, "click", () => {
  if (!els.settings || els.settings.open) return;
  // Opening settings does not start capture, stop playback or end the session.
  //
  // showModal() IS the feature: top layer, modality, focus trapped inside, the room behind inert,
  // Esc as a close request, and focus handed back here on close. All of it is the platform's, which
  // is the point — a hand-rolled overlay gets four of those five wrong.
  els.settings.showModal();
  els.settingsOpen.setAttribute("aria-expanded", "true");
  refreshDevices();
});

// Every close path — the form's method="dialog" button, Esc, light dismiss, or a programmatic
// close — arrives here, so the trigger's state is honest whichever way it went.
on(els.settings, "close", () => {
  els.settingsOpen.setAttribute("aria-expanded", "false");
  els.settingsOpen.focus();
});

// Light dismiss, declaratively, where the platform supports it: `closedby="any"` on the element.
//
// The documented FALLBACK for browsers that do not (Safari, at the time of writing) is the geometry
// check below — the click's target is the dialog only when the click landed on the backdrop, and the
// coordinates tell the difference between the backdrop and the dialog's own padding.
if (els.settings && !("closedBy" in HTMLDialogElement.prototype)) {
  els.settings.addEventListener("click", (event) => {
    if (event.target !== els.settings) return;
    const rect = els.settings.getBoundingClientRect();
    const inside = rect.top <= event.clientY && event.clientY <= rect.top + rect.height
      && rect.left <= event.clientX && event.clientX <= rect.left + rect.width;
    if (!inside) els.settings.close("dismissed");
  });
}

// ── the two meters: your voice, and the agent's ───────────────────────────
// Driven by the real PCM the client already has (audio-client.js `level()`):
// input energy at the microphone, and one radius per output sample around the
// circle. No audio, no picture — a meter that animates while nothing is being
// heard is the same lie as a "listening" label with the mic off.
const OUTPUT_SAMPLES = 64;
const INPUT_BARS_PAGE = 28;
const OUTPUT_CENTRE = 120;
const OUTPUT_BASE = 62; // hugs the button (radius ~55 in these units)
const OUTPUT_AMPLITUDE = 13; // a contour hugging the button, lightly textured by real audio

// Mean-absolute energy from real speech is small (a quiet room reads ~0.01, a
// talking voice ~0.03-0.1), so a linear meter sits at zero and never moves.
// The square root spreads the quiet end and saturates at the loud end — a meter
// you can read, still driven entirely by the real signal.
function meterLevel(value) {
  const energy = Number(value);
  if (!Number.isFinite(energy) || energy <= 0) return 0;
  return Math.min(1, Math.sqrt(energy) * 1.9);
}

// ── the output ring: a smooth closed curve that morphs at frame rate ───────
//
// Two separate problems made this look "stilted and jilted" (Paul, 2026-09-20):
//
//   1. GEOMETRY. The old path joined 64 sample points with straight `L`
//      segments, so the ring was a 64-gon and its edges were visible.
//   2. DATA RATE. Samples arrive with the audio — around 12 a second — while
//      the loop draws at 60. Redrawing the same numbers 58 times a second is
//      not animation: what the eye sees is ~12 discrete jumps a second, each
//      one shifting the whole ring by a whole sample.
//
// So the ring keeps a *fractional phase* that eases toward the newest data and
// samples the ring between its points, and the polyline is turned into a closed
// Catmull-Rom curve through denser points. The picture then changes every frame
// (measured 60/s, see the drive note in the commit) while the data underneath
// still arrives at the audio rate — the honest way to interpolate a coarse
// signal rather than pretending it is faster than it is.
const RENDER_POINTS = 160; // drawn points around the ring (was 64, straight-joined)
let ringPhase = 0;         // where we are rendering, in ring positions
let ringTarget = 0;        // where the newest data has arrived, in ring positions
let ringSeen = null;       // the newest sample we have already counted

function ringAt(samples, position) {
  const n = samples.length;
  const i = Math.floor(position) % n;
  const j = (i + 1) % n;
  const t = position - Math.floor(position);
  return samples[i] * (1 - t) + samples[j] * t;
}

/** Closed Catmull-Rom through the points, as cubic Béziers — no visible facets. */
function closedCurve(points) {
  const n = points.length;
  const at = (i) => points[(i % n + n) % n];
  let d = `M${at(0)[0].toFixed(2)},${at(0)[1].toFixed(2)}`;
  for (let i = 0; i < n; i++) {
    const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2);
    const c1x = p1[0] + (p2[0] - p0[0]) / 6;
    const c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6;
    const c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += `C${c1x.toFixed(2)},${c1y.toFixed(2)} ${c2x.toFixed(2)},${c2y.toFixed(2)} ${p2[0].toFixed(2)},${p2[1].toFixed(2)}`;
  }
  return `${d}Z`;
}

function drawOutputRing(samples) {
  const path = document.getElementById("output-path");
  if (!path) return;
  if (!samples) {
    path.removeAttribute("d");
    ringSeen = null;
    ringPhase = 0;
    ringTarget = 0;
    return;
  }
  // Count a new sample once: the newest value changing is the signal that the
  // client's ring advanced (it advances on PLAYBACK, not on arrival).
  const newest = samples[samples.length - 1];
  if (ringSeen === null || Math.abs(newest - ringSeen) > 1e-6) {
    ringSeen = newest;
    ringTarget += 1;
  }
  // Ease the render phase toward the data, so a step arrives as a movement.
  ringPhase += (ringTarget - ringPhase) * 0.18;

  const points = [];
  for (let i = 0; i < RENDER_POINTS; i++) {
    const position = ringPhase + (i / RENDER_POINTS) * OUTPUT_SAMPLES;
    const angle = (i / RENDER_POINTS) * Math.PI * 2 - Math.PI / 2;
    const radius = OUTPUT_BASE + meterLevel(ringAt(samples, position)) * OUTPUT_AMPLITUDE;
    points.push([OUTPUT_CENTRE + Math.cos(angle) * radius, OUTPUT_CENTRE + Math.sin(angle) * radius]);
  }
  path.setAttribute("d", closedCurve(points));
}

// ── the input wave: fills the button, clipped by its inner circle ─────────
//
// Paul, 2026-09-20: "It just looks like a little blue bar that kind of grows…
// I'd expect it to be bigger and maybe kind of clipped to the inner circle of
// the big button." The old version was capped at ±11 units in a 40-tall box on
// purpose; this one uses the whole 100-unit circle and lets the clip do the
// framing, with attack/decay so quiet speech still moves instead of sitting on
// the floor (attack is fast, decay is slow — the eye reads movement, and a
// meter that snaps back to nothing between syllables reads as broken).
const inputDisplay = new Float32Array(INPUT_BARS_PAGE);
let inputInit = false;
// A running peak, decaying slowly, so the wave uses the space it has at ANY
// speaking level instead of sitting near the floor for quiet speech. Below a
// floor it stops amplifying: a silent room must not be drawn as a loud one,
// which is the difference between a normalised meter and a lie.
let inputPeak = 0;
const INPUT_GATE = 0.12;

function drawInputWave(samples) {
  const path = document.getElementById("input-path");
  if (!path) return;
  if (!samples) {
    path.removeAttribute("d");
    inputInit = false;
    return;
  }
  const n = samples.length;
  if (!inputInit || inputDisplay.length !== n) {
    inputDisplay.fill(0);
    inputInit = true;
  }
  const middle = 50;
  const maxHalf = 46; // the clip circle's radius: the wave fills it, the circle trims it
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, meterLevel(samples[i]));
  inputPeak = Math.max(peak, inputPeak * 0.94);
  const gain = inputPeak >= INPUT_GATE ? 1 / inputPeak : 1;
  let top = "";
  let bottom = "";
  for (let i = 0; i < n; i++) {
    const target = Math.min(maxHalf, meterLevel(samples[i]) * gain * maxHalf * 0.85);
    // attack fast, decay slow
    inputDisplay[i] += (target - inputDisplay[i]) * (target > inputDisplay[i] ? 0.6 : 0.12);
    const half = Math.max(0.8, inputDisplay[i]);
    // x spans the full width; the ends are cut by the circle rather than padded
    const x = ((i / (n - 1)) * 108 - 4).toFixed(2);
    top += `${i ? "L" : "M"}${x},${(middle - half).toFixed(2)}`;
    bottom = `L${x},${(middle + half).toFixed(2)}` + bottom;
  }
  path.setAttribute("d", `${top}${bottom}Z`);
}

// The animation handle lives on the window, not in a module variable: after a
// hot update two module instances can both hold a loop, and two loops writing
// one path is how a meter ends up drawing a stale revision over a live one.
function stopMeters() {
  if (window.__voiceboxMeterFrame) {
    cancelAnimationFrame(window.__voiceboxMeterFrame);
    window.__voiceboxMeterFrame = 0;
  }
}

function meters() {
  const client = window.__voiceboxLiveClient;
  const voice = els.stage?.dataset.voice;
  if (client?.level && (voice === "listening" || voice === "speaking")) {
    const reading = client.level();
    if (voice === "listening") drawInputWave(reading.input);
    drawOutputRing(reading.output);
    window.__voiceboxMeterFrame = requestAnimationFrame(meters);
    return;
  }
  // Nothing is being heard or played: clear both meters rather than leave the
  // last frame frozen on screen pretending to be live.
  window.__voiceboxMeterFrame = 0;
  drawInputWave(null);
  drawOutputRing(null);
}

function startMeters() {
  if (!window.__voiceboxMeterFrame) window.__voiceboxMeterFrame = requestAnimationFrame(meters);
}

stopMeters();

loadPrefs();
window.__voiceboxDevices = {
  micId: () => devices.prefs.mic.id || null,
  outputId: () => devices.prefs.out.id || null,
  state: () => ({ ...devices.prefs, policy: devices.policy }),
};
if (navigator.mediaDevices?.addEventListener) navigator.mediaDevices.addEventListener("devicechange", refreshDevices);
refreshDevices();

// A seam for driving the two meters without a microphone: a headless browser
// has no device, so the visual can only be checked here by handing the drawing
// the same arrays the client produces. The live path above is unchanged and
// still reads real PCM from the client; this is how the verifier proves the
// picture responds to data rather than being decoration.
window.__voiceboxMeters = { drawInputWave, drawOutputRing, startMeters };

// ── which revision is this? ───────────────────────────────────────────────
// The dev server bakes the identity of its own checkout into this document at
// serve time (vite.config.js, transformIndexHtml). A server that did not stamp
// the page leaves the marker empty and this line stays blank: naming a revision
// the server never sent is the lie this whole line exists to prevent.
function pageBuild() {
  const content = document.querySelector('meta[name="voicebox-build"]')?.getAttribute("content") ?? "";
  if (!content || content.includes("__VOICEBOX_BUILD_STAMP__")) return "";
  return content;
}

function stampBuild(server) {
  const line = document.getElementById("build");
  if (!line) return;
  const page = pageBuild();
  if (!page) return;
  // BOTH HALVES, because they go stale independently: Vite reloads the page on
  // every edit and the node process behind it never does. On 2026-09-19 Paul
  // spent an hour on "the voice does not work with the API keys" while the page
  // happily reported its own revision and said nothing about a server started
  // before /live existed.
  const parts = [`page ${page}`];
  if (server?.commit) {
    parts.push(`server ${server.branch} @ ${server.commit}${server.dirty ? " · uncommitted changes" : ""}`);
  } else if (server === null) {
    parts.push("server revision unknown");
  }
  // The comparison is on the sha alone: both halves carry branch, distance from
  // their remote and a dirty flag, and those are allowed to differ legitimately.
  const sha = (text) => (text.match(/@\s*([0-9a-f]{7,40})/) ?? [])[1] ?? null;
  const mismatch = Boolean(server?.commit) && sha(page) !== null && server.commit !== sha(page);
  if (mismatch) parts.push("the server is a different revision — restart it");
  line.textContent = parts.join(" · ");
  line.dataset.dirty = String(mismatch || Boolean(server?.dirty) || page.includes("uncommitted"));
}

stampBuild(undefined);
if (els.stage) new MutationObserver(startMeters).observe(els.stage, { attributes: true, attributeFilter: ["data-voice"] });

// The empty state teaches the loop with turns the resolver really answers.
const SAMPLES = [
  "create a file called notes.md with the first thing I noticed today",
  "create a file called ideas.txt with a sorter for walks and reading",
  "list files",
];
for (const said of SAMPLES) {
  const li = document.createElement("li");
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = said;
  button.addEventListener("click", () => send(said));
  li.append(button);
  els.samples.append(li);
}
if (els.where) els.where.textContent = "checking the local server…";

health();
load();
