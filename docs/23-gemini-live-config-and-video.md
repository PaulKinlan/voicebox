# Gemini Live API Configuration Matrix & Multimodal Video Streaming

This document analyzes the `BidiGenerateContent` WebSocket protocol defined at `https://ai.google.dev/api/live`, compares it against the current handshake in `lib/live-providers/gemini.mjs`, and documents the configuration builder (`lib/live-video-stream.mjs`), browser capture controller (`public/live-video-experiment.mjs`), and interactive studio (`public/apps/live-vision-studio.html`) for streaming live Camera (`getUserMedia`) and Desktop Screen Share (`getDisplayMedia`) video alongside 16 kHz voice audio.

---

## 1. Complete Matrix of `BidiGenerateContentSetup` Options

The Gemini Live session configuration is sent once as the initial message (`{ "setup": BidiGenerateContentSetup }`) after opening the WebSocket connection to:

```text
wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent
```

The server acknowledges readiness with `{ "setupComplete": {} }` before realtime audio, video, or text frames begin flowing.

### 1.1 `setup.generationConfig` Fields

| Field | Wire Path | Supported Values / Type | Current `lib/live-providers/gemini.mjs` | Engineering Impact |
|---|---|---|---|---|
| `responseModalities` | `generationConfig.responseModalities` | `["AUDIO"]` or `["TEXT"]` | Hardcoded `["AUDIO"]` | Selects whether the model replies with 24 kHz PCM audio (`audio/pcm;rate=24000`) or text parts. Only one modality may be requested per session. |
| `speechConfig` | `generationConfig.speechConfig` | `{ voiceConfig: { prebuiltVoiceConfig: { voiceName } }, languageCode }` | Sets `voiceName` when `voice` is passed; omits `languageCode` | Controls the synthesized speaker voice (`Puck`, `Kore`, `Charon`, `Fenrir`, `Aoede`) and BCP-47 output language alignment. |
| `thinkingConfig` | `generationConfig.thinkingConfig` | `{ thinkingBudget: number, includeThoughts?: boolean }` | `-1` (dynamic) on `models/gemini-3.8-live`; `2048` on `models/gemini-3.8-thinking` | Controls internal reasoning before speech starts. Setting `0` disables thinking for minimum first-audio latency; `-1` scales dynamically with prompt complexity. |
| `mediaResolution` | `generationConfig.mediaResolution` | `"MEDIA_RESOLUTION_LOW"`, `"MEDIA_RESOLUTION_MEDIUM"`, `"MEDIA_RESOLUTION_HIGH"` | Not set | **Critical for Live Video**: Governs the visual token budget per incoming JPEG frame. Low resolution minimizes token burn during continuous webcam presence; High resolution preserves fine typography when sharing desktop code editors or terminal windows. |
| `enableAffectiveDialog` | `generationConfig.enableAffectiveDialog` | `boolean` | Not set | Adapts spoken response prosody, pacing, and tone to match the user's vocal expression. |
| `temperature`, `topP`, `topK`, `maxOutputTokens` | `generationConfig.*` | `number` / `integer` | Uses model defaults | Standard sampling controls. Note that `responseLogprobs`, `responseMimeType`, `responseSchema`, `responseJsonSchema`, and `stopSequence` are explicitly unsupported in `BidiGenerateContentSetup`. |

### 1.2 Top-Level `setup` Fields (Peers of `generationConfig`)

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
| `tools` | `setup.tools` | `[{ functionDeclarations?: [...], googleSearch?: {}, codeExecution?: {} }]` | Registers callable tools alongside grounded search and sandboxed code execution. |

---

## 2. Live Video Streaming Protocol (`BidiGenerateContentRealtimeInput`)

Once `setupComplete` arrives, the client streams audio and video concurrently over the same WebSocket using `BidiGenerateContentRealtimeInput` messages. Note that `realtimeInput.mediaChunks` is deprecated in the `https://ai.google.dev/api/live` specification in favor of the dedicated `audio`, `video`, and `text` fields:

### 2.1 Continuous Audio + Video Wire Format

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

2. **Camera (`getUserMedia`) & Desktop Screen (`getDisplayMedia`) Video Frames**:
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

3. **Manual Push-to-Talk Activity Signals (when `automaticActivityDetection.disabled === true`)**:
   ```json
   { "realtimeInput": { "activityStart": {} } }
   { "realtimeInput": { "activityEnd": {} } }
   ```

### 2.2 Frame Rate, Scaling, and Token Economics

 Gemini Live processes video as a sequence of discrete image frames (typically `0.5 fps` to `2 fps`):
- **Downscaling**: `public/live-video-experiment.mjs` draws each `<video>` frame onto an offscreen 2D `<canvas>` scaled proportionally so `Math.max(width, height) <= maxDimension` (default `1024` px) before encoding to `"image/jpeg"` (`quality = 0.78`).
- **Validation**: `validateAndFormatVideoFrame` in `lib/live-video-stream.mjs` strips optional `data:image/jpeg;base64,` prefixes, verifies the MIME type (`image/jpeg`, `image/png`, or `image/webp`), checks decoded byte size against `maxBytes` (`1 MiB` default), and serializes the `{ realtimeInput: { video: { mimeType, data } } }` wire frame.
- **Desktop Stop-Sharing Lifecycle**: When capturing a window or screen via `navigator.mediaDevices.getDisplayMedia()`, the user can stop sharing at any time via the browser's native sharing bar. `createLiveVideoController` attaches an `ended` listener to the primary video track so the sampling timer and state reset immediately when native sharing stops.

---

## 3. Architecture of the Live Vision Experiment Modules

- `lib/live-video-stream.mjs` — Pure configuration catalogue (`GEMINI_LIVE_CONFIG_CATALOGUE`), `BidiGenerateContentSetup` payload builder (`buildGeminiLiveSetupPayload`), video frame validator (`validateAndFormatVideoFrame`), and manual VAD signal builder (`buildActivityControlPayload`).
- `public/live-video-experiment.mjs` — Browser controller (`createLiveVideoController`) managing `getUserMedia` camera capture, `getDisplayMedia` desktop screen sharing, proportional canvas scaling, JPEG base64 extraction, and track lifecycle cleanup.
- `public/apps/live-vision-studio.html` — Interactive Mini-App (**Live Vision & Config Studio**) providing live camera and desktop preview, real-time Gemini Live configuration controls, handshake preview, and WebMCP tools (`get_live_vision_status`, `capture_live_frame`, `configure_live_session`).
- `tests/gemini-live-video-config.test.mjs` — Fast unit test suite verifying setup payload generation, frame validation, camera/screen controller lifecycle, and plain-language compliance.
