# Task Delegation & Durable Handles (`delegate_task`)

Voicebox supports delegating long-running engineering tasks to external coding agents (`delegate_task`, `task_status`, `cancel_task`) with cryptographic owner binding, root pinning, and private audit persistence (`core/tasks.ts`, `lib/tasks.mjs`, `lib/task-placement.mjs`).

---

## 1. Task Delegation API & Authority

Tasks can be delegated from a local authenticated session (carrying the host token, loopback session cookie, or same-origin local browser entitlement) or across paired environments via `POST /api/call` → `POST /api/execute`.

### Request Payloads
```json
// Delegate a new task
{ "agent": "pi", "task": "Refactor the parser and run unit tests", "context": [] }

// Check task status or cancel
{ "address": "<sealed-task-address>" }
```

- **Idempotency (`x-voicebox-call-id`)**: Reusing the same `x-voicebox-call-id` for the same owner and workspace root returns the existing task record without re-dispatching. Supplying different task parameters under an existing call ID is refused with `task-call-id-conflict`.
- **Strict Parameter Isolation**: Model arguments cannot override the task owner, target environment, workspace root, CLI binary, or execution bounds. Non-empty `context` arrays are refused with `task-context-unavailable` unless supported by the target host.
- **Unauthenticated Call Refusal**: Requests lacking verified local or paired-bearer authority are refused with `task-owner-unverified`.

---

## 2. Cryptographic Pinning & Private Persistence

Every admitted task is pinned to four immutable attributes in `lib/tasks.mjs`:

1. **Environment (`SELF_ENVIRONMENT`)**: Bound to the host's `.environment-key` identity.
2. **Owner**: Derived from a domain-separated hash of the caller's pairing credential and registry key (or the durable local task owner for local browser sessions). One paired caller cannot inspect or cancel another caller's tasks (`task-owner-mismatch`).
3. **Workspace Root**: Bound to the canonical path and filesystem device/inode of the active machine root (`core/root.ts`), or to portable `opfs` / `handle` roots in browser placement (`lib/task-placement.mjs`, [`16-zero-server-delegation.md`](16-zero-server-delegation.md)). Switching or replacing the workspace directory later refuses readback with `task-root-replaced` or `task-root-unavailable`.
4. **Sealed Task Address**: Signed with the host token and owner identity. Possessing an address string alone grants no read or cancel authority; rotating `.host-token` invalidates previously minted addresses.

### Private Audit Log (`<root>/.audit/*.jsonl`)
Task events (which include the task prompt) are persisted in the active root's `.audit/*.jsonl` file with `0600` permissions. Task records are filtered out of public `GET /api/audit` responses and are inaccessible to workspace file tools (`protected-audit`).

---

## 3. Admission, Execution & Lifecycle Policy

1. **Pre-Flight Validation**: Validates caller authentication, checks that the prompt is within the 16,384-byte UTF-8 input budget (`task-input-over-budget`), and verifies that a task executor is installed via `installTaskExecutor()` (`executor-unavailable` if no harness is active).
2. **Durable Queueing before Dispatch**: The `queued` event is appended and flushed to disk before the task handle is returned. Execution starts asynchronously on a subsequent event-loop turn only after a `running` event is persisted.
3. **Concurrency & Resource Ceilings**: A machine host runs at most 8 concurrent tasks (4 in browser placement) with bounded wall-clock deadlines and a 64 KiB output cap (`task-capacity-exhausted`, `task-output-over-budget`).
4. **Crash Reconciliation (No Automatic Replay)**: If a host process exits while a task is `queued` or `running`, subsequent readback checks whether the original PID is still alive (`ESRCH`). Once confirmed absent, the task transitions to `interrupted` (`lib/task-interrupted.mjs`). Unfinished prompts are never automatically re-executed after a crash.
5. **Closure & Surface Delivery Policy**: Every `task_view` includes:
   - `closurePolicy`: `{ onVoiceDisconnect: "continue", onEnvironmentClose: "continue-until-host-exit" | "interrupt", reconciliation }`
   - `delivery`: `{ mode: "surface-notification", surfaceUpdated: true, modelReceived: false }` — task updates push `{ type: "task", task, delivery }` frames to update the browser task card in real time without injecting unsolicited turns into the live voice stream.

---

## 4. Outcome Classification

Terminal task records carry an explicit `outcome` classification (`tests/task-outcome.test.mjs`) that distinguishes executor claims from host-observed terminations:

| Terminal State | Outcome Class | Basis | Meaning |
|---|---|---|---|
| `completed` | `claimed-complete` | `executor-claimed` | The coding agent returned a response within its time and output bounds. |
| `failed` | `observed-failure` | `host-observed` | The adapter or subprocess exited with an error. |
| `interrupted` | `observed-interruption` | `host-observed` | Execution hit its deadline or the host process terminated before completion. |
| `cancelled` | `observed-cancellation` | `host-observed` | The task was cancelled via `cancel_task` and confirmed stopped by the adapter. |

*(Non-terminal states such as `running` or `cancel_unconfirmed` carry no outcome classification.)*

### Partial Output Preservation (D6)
When a task fails or is interrupted after partial execution output has been returned by the executor or attached to a thrown failure (`err.partial`), the partial output is recorded in `partial` rather than discarded (`lib/tasks.mjs`). Terminal partial text is scrubbed through `redactSecrets()` at the durable `settle()` boundary before being written to `.audit` or served in task views.

### Verification Suites
```bash
node --test --test-concurrency=1 tests/tasks.test.mjs tests/tasks-http.test.mjs tests/tasks-browser.test.mjs tests/task-outcome.test.mjs
```
