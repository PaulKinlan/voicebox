# D1: authenticated task admission and durable handles

**Scope:** task records, admission and readback. The stock server has **no task executor** and refuses `delegate_task` with `executor-unavailable`. This is not an ACP integration, an agent sandbox, or a task-card UI.

## Calling the host

Use the existing paired `/api/call` → `/api/execute` path. The proxy holds the bearer; it is not delivered to the page. Direct `/api/execute` callers must authenticate with the currently accepted pairing bearer on every request.

`delegate_task` takes:

```json
{"agent":"configured-agent-name","task":"bounded task text","context":[]}
```

The authenticated transport supplies `x-voicebox-call-id` separately. The proxy forwards a supplied ID or creates one. Reusing the same ID for the same owner **and root** returns the existing record, never dispatches twice, and refuses different input as `task-call-id-conflict`. A caller that needs retry safety must retain its transport ID. This is not a cross-root idempotency index.

`task_status` takes only `{"address":"<returned address>"}`. Success contains `task.address`, `task.environment`, `task.root`, `task.state`, timestamps, and any result/refusal reason. Model arguments cannot supply owner, environment, root, CLI command, endpoints, or bounds. Nonempty context references currently refuse as `task-context-unavailable`; no context snapshot is silently invented.

Ambient local calls refuse as `task-owner-unverified`. The unauthenticated `/live` connection is not a delegation authority. These tools are not advertised in its file-command list; authenticated live delegation and agent discovery remain later work.

## What is pinned

- **Environment:** the host's existing `SELF_ENVIRONMENT` (`.environment-key`), not a registry routing alias, label, origin, or connection ID.
- **Owner:** a domain-separated hash of the accepted pairing credential and its registry key, never the bearer itself. This identifies the credential holder, not a new user-account system. Another authenticated pairing cannot read the record.
- **Root:** this host's explicitly declared machine directory, canonical path and filesystem identity. Switching the active project cannot retarget readback. Foreign roots, page roots, a vanished root, and a replacement directory refuse by name.
- **Address:** a sealed root locator. The existing host token signs it together with the owner identity. Ownership is checked before reading the located root, then checked again against the record. Possessing the address grants no authority. Replacing the host token invalidates its old addresses; replacing the pairing credential does not inherit the old owner's tasks.

There is no second task database or root index. Task events share the original root's per-writer `.audit/*.jsonl`. They contain the task prompt and are private: the file is mode `0600`, the public audit view excludes task events, and ordinary file reads/writes (including admitted extension tools and symlink aliases) cannot access the audit namespace. Do not publish these private audit files as source code.

## Admission and execution

1. Authenticate the caller and validate bounded input (16,384 UTF-8 bytes).
2. Pin the host/root and check a host-installed executor implementation. A CLI descriptor, `bounded: true`, or remote capability metadata cannot install one. The stock server has none.
3. Append the `queued` record, flush the file and directory entries, then read it back. Failed persistence means no accepted handle and no execution.
4. Return the handle; dispatch on a later event-loop turn, without awaiting completion. Dispatch also requires a durable `running` event.

At most eight tasks are active per host service. Each admitted implementation must establish finite deadline and output bounds. Captured input and executor-facing bounds are immutable. A deadline records `interrupted`; it does **not** claim a subprocess was killed, and capacity stays charged until execution actually settles. A trusted executor can also report `TaskInterrupted` with a named reason when its runtime ends without a confirmed result; other errors remain `failed`. No public Stop/cancel implementation is provided by D1.

`installTaskExecutor()` is a trusted **host-code** seam, not a request/configuration route or proof of containment. Its synchronous `check()` must establish the actual mechanism; `run()` is called only after persistence. D2 must supply and verify a real adapter and its enforcement before production tasks can run. The lifecycle fixture supplies fixed, no-untrusted-code operations only. The [ACP diagnostic slice](11-acp-adapter.md) verifies one actual adapter handshake and typed process interruption, but its production executor refuses pending bounded provider access.

## Process death is not replay permission

On authenticated readback, an unfinished record from a different boot is marked `interrupted` only after the old process is observed absent (`ESRCH`). A process that might still exist yields `task-owner-unconfirmed`. No saved prompt is submitted during recovery or retry. Late completion cannot rewrite a terminal state.

This uses the audit's existing single-writer-per-root assumption and local process namespace. It is not a distributed ownership lease. Torn/inconsistent logs fail closed; automatic repair, PID-reuse recovery, credential migration and broader reconciliation remain D7/I3 work. Readback performs this narrow reconciliation lazily; there is no background all-root scan. D10's broader harness-closure lifetime policy remains open.

## Verification and limits

```sh
node --test --test-concurrency=1 tests/tasks.test.mjs tests/tasks-http.test.mjs tests/tasks-browser.test.mjs
```

The HTTP test opens separate, independently authenticated TCP connections, rejects a second owner and unauthenticated possession, switches roots, kills the owned process, confirms exit, restarts against the same state, and checks `interrupted` with exactly one dispatch.

The browser test drives native microphone capture with fake media through real `/live` frames, an unrelated live text turn and native text form while work is held open, page reload, and an independent Chrome/profile. Its visible task witness is **test instrumentation, not D8 UI**. The host/voice implementations are **closed fixtures, not ACP/ASR/model/D8 UI acceptance**. The paired browser fixture uses the same owned host through its real proxy; it does not establish cross-machine pairing or containment.

The first browser instrument waited on the absent `#caption` element and failed. That RED is retained externally; the product bug is tracked as `voicebox-beads-sor`. The corrected instrument observes raw CDP WebSocket frames without modifying the page's WebSocket or inventing a product caption. Frame arrival is not proof the product displays the reply.

D2–D10 remain unfinished: adapter execution, discovery/default selection, outcome guidance, permission mediation, progress/cancellation, broader recovery, result UI, interjection semantics and lifetime policy are not supplied by this slice.
