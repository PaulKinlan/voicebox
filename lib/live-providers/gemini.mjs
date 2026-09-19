// lib/live-providers/gemini.mjs — Gemini Live as a provider, not as the only path.
//
// This is the code that used to BE lib/live-session.mjs, minus the readiness gate: the gate is the
// host's now (lib/live-session.mjs), so that a second provider cannot forget it. What is left here is
// exactly what is Gemini's — the endpoint, the handshake, the event names, and what to do with a frame
// that will not parse.
//
// Upstream protocol (verified live 2026-09-19 against models/gemini-3.8-live:
// setup → setupComplete (365 ms) → text-in → audio/pcm;rate=24000 parts out).

const UPSTREAM_URL =
  "wss://generativelanguage.googleapis.com/ws/" +
  "google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

export const GEMINI_LIVE_MODEL = "models/gemini-3.8-live";

export function createGeminiProvider({ model, emit, log, transport }) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY is not set — the live session cannot start");

  // NO AMBIENT SOCKET. The host hands us a transport, so our audio goes through the gate like the page's
  // (astra's finding 1: the factory used to receive only {model, emit, log} and dial out itself).
  if (!transport) throw new Error("createGeminiProvider: the host must supply a transport");

  transport.connect(`${UPSTREAM_URL}?key=${key}`, {
    // Events arrive as DATA from the facade: { kind, data }. Never the raw event — so a provider cannot
    // reach `event.target` and send around the transport (astra's re-review).
    onEvent: (ev) => {
      if (ev.kind === "open") return onOpen();
      if (ev.kind === "message") return void onFrame({ data: ev.data });
      if (ev.kind === "error") return emit({ type: "error", message: ev.message });
      if (ev.kind === "close") return emit({ type: "closed", code: ev.code, reason: ev.reason });
    },
  });

  function onOpen() {
    {
      emit({ type: "transport-open" });
      transport.send("handshake", JSON.stringify({
      setup: {
        model: model ?? GEMINI_LIVE_MODEL,
        generationConfig: {
          responseModalities: ["AUDIO"], // the only modality this model accepts here
          // Thinking is ON BY DEFAULT on this model (measured: no config →
          // usageMetadata.thoughtsTokenCount ≈ 50; 0 → disabled). -1 = dynamic.
          thinkingConfig: { thinkingBudget: -1 },
        },
        // A field of `setup`, NOT of `setup.generationConfig` — the first version put it inside
        // generationConfig and upstream refused the session with 1007 "Unknown name
        // \"outputAudioTranscription\" at 'setup.generation_config'", so setupComplete never arrived and
        // the readiness gate never opened.
        outputAudioTranscription: {},
      },
    }));
    }
  }

  async function onFrame(event) {
    const text = typeof event.data === "string" ? event.data : (event.data?.text ? await event.data.text() : "");
    if (!text) return;
    let msg;
    // ONE MALFORMED FRAME COSTS A FRAME. A parse failure is a local fact; escalating it would kill the
    // conversation for a vendor hiccup. (The frame-level cousin lives in lib/ws-server.mjs: a fragmented
    // WebSocket frame is NOT a malformed message but an unsupported one, and that one closes with 1003.)
    try { msg = JSON.parse(text); } catch { return; }
    // JSON `null` parses fine and is not an object — a null frame costs a frame (astra's finding 4).
    if (!msg || typeof msg !== "object") return;

    if (msg.setupComplete) { emit({ type: "ready" }); return; }
    if (msg.error) { emit({ type: "error", message: msg.error.message ?? "upstream error", raw: msg.error }); return; }

    const sc = msg.serverContent;
    if (!sc) return;
    for (const part of sc.modelTurn?.parts ?? []) {
      if (part.inlineData?.data) emit({ type: "output-audio", pcm16: part.inlineData.data, rate: 24000 });
      if (part.text) emit({ type: "output-text", text: part.text, kind: "model" });
    }
    if (sc.outputTranscription?.text) emit({ type: "output-text", text: sc.outputTranscription.text, kind: "model-transcript" });
    if (sc.turnComplete) emit({ type: "turn-complete" });
    if (sc.interrupted) emit({ type: "interrupt" });
  }

  return {
    sendAudio(pcm16Base64) {
      transport.send("audio", JSON.stringify({
        realtimeInput: { audio: { data: pcm16Base64, mimeType: "audio/pcm;rate=16000" } },
      }));
    },
    sendText(text) {
      transport.send("text", JSON.stringify({
        clientContent: { turns: [{ role: "user", parts: [{ text }] }], turnComplete: true },
      }));
    },
    interrupt() {
      // Gemini has no client-side interrupt call; the session is barge-in aware server-side. Named here
      // as a refusal rather than a silent no-op: `interrupt()` is a no-op for this provider ON PURPOSE.
      log("[live-provider:gemini] interrupt() is not sent — this provider's barge-in is server-side");
    },
    close() {
      transport.close();
    },
  };
}
