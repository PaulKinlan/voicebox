# Gemini Live API Configuration Matrix & Multimodal Video Streaming

This document analyzes the `BidiGenerateContent` WebSocket protocol defined at `https://ai.google.dev/api/live`, compares `models/gemini-3.8-live` and `models/gemini-3.8-live-extended-thinking`, and documents the live provider (`lib/live-providers/gemini.mjs`), session dispatcher (`lib/live-session.mjs`), configuration builder (`lib/live-video-stream.mjs`), browser capture controller (`public/live-video-experiment.mjs`), and interactive studio (`public/apps/live-vision-studio.html`) for streaming live Camera (`getUserMedia`) and Desktop Screen Share (`getDisplayMedia`) video alongside 16 kHz voice audio.

---

## 1. Gemini 3.8 Live Model Comparison (`gemini-3.8-live` vs `gemini-3.8-live-extended-thinking`)

| Capability / Field | `models/gemini-3.8-live` | `models/gemini-3.8-live-extended-thinking` | `gemini-3.1-flash-live-preview` |
|---|---|---|---|
| **Primary Workload** | Low-latency native audio + video conversation | Complex multi-step reasoning, asynchronous tool orchestration, and deep visual inspection | Preview flash live model |
| **`thinkingConfig.thinkingLevel`** | **Omitted** (uses `thinkingBudget` only; `thinkingLevel` must not be sent) | Supported: `"low"` (default), `"medium"`, `"high"` (`"minimal"` is unsupported; `thinkingBudget` must be omitted) | `"minimal"`, `"low"`, `"medium"`, `"high"` |
| **`thinkingConfig.thinkingBudget`** | Supported (`-1` dynamic default, `0` disabled, or positive integer; mutually exclusive with `thinkingLevel`) | **Omitted** (setting both `thinkingBudget` and `thinkingLevel` is rejected by the Live API with `"You can only set only one of thinking budget and thinking level."`) | Mutually exclusive with `thinkingLevel` |
| **`thinkingConfig.includeThoughts`** | Optional `boolean` | Optional `boolean` (streams thought summaries in `modelTurn.parts` with `thought: true`) | Optional `boolean` |
| **Function Declaration `behavior`** | Standard or `"NON_BLOCKING"` when `nonBlockingTools: true` | Defaults all `functionDeclarations` to `behavior: "NON_BLOCKING"` | Optional `"NON_BLOCKING"` |
| **`interactionStatus` Lifecycle** | Emits `IN_PROGRESS` / `IDLE` during async tool execution | Coordinates multi-step non-blocking tool loops (`IN_PROGRESS` while background tools run; `IDLE` when all pending tool work completes) | Standard `turnComplete` |
| **Hybrid VAD (`audioStreamEnd`)** | Supported (`{ realtimeInput: { audioStreamEnd: true } }`) | Supported (`{ realtimeInput: { audioStreamEnd: true } }`) | Supported |

---

## 2. Complete Matrix of `BidiGenerateContentSetup` Options

The Gemini Live session configuration is sent once as the initial message (`{ "setup": BidiGenerateContentSetup }`) after opening the WebSocket connection to:

```text
wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent
```

The server acknowledges readiness with `{ "setupComplete": {} }` before realtime audio, video, or text frames begin flowing.

### 2.1 `setup.generationConfig` Fields

| Field | Wire Path | Supported Values / Type | `lib/live-providers/gemini.mjs` & `lib/live-video-stream.mjs` | Engineering Impact |
|---|---|---|---|---|
| `responseModalities` | `generationConfig.responseModalities` | `["AUDIO"]` or `["TEXT"]` | Defaults to `["AUDIO"]` | Selects whether the model replies with 24 kHz PCM audio (`audio/pcm;rate=24000`) or text parts. Only one modality may be requested per session. |
| `speechConfig` | `generationConfig.speechConfig` | `{ voiceConfig: { prebuiltVoiceConfig: { voiceName } }, languageCode }` | Sets `voiceName` when `voice` is passed and optional `languageCode` | Controls the synthesized speaker voice (`Puck`, `Kore`, `Charon`, `Fenrir`, `Aoede`) and BCP-47 output language alignment. |
| `thinkingConfig` | `generationConfig.thinkingConfig` | `{ thinkingBudget?: number, thinkingLevel?: "low" \| "medium" \| "high", includeThoughts?: boolean }` | Mutually exclusive: sets **only** `thinkingLevel` (`"low"` default) on `models/gemini-3.8-live-extended-thinking` and **only** `thinkingBudget` (`-1` default) on `models/gemini-3.8-live` | Controls internal reasoning depth before speech starts and optionally streams thought summaries (`includeThoughts: true`). Setting both `thinkingBudget` and `thinkingLevel` is rejected by the Live API. |
| `mediaResolution` | `generationConfig.mediaResolution` | `"MEDIA_RESOLUTION_LOW"`, `"MEDIA_RESOLUTION_MEDIUM"`, `"MEDIA_RESOLUTION_HIGH"` | Validated against `VALID_MEDIA_RESOLUTIONS` | **Critical for Live Video**: Governs the visual token budget per incoming JPEG frame. Low resolution minimizes token burn during continuous webcam presence; High resolution preserves fine typography when sharing desktop code editors or terminal windows. |
| `enableAffectiveDialog` | `generationConfig.enableAffectiveDialog` | `boolean` | Configurable via `affectiveDialog` | Adapts spoken response prosody, pacing, and tone to match the user's vocal expression. |
| `temperature`, `topP`, `topK`, `maxOutputTokens` | `generationConfig.*` | `number` / `integer` | Uses model defaults unless specified | Standard sampling controls. Note that `responseLogprobs`, `responseMimeType`, `responseSchema`, `responseJsonSchema`, and `stopSequence` are explicitly unsupported in `BidiGenerateContentSetup`. |

### 2.2 Top-Level `setup` Fields (Peers of `generationConfig`)

A key protocol rule documented in `lib/live-providers/gemini.mjs` is that transcription, VAD, compression, and resumption fields live directly on `setup` — placing them inside `generationConfig` causes an immediate WebSocket `1007` schema rejection.

| Field | Wire Path | Supported Options | Purpose in Voice + Video Sessions |
|---|---|---|---|
| `inputAudioTranscription` | `setup.inputAudioTranscription` | `{ languageCodes?: string[], customVocabulary?: string[], wordTimestamp?: boolean, diarization?: boolean, mode?: "VERBATIM" \| "SMART" }` | Enables live server-side speech-to-text for user microphone audio (`serverContent.inputTranscription` and `serverContent.interimInputTranscription`). |
| `outputAudioTranscription` | `setup.outputAudioTranscription` | `{ languageCodes?: string[], mode?: "VERBATIM" \| "SMART" }` | Enables live text transcripts of the model's spoken audio (`serverContent.outputTranscription`), synchronized with audio playback. |
| `realtimeInputConfig.automaticActivityDetection` | `setup.realtimeInputConfig.automaticActivityDetection` | `{ disabled?: boolean, startOfSpeechSensitivity?: "START_SENSITIVITY_HIGH" \| "START_SENSITIVITY_LOW", endOfSpeechSensitivity?: "END_SENSITIVITY_HIGH" \| "END_SENSITIVITY_LOW", prefixPaddingMs?: number, silenceDurationMs?: number }` | Tunes server-side voice activity detection (VAD). Increasing `silenceDurationMs` (for example from `500` ms to `1000` ms) or selecting `END_SENSITIVITY_LOW` prevents premature cutoffs when a user pauses while demonstrating something on screen. Setting `disabled: true` switches to client push-to-talk via `activityStart` and `activityEnd`. |
| `realtimeInputConfig.activityHandling` | `setup.realtimeInputConfig.activityHandling` | `"START_OF_ACTIVITY_INTERRUPTS"` (default) or `"NO_INTERRUPTION"` | Controls barge-in behavior. `"START_OF_ACTIVITY_INTERRUPTS"` immediately halts model generation and emits `serverContent.interrupted: true` when user speech begins; `"NO_INTERRUPTION"` lets the model finish speaking despite background noise. |
| `realtimeInputConfig.turnCoverage` | `setup.realtimeInputConfig.turnCoverage` | `"TURN_INCLUDES_ONLY_ACTIVITY"`, `"TURN_INCLUDES_ALL_INPUT"`, `"TURN_INCLUDES_AUDIO_ACTIVITY_AND_ALL_VIDEO"` | **Essential for Live Video**: When set to `"TURN_INCLUDES_ONLY_ACTIVITY"`, video frames sent while the user is silent are discarded before the turn begins. Setting `"TURN_INCLUDES_ALL_INPUT"` (or `"TURN_INCLUDES_AUDIO_ACTIVITY_AND_ALL_VIDEO"`) ensures the model sees camera and desktop frames captured prior to the user speaking. |
| `contextWindowCompression` | `setup.contextWindowCompression` | `{ triggerTokens?: number, slidingWindow: { targetTokens?: number } }` | **Essential for Video Sessions > 2 Minutes**: Continuous audio and video streams rapidly fill the context window (capping uncompressed video sessions at roughly 2 minutes). Enabling `slidingWindow: {}` automatically prunes the oldest user turns while preserving `systemInstruction` at the head of context. |
| `sessionResumption` | `setup.sessionResumption` | `{ handle?: string }` | Requests `sessionResumptionUpdate` frames (`{ newHandle, resumable }`) from the server so the client can transparently reconnect across network drops or `goAway` notices without losing conversation memory. |
| `proactivity` | `setup.proactivity` | `{ proactiveAudio?: boolean }` | When `proactiveAudio: true`, the model can choose not to speak when incoming speech or background chatter is not directed at it. |
| `tools` | `setup.tools` | `[{ functionDeclarations?: [...], googleSearch?: {}, codeExecution?: {} }]` | Registers callable tools alongside grounded search and sandboxed code execution. When `models/gemini-3.8-live-extended-thinking` or `nonBlockingTools: true` is active, each function declaration includes `behavior: "NON_BLOCKING"`. |

---

## 3. Non-Blocking Function Calling, `interactionStatus`, & Session Lifecycle Events

### 3.1 Non-Blocking Tool Declarations & `interactionStatus` (`IN_PROGRESS` vs `IDLE`)
- In `models/gemini-3.8-live-extended-thinking` (or when `nonBlockingTools: true` is passed), `lib/live-providers/gemini.mjs` and `lib/live-video-stream.mjs` attach `behavior: "NON_BLOCKING"` to each declaration inside `setup.tools[0].functionDeclarations`.
- While asynchronous tools are running in the background, the server emits `interactionStatus: "IN_PROGRESS"` (either at the top level or inside `serverContent`).
- Even if a spoken sub-turn finishes (`serverContent.turnComplete: true`), the overall multi-step interaction remains active while `interactionStatus === "IN_PROGRESS"`. `lib/live-providers/gemini.mjs` tracks this state, emits `{ type: "interaction-status", status: "IN_PROGRESS" | "IDLE" }`, and holds queued client text until `interactionStatus` transitions back to `"IDLE"` (or `turnComplete` arrives when not `IN_PROGRESS`).

### 3.2 `generationComplete` vs `turnComplete`
- `serverContent.generationComplete: true` signals that the model has finished generating its current response stream (emitting `{ type: "generation-complete" }`), whereas `serverContent.turnComplete: true` marks the completion of the model's turn.

### 3.3 Session Resumption & `goAway` Notices
- When `setup.sessionResumption` is enabled, the server periodically sends `sessionResumptionUpdate: { newHandle, resumable }`. `lib/live-providers/gemini.mjs` caches the latest `newHandle` when `resumable !== false` and emits `{ type: "session-resumption", resumable, handle }`.
- Before terminating a long-lived WebSocket connection, the server sends `goAway: { timeLeft }`. `lib/live-providers/gemini.mjs` emits `{ type: "go-away", timeLeft, resumptionHandle }` with the latest cached resumption handle so the session can reconnect seamlessly via `setup.sessionResumption: { handle }`.

---

## 4. Live Video Streaming & Hybrid VAD (`BidiGenerateContentRealtimeInput`)

Once `setupComplete` arrives, the client streams audio and video concurrently over the same WebSocket using `BidiGenerateContentRealtimeInput` messages. Note that `realtimeInput.mediaChunks` is deprecated in the `https://ai.google.dev/api/live` specification in favor of the dedicated `audio`, `video`, and `text` fields:

### 4.1 Continuous Audio, Video, and Hybrid VAD Wire Format

1. **Microphone Audio Stream (16 kHz PCM16)**:
   ```json
   {
     "realtimeInput": {
       "audio": {
         "mimeType": "audio/pcm;rate=16000",
         "data": "<base64-encoded-int16-pcm>"
       }
     }
   }
   ```

2. **Hybrid VAD Audio Stream End (`audioStreamEnd`)**:
   When automatic VAD is enabled (`automaticActivityDetection.disabled: false`) and the user mutes or pauses their microphone stream for more than a second, sending `audioStreamEnd: true` via `session.sendAudioStreamEnd()` or `buildActivityControlPayload("audioStreamEnd")` flushes cached server-side audio immediately without waiting for `silenceDurationMs`:
   ```json
   { "realtimeInput": { "audioStreamEnd": true } }
   ```

3. **Camera (`getUserMedia`) & Desktop Screen (`getDisplayMedia`) Video Frames**:
   ```json
   {
     "realtimeInput": {
       "video": {
         "mimeType": "image/jpeg",
         "data": "<base64-encoded-jpeg-bytes>"
       }
     }
   }
   ```

4. **Manual Push-to-Talk Activity Signals (when `automaticActivityDetection.disabled === true`)**:
   ```json
   { "realtimeInput": { "activityStart": {} } }
   { "realtimeInput": { "activityEnd": {} } }
   ```

### 4.2 Frame Rate, Scaling, and Token Economics

Gemini Live processes video as a sequence of discrete image frames (typically `0.5 fps` to `2 fps`):
- **Downscaling**: `public/live-video-experiment.mjs` draws each `<video>` frame onto an offscreen 2D `<canvas>` scaled proportionally so `Math.max(width, height) <= maxDimension` (default `1024` px) before encoding to `"image/jpeg"` (`quality = 0.78`).
- **Validation**: `validateAndFormatVideoFrame` in `lib/live-video-stream.mjs` strips optional `data:image/jpeg;base64,` prefixes, verifies the MIME type (`image/jpeg`, `image/png`, or `image/webp`), checks decoded byte size against `maxBytes` (`1 MiB` default), and serializes the `{ realtimeInput: { video: { mimeType, data } } }` wire frame.
- **Desktop Stop-Sharing Lifecycle**: When capturing a window or screen via `navigator.mediaDevices.getDisplayMedia()`, the user can stop sharing at any time via the browser's native sharing bar. `createLiveVideoController` attaches an `ended` listener to the primary video track so the sampling timer and state reset immediately when native sharing stops.

---

## 5. Architecture of the Live Vision & Extended Thinking Modules

- `lib/live-providers/gemini.mjs` — Gemini Live WebSocket adapter supporting `models/gemini-3.8-live` and `models/gemini-3.8-live-extended-thinking`, `thinkingLevel`, `behavior: "NON_BLOCKING"` tool declarations, `interactionStatus` (`IN_PROGRESS` / `IDLE`) turn gating, `contextWindowCompression`, `sessionResumptionUpdate`, `goAway`, `generationComplete`, and `sendAudioStreamEnd()`.
- `lib/live-session.mjs` — Provider-neutral live session dispatcher forwarding `thinkingLevel`, `includeThoughts`, `nonBlockingTools`, `contextWindowCompression`, `sessionResumption`, and `sendAudioStreamEnd()`, plus dispatching `interaction-status`, `generation-complete`, `session-resumption`, and `go-away` events.
- `lib/live-video-stream.mjs` — Pure configuration catalogue (`GEMINI_LIVE_CONFIG_CATALOGUE`), `BidiGenerateContentSetup` payload builder (`buildGeminiLiveSetupPayload`), video frame validator (`validateAndFormatVideoFrame`), and VAD/Hybrid VAD signal builder (`buildActivityControlPayload`).
- `public/live-video-experiment.mjs` — Browser controller (`createLiveVideoController`) managing `getUserMedia` camera capture, `getDisplayMedia` desktop screen sharing, proportional canvas scaling, JPEG base64 extraction, and track lifecycle cleanup.
- `public/apps/live-vision-studio.html` — Interactive Mini-App (**Live Vision & Config Studio**) providing live camera and desktop preview, model & `thinkingLevel` selector, `includeThoughts` and `NON_BLOCKING` toggles, Hybrid VAD `audioStreamEnd` trigger, live `interactionStatus` / `sessionResumption` / `goAway` badges, and WebMCP tools (`get_live_vision_status`, `capture_live_frame`, `configure_live_session`).
- `tests/gemini-live-video-config.test.mjs` and `tests/live-provider-seam.test.mjs` — Fast unit test suites verifying setup payload generation, extended thinking configuration, non-blocking tool declarations, `interactionStatus` gating, session resumption, `goAway`, `audioStreamEnd`, and plain-language compliance.
