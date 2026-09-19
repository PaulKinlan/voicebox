// voicebox fused page — astra's designed surface driving the real loop.
// Real: files on disk, the turn submission, the containment refusals.
// Simulated (labelled on the page): the N19 shared view, seen-marks, admission.
const $ = (id) => document.getElementById(id);

async function loadFiles() {
  const r = await fetch("/api/files");
  const { files } = await r.json();
  const list = document.querySelector(".objects");
  if (!list) return;
  list.replaceChildren(...files.map((name) => {
    const li = document.createElement("li");
    li.className = "object";
    const btn = document.createElement("span");
    btn.className = "artifact-caption";
    const strong = document.createElement("strong");
    strong.textContent = name;
    btn.append(strong);
    li.append(btn);
    return li;
  }));
  const count = files.length;
  const arrival = document.getElementById("arrival-count");
  if (arrival) arrival.textContent = `${count} file${count === 1 ? "" : "s"} on disk`;
  const empty = document.getElementById("empty");
  if (empty) empty.hidden = count > 0;
  if (list) list.hidden = count === 0;
}

async function doTurn(transcript) {
  if (!transcript.trim()) return;
  const r = await fetch("/api/turn", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ transcript }),
  });
  const j = await r.json();
  if (j.result?.ok) {
    await loadFiles(); // the workspace changed — re-render the real files
  } else if (j.error || j.note) {
    const err = document.createElement("div");
    err.className = "object";
    err.textContent = j.error ?? j.note ?? "the turn was not executed";
    document.querySelector(".objects")?.prepend(err);
  }
  return j;
}

// ── text form ──────────────────────────────────────────────────────────────
const form = document.getElementById("text-form") ?? document.querySelector("form");
if (form) {
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = form.querySelector("textarea, input[type=text], input");
    if (!input?.value?.trim()) return;
    await doTurn(input.value.trim());
    input.value = "";
  });
}

// ── mic: SpeechRecognition → POST /api/turn ───────────────────────────────
const micButton = document.getElementById("mic");
micButton?.addEventListener("click", () => {
  const SR = window.SpeechRecognition ?? window.webkitSpeechRecognition;
  if (!SR) { micButton.textContent = "Speech recognition unavailable"; return; }
  const rec = new SR();
  rec.lang = "en-GB";
  rec.interimResults = false;
  rec.maxAlternatives = 1;
  rec.onresult = (e) => { doTurn(e.results[0][0].transcript); };
  rec.onerror = (e) => { micButton.textContent = `mic error: ${e.error}`; };
  rec.onend = () => { micButton.textContent = "\u25cf hold a turn"; };
  micButton.textContent = "listening\u2026";
  rec.start();
});

// ── init ──────────────────────────────────────────────────────────────────
loadFiles();
