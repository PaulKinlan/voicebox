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
