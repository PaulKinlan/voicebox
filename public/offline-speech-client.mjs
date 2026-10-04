// public/offline-speech-client.mjs — Browser offline speech recognition and voice synthesis fallback.

export function createOfflineSpeechController({
  windowObj = globalThis.window,
  navigatorObj = globalThis.navigator,
  onTranscript = null,
  onStateChange = null,
} = {}) {
  let activeRecognition = null;
  let isListening = false;

  function getRecognitionCtor() {
    return windowObj?.SpeechRecognition || windowObj?.webkitSpeechRecognition || null;
  }

  function getSynthesis() {
    return windowObj?.speechSynthesis || null;
  }

  function shouldUseOfflineFallback({ cloudProviderAvailable = true } = {}) {
    if (navigatorObj && navigatorObj.onLine === false) {
      return true;
    }
    return !cloudProviderAvailable;
  }

  function speak(text, { rate = 1.0, pitch = 1.0, voiceName = "" } = {}) {
    const cleanText = String(text ?? "").trim();
    if (!cleanText) {
      return { ok: false, mode: "empty", spoken: "" };
    }

    const synth = getSynthesis();
    if (!synth) {
      return { ok: false, mode: "unsupported", spoken: "" };
    }

    try {
      synth.cancel?.();
    } catch {}

    const UtteranceCtor = windowObj?.SpeechSynthesisUtterance;
    const utterance = typeof UtteranceCtor === "function" ? new UtteranceCtor(cleanText) : { text: cleanText };
    utterance.rate = Number.isFinite(rate) ? rate : 1.0;
    utterance.pitch = Number.isFinite(pitch) ? pitch : 1.0;

    if (voiceName && typeof synth.getVoices === "function") {
      const voices = synth.getVoices() || [];
      const match = voices.find((v) => v && (v.name === voiceName || v.lang === voiceName));
      if (match) {
        utterance.voice = match;
      }
    }

    utterance.onstart = () => {
      onStateChange?.("speaking");
    };
    utterance.onend = () => {
      onStateChange?.("idle");
    };
    utterance.onerror = () => {
      onStateChange?.("idle");
    };

    onStateChange?.("speaking");
    synth.speak(utterance);

    return {
      ok: true,
      mode: "browser-speech-synthesis",
      spoken: cleanText,
    };
  }

  function stopSpeaking() {
    const synth = getSynthesis();
    try {
      synth?.cancel?.();
    } catch {}
    onStateChange?.("idle");
    return { ok: true };
  }

  function startListening({ continuous = false, interimResults = true, lang = "en-US" } = {}) {
    const Recognition = getRecognitionCtor();
    if (!Recognition) {
      return { ok: false, mode: "unsupported" };
    }

    if (activeRecognition && isListening) {
      try {
        activeRecognition.stop?.();
      } catch {}
    }

    const recognition = new Recognition();
    recognition.continuous = Boolean(continuous);
    recognition.interimResults = Boolean(interimResults);
    recognition.lang = lang || "en-US";

    recognition.onstart = () => {
      isListening = true;
      onStateChange?.("listening");
    };

    recognition.onresult = (event) => {
      const results = event?.results;
      if (!results || typeof results.length !== "number" || results.length === 0) return;
      const latest = results[results.length - 1];
      const alternative = latest?.[0] ?? latest;
      const transcript = String(alternative?.transcript ?? "").trim();
      const isFinal = Boolean(latest?.isFinal ?? true);
      if (transcript) {
        onTranscript?.(transcript, { isFinal });
      }
    };

    recognition.onend = () => {
      isListening = false;
      onStateChange?.("idle");
    };

    recognition.onerror = () => {
      isListening = false;
      onStateChange?.("idle");
    };

    activeRecognition = recognition;
    isListening = true;
    onStateChange?.("listening");
    recognition.start?.();

    return {
      ok: true,
      mode: "browser-speech-recognition",
    };
  }

  function stopListening() {
    if (activeRecognition) {
      try {
        activeRecognition.stop?.();
      } catch {}
      activeRecognition = null;
    }
    isListening = false;
    onStateChange?.("idle");
    return { ok: true };
  }

  function getStatus({ cloudProviderAvailable = true } = {}) {
    const offline = shouldUseOfflineFallback({ cloudProviderAvailable });
    return {
      online: navigatorObj?.onLine !== false,
      activeMode: offline ? "offline" : "cloud",
      browserSttSupported: Boolean(getRecognitionCtor()),
      browserTtsSupported: Boolean(getSynthesis()),
    };
  }

  return {
    shouldUseOfflineFallback,
    speak,
    stopSpeaking,
    startListening,
    stopListening,
    getStatus,
  };
}
