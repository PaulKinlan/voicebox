# Pluggable live models

Voicebox separates the agent loop from the model, in the same spirit as Pi's loop: the host owns tools, policy and lifecycle; a provider translates messages. Switching Gemini to OpenAI changes neither the UI nor the tool catalogue. The live-model seam is separate from coding-agent delegation (Pi/Claude ACP) and from the text-turn resolver.

## Four layers, one upstream boundary

![Live-model layers, rate negotiation and bounded tool loop](assets/pluggable-live-models.svg)

```text
1 Client UI / microphone / playback
                | PCM16 + text + state
2 Wire protocol /live (server: entitlement, rate announcement, frame bounds)
                |
3 Live harness seam (ready gate, lifecycle, callbacks)
                | normalized audio / text / calls / results
4 Live providers: Gemini 3.8 | OpenAI Realtime | Claude placeholder
                | vendor-specific frames via injected transport
   Upstream vendor bidirectional sockets (Gemini / OpenAI only)

   Tool calls leave layer 3 for the host executor, NOT for the UI or provider.
```

- **Client:** `public/live-voice.js` and `public/audio-client.js` capture/play audio. They never interpret vendor frames or receive vendor keys.
- **Wire:** `server.mjs` owns `/live` entitlement, binary-frame validation and the shared executor. It supplies the catalogue and answers tool calls.
- **Harness:** `lib/live-harness.mjs` is the public library entry point; `lib/live-session.mjs` owns registration, readiness, terminal state and the transport facade. Importing the library starts no server or UI.
- **Providers:** `lib/live-providers/gemini.mjs` and `lib/live-providers/openai.mjs` own vendor setup, events and response encoding. `lib/live-providers/claude.mjs` is registered but **does not implement live streaming**; Claude coding-task delegation is a different capability.

The current library uses host runtime capabilities (`process.env`, `Buffer`, and a WebSocket implementation supporting connection headers for OpenAI). It is UI-independent, not a claim of zero-server browser portability. API keys remain in the host. The facade mediates trusted in-process providers; it is not a sandbox against malicious provider code.

## Library and provider contract

```js
import { createLiveSession, inputRateRequiredBy } from "./lib/live-harness.mjs";

const provider = "openai"; // OPENAI_API_KEY in the host environment
const inputRate = inputRateRequiredBy(provider);
const session = createLiveSession({
  provider,
  voice: "coral",
  onState(state, detail) { console.log(state, detail); },
  onText(text) { console.log(text); },
  onAudioOut(pcm, mime) { /* send bytes to the host's playback sink */ },
});
// After onState("ready"), send PCM16 base64 captured at inputRate:
// session.sendAudio(pcm16Base64, inputRate);
// session.sendText("Hello"); session.interrupt(); session.close();
```

For tools, pass `tools: functionDeclarations()` and `systemInstruction: liveSystemInstruction()` from `lib/commands.mjs`. Supply `onToolCall(calls)` to validate each call with `commandToAction`, execute it through your environment's bounded executor, and always answer with `session.sendToolResponse([{ id, name, response: { result } }])`, including refusals. The library never grants filesystem or command authority itself.

Register a new adapter with `registerLiveProvider(name, factory, { inputRate })`. The factory receives `{ emit, transport, model, tools, voice, instruction, projectInstruction, systemInstruction, log, debug }`. Rates must be positive integers; an undeclared rate is refused by `inputRateRequiredBy`. Re-registering does not retain an old rate. Existing text-only/test providers may omit it.

| Surface | Contract |
|---|---|
| Transport `connect(url, options)` | Provider factory dials through the injected host transport; options are `{ headers?, onEvent }`. Returns a boolean, never a socket. Events are plain data: open, message, error, close. |
| Transport `send(kind, payload)` | Handshake, audio, text or control; returns acceptance by the transport, not acknowledgement by the model. Audio is refused before ready. |
| Session/provider `sendAudio(pcm16, rate)` | Base64 PCM16. Session checks explicit rate against the registered requirement before forwarding unchanged. Omitted rate uses the registered rate for existing callers. |
| `sendText(text)` | User text; session gates it on readiness. |
| `sendToolResponse(responses)` | Correlated `{ id, name, response }` array; returns false if the answer cannot be sent. |
| `interrupt()` | OpenAI cancels a response; Gemini uses upstream barge-in and logs that no client command is sent. |
| `close()` | Idempotent session shutdown; exactly one terminal notification. |

`connect` intentionally belongs to the injected **transport**, not a second public session lifecycle: a provider factory connects, and optional `start()` runs after construction. This preserves the readiness gate and keeps raw vendor sockets inaccessible to clients. `updateProjectInstruction(text)` is an optional capability with a named refusal when unsupported.

Providers emit:

| Event | Data / host callback |
|---|---|
| `transport-open` | `onState("transport-open")`; not ready yet |
| `ready` | Opens the gate; `onState("ready")` |
| `output-audio` | `{ pcm16, rate }` → `onAudioOut(Buffer, "audio/pcm;rate=...")` |
| `output-text` | `{ text, kind }` → `onText(text, kind)` |
| `tool-call` | `{ calls: [{ id, name, args }] }` → `onToolCall(calls)` only when ready |
| `closed` | `{ code, reason }` → terminal `onState("upstream-closed", detail)` |
| `error` | `{ message }` → non-terminal `onState("error", detail)` |
| `interrupt`, `turn-complete` | Playback/turn state notifications |

## Model selection and reasoning depth

Select provider, model and voice in Settings; changes apply to the next session. `core/agent-settings.ts` owns the offered lists and rejects models/voices from the wrong provider.

| Provider | Offered models | Capture / playback |
|---|---|---|
| Gemini | `models/gemini-3.8-live` (default), `models/gemini-3.8-thinking` | 16 kHz / 24 kHz |
| OpenAI | `gpt-realtime` (default), `gpt-4o-realtime-preview`, `gpt-4o-mini-realtime-preview` | 24 kHz / 24 kHz |

Thinking sends `generationConfig.thinkingConfig: { thinkingBudget: 2048 }`; Live and Flash retain the dynamic budget (`-1`). The explicit Thinking model is not silently substituted. The existing Live tool-turn retry on upstream close 1011 now targets **3.8 Flash**, once, replaying pending text; no Gemini 2 model is offered or used by this live fallback.

OpenAI voices: alloy, verse, shimmer, ash, ballad, coral, echo, sage. The GA setup puts voice under `session.audio.output.voice`, with PCM formats at 24000 Hz for input and output. Readiness requires `session.updated`, not just socket open. Preview event aliases for audio/transcripts are normalized; all listed models use the GA session setup.

These are configured identifiers, not a guarantee of vendor account entitlement or model availability. Deterministic tests validate frames and settings; a credentialed session is still needed to verify upstream acceptance and audible quality, especially the requested Gemini 3.8 Thinking/Flash endpoints.

## Audio streaming and rate negotiation

```text
Provider rate declaration (Gemini 16000 / OpenAI 24000)
       -> /live first frame: {type: "rate", inputRate, provider}
       -> browser AudioContext({sampleRate: inputRate}) -> PCM16 worklet
       -> binary /live frame -> size/even-byte validation
       -> session.sendAudio(base64, inputRate) -> ready + rate gates
       -> provider frame -> vendor

Vendor PCM16 + rate -> output-audio -> onAudioOut -> /live binary -> playback
                         Gemini/OpenAI output: 24000 Hz
```

The browser resamples through AudioContext; the host does not invent a resampler. Early audio is counted and dropped, not queued. The library rejects a mismatched rate rather than mislabelling bytes. It cannot infer the true sampling rate from PCM bytes: the caller must capture at the announced rate. The current `/live` binary playback path assumes the two implemented vendors' 24 kHz output; the library callback carries MIME/rate for other hosts.

## Bounded tool execution loop

```text
Model functionCall / response.function_call_arguments.done
  -> normalized {id, name, args}
  -> ready gate -> Voicebox tool catalogue (commandToAction)
  -> shared host executor, declared root + capability policy
       +-- WASM shelf: digest pinned, wall-clock / memory / output bounds
       +-- System commands: validated action, browser capability checks
       +-- Extensions / Mini-Apps: admission + scoped execution
  -> {result: success OR named refusal}, same call id
  -> sendToolResponse -> vendor encoding -> model continues speaking
```

Root-scoped CLI execution in `lib/system-tools.mjs` uses `lib/git-env.mjs` to remove inherited Git hook plumbing before spawning commands, including non-Git commands that may invoke Git themselves. Explicit non-Git environment settings are preserved; this prevents a hook's repository from overriding the declared working directory, not an OS sandbox guarantee.

The provider cannot run a tool directly. The server's executor catches execution failures and returns a result for each call, preserving root containment and audit semantics from the text path. Bounds belong to the execution backend (see [WASM tools](20-webassembly-tools.md) and [extension admission](07-extension-admission.md)); the session is not itself a general tool timeout scheduler.

OpenAI emits `conversation.item.create` with `function_call_output` and the original `call_id`. It resumes with exactly one `response.create` only after both `response.done` and all pending tool outputs, whether execution or generation finishes first. Malformed JSON arguments produce a correlated refusal instead of executing an action.

## Verification and publishing

`tests/live-harness.test.mjs` exercises the public entry point, rate registration/refusal, Gemini thinking/fallback, and the OpenAI catalogue roundtrip through a recording socket. `tests/openai-provider.test.mjs` verifies GA configuration, malformed calls, and both tool-completion orders. These tests make no paid vendor calls. The existing OpenAI browser test drives the server/UI against a local vendor fixture.

```sh
node --test tests/live-harness.test.mjs tests/openai-provider.test.mjs tests/live-required-rates.test.mjs tests/live-tools-unit.test.mjs
node scripts/docs-check.mjs --write
node scripts/docs-check.mjs
```

GitHub Pages builds the documentation with Jekyll using `.github/workflows/pages.yml`. The entry page is `docs/index.md`; the theme and Markdown link conversion are configured by `docs/_config.yml`. Enable **Settings → Pages → Source: GitHub Actions** once. A push to main touching documentation or the workflow deploys it; a feature-branch push does not replace the published site. Maintainers can also run the workflow manually from main. Full tests and page acceptance remain merger-lane gates before landing.
