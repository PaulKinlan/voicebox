# Live provider fixes — 2026-09-21

## OpenAI tool contract (voicebox-beads-g1l)

Reproduced before edits on public main `a9bd404db339daa92ea9090c12486e5d7edecf39`,
not inferred from the reviewer's older `cd27c8e` drive. The actual OpenAI adapter
ignored `response.function_call_arguments.done` and declared neither tools nor
instructions. A subsequent transcript arrived but the requested file and reply did not.
[Baseline characterization](evidence/live-fixes/g1l/baseline.json).

The adapter now advertises the shared command catalogue, emits the host's tool-call
event, and sends `conversation.item.create` / `function_call_output` with the original
`call_id`. Invalid JSON/non-object arguments return `invalid-tool-call`; a missing
correlation ID emits a named page error instead of invoking an action. Executor
refusals retain their original names. `response.create` waits for generation and all
outstanding tool results, including either completion order, to avoid starting an
OpenAI response while another one is active.

Validation uses the actual page, native Chromium fake microphone, server, executor,
audit and provider. Only vendor WebSocket destinations redirect to owned loopback;
synthetic keys, ephemeral ports and removable private workspace/host directories.
No paid vendor/model call, real microphone, audible speech or deployed acceptance is
claimed. Screenshots were captured, not visually reviewed.

- `node --test tests/openai-provider.test.mjs tests/live-openai-browser.test.mjs`:
  **8 passed / 0 failed / 0 skipped**. [Log](evidence/live-fixes/g1l/g1l-focused.log).
- Browser drive: exact UTF-8 write/readback, live audit, matching call ID, continuation,
  unknown command, missing argument and malformed JSON refusals, then transcript
  on the same healthy connection. [Receipt](evidence/live-fixes/g1l/receipt.json),
  [screenshot](evidence/live-fixes/g1l/write-and-refusals.png).
- Negative control: replace the unique adapter case label
  `case "response.function_call_arguments.done": {` with
  `case "mutation-withheld-tool-handler": {`, run
  `node --test tests/live-openai-browser.test.mjs`, then restore the case label.
  **0 passed / 1 failed**, specifically no correlated write result within 5000ms.
  The mutation asserted a single replacement and was restored before continuing.
  [Log](evidence/live-fixes/g1l/g1l-handler-mutant.log).

The review's other findings (failed-response status, empty close reason, malformed
audio diagnostics and a provider throwing during PCM) are outside these two fixes.

## Settings-selected rate (voicebox-beads-94c)

Also reproduced on unmodified `a9bd404`: environment Gemini plus settings OpenAI
actually dialed OpenAI but declared Gemini/16000. The native capture ran at 16000
and the correct comparison reported no contradiction with that false declaration.
[Baseline](evidence/live-fixes/94c/baseline.json).

`beginSession` now snapshots the settings provider and its model once. That provider
supplies the rate, actual dial and later session metadata. Changing settings affects
the next session, not the running one's model label. **The contradiction comparison
is untouched.** The library still supports its `VOICEBOX_LIVE_PROVIDER` (old name `LIVE_PROVIDER`) fallback when no
explicit provider is supplied; the server supplies the settings provider explicitly.
Invalid settings refuse at their existing API admission boundary. The frame tests
now exercise that actual boundary rather than an unused environment override, and
own/remove their host directories instead of creating tokens in the checkout.

- `node --test tests/live-openai-browser.test.mjs tests/live-rate-frame.test.mjs tests/live-rate-browser.test.mjs`:
  **9 passed / 0 failed / 0 skipped**. [Log](evidence/live-fixes/94c/94c-focused.log).
- Real page/native capture on Gemini-env/OpenAI-settings: **OpenAI/24000**;
  OpenAI-env/Gemini-settings: **Gemini/16000**. Both reach the selected actual vendor,
  receive native PCM, and retain their original model metadata after settings change.
  [OpenAI receipt](evidence/live-fixes/94c/Selected-openai-declaration-and-native-capture-agree-despite-gemini-environment/receipt.json),
  [Gemini receipt](evidence/live-fixes/94c/Selected-gemini-declaration-and-native-capture-agree-despite-openai-environment/receipt.json).
- Existing native browser conflict regression still observes a late declaration of
  **24000** against a running context of **16000**, with the precise contradiction
  `{ declared: 24000, running: 16000 }` and fresh PCM after the declaration.
  [Receipt](evidence/live-fixes/94c/conflicting-rate/receipt.json).
- Negative control: replace the unique
  `inputRate = inputRateRequiredBy(provider);` with
  `inputRate = inputRateRequiredBy(process.env.VOICEBOX_LIVE_PROVIDER);`, then run
  `node --test --test-name-pattern='Selected ' tests/live-openai-browser.test.mjs`.
  **0 passed / 2 failed**: both mismatched directions reject the incorrect rate.
  Single replacement asserted; original source restored.
  [Log](evidence/live-fixes/94c/94c-declaration-mutant.log).

## The live half, driven for real (journal-6g0, 2026-09-25)

Everything above this section either redirected the vendor or declined to claim a
paid call. This one is the bead's own live half, and the claim is the other way
round: a REAL, AUTHENTICATED OpenAI Realtime session, real speech in, real audio
out, and machine witnesses for both directions of the rate contract.

The drive ([evidence/live-fixes/6g0/drive.mjs](evidence/live-fixes/6g0/drive.mjs), run under node v24.21.0) builds the
session exactly as the host does — `createLiveSession({ provider: "openai" })`, so the
dial is the 7ade86e probe-as-dial with `Authorization: Bearer` attached — waits for
`session.updated`, then speaks a TTS-synthesized question ("What is two plus two")
INTO the session as 24 kHz pcm16 frames, followed by 1.4 s of room tone. The room tone
is not decoration: the vendor's server VAD end-points on silence IN THE AUDIO TIMELINE,
and a buffer that merely stops appending never advances past the last word — measured:
speech_started, then no commit and no response for a full timeout. Pacing the send has
the opposite failure: perceived silence between chunks end-points the utterance early
and the vendor answers a fragment (measured twice). Burst speech, then real silence.

What the passing receipt proves, check by check:

- **V1 — output rate**: every `output-audio` delta arrived at `rate=24000` — the
declared output rate is the delivered rate. [Receipt](evidence/live-fixes/6g0/receipt.json).
- **V2 — input intelligibility**: the model's SPOKEN answer was "The answer is 4."
A model cannot answer a question it did not hear and understand, so the 24 kHz speech
that went in was intelligible. (Earlier attempts that heard fragments answered with
fragments — "you" — which is the failure signature this check guards against.)
- **V3/V3b — duration**: 40800 samples = 1.70 s at 24 kHz, 9.4 chars/sec against the
heard text — natural speech; a wrong-rate stream shrinks or stretches exactly here.
- **V4 — audible output**: whisper-1 transcribed the output wav to "The answer is 4."
[Output audio](evidence/live-fixes/6g0/output.wav) — machine-transcribed, not
human-listened; no person heard this drive.
- **V5 — gate quiet**: the host refused zero frames (`refusedByTransport` all zero).

What stays open, stated plainly: the vendor emitted no `output_audio_transcript.delta`
this provider sees (audio + whisper prove the turn regardless), and the provider's
`session.update` configures no `input_audio_transcription`, so there is no input-side
ASR receipt — the input witness is the model's own correct answer. Both are provider
observations, not rate failures. Pitch and speed are correct BY RATE AGREEMENT
(declared = sent = played = 24000, duration natural) plus the whisper transcription;
no human ear was on the call.

Paid-call accounting: one TTS render, one realtime turn, and one whisper transcription
per attempt; two attempts total for the clean receipt (attempt 1 is recorded in the
receipt with its fragment answer).
