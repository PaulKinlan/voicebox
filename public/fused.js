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

function render() {
  const count = entries.length;
  if (!els.files || !els.made || !els.count) return;
  els.files.replaceChildren(...entries.map(card));
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
    await request("/api/health");
    if (els.dot) els.dot.dataset.ok = "true";
    if (els.where) els.where.textContent = "local server ready";
  } catch {
    if (els.dot) els.dot.dataset.ok = "false";
    if (els.where) els.where.textContent = "no answer from the local server";
  }
}

async function load() {
  if (entries.length === 0) showSkeleton();
  try {
    const { files: names } = await request("/api/files");
    entries = await Promise.all(names.map(async (name) => {
      try {
        const answer = await turn(`read ${name}`);
        const result = answer.result ?? {};
        if (result.ok) {
          const content = result.content ?? "";
          return { name, meta: size(content), preview: content.slice(0, 360) + (content.length > 360 ? "…" : "") };
        }
        return { name, meta: "on disk", why: result.error ?? answer.note ?? "the server would not read it back" };
      } catch (error) {
        return { name, meta: "on disk", why: error.message };
      }
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
    const answer = await turn(`read ${name}`);
    const result = answer.result ?? {};
    if (result.ok) {
      const content = result.content ?? "";
      els.readerFacts.textContent = `${size(content)} · read from workspace/${name} just now`;
      els.readerBody.textContent = content;
      els.reader.dataset.state = "ready";
      els.copy.disabled = content.length === 0;
    } else {
      els.readerFacts.textContent = result.error ?? answer.note ?? "the server would not read this file";
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
    if (answer.action?.verb === "read") showFile(result.action);
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

// ── which revision is this? ───────────────────────────────────────────────
// The dev server bakes the identity of its own checkout into this document at
// serve time (vite.config.js, transformIndexHtml). A server that did not stamp
// the page leaves the marker empty and this line stays blank: naming a revision
// the server never sent is the lie this whole line exists to prevent.
function stampBuild() {
  const line = document.getElementById("build");
  if (!line) return;
  const content = document.querySelector('meta[name="voicebox-build"]')?.getAttribute("content") ?? "";
  if (!content || content.includes("__VOICEBOX_BUILD_STAMP__")) return;
  line.textContent = content;
  line.dataset.dirty = String(content.includes("uncommitted"));
}

stampBuild();

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
