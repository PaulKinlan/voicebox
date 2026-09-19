// Voicebox — the working surface.
//
// Everything this page shows comes from the local server: the file list is
// read from workspace/, a turn is run through the agent loop (lib/loop.mjs),
// and a file is opened by reading its bytes back. There is no seeded content,
// no timer that fakes a state, and no claim the server has not made. Strings
// are rendered with textContent only.
import { createLoop } from "/lib/loop.mjs";

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
  stage: "voice-ring-wrap", mic: "mic", state: "voice-state",
  session: "session", log: "session-log", form: "text-form", utterance: "utterance", send: "send",
  reader: "reader", readerTitle: "reader-title", readerFacts: "file-facts", readerBody: "file-body",
  copy: "file-copy", close: "reader-close",
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

// The page drives the SAME cycle the server runs (brief N18): lib/loop.mjs is
// served byte-for-byte from the server's own copy, so there is no client-side
// reimplementation of the loop to drift. The decide and dispatch stages reach
// the server over HTTP — the model and the filesystem live behind it — but
// the cycle itself (turn → decide → dispatch → result → record) runs here.
const post = (path, payload) => request(path, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(payload),
});

const loop = createLoop({
  execute: (action) => post("/api/execute", action).then((r) => r.result),
});
loop.registerResolver("remote", async (transcript) => {
  const r = await post("/api/resolve", { transcript });
  return r.action ?? { unresolved: r.note ?? "the server did not resolve the turn" };
});

const turn = (transcript) => loop.runTurn(transcript, { provider: "remote" });

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

async function health() {
  try {
    const answer = await request("/api/health");
    if (els.dot) els.dot.dataset.ok = "true";
    if (els.where) els.where.textContent = "local server ready";
    stampBuild(answer.build ?? null);
  } catch {
    if (els.dot) els.dot.dataset.ok = "false";
    if (els.where) els.where.textContent = "no answer from the local server";
    stampBuild(null);
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
      els.readerFacts.textContent = `${size(content)} · read from workspace/${name} just now`;
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
      els.readerFacts.textContent = `${size(result.content)} · read from workspace/${result.action} just now`;
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

// ── the two meters: your voice, and the agent's ───────────────────────────
// Driven by the real PCM the client already has (audio-client.js `level()`):
// input energy at the microphone, and one radius per output sample around the
// circle. No audio, no picture — a meter that animates while nothing is being
// heard is the same lie as a "listening" label with the mic off.
const OUTPUT_SAMPLES = 64;
const OUTPUT_CENTRE = 120;
const OUTPUT_BASE = 96;
const OUTPUT_AMPLITUDE = 16;

// Mean-absolute energy from real speech is small (a quiet room reads ~0.01, a
// talking voice ~0.03-0.1), so a linear meter sits at zero and never moves.
// The square root spreads the quiet end and saturates at the loud end — a meter
// you can read, still driven entirely by the real signal.
function meterLevel(value) {
  const energy = Number(value);
  if (!Number.isFinite(energy) || energy <= 0) return 0;
  return Math.min(1, Math.sqrt(energy) * 1.9);
}

function drawOutputRing(samples) {
  const path = document.getElementById("output-path");
  if (!path) return;
  if (!samples) { path.removeAttribute("d"); return; }
  let d = "";
  for (let i = 0; i < OUTPUT_SAMPLES; i++) {
    const angle = (i / OUTPUT_SAMPLES) * Math.PI * 2 - Math.PI / 2;
    const radius = OUTPUT_BASE + meterLevel(samples[i]) * OUTPUT_AMPLITUDE;
    d += `${i ? "L" : "M"}${(OUTPUT_CENTRE + Math.cos(angle) * radius).toFixed(2)},${(OUTPUT_CENTRE + Math.sin(angle) * radius).toFixed(2)}`;
  }
  path.setAttribute("d", `${d}Z`);
  path.dataset.rev = `r4 first=${String(samples[0])} level=${meterLevel(samples[0]).toFixed(3)}`;
}

function drawInputWave(samples) {
  const path = document.getElementById("input-path");
  if (!path) return;
  if (!samples) { path.removeAttribute("d"); return; }
  const n = samples.length;
  const middle = 20;
  const height = 15;
  let top = "";
  let bottom = "";
  for (let i = 0; i < n; i++) {
    const x = ((i / (n - 1)) * 100).toFixed(2);
    const half = Math.max(1, meterLevel(samples[i]) * height);
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
  const mismatch = Boolean(server?.commit) && page.includes("@") && server.commit !== page.split("@").pop().trim().split(" ")[0];
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
