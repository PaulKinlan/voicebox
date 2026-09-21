# ACP adapter: real handshake, task admission blocked

**Partial D2, not a working delegated model task.** One third-party adapter is targeted:
**pi-acp 0.0.33 with pi 0.85.1, ACP v1**. No provider credential or model request is used
by the diagnostic. The stock server still has no task executor installed.

## What runs

`lib/acp-client.mjs` implements bounded JSON-RPC request correlation, `initialize`,
`session/new`, text-only `session/prompt`, streamed text collection and `session/cancel`.
It sends no filesystem/terminal capabilities, denies permission requests with ACP's cancelled
outcome and refuses unsupported client requests. Cancellation sent is not termination observed.
It requires the exact adapter name/version in the actual initialization response; no guessed
fallback. This module has no Node imports. Its prompt/cancel behavior is **fixture-tested**,
not verified against a real authenticated provider.

`lib/pi-acp.mjs` supplies a **diagnostic-only** machine transport: bounded newline-delimited
stdio in bubblewrap with all namespaces unshared, cleared environment, fresh home/work area,
read-only runtime packages, no provider keys and no network access. It checks installed adapter
metadata and executes the actual pi binary's version check inside that isolation before the ACP
handshake. Version mismatches name `adapter-version-unsupported` or `harness-version-unsupported`.
Versions are compatibility checks, not signatures or proof a modified binary is trustworthy.

The probe defaults to 10 seconds and 262144 total stdout/stderr bytes. Configured limits above
30 seconds or 1048576 bytes refuse. It kills its owned process on closure, timeout or output
overrun, waits for close and removes its temporary launch file. Its returned interface offers
initialization information and credential-free session setup, **no prompt/effect method**.
The observed real session setup refuses as `acp-authentication-required` without credentials.

## Run the credential-free check

Install the exact versions through your normal trusted package-management process first;
this command installs nothing and never runs `npx` or loads your existing pi profile.
Pass explicit absolute installation paths (not model-authored task arguments):

```sh
node tools/acp-check.mjs "$PI_ACP_INSTALL_DIR" "$PI_BINARY"
```

Linux, bubblewrap with user namespaces, and the Node executable in the system runtime directory
are required. The pi binary must be in its distribution directory with its adjacent version
manifest. The pi-acp installation must retain its SDK sibling and its zod dependency.
The tool prints the actual handshake plus the production admission refusal. Successful exit
means **handshake diagnostic completed**, not that a task can execute.

For the runnable checks, including the real installed adapter rather than a stand-in:

```sh
VOICEBOX_ACP_ADAPTER="$PI_ACP_INSTALL_DIR" VOICEBOX_ACP_PI="$PI_BINARY" \
  node --test tests/acp-client.test.mjs tests/pi-acp.test.mjs tests/acp-browser.test.mjs tests/tasks.test.mjs
```

The two installed-adapter tests explicitly skip when those paths are absent. No real-provider
acceptance is included, skipped or otherwise. Optional `VOICEBOX_ACP_EVIDENCE` names a directory
for the browser screenshot and JSON receipt. All test servers bind ephemeral ports.

## Why real tasks refuse

`createPiAcpExecutor()` can be passed to D1's trusted `installTaskExecutor()` seam, but both
`check()` and `run()` currently refuse **`absent-capability`**, naming network/credential isolation
and the missing task-scoped model broker. Descriptor claims cannot bypass this. No production
admission is enabled by the diagnostic, a timeout alone, or S1's shared-network filesystem sandbox.

The broker prerequisite is tracked as `voicebox-beads-8fv.5`: fixed provider endpoint/model,
finite request/byte/token budgets, credentials held outside the delegate, and a no-network
namespace with broker-only access. It needs independent security review and explicit approval
for ACP credential use. Approval for embedding experiments does not authorize this work.
No model task completion, model cost, permission enforcement against a real model, or real
ACP cancellation acknowledgment is claimed here.

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

**Smallest next step:** build and independently verify the bounded broker before enabling real
machine task admission; separately finish the D1 browser-placement prerequisite. Keep D2 open.
