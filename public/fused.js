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

// ── live voice: mic ⇄ /live ⇄ Gemini Live ────────────────────────────────
// Dictation above is one-way (you speak, it transcribes, a turn happens).
// This is the conversation: the mic streams PCM16 (16 kHz, captured in a
// 16 kHz AudioContext so the BROWSER resamples — no hand-rolled resampler),
// and the model's PCM16 (24 kHz) streams back and plays. The page says which
// of the two is live, because a page that says "voice" while doing dictation
// is a label waiting to bite.
const liveButton = document.getElementById("live-mic");
const liveLabel = document.getElementById("live-label");
let liveSocket = null;
let liveCtx = null;

function setLiveLabel(text) { if (liveLabel) liveLabel.textContent = text; }

function floatTo16(f32) {
  const pcm = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) {
    const s = Math.max(-1, Math.min(1, f32[i]));
    pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return pcm;
}

async function startLive() {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  liveCtx = new AudioContext({ sampleRate: 16000 }); // Chrome resamples natively.
  const src = liveCtx.createMediaStreamSource(stream);
  await liveCtx.audioWorklet.addModule("/pcm-worklet.js");
  const node = new AudioWorkletNode(liveCtx, "pcm-capture");
  src.connect(node);

  const proto = location.protocol === "https:" ? "wss" : "ws";
  liveSocket = new WebSocket(`${proto}://${location.host}/live`);
  liveSocket.binaryType = "arraybuffer";

  const playCtx = new AudioContext({ sampleRate: 24000 }); // Gemini's output rate.
  let playHead = playCtx.currentTime + 0.05;
  const playPcm = (buf) => {
    const pcm = new Int16Array(buf);
    const f32 = new Float32Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) f32[i] = pcm[i] / 0x8000;
    const audio = playCtx.createBuffer(1, f32.length, 24000);
    audio.getChannelData(0).set(f32);
    const src = playCtx.createBufferSource();
    src.buffer = audio;
    src.connect(playCtx.destination);
    if (playHead < playCtx.currentTime) playHead = playCtx.currentTime + 0.02;
    src.start(playHead);
    playHead += audio.duration;
  };

  liveSocket.onmessage = (e) => {
    if (typeof e.data === "string") {
      const msg = JSON.parse(e.data);
      if (msg.type === "state" && msg.state === "ready") {
        setLiveLabel(`live: ${msg.model ?? "the live model"} — talk`);
        if (msg.detail?.gatedFrames > 0) setLiveLabel(`live: ${msg.model} — ${msg.detail.gatedFrames} early frame(s) held at the readiness gate`);
      } else if (msg.type === "state") {
        setLiveLabel(`live: ${msg.state}`);
      } else if (msg.type === "text") {
        setLiveLabel(`live: ${msg.role === "model-transcript" ? msg.text : liveLabel?.textContent}`);
      } else if (msg.type === "error") {
        setLiveLabel(`live error: ${msg.error}`);
      }
      return;
    }
    playPcm(e.data); // a binary frame is model audio, 24 kHz PCM16
  };
  liveSocket.onclose = () => setLiveLabel("live: closed");
  liveSocket.onerror = () => setLiveLabel("live: socket error — the text path still works");

  node.port.onmessage = (e) => {
    if (liveSocket?.readyState === WebSocket.OPEN) {
      liveSocket.send(floatTo16(e.data).buffer);
    }
  };
}

liveButton?.addEventListener("click", () => {
  if (liveSocket?.readyState === WebSocket.OPEN) {
    liveSocket.send(JSON.stringify({ type: "stop" }));
    liveSocket.close();
    liveCtx?.close();
    liveSocket = null;
    setLiveLabel("live: off");
    return;
  }
  setLiveLabel("live: connecting…");
  startLive().catch((e) => setLiveLabel(`live: ${e.message ?? e}`));
});

// ── init ──────────────────────────────────────────────────────────────────
loadFiles();
