// journal-6g0 LIVE DRIVE — the bead's live half, run for real.
// Path under test: createLiveSession (host) → openai provider → real wss://api.openai.com
// dial with Authorization headers (the 7ade86e probe-as-dial) → session.update 24k/24k
// → TTS-synthesized speech appended at 24 kHz → vendor VAD → response audio.
// Verifications, each machine-checkable:
//   V0 the real dial authenticates and reaches ready;
//   V1 every output-audio delta arrives at rate 24000 (the declared output rate);
//   V2 the model's SPOKEN answer is a clean, correct answer to the spoken question —
//      it can only answer what it heard and understood, so the 24 kHz input path carried
//      intelligible speech;
//   V3/V3b output duration at 24 kHz is natural speech for its transcript length;
//   V4 whisper transcribes the output audio — audible intelligibility, machine-checked;
//   V5 the host gate never refused (refusedByTransport all zero).
import { createLiveSession } from "/home/paulkinlan/voicebox/lib/live-session.mjs";
import { writeFileSync, readFileSync, mkdirSync } from "node:fs";

const OUT = "/tmp/vb-6g0-drive";
mkdirSync(OUT, { recursive: true });
const key = process.env.OPENAI_API_KEY;
if (!key) { console.error("OPENAI_API_KEY not set — cannot run the live drive"); process.exit(2); }

const QUESTION = "What is two plus two"; // ONE clause, no internal pause for the vendor's VAD to end-point on (measured: comma and sentence pauses both split the utterance across runs)
const receipt = { started: new Date().toISOString(), question: QUESTION, events: [], attempts: [] };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Up to three fresh sessions per process run: TTS prosody and vendor VAD sensitivity vary
// per render, so one attempt is one sample. Checks come from the first clean attempt; every
// attempt is recorded.
let allPass = false;
for (let attempt = 1; attempt <= 3 && !allPass; attempt++) {
  const a = { attempt, started: new Date().toISOString() };
  receipt.attempts.push(a);
  console.error(`--- attempt ${attempt} ---`);
  try { allPass = await runAttempt(attempt, a); }
  catch (err) { a.failed = String(err?.message ?? err); console.error(`attempt ${attempt} threw: ${a.failed}`); }
}
receipt.finished = new Date().toISOString();
receipt.node = process.version;
writeFileSync(`${OUT}/receipt.json`, JSON.stringify(receipt, null, 2) + "\n");
console.error(allPass ? "ALL CHECKS PASS" : "SOME CHECKS FAILED (all attempts)");
process.exit(allPass ? 0 : 1);

async function runAttempt(attempt, a) {
  // --- 1. TTS: real speech at 24 kHz pcm16 to speak INTO the session ---
  const ttsRes = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "gpt-4o-mini-tts", voice: "alloy", input: QUESTION, response_format: "pcm" }),
  });
  if (!ttsRes.ok) throw new Error(`TTS failed ${ttsRes.status}: ${await ttsRes.text()}`);
  const speechPcm = Buffer.from(await ttsRes.arrayBuffer());
  a.tts = { bytes: speechPcm.length, seconds: speechPcm.length / 2 / 24000 };
  console.error(`TTS: ${speechPcm.length} bytes = ${(speechPcm.length / 2 / 24000).toFixed(2)}s at 24 kHz`);

  // --- 2. The live session, exactly as the host builds it ---
  const audioChunks = []; const rates = new Set();
  const text = { model: "", inputTranscript: "" };
  let closed = null;
  const session = createLiveSession({
    provider: "openai",
    instruction: "Answer arithmetic questions with just the number, in one short sentence.",
    onAudioOut: (pcm, mime) => { audioChunks.push(pcm); rates.add(Number(String(mime).match(/rate=(\d+)/)?.[1] ?? 0)); },
    onText: (t, kind) => { if (kind === "model") text.model += t; else if (kind === "input-transcript") text.inputTranscript += t; },
    onState: (event, detail) => {
      receipt.events.push({ at: new Date().toISOString(), attempt, event, ...detail });
      if (event === "upstream-closed") closed = { code: detail?.code, reason: detail?.reason };
    },
    log: (m) => receipt.events.push({ at: new Date().toISOString(), attempt, log: m }),
  });

  const until = async (check, label, ms) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) { if (check()) return true; await sleep(100); }
    return false;
  };

  if (!await until(() => session.ready, "session ready (OpenAI dial + session.updated)", 20000)) {
    session.close(); throw new Error("session never became ready");
  }
  console.error(`ready: provider=${session.provider}, gatedFrames=${session.gatedFrames}`);

  // --- 3. Speak into the session as one utterance, then leave room tone ---
  // BURST append: pacing leaves VAD-perceived silence between chunks and the vendor
  // end-points mid-utterance (measured, run 1). The tail of real zeros matters the other
  // way: a buffer that just stops appends never advances the audio timeline past the last
  // word, so the vendor never sees the trailing silence it needs to commit (measured, run 3).
  const CHUNK = 8192; // 4096 samples ≈ 171 ms of speech per frame
  for (let off = 0; off < speechPcm.length; off += CHUNK) {
    session.sendAudio(speechPcm.subarray(off, off + CHUNK).toString("base64"));
  }
  const tail = Buffer.alloc(24000 * 2 * 1.4); // 1.4 s of silence at 24 kHz pcm16
  for (let off = 0; off < tail.length; off += CHUNK) {
    session.sendAudio(tail.subarray(off, off + CHUNK).toString("base64"));
  }
  console.error("speech + room tone appended; waiting for the vendor's response…");
  const completed = await until(() => receipt.events.some(e => e.attempt === attempt && e.event === "turn-complete"), "turn-complete", 45000);
  await sleep(1500); // trailing audio deltas after turn-complete
  session.close();
  await sleep(500);
  if (!completed) { a.note = "no turn-complete within 45s"; return finishAttempt(a, attempt, { audioChunks, rates, text, closed, session }, false, "no turn-complete within 45s"); }

  // --- 4. Measurements ---
  const outputPcm = Buffer.concat(audioChunks);
  const samples = outputPcm.length / 2;
  const seconds = samples / 24000;
  a.output = { bytes: outputPcm.length, samples, secondsAt24000: seconds, rates: [...rates], modelTranscript: text.model.trim(), inputTranscript: text.inputTranscript };
  a.terminal = closed;
  a.refusedByTransport = session.refusedByTransport;

  let ok = true;
  ok = mark(a, "V1-output-rate", rates.size === 1 && rates.has(24000), `output-audio mime rates: [${[...rates].join(", ")}] (want [24000])`) && ok;
  ok = mark(a, "V3-duration-positive", seconds > 0.3, `${samples} samples = ${seconds.toFixed(2)}s at 24 kHz (a wrong-rate stream would shrink/stretch this)`) && ok;
  ok = mark(a, "V5-gate-quiet", session.refusedByTransport.audioBeforeReady === 0 && session.refusedByTransport.afterClose === 0, `refused=${JSON.stringify(session.refusedByTransport)}`) && ok;

  // --- 5. Whisper transcription of the output audio (the intelligibility witness) ---
  if (outputPcm.length === 0) return finishAttempt(a, attempt, {}, false, "no output audio received");
  writeFileSync(`${OUT}/output.wav`, Buffer.concat([wavHeader(outputPcm.length), outputPcm]));
  const form = new FormData();
  form.append("file", new Blob([readFileSync(`${OUT}/output.wav`)], { type: "audio/wav" }), "output.wav");
  form.append("model", "whisper-1");
  form.append("language", "en");
  const trRes = await fetch("https://api.openai.com/v1/audio/transcriptions", { method: "POST", headers: { Authorization: `Bearer ${key}` }, body: form });
  if (!trRes.ok) return finishAttempt(a, attempt, {}, false, `transcription API ${trRes.status}: ${await trRes.text()}`);
  const heard = (await trRes.json()).text?.trim() ?? "";
  a.whisper = heard;
  // THE INPUT-PATH WITNESS: a clean, correct spoken answer proves the model heard and
  // understood the 24 kHz speech that went IN. A rambling or fragmentary answer is the
  // signature of garbled or truncated input (both measured on earlier runs).
  ok = mark(a, "V2-input-intelligible", /\b4\b|four/i.test(heard) && heard.length < 100, `spoken answer: "${heard.slice(0, 160)}"`) && ok;
  const heardCps = seconds > 0 ? heard.length / seconds : 0;
  ok = mark(a, "V3b-duration-natural", heardCps > 5 && heardCps < 40, `${seconds.toFixed(2)}s at 24 kHz for ${heard.length} heard chars = ${heardCps.toFixed(1)} chars/sec (natural range)`) && ok;
  ok = mark(a, "V4-whisper-hears-it", heard.length > 0, `whisper transcribed ${heard.length} chars of the output at its declared 24 kHz`) && ok;
  a.notes = {
    modelTranscriptDeltas: text.model.trim() || "none arrived — audio + whisper prove the turn; recorded as an observation for the provider's owner (this deployment emits no output_audio_transcript.delta the provider sees, and session.update sets no input_audio_transcription)",
  };
  return finishAttempt(a, attempt, { checks: a.checks }, ok);

  function mark(aa, name, cond, detail) {
    aa.checks = aa.checks || {};
    aa.checks[name] = { ok: cond, detail };
    console.error(`${cond ? "PASS" : "FAIL"} ${name}: ${detail}`);
    return cond;
  }
}

function finishAttempt(a, attempt, extra, ok, failReason) {
  if (failReason) a.failed = failReason;
  if (ok && a.checks) {
    receipt.checks = a.checks;
    receipt.cleanAttempt = attempt;
  }
  return Boolean(ok);
}

function wavHeader(pcmBytes, rate = 24000, channels = 1) {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + pcmBytes, 4); h.write("WAVE", 8);
  h.write("fmt ", 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * channels * 2, 28); h.writeUInt16LE(channels * 2, 32); h.writeUInt16LE(16, 34);
  h.write("data", 36); h.writeUInt32LE(pcmBytes, 40);
  return h;
}
