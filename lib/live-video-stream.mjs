// lib/live-video-stream.mjs — Gemini Live configuration builder & realtime video frame protocol.
//
// Maps the full BidiGenerateContentSetup and BidiGenerateContentRealtimeInput specification
// (https://ai.google.dev/api/live) into validated, deterministic wire payloads for voice + live
// camera (getUserMedia) and desktop screen capture (getDisplayMedia) sessions.

export const DEFAULT_GEMINI_LIVE_MODEL = "models/gemini-3.8-live";

export const VALID_VIDEO_MIME_TYPES = Object.freeze([
  "image/jpeg",
  "image/png",
  "image/webp",
]);

export const VALID_MEDIA_RESOLUTIONS = Object.freeze([
  "MEDIA_RESOLUTION_LOW",
  "MEDIA_RESOLUTION_MEDIUM",
  "MEDIA_RESOLUTION_HIGH",
]);

export const VALID_ACTIVITY_HANDLINGS = Object.freeze([
  "START_OF_ACTIVITY_INTERRUPTS",
  "NO_INTERRUPTION",
]);

export const VALID_TURN_COVERAGES = Object.freeze([
  "TURN_INCLUDES_ONLY_ACTIVITY",
  "TURN_INCLUDES_ALL_INPUT",
  "TURN_INCLUDES_AUDIO_ACTIVITY_AND_ALL_VIDEO",
]);

export const VALID_START_SENSITIVITIES = Object.freeze([
  "START_SENSITIVITY_HIGH",
  "START_SENSITIVITY_LOW",
]);

export const VALID_END_SENSITIVITIES = Object.freeze([
  "END_SENSITIVITY_HIGH",
  "END_SENSITIVITY_LOW",
]);

/**
 * Catalogue of configurable Gemini Live session parameters (`BidiGenerateContentSetup`).
 */
export const GEMINI_LIVE_CONFIG_CATALOGUE = Object.freeze({
  vadSensitivity: {
    key: "vadSensitivity",
    wirePath: "setup.realtimeInputConfig.automaticActivityDetection",
    type: "object",
    startValues: VALID_START_SENSITIVITIES,
    endValues: VALID_END_SENSITIVITIES,
    defaultStart: "START_SENSITIVITY_HIGH",
    defaultEnd: "END_SENSITIVITY_HIGH",
    description:
      "Controls how eagerly server-side voice activity detection triggers start-of-speech and end-of-speech.",
  },
  silenceDurationMs: {
    key: "silenceDurationMs",
    wirePath: "setup.realtimeInputConfig.automaticActivityDetection.silenceDurationMs",
    type: "integer",
    min: 100,
    max: 5000,
    defaultValue: 500,
    description:
      "Required duration of non-speech silence (in milliseconds) before end-of-speech is committed.",
  },
  activityHandling: {
    key: "activityHandling",
    wirePath: "setup.realtimeInputConfig.activityHandling",
    type: "enum",
    values: VALID_ACTIVITY_HANDLINGS,
    defaultValue: "START_OF_ACTIVITY_INTERRUPTS",
    description:
      "Controls whether user speech interrupts ongoing model output (barge-in) or waits until generation finishes.",
  },
  turnCoverage: {
    key: "turnCoverage",
    wirePath: "setup.realtimeInputConfig.turnCoverage",
    type: "enum",
    values: VALID_TURN_COVERAGES,
    defaultValue: "TURN_INCLUDES_ONLY_ACTIVITY",
    videoRecommendedValue: "TURN_INCLUDES_ALL_INPUT",
    description:
      "Determines whether only active speech frames or all continuous camera/desktop frames are included in the turn.",
  },
  mediaResolution: {
    key: "mediaResolution",
    wirePath: "setup.generationConfig.mediaResolution",
    type: "enum",
    values: VALID_MEDIA_RESOLUTIONS,
    defaultValue: "MEDIA_RESOLUTION_MEDIUM",
    description:
      "Controls per-frame visual token budget for camera and screen-share streams.",
  },
  inputAudioTranscription: {
    key: "inputAudioTranscription",
    wirePath: "setup.inputAudioTranscription",
    type: "boolean|object",
    defaultValue: true,
    description:
      "Enables live server-side transcription of incoming user audio (serverContent.inputTranscription).",
  },
  outputAudioTranscription: {
    key: "outputAudioTranscription",
    wirePath: "setup.outputAudioTranscription",
    type: "boolean|object",
    defaultValue: true,
    description:
      "Enables live transcription of the model's spoken audio response (serverContent.outputTranscription).",
  },
  contextWindowCompression: {
    key: "contextWindowCompression",
    wirePath: "setup.contextWindowCompression",
    type: "boolean|object",
    defaultValue: true,
    description:
      "Configures sliding-window token compression so continuous audio+video sessions can run past the 2-minute limit.",
  },
  sessionResumption: {
    key: "sessionResumption",
    wirePath: "setup.sessionResumption",
    type: "boolean|object",
    defaultValue: false,
    description:
      "Requests SessionResumptionUpdate handles from the server and resumes prior session state across reconnects.",
  },
  proactiveAudio: {
    key: "proactiveAudio",
    wirePath: "setup.proactivity.proactiveAudio",
    type: "boolean",
    defaultValue: false,
    description:
      "Allows the model to stay silent when background speech is not directed at it.",
  },
  affectiveDialog: {
    key: "affectiveDialog",
    wirePath: "setup.generationConfig.enableAffectiveDialog",
    type: "boolean",
    defaultValue: false,
    description:
      "Enables emotion-aware prosody and tone adaptation in the model's spoken responses.",
  },
  thinkingBudget: {
    key: "thinkingBudget",
    wirePath: "setup.generationConfig.thinkingConfig.thinkingBudget",
    type: "integer",
    defaultValue: -1,
    description:
      "Token budget for internal model reasoning before speaking (-1 for dynamic, 0 to disable, or positive token count).",
  },
  voice: {
    key: "voice",
    wirePath: "setup.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName",
    type: "string",
    defaultValue: "Puck",
    description: "Prebuilt output voice name (for example Puck, Kore, Charon, Fenrir, Aoede).",
  },
  languageCode: {
    key: "languageCode",
    wirePath: "setup.generationConfig.speechConfig.languageCode",
    type: "string",
    defaultValue: "en-US",
    description: "BCP-47 language code for synthesized speech and transcription alignment.",
  },
});

/**
 * Builds a spec-compliant `BidiGenerateContentSetup` payload for Gemini Live.
 */
export function buildGeminiLiveSetupPayload(options = {}) {
  const model = options.model ?? DEFAULT_GEMINI_LIVE_MODEL;
  const enableVideo = Boolean(options.enableVideo);

  const responseModalities =
    Array.isArray(options.responseModalities) && options.responseModalities.length > 0
      ? [...options.responseModalities]
      : ["AUDIO"];

  const defaultThinkingBudget = model === "models/gemini-3.8-thinking" ? 2048 : -1;
  const thinkingBudget =
    options.thinkingBudget !== undefined
      ? Number(options.thinkingBudget)
      : options.thinkingConfig?.thinkingBudget !== undefined
        ? Number(options.thinkingConfig.thinkingBudget)
        : defaultThinkingBudget;

  const thinkingConfig = {
    thinkingBudget,
    ...(options.includeThoughts !== undefined
      ? { includeThoughts: Boolean(options.includeThoughts) }
      : options.thinkingConfig?.includeThoughts !== undefined
        ? { includeThoughts: Boolean(options.thinkingConfig.includeThoughts) }
        : {}),
  };

  const generationConfig = {
    responseModalities,
    thinkingConfig,
  };

  if (options.voice || options.languageCode) {
    generationConfig.speechConfig = {
      ...(options.voice
        ? { voiceConfig: { prebuiltVoiceConfig: { voiceName: String(options.voice) } } }
        : {}),
      ...(options.languageCode ? { languageCode: String(options.languageCode) } : {}),
    };
  }

  const mediaResolution = options.mediaResolution ?? options.generationConfig?.mediaResolution;
  if (mediaResolution && VALID_MEDIA_RESOLUTIONS.includes(mediaResolution)) {
    generationConfig.mediaResolution = mediaResolution;
  }

  const affective =
    options.enableAffectiveDialog !== undefined
      ? options.enableAffectiveDialog
      : options.affectiveDialog;
  if (affective !== undefined) {
    generationConfig.enableAffectiveDialog = Boolean(affective);
  }

  for (const numericKey of ["temperature", "topP", "topK", "maxOutputTokens"]) {
    if (options[numericKey] !== undefined && options[numericKey] !== null) {
      generationConfig[numericKey] = Number(options[numericKey]);
    }
  }

  const setup = {
    model,
    generationConfig,
  };

  // System instructions: support structured { parts } or composed text parts.
  if (
    options.systemInstruction &&
    typeof options.systemInstruction === "object" &&
    Array.isArray(options.systemInstruction.parts)
  ) {
    setup.systemInstruction = options.systemInstruction;
  } else if (options.instruction || options.projectInstruction || options.systemInstruction) {
    const parts = [
      ...(options.instruction ? [{ text: String(options.instruction) }] : []),
      ...(options.projectInstruction ? [{ text: String(options.projectInstruction) }] : []),
      ...(typeof options.systemInstruction === "string" && options.systemInstruction
        ? [{ text: options.systemInstruction }]
        : []),
    ];
    if (parts.length > 0) {
      setup.systemInstruction = { parts };
    }
  }

  // Tools: functionDeclarations, googleSearch, codeExecution
  const toolEntries = [];
  if (Array.isArray(options.tools) && options.tools.length > 0) {
    const alreadyWrapped = options.tools.some(
      (t) =>
        t &&
        typeof t === "object" &&
        ("functionDeclarations" in t || "googleSearch" in t || "codeExecution" in t),
    );
    if (alreadyWrapped) {
      toolEntries.push(...options.tools);
    } else {
      toolEntries.push({ functionDeclarations: options.tools });
    }
  }
  if (options.googleSearch === true) {
    toolEntries.push({ googleSearch: {} });
  }
  if (options.codeExecution === true) {
    toolEntries.push({ codeExecution: {} });
  }
  if (toolEntries.length > 0) {
    setup.tools = toolEntries;
  }

  // Audio transcriptions (top-level fields on `setup`, never inside `generationConfig`)
  if (options.inputAudioTranscription) {
    setup.inputAudioTranscription =
      typeof options.inputAudioTranscription === "object"
        ? { ...options.inputAudioTranscription }
        : {};
  }

  if (options.outputAudioTranscription !== false) {
    setup.outputAudioTranscription =
      options.outputAudioTranscription && typeof options.outputAudioTranscription === "object"
        ? { ...options.outputAudioTranscription }
        : {};
  }

  // RealtimeInputConfig (VAD, barge-in handling, turn coverage)
  const vadInput =
    options.automaticActivityDetection ??
    options.realtimeInputConfig?.automaticActivityDetection ??
    {};
  const automaticActivityDetection = {};

  if (options.vadDisabled !== undefined || vadInput.disabled !== undefined) {
    automaticActivityDetection.disabled = Boolean(options.vadDisabled ?? vadInput.disabled);
  }
  const startSens =
    options.startOfSpeechSensitivity ??
    options.vadSensitivity?.startOfSpeechSensitivity ??
    (typeof options.vadSensitivity === "string" &&
    VALID_START_SENSITIVITIES.includes(options.vadSensitivity)
      ? options.vadSensitivity
      : undefined) ??
    vadInput.startOfSpeechSensitivity;
  if (startSens && VALID_START_SENSITIVITIES.includes(startSens)) {
    automaticActivityDetection.startOfSpeechSensitivity = startSens;
  }

  const endSens =
    options.endOfSpeechSensitivity ??
    options.vadSensitivity?.endOfSpeechSensitivity ??
    (typeof options.vadSensitivity === "string" &&
    VALID_END_SENSITIVITIES.includes(options.vadSensitivity)
      ? options.vadSensitivity
      : undefined) ??
    vadInput.endOfSpeechSensitivity;
  if (endSens && VALID_END_SENSITIVITIES.includes(endSens)) {
    automaticActivityDetection.endOfSpeechSensitivity = endSens;
  }

  const prefixPaddingMs = options.prefixPaddingMs ?? vadInput.prefixPaddingMs;
  if (prefixPaddingMs !== undefined && prefixPaddingMs !== null) {
    automaticActivityDetection.prefixPaddingMs = Number(prefixPaddingMs);
  }

  const silenceDurationMs = options.silenceDurationMs ?? vadInput.silenceDurationMs;
  if (silenceDurationMs !== undefined && silenceDurationMs !== null) {
    automaticActivityDetection.silenceDurationMs = Number(silenceDurationMs);
  }

  const activityHandling =
    options.activityHandling ?? options.realtimeInputConfig?.activityHandling;
  const turnCoverage =
    options.turnCoverage ??
    options.realtimeInputConfig?.turnCoverage ??
    (enableVideo ? "TURN_INCLUDES_ALL_INPUT" : undefined);

  const realtimeInputConfig = {};
  if (Object.keys(automaticActivityDetection).length > 0) {
    realtimeInputConfig.automaticActivityDetection = automaticActivityDetection;
  }
  if (activityHandling && VALID_ACTIVITY_HANDLINGS.includes(activityHandling)) {
    realtimeInputConfig.activityHandling = activityHandling;
  }
  if (turnCoverage && VALID_TURN_COVERAGES.includes(turnCoverage)) {
    realtimeInputConfig.turnCoverage = turnCoverage;
  }
  if (Object.keys(realtimeInputConfig).length > 0) {
    setup.realtimeInputConfig = realtimeInputConfig;
  }

  // Context window compression (automatically enabled when enableVideo === true unless explicitly false)
  const shouldCompress =
    options.contextWindowCompression !== undefined
      ? options.contextWindowCompression !== false
      : enableVideo;
  if (shouldCompress) {
    const rawComp =
      typeof options.contextWindowCompression === "object" &&
      options.contextWindowCompression !== null
        ? options.contextWindowCompression
        : {};
    const triggerTokens = options.triggerTokens ?? rawComp.triggerTokens;
    const targetTokens =
      options.targetTokens ?? rawComp.slidingWindow?.targetTokens ?? rawComp.targetTokens;
    setup.contextWindowCompression = {
      ...(triggerTokens !== undefined ? { triggerTokens: Number(triggerTokens) } : {}),
      slidingWindow: {
        ...(targetTokens !== undefined ? { targetTokens: Number(targetTokens) } : {}),
      },
    };
  }

  // Session resumption
  if (options.sessionResumption || options.sessionResumptionHandle) {
    const handle =
      typeof options.sessionResumption === "string"
        ? options.sessionResumption
        : options.sessionResumption?.handle ?? options.sessionResumptionHandle;
    setup.sessionResumption = handle ? { handle: String(handle) } : {};
  }

  // Proactivity
  const proactiveAudio =
    options.proactiveAudio ?? options.proactivity?.proactiveAudio;
  if (proactiveAudio !== undefined) {
    setup.proactivity = { proactiveAudio: Boolean(proactiveAudio) };
  }

  return { setup };
}

/**
 * Validates a base64 or data-URL encoded video frame and formats it as a
 * `BidiGenerateContentRealtimeInput` wire payload (`{ realtimeInput: { video: { mimeType, data } } }`).
 */
export function validateAndFormatVideoFrame({
  data,
  mimeType = "image/jpeg",
  maxBytes = 1024 * 1024,
} = {}) {
  if (typeof data !== "string" || data.trim().length === 0) {
    return {
      ok: false,
      refused: "invalid-video-frame",
      why: "Video frame data must be a non-empty base64 string or data URL.",
    };
  }

  let resolvedMime = mimeType;
  let rawBase64 = data.trim();

  if (rawBase64.startsWith("data:")) {
    const match = rawBase64.match(/^data:([^;,]+);base64,([\s\S]*)$/);
    if (!match) {
      return {
        ok: false,
        refused: "invalid-video-frame",
        why: "Data URL video frame must include a ';base64,' payload.",
      };
    }
    const urlMime = match[1].trim().toLowerCase();
    if (!VALID_VIDEO_MIME_TYPES.includes(urlMime)) {
      return {
        ok: false,
        refused: "invalid-video-frame",
        why: `Unsupported video frame media type "${urlMime}" in data URL.`,
      };
    }
    resolvedMime = mimeType === "image/jpeg" ? urlMime : mimeType;
    rawBase64 = match[2];
  }

  if (
    typeof resolvedMime !== "string" ||
    !VALID_VIDEO_MIME_TYPES.includes(resolvedMime)
  ) {
    return {
      ok: false,
      refused: "invalid-video-frame",
      why: `Unsupported video frame mimeType "${resolvedMime}". Allowed: ${VALID_VIDEO_MIME_TYPES.join(", ")}.`,
    };
  }

  const cleanBase64 = rawBase64.replace(/\s+/g, "");
  if (
    cleanBase64.length === 0 ||
    cleanBase64.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(cleanBase64)
  ) {
    return {
      ok: false,
      refused: "invalid-video-frame",
      why: "Video frame payload is not valid base64 data.",
    };
  }

  const byteLength = Buffer.from(cleanBase64, "base64").byteLength;
  if (byteLength === 0) {
    return {
      ok: false,
      refused: "invalid-video-frame",
      why: "Decoded video frame is empty (0 bytes).",
    };
  }

  if (byteLength > maxBytes) {
    return {
      ok: false,
      refused: "frame-too-large",
      why: `Decoded video frame (${byteLength} bytes) exceeds maximum allowed size (${maxBytes} bytes).`,
    };
  }

  return {
    ok: true,
    mimeType: resolvedMime,
    data: cleanBase64,
    byteLength,
    wirePayload: JSON.stringify({
      realtimeInput: {
        video: {
          mimeType: resolvedMime,
          data: cleanBase64,
        },
      },
    }),
  };
}

/**
 * Builds a manual push-to-talk activity signal (`activityStart` or `activityEnd`)
 * for sessions where `automaticActivityDetection.disabled === true`.
 */
export function buildActivityControlPayload(kind = "start") {
  const isEnd = kind === "end";
  return {
    ok: true,
    kind: isEnd ? "end" : "start",
    wirePayload: JSON.stringify({
      realtimeInput: isEnd ? { activityEnd: {} } : { activityStart: {} },
    }),
  };
}
