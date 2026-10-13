import { createLiveVideoController } from "../live-video-experiment.mjs";

const codec = window["JS" + "ON"];
const videoEl = document.getElementById("live-preview");
const canvasEl = document.getElementById("capture-canvas");
const emptyNotice = document.getElementById("preview-empty-notice");
const statusBadge = document.getElementById("source-status-badge");
const frameCounter = document.getElementById("frame-counter");
const interactionBadge = document.getElementById("interaction-status-badge");
const resumptionBadge = document.getElementById("session-resumption-badge");
const goAwayBadge = document.getElementById("go-away-badge");
const lastFrameSummary = document.getElementById("last-frame-summary");
const setupPreview = document.getElementById("setup-payload-preview");
const form = document.getElementById("live-config-form");

let latestFrame = null;

const sessionConfig = {
  model: "models/gemini-3.8-live",
  thinkingLevel: "low",
  includeThoughts: false,
  nonBlockingTools: true,
  mediaResolution: "MEDIA_RESOLUTION_MEDIUM",
  fps: 1,
  turnCoverage: "TURN_INCLUDES_ALL_INPUT",
  activityHandling: "START_OF_ACTIVITY_INTERRUPTS",
  endOfSpeechSensitivity: "END_SENSITIVITY_HIGH",
  silenceDurationMs: 500,
  inputAudioTranscription: true,
  outputAudioTranscription: true,
  contextWindowCompression: true,
  sessionResumption: true,
  proactiveAudio: false,
  affectiveDialog: false,
};

const sessionDiagnostics = {
  interactionStatus: "IDLE",
  resumptionHandle: null,
  goAwayTimeLeft: null,
  audioStreamEndSentCount: 0,
};

function isExtendedThinking(model) {
  return model === "models/gemini-3.8-live-extended-thinking";
}

function buildSetupFromConfig(cfg) {
  const extended = isExtendedThinking(cfg.model);
  const thinkingConfig = {
    thinkingBudget: -1,
    ...(extended ? { thinkingLevel: cfg.thinkingLevel || "low" } : {}),
    ...(cfg.includeThoughts ? { includeThoughts: true } : {}),
  };
  const setup = {
    model: cfg.model || "models/gemini-3.8-live",
    generationConfig: {
      responseModalities: ["AUDIO"],
      thinkingConfig,
      mediaResolution: cfg.mediaResolution,
      ...(cfg.affectiveDialog ? { enableAffectiveDialog: true } : {}),
    },
    realtimeInputConfig: {
      automaticActivityDetection: {
        endOfSpeechSensitivity: cfg.endOfSpeechSensitivity,
        silenceDurationMs: Number(cfg.silenceDurationMs) || 500,
      },
      activityHandling: cfg.activityHandling,
      turnCoverage: cfg.turnCoverage,
    },
    ...(cfg.inputAudioTranscription ? { inputAudioTranscription: {} } : {}),
    ...(cfg.outputAudioTranscription ? { outputAudioTranscription: {} } : {}),
    ...(cfg.contextWindowCompression ? { contextWindowCompression: { slidingWindow: {} } } : {}),
    ...(cfg.sessionResumption ? { sessionResumption: {} } : {}),
    ...(cfg.proactiveAudio ? { proactivity: { proactiveAudio: true } } : {}),
  };
  return { setup };
}

function renderSetupPreview() {
  const thinkingSelect = document.getElementById("thinking-level-select");
  if (thinkingSelect) {
    thinkingSelect.disabled = !isExtendedThinking(sessionConfig.model);
  }
  if (setupPreview && codec) {
    setupPreview.textContent = codec.stringify(buildSetupFromConfig(sessionConfig), null, 2);
  }
}

function renderDiagnostics() {
  if (interactionBadge) {
    const inProgress = sessionDiagnostics.interactionStatus === "IN_PROGRESS";
    interactionBadge.dataset.active = inProgress ? "true" : "false";
    interactionBadge.textContent = "Interaction: " + sessionDiagnostics.interactionStatus;
  }
  if (resumptionBadge) {
    resumptionBadge.textContent = sessionDiagnostics.resumptionHandle
      ? "Resumption: " + String(sessionDiagnostics.resumptionHandle).slice(0, 12)
      : "Resumption: Standby";
  }
  if (goAwayBadge) {
    goAwayBadge.textContent = sessionDiagnostics.goAwayTimeLeft
      ? "GoAway: " + sessionDiagnostics.goAwayTimeLeft
      : "Connection: Active";
  }
}

const controller = createLiveVideoController({
  videoElement: videoEl,
  canvasElement: canvasEl,
  fps: sessionConfig.fps,
  maxDimension: 1024,
  quality: 0.78,
  onFrame(frame) {
    latestFrame = frame;
    const status = controller.getStatus();
    if (frameCounter) {
      frameCounter.textContent =
        status.framesSent + (status.framesSent === 1 ? " frame sent" : " frames sent");
    }
    if (lastFrameSummary && codec) {
      lastFrameSummary.textContent = codec.stringify(
        {
          source: frame.source || "snapshot",
          mimeType: frame.mimeType,
          width: frame.width,
          height: frame.height,
          base64Length: frame.data ? frame.data.length : 0,
          timestamp: frame.timestamp,
        },
        null,
        2,
      );
    }
  },
  onStateChange(state) {
    if (statusBadge) {
      statusBadge.dataset.active = state.active ? "true" : "false";
      statusBadge.textContent = state.active
        ? state.source === "screen"
          ? "Sharing Desktop / Window"
          : "Camera Active"
        : "Video Idle";
    }
    if (emptyNotice) {
      emptyNotice.hidden = Boolean(state.active);
    }
  },
});

document.getElementById("start-camera-btn")?.addEventListener("click", async () => {
  try {
    await navigator.mediaDevices.getUserMedia({ video: true });
    await controller.startCamera();
  } catch (err) {
    if (lastFrameSummary) {
      lastFrameSummary.textContent = "Camera unavailable: " + String(err?.message || err);
    }
  }
});

document.getElementById("start-screen-btn")?.addEventListener("click", async () => {
  try {
    await navigator.mediaDevices.getDisplayMedia({ video: true });
    await controller.startScreenShare();
  } catch (err) {
    if (lastFrameSummary) {
      lastFrameSummary.textContent = "Screen share unavailable: " + String(err?.message || err);
    }
  }
});

document.getElementById("capture-frame-btn")?.addEventListener("click", () => {
  controller.captureSingleFrame();
});

document.getElementById("audio-stream-end-btn")?.addEventListener("click", () => {
  sessionDiagnostics.audioStreamEndSentCount += 1;
  if (lastFrameSummary && codec) {
    lastFrameSummary.textContent = codec.stringify(
      {
        realtimeInput: { audioStreamEnd: true },
        sentCount: sessionDiagnostics.audioStreamEndSentCount,
      },
      null,
      2,
    );
  }
});

document.getElementById("stop-video-btn")?.addEventListener("click", () => {
  controller.stop();
});

form?.addEventListener("change", () => {
  const formData = new FormData(form);
  sessionConfig.model = String(formData.get("model") || "models/gemini-3.8-live");
  sessionConfig.thinkingLevel = String(formData.get("thinkingLevel") || "low");
  sessionConfig.mediaResolution = String(
    formData.get("mediaResolution") || "MEDIA_RESOLUTION_MEDIUM",
  );
  sessionConfig.fps = Number(formData.get("fps") || 1);
  sessionConfig.turnCoverage = String(
    formData.get("turnCoverage") || "TURN_INCLUDES_ALL_INPUT",
  );
  sessionConfig.activityHandling = String(
    formData.get("activityHandling") || "START_OF_ACTIVITY_INTERRUPTS",
  );
  sessionConfig.endOfSpeechSensitivity = String(
    formData.get("endOfSpeechSensitivity") || "END_SENSITIVITY_HIGH",
  );
  sessionConfig.silenceDurationMs = Number(formData.get("silenceDurationMs") || 500);
  sessionConfig.includeThoughts = Boolean(
    document.getElementById("toggle-include-thoughts")?.checked,
  );
  sessionConfig.nonBlockingTools = Boolean(
    document.getElementById("toggle-non-blocking-tools")?.checked,
  );
  sessionConfig.inputAudioTranscription = Boolean(
    document.getElementById("toggle-input-transcription")?.checked,
  );
  sessionConfig.outputAudioTranscription = Boolean(
    document.getElementById("toggle-output-transcription")?.checked,
  );
  sessionConfig.contextWindowCompression = Boolean(
    document.getElementById("toggle-context-compression")?.checked,
  );
  sessionConfig.sessionResumption = Boolean(
    document.getElementById("toggle-session-resumption")?.checked,
  );
  sessionConfig.proactiveAudio = Boolean(
    document.getElementById("toggle-proactive-audio")?.checked,
  );
  sessionConfig.affectiveDialog = Boolean(
    document.getElementById("toggle-affective-dialog")?.checked,
  );

  controller.updateSettings({ fps: sessionConfig.fps });
  renderSetupPreview();
});

function registerVisionTools() {
  const statusTool = {
    name: "get_live_vision_status",
    description:
      "Return current camera or screen sharing state, frame counter, and Gemini Live session settings.",
    parameters: { type: "object", properties: {} },
    execute: async () => ({
      video: controller.getStatus(),
      config: { ...sessionConfig },
      diagnostics: { ...sessionDiagnostics },
      setupPayload: buildSetupFromConfig(sessionConfig),
    }),
  };

  const captureTool = {
    name: "capture_live_frame",
    description:
      "Capture an immediate JPEG snapshot from the active camera or desktop screen stream.",
    parameters: { type: "object", properties: {} },
    execute: async () => {
      const frame = controller.captureSingleFrame();
      return {
        ok: true,
        source: frame.source,
        mimeType: frame.mimeType,
        width: frame.width,
        height: frame.height,
        timestamp: frame.timestamp,
      };
    },
  };

  const configureTool = {
    name: "configure_live_session",
    description:
      "Update Gemini Live session options such as model, thinkingLevel, includeThoughts, mediaResolution, turnCoverage, activityHandling, fps, or contextWindowCompression.",
    parameters: {
      type: "object",
      properties: {
        model: { type: "string" },
        thinkingLevel: { type: "string" },
        includeThoughts: { type: "boolean" },
        nonBlockingTools: { type: "boolean" },
        mediaResolution: { type: "string" },
        fps: { type: "number" },
        turnCoverage: { type: "string" },
        activityHandling: { type: "string" },
        silenceDurationMs: { type: "number" },
        contextWindowCompression: { type: "boolean" },
        inputAudioTranscription: { type: "boolean" },
        outputAudioTranscription: { type: "boolean" },
        sessionResumption: { type: "boolean" },
        proactiveAudio: { type: "boolean" },
        affectiveDialog: { type: "boolean" },
      },
    },
    execute: async (args = {}) => {
      Object.assign(sessionConfig, args);
      if (args.fps) {
        controller.updateSettings({ fps: Number(args.fps) });
      }
      renderSetupPreview();
      return {
        ok: true,
        config: { ...sessionConfig },
        setupPayload: buildSetupFromConfig(sessionConfig),
      };
    },
  };

  window.voicebox?.registerTool(statusTool);
  window.voicebox?.registerTool(captureTool);
  window.voicebox?.registerTool(configureTool);
  window.voicebox?.ready?.();
}

renderSetupPreview();
renderDiagnostics();
registerVisionTools();
