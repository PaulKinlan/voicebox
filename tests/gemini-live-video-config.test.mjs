// tests/gemini-live-video-config.test.mjs — Unit tests for Gemini Live setup configuration,
// realtime video frame protocol, camera/desktop capture controller, and Live Vision Studio.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  DEFAULT_GEMINI_LIVE_MODEL,
  GEMINI_LIVE_EXTENDED_THINKING_MODEL,
  VALID_THINKING_LEVELS,
  isExtendedThinkingModel,
  GEMINI_LIVE_CONFIG_CATALOGUE,
  buildGeminiLiveSetupPayload,
  validateAndFormatVideoFrame,
  buildActivityControlPayload,
} from "../lib/live-video-stream.mjs";
import {
  createGeminiProvider,
} from "../lib/live-providers/gemini.mjs";
import {
  createLiveVideoController,
  scaleFrameDimensions,
} from "../public/live-video-experiment.mjs";
import {
  ID_PATTERNS,
  JARGON,
  identifiersInRenderedText,
} from "../tools/rendered-plain-language.mjs";

const BANNED_JARGON_WORDS = [
  "sandbox",
  "iframe",
  "srcdoc",
  "opfs",
  "ipc",
  "json",
  "rpc",
  "wasm",
  "idempotence",
  "worktree",
];

const BANNED_TICKET_SUBSTRINGS = [
  "igmc",
  "ehmn",
  "dtjf",
  "3si2",
  "hn7x",
  "lmvn",
  "xgnm",
  "zjdd",
  "keb7",
  "bavl",
];

function scanPlainLanguage(rawSource) {
  const withoutStyleAndComments = rawSource
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");

  const hits = [...identifiersInRenderedText(withoutStyleAndComments)];

  for (const [re, label, remedy] of ID_PATTERNS) {
    const m = withoutStyleAndComments.match(re);
    if (m) hits.push({ token: m[0], label, remedy });
  }
  for (const [word, remedy] of JARGON) {
    const re = new RegExp(`\\b${word}\\b`, "i");
    if (re.test(withoutStyleAndComments)) {
      hits.push({ token: word, label: "jargon", remedy });
    }
  }
  for (const word of BANNED_JARGON_WORDS) {
    const re = new RegExp(`\\b${word}\\b`, "i");
    if (re.test(rawSource)) {
      hits.push({ token: word, label: "banned-jargon", remedy: "use plain language" });
    }
  }
  for (const id of BANNED_TICKET_SUBSTRINGS) {
    if (rawSource.toLowerCase().includes(id.toLowerCase())) {
      hits.push({ token: id, label: "ticket-id", remedy: "remove ticket id substring" });
    }
  }
  return hits;
}

test("GEMINI_LIVE_CONFIG_CATALOGUE exposes metadata for all configurable Gemini Live parameters", () => {
  const expectedKeys = [
    "vadSensitivity",
    "silenceDurationMs",
    "activityHandling",
    "turnCoverage",
    "mediaResolution",
    "inputAudioTranscription",
    "outputAudioTranscription",
    "contextWindowCompression",
    "sessionResumption",
    "proactiveAudio",
    "affectiveDialog",
    "thinkingBudget",
    "thinkingLevel",
    "nonBlockingTools",
    "voice",
    "languageCode",
  ];
  for (const key of expectedKeys) {
    assert.ok(
      GEMINI_LIVE_CONFIG_CATALOGUE[key],
      `Missing expected catalogue entry: ${key}`,
    );
    assert.equal(GEMINI_LIVE_CONFIG_CATALOGUE[key].key, key);
    assert.ok(GEMINI_LIVE_CONFIG_CATALOGUE[key].wirePath.startsWith("setup."));
  }
});

test("buildGeminiLiveSetupPayload builds spec-compliant BidiGenerateContentSetup with VAD, transcriptions, compression, resumption, proactivity, and affective dialog", () => {
  const payload = buildGeminiLiveSetupPayload({
    model: "models/gemini-3.8-live",
    voice: "Kore",
    languageCode: "en-US",
    thinkingBudget: 1024,
    includeThoughts: true,
    mediaResolution: "MEDIA_RESOLUTION_HIGH",
    enableAffectiveDialog: true,
    temperature: 0.6,
    inputAudioTranscription: true,
    outputAudioTranscription: true,
    startOfSpeechSensitivity: "START_SENSITIVITY_HIGH",
    endOfSpeechSensitivity: "END_SENSITIVITY_LOW",
    prefixPaddingMs: 120,
    silenceDurationMs: 850,
    activityHandling: "NO_INTERRUPTION",
    turnCoverage: "TURN_INCLUDES_ALL_INPUT",
    contextWindowCompression: {
      triggerTokens: 24000,
      slidingWindow: { targetTokens: 12000 },
    },
    sessionResumption: { handle: "resume-token-abc" },
    proactiveAudio: true,
    instruction: "Be concise.",
    projectInstruction: "Follow repository conventions.",
    tools: [{ name: "list_files", description: "List files" }],
    googleSearch: true,
  });

  assert.equal(payload.setup.model, "models/gemini-3.8-live");
  assert.deepEqual(payload.setup.generationConfig.responseModalities, ["AUDIO"]);
  assert.deepEqual(payload.setup.generationConfig.speechConfig, {
    voiceConfig: { prebuiltVoiceConfig: { voiceName: "Kore" } },
    languageCode: "en-US",
  });
  assert.deepEqual(payload.setup.generationConfig.thinkingConfig, {
    thinkingBudget: 1024,
    includeThoughts: true,
  });
  assert.equal(payload.setup.generationConfig.mediaResolution, "MEDIA_RESOLUTION_HIGH");
  assert.equal(payload.setup.generationConfig.enableAffectiveDialog, true);
  assert.equal(payload.setup.generationConfig.temperature, 0.6);

  assert.deepEqual(payload.setup.inputAudioTranscription, {});
  assert.deepEqual(payload.setup.outputAudioTranscription, {});

  assert.deepEqual(payload.setup.realtimeInputConfig, {
    automaticActivityDetection: {
      startOfSpeechSensitivity: "START_SENSITIVITY_HIGH",
      endOfSpeechSensitivity: "END_SENSITIVITY_LOW",
      prefixPaddingMs: 120,
      silenceDurationMs: 850,
    },
    activityHandling: "NO_INTERRUPTION",
    turnCoverage: "TURN_INCLUDES_ALL_INPUT",
  });

  assert.deepEqual(payload.setup.contextWindowCompression, {
    triggerTokens: 24000,
    slidingWindow: { targetTokens: 12000 },
  });
  assert.deepEqual(payload.setup.sessionResumption, { handle: "resume-token-abc" });
  assert.deepEqual(payload.setup.proactivity, { proactiveAudio: true });
  assert.deepEqual(payload.setup.systemInstruction, {
    parts: [{ text: "Be concise." }, { text: "Follow repository conventions." }],
  });
  assert.equal(payload.setup.tools.length, 2);
  assert.deepEqual(payload.setup.tools[0], {
    functionDeclarations: [{ name: "list_files", description: "List files" }],
  });
  assert.deepEqual(payload.setup.tools[1], { googleSearch: {} });
});

test("buildGeminiLiveSetupPayload automatically enables slidingWindow compression and TURN_INCLUDES_ALL_INPUT when enableVideo is true", () => {
  const videoPayload = buildGeminiLiveSetupPayload({
    enableVideo: true,
  });

  assert.deepEqual(videoPayload.setup.contextWindowCompression, {
    slidingWindow: {},
  });
  assert.equal(
    videoPayload.setup.realtimeInputConfig?.turnCoverage,
    "TURN_INCLUDES_ALL_INPUT",
  );
});

test("validateAndFormatVideoFrame and buildActivityControlPayload format spec-compliant BidiGenerateContentRealtimeInput messages", () => {
  const sampleBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
  const sampleBase64 = sampleBytes.toString("base64");

  // 1. Raw base64 input
  const rawResult = validateAndFormatVideoFrame({
    data: sampleBase64,
    mimeType: "image/jpeg",
  });
  assert.equal(rawResult.ok, true);
  assert.equal(rawResult.mimeType, "image/jpeg");
  assert.equal(rawResult.data, sampleBase64);
  assert.equal(rawResult.byteLength, sampleBytes.length);
  assert.deepEqual(JSON.parse(rawResult.wirePayload), {
    realtimeInput: {
      video: {
        mimeType: "image/jpeg",
        data: sampleBase64,
      },
    },
  });

  // 2. Data URL input (strips prefix automatically)
  const dataUrlResult = validateAndFormatVideoFrame({
    data: `data:image/jpeg;base64,${sampleBase64}`,
  });
  assert.equal(dataUrlResult.ok, true);
  assert.equal(dataUrlResult.data, sampleBase64);
  assert.equal(dataUrlResult.byteLength, sampleBytes.length);

  // 3. Refuses oversized frames
  const tooLarge = validateAndFormatVideoFrame({
    data: sampleBase64,
    maxBytes: 4,
  });
  assert.equal(tooLarge.ok, false);
  assert.equal(tooLarge.refused, "frame-too-large");

  // 4. Refuses unsupported mimeType or empty data
  const badMime = validateAndFormatVideoFrame({
    data: sampleBase64,
    mimeType: "video/mp4",
  });
  assert.equal(badMime.ok, false);
  assert.equal(badMime.refused, "invalid-video-frame");

  // 5. Activity start/end payloads for manual VAD control
  const startSignal = buildActivityControlPayload("start");
  assert.equal(startSignal.ok, true);
  assert.deepEqual(JSON.parse(startSignal.wirePayload), {
    realtimeInput: { activityStart: {} },
  });

  const endSignal = buildActivityControlPayload("end");
  assert.equal(endSignal.ok, true);
  assert.deepEqual(JSON.parse(endSignal.wirePayload), {
    realtimeInput: { activityEnd: {} },
  });
});

test("createLiveVideoController manages getUserMedia camera and getDisplayMedia desktop screen share streams", async () => {
  const sampleBase64 = Buffer.from("fake-jpeg-frame-bytes").toString("base64");
  let cameraTrackStopped = false;
  let screenTrackStopped = false;
  let screenEndedHandler = null;
  let lastGetUserMediaConstraints = null;
  let lastGetDisplayMediaConstraints = null;

  const mockMediaDevices = {
    async getUserMedia(constraints) {
      lastGetUserMediaConstraints = constraints;
      return {
        getTracks() {
          return [
            {
              stop() {
                cameraTrackStopped = true;
              },
              getSettings() {
                return { width: 1920, height: 1080 };
              },
            },
          ];
        },
        getVideoTracks() {
          return this.getTracks();
        },
      };
    },
    async getDisplayMedia(constraints) {
      lastGetDisplayMediaConstraints = constraints;
      const track = {
        stop() {
          screenTrackStopped = true;
        },
        addEventListener(event, cb) {
          if (event === "ended") screenEndedHandler = cb;
        },
        getSettings() {
          return { width: 2560, height: 1440 };
        },
      };
      return {
        getTracks() {
          return [track];
        },
        getVideoTracks() {
          return [track];
        },
      };
    },
  };

  const mockDocument = {
    createElement(tag) {
      if (tag === "video") {
        return {
          videoWidth: 1920,
          videoHeight: 1080,
          srcObject: null,
          async play() {},
        };
      }
      if (tag === "canvas") {
        return {
          width: 0,
          height: 0,
          getContext() {
            return { drawImage() {} };
          },
          toDataURL(type) {
            assert.equal(type, "image/jpeg");
            return `data:image/jpeg;base64,${sampleBase64}`;
          },
        };
      }
      return {};
    },
  };

  const frames = [];
  const stateChanges = [];

  const controller = createLiveVideoController({
    mediaDevices: mockMediaDevices,
    documentObj: mockDocument,
    fps: 1,
    maxDimension: 1024,
    quality: 0.8,
    onFrame(frame) {
      frames.push(frame);
    },
    onStateChange(state) {
      stateChanges.push(state);
    },
  });

  // 1. Start Camera (getUserMedia)
  await controller.startCamera({ facingMode: "environment", deviceId: "cam-1" });
  assert.deepEqual(lastGetUserMediaConstraints, {
    video: {
      facingMode: "environment",
      deviceId: { exact: "cam-1" },
      width: { ideal: 1024 },
      height: { ideal: 1024 },
    },
    audio: false,
  });
  assert.equal(controller.getStatus().active, true);
  assert.equal(controller.getStatus().source, "camera");

  // 2. Capture single frame and verify proportional scaling (1920x1080 -> 1024x576)
  const captured = controller.captureSingleFrame();
  assert.equal(captured.source, "camera");
  assert.equal(captured.mimeType, "image/jpeg");
  assert.equal(captured.data, sampleBase64);
  assert.equal(captured.width, 1024);
  assert.equal(captured.height, 576);
  assert.equal(frames.length, 1);
  assert.equal(controller.getStatus().framesSent, 1);

  // 3. Switch to Desktop Screen Share (getDisplayMedia)
  await controller.startScreenShare();
  assert.equal(cameraTrackStopped, true, "previous camera track should stop when switching to screen share");
  assert.deepEqual(lastGetDisplayMediaConstraints, {
    video: {
      width: { ideal: 1024 },
      height: { ideal: 1024 },
      frameRate: { ideal: 1 },
    },
    audio: false,
  });
  assert.equal(controller.getStatus().active, true);
  assert.equal(controller.getStatus().source, "screen");

  const screenFrame = controller.captureSingleFrame();
  assert.equal(screenFrame.source, "screen");
  assert.equal(controller.getStatus().framesSent, 2);

  // 4. Simulate user clicking browser's native "Stop sharing" bar
  assert.equal(typeof screenEndedHandler, "function");
  screenEndedHandler();
  assert.equal(controller.getStatus().active, false);
  assert.equal(controller.getStatus().source, null);
  assert.deepEqual(stateChanges.at(-1), { active: false, source: null });

  // 5. Restart and verify explicit stop() stops all tracks
  screenTrackStopped = false;
  await controller.startScreenShare();
  controller.stop();
  assert.equal(screenTrackStopped, true);
  assert.equal(controller.getStatus().active, false);
  assert.equal(controller.getStatus().source, null);
  assert.deepEqual(stateChanges.at(-1), {
    active: false,
    source: null,
    framesSent: 2,
  });

  // 6. Verify scaleFrameDimensions helper directly
  assert.deepEqual(scaleFrameDimensions(800, 600, 1024), { width: 800, height: 600 });
  assert.deepEqual(scaleFrameDimensions(2048, 1024, 1024), { width: 1024, height: 512 });
});

test("public/live-video-experiment.mjs and public/apps/live-vision-studio.html pass plain-language scan with zero hits", () => {
  const moduleSource = fs.readFileSync(
    new URL("../public/live-video-experiment.mjs", import.meta.url),
    "utf8",
  );
  const studioHtml = fs.readFileSync(
    new URL("../public/apps/live-vision-studio.html", import.meta.url),
    "utf8",
  );

  const moduleHits = scanPlainLanguage(moduleSource);
  assert.deepEqual(
    moduleHits,
    [],
    `Expected 0 plain-language hits in public/live-video-experiment.mjs, got: ${JSON.stringify(moduleHits)}`,
  );

  const studioHits = scanPlainLanguage(studioHtml);
  assert.deepEqual(
    studioHits,
    [],
    `Expected 0 plain-language hits in public/apps/live-vision-studio.html, got: ${JSON.stringify(studioHits)}`,
  );

  // Verify Live Vision Studio controls and WebMCP tools
  assert.match(studioHtml, /^<!DOCTYPE html>/i);
  assert.match(studioHtml, /id="start-camera-btn"/);
  assert.match(studioHtml, /id="start-screen-btn"/);
  assert.match(studioHtml, /id="stop-video-btn"/);
  assert.match(studioHtml, /id="capture-frame-btn"/);
  assert.match(studioHtml, /id="audio-stream-end-btn"/);
  assert.match(studioHtml, /id="live-model-select"/);
  assert.match(studioHtml, /id="thinking-level-select"/);
  assert.match(studioHtml, /id="toggle-include-thoughts"/);
  assert.match(studioHtml, /id="toggle-non-blocking-tools"/);
  assert.match(studioHtml, /id="interaction-status-badge"/);
  assert.match(studioHtml, /id="session-resumption-badge"/);
  assert.match(studioHtml, /id="go-away-badge"/);
  assert.match(studioHtml, /id="live-preview"/);
  assert.match(studioHtml, /id="capture-canvas"/);
  assert.match(studioHtml, /id="frame-counter"/);
  assert.match(studioHtml, /id="live-config-form"/);
  assert.match(studioHtml, /get_live_vision_status/);
  assert.match(studioHtml, /capture_live_frame/);
  assert.match(studioHtml, /configure_live_session/);
});

test("buildGeminiLiveSetupPayload configures thinkingLevel and NON_BLOCKING tools for gemini-3.8-live-extended-thinking and omits thinkingLevel for gemini-3.8-live", () => {
  assert.equal(DEFAULT_GEMINI_LIVE_MODEL, "models/gemini-3.8-live");
  assert.equal(GEMINI_LIVE_EXTENDED_THINKING_MODEL, "models/gemini-3.8-live-extended-thinking");
  assert.deepEqual(VALID_THINKING_LEVELS, ["low", "medium", "high"]);
  assert.equal(isExtendedThinkingModel("models/gemini-3.8-live"), false);
  assert.equal(isExtendedThinkingModel("models/gemini-3.8-live-extended-thinking"), true);
  assert.equal(isExtendedThinkingModel("models/gemini-3.8-thinking"), true);

  // 1. Standard gemini-3.8-live MUST NOT include thinkingLevel even if passed
  const standardPayload = buildGeminiLiveSetupPayload({
    model: "models/gemini-3.8-live",
    thinkingLevel: "high",
    tools: [{ name: "get_weather", description: "Get weather" }],
  });
  assert.equal("thinkingLevel" in standardPayload.setup.generationConfig.thinkingConfig, false);
  assert.equal(
    "behavior" in standardPayload.setup.tools[0].functionDeclarations[0],
    false,
  );

  // 2. Extended thinking model includes thinkingLevel (defaults to 'low', rejects 'minimal') and sets NON_BLOCKING on tools
  const extendedDefault = buildGeminiLiveSetupPayload({
    model: "models/gemini-3.8-live-extended-thinking",
    thinkingLevel: "minimal", // unsupported on 3.8 extended thinking -> falls back to "low"
    includeThoughts: true,
    tools: [{ name: "run_query", description: "Run async query" }],
  });
  assert.equal(
    extendedDefault.setup.generationConfig.thinkingConfig.thinkingLevel,
    "low",
  );
  assert.equal(
    extendedDefault.setup.generationConfig.thinkingConfig.includeThoughts,
    true,
  );
  assert.equal(
    extendedDefault.setup.tools[0].functionDeclarations[0].behavior,
    "NON_BLOCKING",
  );

  const extendedHigh = buildGeminiLiveSetupPayload({
    model: "models/gemini-3.8-live-extended-thinking",
    thinkingLevel: "high",
  });
  assert.equal(
    extendedHigh.setup.generationConfig.thinkingConfig.thinkingLevel,
    "high",
  );

  // 3. Hybrid VAD audioStreamEnd control payload
  const streamEnd = buildActivityControlPayload("audioStreamEnd");
  assert.equal(streamEnd.ok, true);
  assert.equal(streamEnd.kind, "audioStreamEnd");
  assert.deepEqual(JSON.parse(streamEnd.wirePayload), {
    realtimeInput: { audioStreamEnd: true },
  });
});

test("createGeminiProvider handles extended thinking handshake, NON_BLOCKING tools, interactionStatus gating, sessionResumptionUpdate, goAway, generationComplete, and sendAudioStreamEnd", () => {
  const prevKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = "unit-test-gemini-key";
  try {
    const events = [];
    const sentFrames = [];
    let onTransportEvent = null;

    const transport = {
      connect(_url, handlers) {
        onTransportEvent = handlers.onEvent;
        return true;
      },
      send(kind, data) {
        sentFrames.push({ kind, payload: JSON.parse(data) });
        return true;
      },
      close() {},
    };

    const provider = createGeminiProvider({
      model: "models/gemini-3.8-live-extended-thinking",
      thinkingLevel: "medium",
      includeThoughts: true,
      contextWindowCompression: { triggerTokens: 20000, slidingWindow: { targetTokens: 10000 } },
      sessionResumption: { handle: "initial-handle-1" },
      tools: [{ name: "fetch_data", description: "Async tool" }],
      emit: (e) => events.push(e),
      log: () => {},
      transport,
    });

    onTransportEvent({ kind: "open" });
    assert.equal(sentFrames.length, 1);
    assert.equal(sentFrames[0].kind, "handshake");
    const setup = sentFrames[0].payload.setup;
    assert.equal(setup.model, "models/gemini-3.8-live-extended-thinking");
    assert.equal(setup.generationConfig.thinkingConfig.thinkingLevel, "medium");
    assert.equal(setup.generationConfig.thinkingConfig.includeThoughts, true);
    assert.equal(setup.tools[0].functionDeclarations[0].behavior, "NON_BLOCKING");
    assert.deepEqual(setup.contextWindowCompression, {
      triggerTokens: 20000,
      slidingWindow: { targetTokens: 10000 },
    });
    assert.deepEqual(setup.sessionResumption, { handle: "initial-handle-1" });

    // Complete handshake
    onTransportEvent({ kind: "message", data: JSON.stringify({ setupComplete: {} }) });
    assert.ok(events.some((e) => e.type === "ready"));

    // Hybrid VAD audioStreamEnd
    provider.sendAudioStreamEnd();
    assert.deepEqual(sentFrames.at(-1), {
      kind: "control",
      payload: { realtimeInput: { audioStreamEnd: true } },
    });

    // SessionResumptionUpdate + GoAway
    onTransportEvent({
      kind: "message",
      data: JSON.stringify({
        sessionResumptionUpdate: { newHandle: "resumed-handle-2", resumable: true },
      }),
    });
    assert.ok(
      events.some(
        (e) =>
          e.type === "session-resumption" &&
          e.handle === "resumed-handle-2" &&
          e.resumable === true,
      ),
    );

    onTransportEvent({
      kind: "message",
      data: JSON.stringify({
        goAway: { timeLeft: "45s" },
      }),
    });
    assert.ok(
      events.some(
        (e) =>
          e.type === "go-away" &&
          e.timeLeft === "45s" &&
          e.resumptionHandle === "resumed-handle-2",
      ),
    );

    // Non-blocking tool call with interactionStatus IN_PROGRESS -> IDLE gating queued text
    onTransportEvent({
      kind: "message",
      data: JSON.stringify({
        interactionStatus: "IN_PROGRESS",
        serverContent: {
          modelTurn: {
            parts: [{ inlineData: { data: Buffer.from([1, 2]).toString("base64") } }],
          },
        },
      }),
    });
    assert.ok(
      events.some((e) => e.type === "interaction-status" && e.status === "IN_PROGRESS"),
    );

    // Queue user text while model is speaking & interactionStatus is IN_PROGRESS
    provider.sendText("Follow-up after async tool finishes");
    const countBeforeTurnComplete = sentFrames.length;

    // Spoken turn finishes (generationComplete + turnComplete), but interactionStatus is still IN_PROGRESS
    onTransportEvent({
      kind: "message",
      data: JSON.stringify({
        serverContent: {
          generationComplete: true,
          turnComplete: true,
        },
      }),
    });
    assert.ok(events.some((e) => e.type === "generation-complete"));
    assert.equal(
      sentFrames.length,
      countBeforeTurnComplete,
      "Queued text must remain held while interactionStatus is IN_PROGRESS",
    );

    // Once interactionStatus becomes IDLE, queued text flushes automatically
    onTransportEvent({
      kind: "message",
      data: JSON.stringify({
        interactionStatus: "IDLE",
      }),
    });
    assert.ok(events.some((e) => e.type === "interaction-status" && e.status === "IDLE"));
    assert.equal(sentFrames.length, countBeforeTurnComplete + 1);
    assert.deepEqual(sentFrames.at(-1).payload, {
      clientContent: {
        turns: [{ role: "user", parts: [{ text: "Follow-up after async tool finishes" }] }],
        turnComplete: true,
      },
    });
  } finally {
    if (prevKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = prevKey;
  }
});

