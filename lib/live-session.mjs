// lib/live-session.mjs — one Gemini Live session per connected page.
//
// The shape: page WS ⇄ this session ⇄ Gemini BidiGenerateContent upstream.
// Two hard-won properties, each bought with somebody else's incident:
//
//  1. THE READINESS GATE (isocan, 2026-09-12: 192 of 208 audio frames went up
//     before `setupComplete` and were silently dropped — the symptom read as a
//     broken model or a broken mic). Client audio received before the upstream
//     handshake completes is NOT forwarded; it is counted and logged, never
//     silently sent and never silently dropped without a number.
//
//  2. NO HAND-ROLLED RESAMPLER (isocan-xsh.9: an epsilon-rounded resampler
//     index zeroed 98% of captured PCM at 44.1 kHz). The page captures at
//     16000 Hz and plays back at 24000 Hz by creating AudioContexts AT those
//     rates — the browser's own pipeline resamples. This session relays PCM16
//     unchanged in both directions.
//
// Upstream protocol (verified live 2026-09-19 against models/gemini-3.8-live:
// setup → setupComplete (365 ms) → text-in → audio/pcm;rate=24000 parts out).

const UPSTREAM_URL =
  "wss://generativelanguage.googleapis.com/ws/" +
  "google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

export const LIVE_MODEL = "models/gemini-3.8-live";

export function createLiveSession({ onAudioOut, onText, onState, log = console.error }) {
  const state = {
    ready: false,          // the readiness gate: setupComplete seen
    gatedFrames: 0,        // audio frames received BEFORE the gate opened (isocan's number)
    upstream: null,
    closed: false,
  };

  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY is not set — the live session cannot start");

  const ws = new WebSocket(`${UPSTREAM_URL}?key=${key}`);

  ws.onopen = () => {
    onState?.("upstream-open");
    ws.send(JSON.stringify({
      setup: {
        model: LIVE_MODEL,
        generationConfig: {
          responseModalities: ["AUDIO"],
          // Thinking is ON BY DEFAULT on this model (measured: no config →
          // usageMetadata.thoughtsTokenCount ≈ 50; 0 → disabled). -1 = dynamic.
          thinkingConfig: { thinkingBudget: -1 },
        },
        // A field of `setup`, NOT of `setup.generationConfig` — the first version
        // put it inside generationConfig and upstream refused the session with
        // 1007 "Unknown name \"outputAudioTranscription\" at 'setup.generation_config'",
        // so setupComplete never arrived and the readiness gate never opened.
        // (Gemini's probe, 2026-09-19: accepted; the transcript carries spoken
        // words only — no thought text reaches the client under AUDIO.)
        outputAudioTranscription: {},
      },
    }));
  };

  ws.onmessage = async (event) => {
    const text = typeof event.data === "string" ? event.data : (event.data?.text ? await event.data.text() : "");
    if (!text) return;
    let msg;
    try { msg = JSON.parse(text); } catch { return; }

    if (msg.setupComplete) {
      state.ready = true; // the gate opens — and not one frame before
      onState?.("ready", { gatedFrames: state.gatedFrames });
      if (state.gatedFrames > 0) {
        log(`[live-session] readiness gate held ${state.gatedFrames} frame(s) before setupComplete — not forwarded (that is the gate working, isocan's 192/208 lesson)`);
      }
      return;
    }
    if (msg.error) { onState?.("error", msg.error); return; }

    const sc = msg.serverContent;
    if (!sc) return;
    for (const part of sc.modelTurn?.parts ?? []) {
      if (part.inlineData?.data) {
        onAudioOut(Buffer.from(part.inlineData.data, "base64"), part.inlineData.mimeType ?? "audio/pcm;rate=24000");
      }
      if (part.text) onText?.(part.text, "model");
    }
    if (sc.outputTranscription?.text) onText?.(sc.outputTranscription.text, "model-transcript");
    if (sc.turnComplete) onState?.("turn-complete");
    if (sc.interrupted) onState?.("interrupted");
  };

  ws.onerror = (e) => onState?.("error", { message: e?.message ?? "upstream websocket error" });
  ws.onclose = (e) => { state.closed = true; onState?.("upstream-closed", { code: e.code, reason: e.reason }); };

  return {
    /** A PCM16 (16 kHz) audio frame from the page. The readiness gate applies. */
    sendAudio(pcm16Base64) {
      if (state.closed) return;
      if (!state.ready) {
        state.gatedFrames += 1; // counted, logged at gate-open — never silently sent
        return;
      }
      ws.send(JSON.stringify({
        realtimeInput: { audio: { data: pcm16Base64, mimeType: "audio/pcm;rate=16000" } },
      }));
    },
    /** A text turn from the page (the same session also accepts text). */
    sendText(text) {
      if (state.closed || !state.ready) return;
      ws.send(JSON.stringify({
        clientContent: { turns: [{ role: "user", parts: [{ text }] }], turnComplete: true },
      }));
    },
    close() {
      state.closed = true;
      try { ws.close(); } catch { /* already gone */ }
    },
    get ready() { return state.ready; },
    get gatedFrames() { return state.gatedFrames; },
  };
}
