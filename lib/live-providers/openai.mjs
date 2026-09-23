// lib/live-providers/openai.mjs — OpenAI Realtime as a provider behind the same facade as Gemini.
//
// THIS FILE IS THE SECOND IMPLEMENTATION, and therefore the actual test of the seam: "pluggable" with one
// provider is a claim, not a property. Writing it against the interface produced ONE PINCH, and the pinch is
// the finding (reported in full in the PR and in ~/journal/reports/voicebox-live-session-seam.md):
//
//   THE FACADE CARRIES NO WAY TO AUTHENTICATE. `transport.connect(url, { onEvent })` gives the provider a
//   URL and nothing else. OpenAI's server-side WebSocket wants `Authorization: Bearer <key>` — and Node's
//   global `WebSocket` (the runtime this repo uses) accepts no headers, only a protocol list. So this
//   provider CANNOT AUTHENTICATE through the facade as it stands. Gemini needs no header because its key
//   travels in the query string, which is why the gap was invisible with one provider — the classic
//   one-implementation seam.
//
//   The proposed fix is one optional field on the facade — `connect(url, { onEvent, headers })`, with the
//   host responsible for carrying them — and the host cannot use the global WebSocket to honour it (no
//   header support), so it would dial with `node:http`'s upgrade and frame the socket itself. That is a
//   real, zero-dependency change to the HOST, not to this provider; until it exists, this provider throws a
//   named error rather than pretending. Requesting headers here and failing loudly is the honest shape: a
//   provider that silently connected without auth would produce a mystery 401 three layers away.
//
// Protocol, verified against the current documentation (not from memory — the names changed in the 2025
// beta→GA migration):
//   * connect: wss://api.openai.com/v1/realtime?model=<model>, header `Authorization: Bearer <key>`;
//   * configure: `session.update` with session.type "realtime", output_modalities ["audio"], and
//     audio.input.format / audio.output.format ({ type: "audio/pcm", rate: 24000 });
//   * ready when the server sends `session.updated`;
//   * input: `input_audio_buffer.append` with base64 PCM16 — AT 24 kHz, where Gemini takes 16 kHz. That
//     difference is exactly why the interface carries `rate` ON THE EVENT rather than hardcoding one;
//   * output: `response.output_audio.delta` (renamed from `response.audio.delta` in GA), base64 PCM16;
//   * transcripts: `response.output_audio_transcript.delta` (renamed from `response.audio_transcript.delta`);
//   * barge-in: `response.cancel`; server reports `input_audio_buffer.speech_started`.
//
// THE RATES ARE DOCUMENT-SETTLED, with the citation: the official client-event reference says of
// `session.update` → `audio.output.format` → PCMAudio, "Only a 24kHz sample rate is supported", rate "Always
// 24000" — and the same for input:
//   https://developers.openai.com/api/reference/resources/realtime/client-events/
// So 24 kHz is not a guess here, and a page sending 16 kHz bytes under this provider was mis-declaring its
// audio (journal-6g0). What the citation does NOT settle is audible playback, which needs a real drive.

export const OPENAI_REALTIME_MODEL = "gpt-realtime";
export const OPENAI_REALTIME_URL = "wss://api.openai.com/v1/realtime";

/** Input and (declared) output rate. The host carries this on the event so the client need not assume. */
/**
 * THE INPUT RATE OPENAI'S PROTOCOL REQUIRES. Its client-event reference is explicit that only 24 kHz is
 * supported, for output AND input — `https://developers.openai.com/api/reference/resources/realtime/client-events/`
 * — so a page sending 16 kHz bytes under this provider is mis-declaring its audio (journal-6g0). Named here
 * so the host can ask rather than guess.
 */
export const OPENAI_REQUIRED_INPUT_RATE = 24000;
/** The name this file used before the rate work; kept so importers do not break. */
export const OPENAI_INPUT_RATE = OPENAI_REQUIRED_INPUT_RATE;
export const OPENAI_OUTPUT_RATE = 24000;

export function createOpenAIProvider({ model, emit, log, transport, tools, systemInstruction, instruction, projectInstruction, voice }) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY is not set — the OpenAI Realtime session cannot start");
  if (!transport) throw new Error("createOpenAIProvider: the host must supply a transport");

  const chosen = model ?? OPENAI_REALTIME_MODEL;
  let ready = false;
  let responseActive = false;
  let responsePending = false;
  const pendingCalls = new Set();

  function resumeResponse() {
    if (responseActive || pendingCalls.size || !responsePending) return true;
    responsePending = false;
    responseActive = transport.send("control", JSON.stringify({ type: "response.create" }));
    return responseActive;
  }

  function sendToolResponse(responses) {
    for (const { id, response } of responses) {
      if (!transport.send("control", JSON.stringify({
        type: "conversation.item.create",
        item: { type: "function_call_output", call_id: id, output: JSON.stringify(response) },
      }))) return false;
      pendingCalls.delete(id);
    }
    // The executor may finish before response.done. OpenAI permits only one active
    // response in the default conversation; resume after both generation and tools finish.
    responsePending = true;
    return resumeResponse();
  }

  // THE PINCH, requested explicitly: the facade takes { onEvent } and nothing else, so this call asks for
  // a capability it does not have. When the facade grows `headers`, this line needs no change.
  transport.connect(`${OPENAI_REALTIME_URL}?model=${encodeURIComponent(chosen)}`, {
    headers: { Authorization: `Bearer ${key}` },
    onEvent: (ev) => {
      if (ev.kind === "open") {
        emit({ type: "transport-open" });
        transport.send("handshake", JSON.stringify({
          type: "session.update",
          session: {
            type: "realtime",
            model: chosen,
            output_modalities: ["audio"],
            // The agent's voice, vendor-shaped: OpenAI takes it at the session's top level.
            ...(voice ? { voice } : {}),
            ...(tools?.length ? { tools: tools.map(tool => ({ type: "function", ...tool })) } : {}),
            // One string on this vendor: the agent's instruction (personality over the base)
            // first, the tools instruction beneath it — same order as the Gemini parts.
            ...(instruction || systemInstruction ? { instructions: [instruction, systemInstruction].filter(Boolean).join("\n\n") } : {}),
            audio: {
              input: { format: { type: "audio/pcm", rate: OPENAI_INPUT_RATE }, turn_detection: { type: "server_vad" } },
              output: { format: { type: "audio/pcm", rate: OPENAI_OUTPUT_RATE } },
            },
          },
        }));
        return;
      }
      if (ev.kind === "error") { emit({ type: "error", message: ev.message }); return; }
      if (ev.kind === "close") { emit({ type: "closed", code: ev.code, reason: ev.reason }); return; }
      if (ev.kind !== "message") return;

      let msg;
      try { msg = JSON.parse(typeof ev.data === "string" ? ev.data : ""); } catch { return; }
      // A null frame costs a frame, not the conversation — the same rule the Gemini provider keeps.
      if (!msg || typeof msg !== "object") return;

      switch (msg.type) {
        case "session.updated":
          ready = true;
          emit({ type: "ready" });
          break;
        case "response.output_audio.delta":
          if (msg.delta) emit({ type: "output-audio", pcm16: msg.delta, rate: OPENAI_OUTPUT_RATE });
          break;
        case "response.output_audio_transcript.delta":
        case "response.audio_transcript.delta": // the pre-GA name, still emitted by some deployments
          if (msg.delta) emit({ type: "output-text", text: msg.delta, kind: "model-transcript" });
          break;
        case "conversation.item.input_audio_transcription.completed":
          if (msg.transcript) emit({ type: "output-text", text: msg.transcript, kind: "input-transcript" });
          break;
        case "response.created":
          responseActive = true;
          break;
        case "response.function_call_arguments.done": {
          if (typeof msg.call_id !== "string" || !msg.call_id.trim()) {
            emit({ type: "error", message: "invalid-tool-call: OpenAI function call has no call_id; cannot correlate a reply" });
            break;
          }
          pendingCalls.add(msg.call_id);
          let args;
          try {
            args = JSON.parse(msg.arguments);
            if (!args || typeof args !== "object" || Array.isArray(args) ||
                typeof msg.name !== "string" || !msg.name.trim()) throw new Error("invalid call shape");
          } catch {
            sendToolResponse([{ id: msg.call_id, response: { result: {
              ok: false, refused: "invalid-tool-call", error: "invalid-tool-call: expected a function name and JSON object arguments",
            } } }]);
            break;
          }
          emit({ type: "tool-call", calls: [{ id: msg.call_id, name: msg.name, args }] });
          break;
        }
        case "response.done":
          responseActive = false;
          emit({ type: "turn-complete" });
          resumeResponse();
          break;
        case "input_audio_buffer.speech_started":
          emit({ type: "interrupt" });
          break;
        case "error":
          emit({ type: "error", message: msg.error?.message ?? "openai realtime error", raw: msg.error });
          break;
        default:
          break; // an event this provider does not act on is not an error
      }
    },
  });

  return {
    sendAudio(pcm16Base64) {
      transport.send("audio", JSON.stringify({ type: "input_audio_buffer.append", audio: pcm16Base64 }));
    },
    sendText(text) {
      transport.send("text", JSON.stringify({
        type: "conversation.item.create",
        item: { type: "message", role: "user", content: [{ type: "input_text", text }] },
      }));
      transport.send("control", JSON.stringify({ type: "response.create" }));
    },
    sendToolResponse,
    interrupt() {
      // Barge-in is a real call here, unlike Gemini where it is server-side.
      transport.send("control", JSON.stringify({ type: "response.cancel" }));
    },
    close() {
      transport.close();
    },
    get ready() { return ready; },
  };
}
