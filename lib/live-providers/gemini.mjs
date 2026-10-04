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

/**
 * THE INPUT RATE GEMINI'S PROTOCOL REQUIRES — declared by the provider rather than assumed by the caller.
 * 16 kHz in, 24 kHz out (`realtimeInput` at audio/pcm;rate=16000; model parts at rate=24000).
 */
export const GEMINI_REQUIRED_INPUT_RATE = 16000;
export const GEMINI_OUTPUT_RATE = 24000;

export const GEMINI_LIVE_MODEL = "models/gemini-3.8-live";
export const GEMINI_LIVE_EXTENDED_THINKING_MODEL = "models/gemini-3.8-live-extended-thinking";
export const GEMINI_LIVE_TOOL_FALLBACK_MODEL = "models/gemini-3.8-flash";

export const VALID_EXTENDED_THINKING_LEVELS = Object.freeze(["low", "medium", "high"]);

/**
 * Returns true when `model` is a Gemini 3.8 extended-thinking live model that
 * supports `thinkingLevel` ("low" | "medium" | "high") and requires `NON_BLOCKING`
 * asynchronous tool declarations.
 */
export function isExtendedThinkingModel(model) {
  return (
    model === "models/gemini-3.8-live-extended-thinking" ||
    model === "gemini-3.8-live-extended-thinking" ||
    model === "models/gemini-3.8-thinking" ||
    model === "gemini-3.8-thinking"
  );
}

export function normalizeGeminiLiveModel(model) {
  if (!model) return GEMINI_LIVE_MODEL;
  if (isExtendedThinkingModel(model)) return GEMINI_LIVE_EXTENDED_THINKING_MODEL;
  return String(model);
}

export function createGeminiProvider({
  model,
  emit,
  log,
  transport,
  tools,
  systemInstruction,
  instruction,
  projectInstruction,
  voice,
  debug,
  thinkingLevel,
  thinkingBudget,
  includeThoughts,
  nonBlockingTools,
  contextWindowCompression,
  sessionResumption,
  sessionResumptionHandle,
}) {
  const key = process.env.GEMINI_API_KEY;  if (!key) throw new Error("GEMINI_API_KEY is not set — the live session cannot start");

  // NO AMBIENT SOCKET. The host hands us a transport, so our audio goes through the gate like the page's
  // (astra's finding 1: the factory used to receive only {model, emit, log} and dial out itself).
  if (!transport) throw new Error("createGeminiProvider: the host must supply a transport");

  let activeModel = normalizeGeminiLiveModel(model);
  let usedFallback = false;
  let initialReadyEmitted = false;
  let pendingTextPayload = null;
  let resumptionHandle =
    typeof sessionResumption === "string"
      ? sessionResumption
      : sessionResumption?.handle ?? sessionResumptionHandle ?? null;
  const enableSessionResumption = Boolean(sessionResumption || sessionResumptionHandle);

  function dialUpstream() {
    transport.connect(`${UPSTREAM_URL}?key=${key}`, {
      // Events arrive as DATA from the facade: { kind, data }. Never the raw event — so a provider cannot
      // reach `event.target` and send around the transport (astra's re-review).
      onEvent: (ev) => {
        if (ev.kind === "open") return onOpen();
        if (ev.kind === "message") return void onFrame({ data: ev.data });
        if (ev.kind === "error") return emit({ type: "error", message: ev.message });
        if (ev.kind === "close") {
          if (
            ev.code === 1011 &&
            !usedFallback &&
            activeModel === GEMINI_LIVE_MODEL &&
            tools?.length > 0 &&
            pendingTextPayload !== null
          ) {
            usedFallback = true;
            activeModel = GEMINI_LIVE_TOOL_FALLBACK_MODEL;
            log(
              `[live-provider:gemini] upstream ${GEMINI_LIVE_MODEL} closed with 1011 (${ev.reason || "internal error"}) during tool turn; failing over to ${activeModel} and replaying turn`,
            );
            if (dialUpstream()) return;
          }
          return emit({ type: "closed", code: ev.code, reason: ev.reason });
        }
      },
    });
    return true;
  }

  dialUpstream();

  function buildThinkingConfig() {
    const extended = isExtendedThinkingModel(activeModel);
    // Gemini Live API rejects setting BOTH thinkingBudget and thinkingLevel:
    // "You can only set only one of thinking budget and thinking level."
    // Extended thinking models use thinkingLevel ("low" | "medium" | "high") ONLY;
    // standard models (models/gemini-3.8-live) use thinkingBudget ONLY.
    const cfg = extended
      ? {
          thinkingLevel: VALID_EXTENDED_THINKING_LEVELS.includes(thinkingLevel)
            ? thinkingLevel
            : "low",
        }
      : {
          thinkingBudget:
            thinkingBudget !== undefined ? Number(thinkingBudget) : -1,
        };
    if (includeThoughts !== undefined) {
      cfg.includeThoughts = Boolean(includeThoughts);
    }
    return cfg;
  }

  function buildFunctionDeclarations() {
    if (!tools?.length) return null;
    const forceNonBlocking = isExtendedThinkingModel(activeModel) || nonBlockingTools === true;
    if (!forceNonBlocking) return tools;
    return tools.map((decl) => ({
      ...decl,
      behavior: decl.behavior || "NON_BLOCKING",
    }));
  }

  function buildCompressionConfig() {
    if (!contextWindowCompression) return null;
    if (typeof contextWindowCompression === "object") {
      const triggerTokens = contextWindowCompression.triggerTokens;
      const targetTokens =
        contextWindowCompression.slidingWindow?.targetTokens ??
        contextWindowCompression.targetTokens;
      return {
        ...(triggerTokens !== undefined ? { triggerTokens: Number(triggerTokens) } : {}),
        slidingWindow: {
          ...(targetTokens !== undefined ? { targetTokens: Number(targetTokens) } : {}),
        },
      };
    }
    return { slidingWindow: {} };
  }

  function onOpen() {
    {
      if (!initialReadyEmitted) emit({ type: "transport-open" });
      const formattedTools = buildFunctionDeclarations();
      const compressionConfig = buildCompressionConfig();
      transport.send("handshake", JSON.stringify({
      setup: {
        model: activeModel,
        generationConfig: {
          responseModalities: ["AUDIO"], // the only modality this model accepts here
          // Thinking is ON BY DEFAULT on this model (measured: no config →
          // usageMetadata.thoughtsTokenCount ≈ 50; 0 → disabled). -1 = dynamic.
          thinkingConfig: buildThinkingConfig(),
          // The agent's VOICE (core/agent-settings.ts): a person choosing Kore and hearing Puck
          // is the setting-that-does-nothing lie, so the choice rides the setup, vendor-shaped.
          ...(voice ? { speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } } : {}),
        },
        // The voice gets HANDS: tool declarations and the instruction that
        // names them, both generated from the ONE command list
        // (lib/commands.mjs) — the same verbs the text path resolves to, so
        // the live model and the text model can never disagree about what
        // exists. Both are fields of `setup`, peers of generationConfig.
        // The agent's INSTRUCTION (personality composed over the mandatory base,
        // core/agent-settings.ts) comes FIRST — the tools instruction beneath it,
        // never instead of it.
        ...(formattedTools?.length ? { tools: [{ functionDeclarations: formattedTools }] } : {}),
        // A PROJECT INSTRUCTION ALONE MUST STILL ARRIVE. The condition used to be
        // `instruction || systemInstruction`, so a session whose only context was the project's own
        // file (voicebox-beads-0zi4: the folder's AGENTS.md, with the agent instruction composed
        // empty by a caller) shipped NO systemInstruction at all — the file was read and silently
        // dropped. The guard names every part it can carry.
        ...(instruction || projectInstruction || systemInstruction
          ? { systemInstruction: { parts: [...(instruction ? [{ text: instruction }] : []), ...(projectInstruction ? [{ text: projectInstruction }] : []), ...(systemInstruction ? [{ text: systemInstruction }] : [])] } }
          : {}),
        // A field of `setup`, NOT of `setup.generationConfig` — the first version put it inside
        // generationConfig and upstream refused the session with 1007 "Unknown name
        // \"outputAudioTranscription\" at 'setup.generation_config'", so setupComplete never arrived and
        // the readiness gate never opened.
        outputAudioTranscription: {},
        ...(compressionConfig ? { contextWindowCompression: compressionConfig } : {}),
        ...(enableSessionResumption || resumptionHandle
          ? { sessionResumption: resumptionHandle ? { handle: resumptionHandle } : {} }
          : {}),
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

    if (msg.setupComplete) {
      if (!initialReadyEmitted) {
        initialReadyEmitted = true;
        emit({ type: "ready" });
      } else if (pendingTextPayload !== null) {
        const replay = pendingTextPayload;
        transport.send("text", replay);
      }
      return;
    }
    if (msg.error) { emit({ type: "error", message: msg.error.message ?? "upstream error", raw: msg.error }); return; }

    // SessionResumptionUpdate: record latest resumable handle and notify host.
    const sru = msg.sessionResumptionUpdate ?? msg.session_resumption_update;
    if (sru && typeof sru === "object") {
      const newHandle = sru.newHandle ?? sru.new_handle ?? null;
      if (sru.resumable && typeof newHandle === "string" && newHandle) {
        resumptionHandle = newHandle;
      }
      emit({
        type: "session-resumption",
        resumable: Boolean(sru.resumable),
        handle: newHandle,
      });
    }

    // GoAway: server warning before connection termination; surface timeLeft and latest resumptionHandle.
    const goAway = msg.goAway ?? msg.go_away;
    if (goAway && typeof goAway === "object") {
      emit({
        type: "go-away",
        timeLeft: goAway.timeLeft ?? goAway.time_left ?? null,
        resumptionHandle,
      });
    }

    // interactionStatus ("IN_PROGRESS" vs "IDLE") for gemini-3.8-live-extended-thinking.
    const interactionStatus = msg.interactionStatus ?? msg.serverContent?.interactionStatus ?? null;
    if (interactionStatus) {
      currentInteractionStatus = interactionStatus;
      emit({ type: "interaction-status", status: interactionStatus });
      if (interactionStatus === "IDLE" && !msg.serverContent?.turnComplete) {
        flushQueuedText();
      }
    }

    // A TOOL CALL IS THE MODEL'S TURN AT THE VERBS. It arrives as its own
    // message ({ toolCall: { functionCalls: [{ id, name, args }] } }), NOT
    // inside serverContent — checked before the sc bail below, or every call
    // would be dropped as "no serverContent". The host runs it through the
    // same executor the text path uses and answers with sendToolResponse.
    if (msg.toolCall) {
      // A malformed toolCall costs a frame WITH A NAME — silence here reads as a hang
      // (astra's live-tools review, 2026-09-20: a non-array functionCalls threw into an
      // unhandled rejection; an empty toolCall vanished without a word).
      const raw = msg.toolCall.functionCalls;
      debug?.({ type: "tool.wire-request", payload: msg.toolCall });
      if (!Array.isArray(raw)) {
        debug?.({ type: "tool.dropped", severity: "error", reason: "functionCalls-not-array", delivery: "not-sent" });
        log(`[live-provider:gemini] a toolCall frame whose functionCalls is not an array (${JSON.stringify(raw)?.slice(0, 80)}) — one frame, dropped by name`);
        return;
      }
      const calls = raw
        .filter((c) => c && typeof c === "object")
        .map((c) => ({ id: c.id, name: c.name, args: c.args && typeof c.args === "object" ? c.args : {} }));
      if (calls.length === 0) {
        debug?.({ type: "tool.dropped", severity: "error", reason: "no-function-calls", delivery: "not-sent" });
        log("[live-provider:gemini] a toolCall frame carried no function calls — dropped, by name (the model is not waiting on an answer it never asked for)");
        return;
      }
      pendingTextPayload = null;
      awaitingToolTurnComplete = false;
      clearTimeout(toolTurnTimer);
      emit({ type: "tool-call", calls });
      return;
    }

    const sc = msg.serverContent;
    if (!sc) return;
    for (const part of sc.modelTurn?.parts ?? []) {
      if (part.inlineData?.data) emit({ type: "output-audio", pcm16: part.inlineData.data, rate: 24000 });
      if (part.thought || (part.text && part.thought === true)) {
        emit({ type: "output-text", text: part.text ?? String(part.thought), kind: "thought" });
      } else if (part.text) {
        emit({ type: "output-text", text: part.text, kind: "model" });
      }
    }
    if (sc.inputTranscription?.text) emit({ type: "output-text", text: sc.inputTranscription.text, kind: "input-transcript" });
    if (sc.outputTranscription?.text) emit({ type: "output-text", text: sc.outputTranscription.text, kind: "model-transcript" });
    if (sc.generationComplete === true) {
      emit({ type: "generation-complete" });
    }
    if (sc.turnComplete) {
      pendingTextPayload = null;
      emit({
        type: "turn-complete",
        ...(currentInteractionStatus ? { interactionStatus: currentInteractionStatus } : {}),
      });
      if (currentInteractionStatus !== "IN_PROGRESS") {
        flushQueuedText();
      }
    }
    if (sc.interrupted) {
      currentInteractionStatus = "IDLE";
      emit({ type: "interrupt" });
      flushQueuedText();
    }
  }

  let currentInteractionStatus = "IDLE";
  let awaitingToolTurnComplete = false;
  let toolTurnTimer = null;
  const queuedTexts = [];

  function flushQueuedText() {
    awaitingToolTurnComplete = false;
    clearTimeout(toolTurnTimer);
    toolTurnTimer = null;
    if (queuedTexts.length > 0) {
      const nextPayload = queuedTexts.shift();
      pendingTextPayload = nextPayload;
      transport.send("text", nextPayload);
    }
  }

  return {
    sendAudio(pcm16Base64) {
      transport.send("audio", JSON.stringify({
        realtimeInput: { audio: { data: pcm16Base64, mimeType: `audio/pcm;rate=${GEMINI_REQUIRED_INPUT_RATE}` } },
      }));
    },
    sendAudioStreamEnd() {
      return transport.send("control", JSON.stringify({
        realtimeInput: { audioStreamEnd: true },
      }));
    },
    sendVideo(jpegBase64, mimeType = "image/jpeg") {
      if (!jpegBase64 || typeof jpegBase64 !== "string") return false;
      const clean = jpegBase64.replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, "");
      return transport.send("video", JSON.stringify({
        realtimeInput: { video: { data: clean, mimeType: mimeType || "image/jpeg" } },
      }));
    },
    sendActivityControl(kind = "start") {
      if (kind === "audioStreamEnd" || kind === "audio_stream_end") {
        return transport.send("control", JSON.stringify({
          realtimeInput: { audioStreamEnd: true },
        }));
      }
      return transport.send("control", JSON.stringify({
        realtimeInput: kind === "end" ? { activityEnd: {} } : { activityStart: {} },
      }));
    },
    sendText(text) {
      const payload = JSON.stringify({
        clientContent: { turns: [{ role: "user", parts: [{ text }] }], turnComplete: true },
      });
      if (awaitingToolTurnComplete || currentInteractionStatus === "IN_PROGRESS") {
        queuedTexts.push(payload);
        return;
      }
      pendingTextPayload = payload;
      transport.send("text", payload);
    },
    interrupt() {
      // Gemini has no client-side interrupt call; the session is barge-in aware server-side. Named here
      // as a refusal rather than a silent no-op: `interrupt()` is a no-op for this provider ON PURPOSE.
      log("[live-provider:gemini] interrupt() is not sent — this provider's barge-in is server-side");
    },
    /**
     * A folder change with an instruction file (voicebox-beads-0zi4).
     *
     * THE VENDOR SENDS `setup` ONCE PER CONNECTION and `clientContent` turns are USER SPEECH — pushing
     * the file in as a turn is how instructions get read aloud, which this codebase already refuses for
     * the dialogue path. So the refusal is NAMED and the caller decides: the host tells the page, and the
     * text applies to the next session. A silent no-op would let the page believe the voice had the
     * folder's rules while it did not, which is the failure this bead exists to remove.
     */
    updateProjectInstruction() {
      log("[live-provider:gemini] a folder's instruction cannot be applied mid-session: `setup` is sent once, so it takes effect on the next session");
      return { ok: false, reason: "gemini-live-setup-is-once", applies: "next-session" };
    },
    /** Answer a tool call: [{ id, name, response }] — one per functionCall, ids echoed back. */
    sendToolResponse(responses) {
      const sent = transport.send("control", JSON.stringify({
        toolResponse: { functionResponses: responses },
      }));
      if (sent) {
        awaitingToolTurnComplete = true;
        clearTimeout(toolTurnTimer);
        toolTurnTimer = setTimeout(flushQueuedText, 4000);
        if (typeof toolTurnTimer?.unref === "function") toolTurnTimer.unref();
      }
      for (const response of responses) debug?.({ type: "tool.delivery", callId: response.id, name: response.name,
        response: response.response, delivery: sent ? "transport-accepted" : "not-sent", modelReceipt: "unknown", severity: sent ? "info" : "error" });
      return sent;
    },
    close() {
      clearTimeout(toolTurnTimer);
      transport.close();
    },
  };
}
