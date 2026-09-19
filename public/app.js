// The loop: capture a turn (mic or text) -> POST /api/turn -> render the
// action and its result. Speech recognition is the browser's own
// (webkitSpeechRecognition, Chrome) — no key, no library.
const mic = document.getElementById("mic");
const turns = document.getElementById("turns");

function addTurn(transcript, payload) {
  const el = document.createElement("div");
  el.className = "turn";
  const heard = `<div class="heard">“${transcript}”</div>`;
  if (payload.action) {
    const what = payload.action.verb === "list"
      ? `list → ${(payload.result?.files ?? []).join(", ") || "(empty)"}`
      : `${payload.action.verb} ${payload.action.name || ""}`;
    el.innerHTML = `${heard}<div class="action">${what}</div>` +
      `<div class="result">${payload.result?.ok ? payload.result.action ?? "" : ""}</div>`;
  } else if (payload.error) {
    el.innerHTML = `${heard}<div class="result err">${payload.error}</div>`;
  } else {
    el.innerHTML = `${heard}<div class="result err">${payload.note ?? ""}</div>`;
  }
  turns.prepend(el);
}

async function sendTurn(transcript) {
  if (!transcript.trim()) return;
  const res = await fetch("/api/turn", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ transcript }),
  });
  addTurn(transcript, await res.json());
}

// ── speech: the platform's own recognition, one press per turn ────────────
const SR = window.SpeechRecognition ?? window.webkitSpeechRecognition;
let rec = null;

mic.addEventListener("click", () => {
  if (rec) { rec.stop(); rec = null; mic.textContent = "● hold a turn"; return; }
  if (!SR) {
    mic.textContent = "speech recognition unavailable — use the text field";
    return;
  }
  rec = new SR();
  rec.lang = "en-GB";
  rec.interimResults = false;
  rec.maxAlternatives = 1;
  rec.onresult = (e) => {
    const said = e.results[0][0].transcript;
    mic.textContent = "● hold a turn";
    rec = null;
    sendTurn(said);
  };
  rec.onerror = (e) => {
    mic.textContent = "● hold a turn";
    if (e.error !== "aborted") mic.textContent = `mic error: ${e.error}`;
  };
  rec.onend = () => { if (mic.textContent.startsWith("listening")) mic.textContent = "● hold a turn"; };
  mic.textContent = "listening… (speak now)";
  rec.start();
});

document.getElementById("text-fallback").addEventListener("submit", (e) => {
  e.preventDefault();
  const typed = document.getElementById("typed");
  sendTurn(typed.value);
  typed.value = "";
});
