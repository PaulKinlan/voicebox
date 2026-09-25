# ACP adapter: real handshake and configured task execution


**Targeted adapter:** **pi-acp 0.0.34 with pi 0.87.1, ACP v1**.
When configured with `VOICEBOX_HARNESS=pi`, the server installs `createPiAcpExecutor()`,
connecting `delegate_task` to the Pi coding agent via ACP over stdio.
The stock server (unset `VOICEBOX_HARNESS`) has no task executor installed and refuses `delegate_task`
with `executor-unavailable`.

## What runs

`lib/acp-client.mjs` implements bounded JSON-RPC request correlation, `initialize`,
`session/new`, text-only `session/prompt`, streamed text collection and `session/cancel`.
**Cancellation has three states and three names** (`voicebox-beads-6co`): `cancel()` during a
running turn sends `session/cancel` and returns what it DID (`{ ok: true, sent: true }`) rather
than claiming termination; the TURN then settles as **`task-cancelled`** when the harness reports
`stopReason: cancelled`, which is a different fact from `acp-turn-incomplete` (the harness answered
something this client does not accept). Cancelling when nothing has run refuses **`task-not-found`**
(the remedy is to start a task) and cancelling after a turn finished refuses **`task-not-running`**
— the name `lib/tasks.mjs` already uses for a terminal task, so the client did not invent a second
spelling of it. Sending cancellation is still not observing termination.

It sends no filesystem/terminal capabilities, relays permission requests to the host
permission policy (or denies if none is configured), and refuses unsupported client requests.

`lib/pi-acp.mjs` supplies both:
1. `createPiAcpExecutor(options)`: the production task executor that spawns `pi-acp` over stdio
   in the project root, communicates via `createAcpClient`, enforces finite deadlines (<=60s)
   and output bounds (<=64KB), and cancels cleanly when requested.
2. `openPiAcpProbe(options)`: credential-free diagnostic probe in bubblewrap isolation for
   verifying handshake and version parity without running model tasks.

## Configured harness execution

Start the server with the harness configured:

```sh
VOICEBOX_HARNESS=pi npm run serve
```

Run `npm run doctor` to inspect the admitted harness.
Delegating a task via `delegate_task` with `agent: "pi"` runs through the ACP adapter.
Delegating to an unconfigured CLI (such as Claude Code, which has no ACP adapter) is
refused by name as `adapter-not-configured`. Delegating to a configured agent ID that is
not in the host's agent registry is refused as `agent-not-configured`. An admitted task's
record carries the frozen configured-agent snapshot (`agentConfig`) beside its `agentId`
and `harness`, so what the delegation was told at admission is readable back later.

### Configured options consumption (voicebox-beads-ozf)

When an admitted task targets a configured agent record (`core/harness-config.ts`), `lib/pi-acp.mjs`
validates and forwards supported options according to the `pi-acp` adapter contract:
1. **Model selection**: Forwarded via ACP `session/set_config_option` with `configId: "model"` and `value: modelId` (e.g. `google/gemini-2.0-flash`, `openai/gpt-4o`). Unsupported models returned by the adapter refuse before prompt dispatch (`model-unsupported`).
2. **Reasoning / thinking effort**: If `model.thinking` is specified, it is applied via ACP `session/set_config_option` with `configId: "thought_level"`. Unsupported levels refuse (`thinking-level-unsupported`).
3. **Persona / system prompt**: Base persona text (`agentConfig.prompt`) is prepended as system instruction framing to the task prompt.
4. **Needed reach vs granted effect authority**: If `agentConfig.reach.tools` is declared, the host decider refuses any tool outside the declared reach list before consulting outer host policy (`tool-not-in-agent-reach`). Needed reach is necessary but not sufficient: host authority must still independently grant the call.
5. **Unsupported claims refusal**: Adapters other than `pi-acp`, pinned versions not matching the installed adapter, non-stdio transports, or custom model options refuse explicitly at preflight (`adapter-not-configured`, `adapter-version-unsupported`, `unsupported-runtime-capability`, `unsupported-model-options`).


## Diagnostic checks

For the runnable checks, including the real installed adapter rather than a stand-in:

```sh
VOICEBOX_ACP_ADAPTER="$PI_ACP_INSTALL_DIR" VOICEBOX_ACP_PI="$PI_BINARY" \
  node --test tests/acp-client.test.mjs tests/pi-acp.test.mjs tests/acp-browser.test.mjs tests/tasks.test.mjs tests/configured-harness.test.mjs
```

The installed-adapter tests explicitly skip when those paths are absent.

## Boundaries

- **Claude Code**: Has no ACP adapter on this machine or in this repository. `discoverHarnesses()`
  and `delegate_task` refuse with `adapter-not-configured`.
- **Browser-only boundary**: `pi-acp` is a stdio subprocess. A browser environment cannot spawn
  it directly; zero-server browser harnesses remain separate.

## Interruption and durable readback

`lib/task-interrupted.mjs` defines the shared `TaskInterrupted` outcome. D1 records that outcome
as `interrupted` with its named reason; unrelated executor errors still become `failed`.
The ACP transport reports `harness-ended-outcome-unknown` on observed process closure without
a result. D1 never replays the admitted diagnostic and still fences late outcomes.

The real TCP test deliberately installs **test-only diagnostic admission**, holds a real pi-acp
handshake open, reads its D1 handle through a second authenticated connection, rejects another
owner, SIGKILLs that real process, observes ESRCH and persists the typed interruption. Repeating
the call returns the same handle with exactly one launch. This proves the interruption wiring,
**not a killed mid-inference model task**. The admission exception lives only in a test fixture;
normal pi-acp requests on that same fixture server still refuse before launch.

## Browser-only boundary: blocked on the D1 placement design

A harness is the runtime doing work; an environment is where it runs. A stdio-only adapter being
unavailable in a browser does not prohibit browser-native harnesses. Zero-server operation remains
a hard requirement, **not acceptance delivered by this machine diagnostic**.

The real Chromium check imports the same portable ACP client, runs an explicitly labelled protocol
fixture, writes its answer in a real IndexedDB transaction and reads it back. Its server serves
static files only; there are no Voicebox API/bridge endpoints. This is not a browser-native harness,
voice session, model call or durable browser task engine.

It then attempts to import the actual D1 module. Chromium requests unsupported `node:fs`,
`node:path` and `node:crypto` dependencies and fails. The test records those failed requests,
not just a source-based assertion. TypeScript dependencies are served with types stripped so
missing test routes are not the reason for the failure.

**The seam cannot express a browser-only executor today:**

- `installTaskExecutor()` lives only in `lib/tasks.mjs`, with unconditional Node imports.
- `createTaskHost()` requires a machine root, synchronous filesystem flush/readback, inode locators
  and process PID/liveness checks.
- `core/tasks.ts` requires machine-root records in `reduceTask()`.

`voicebox-beads-8fv.1` owns separating portable admission/lifecycle from environment storage,
authority, addressing and liveness. Browser persistence needs asynchronous IndexedDB/OPFS, a
browser-scoped authority/key custodian and honest document/worker death handling. This adapter
adds no parallel browser engine or hidden local bridge. Direct browser provider authentication
and real browser-only harness/voice acceptance are still unverified.

**Smallest next step:** align trusted configured-harness admission with the independent-harness
policy and verify a real task; separately finish the D1 browser-placement prerequisite. Keep D2
open. [Installed harness inventory](12-harness-inventory.md) does not enable task execution.
