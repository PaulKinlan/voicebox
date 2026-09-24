# Zero-server browser-owned delegation: placement as an environment property

**Bead:** `voicebox-beads-8fv.1` · **Parent:** `voicebox-beads-8fv` (delegate_task).

> “there is a world where there is zero server and it's all run locally on the client,
> and that has to be a hard requirement.”
>
> — Paul, 2026-09-21

Voicebox may execute on a server to reach Paul's machine, but **where execution runs is a property
of the environment, not a fork of the harness design**. Delegating a task (`delegate_task`) associates
placement with the executing environment rather than requiring a dedicated server broker.

## The Three Placements

| Placement | Execution Runtime | Root Kinds Supported | Max Deadline | Max Active | Transport |
|---|---|---|---|---|---|
| **`browser`** | In-page / Web Worker | `opfs`, `handle`, portable | 300s (5 min) | 4 | In-memory / MessagePort |
| **`machine`** | Local host process / stdio | `machine` | 3600s (1 hr) | 8 | Local process / pipe |
| **`remote`** | Remote paired server | `machine` (on remote) | 3600s (1 hr) | 8 | Paired HTTP / WebSocket |

Placement is derived from the environment descriptor:
- `kind: "browser"` → `placement: "browser"`
- `kind: "server"` or `"fence"` → `placement: "machine"`
- `reach: "paired"` → `placement: "remote"`

## Core Architecture and Contracts

### 1. Portable Task Roots

Previously, `reduceTask` in `core/tasks.ts` hardcoded `root.kind === "machine"` and `entry.root === "machine:..."`.
Under the zero-server model:
- `opfs`: origin-private storage (`opfs:${root.path}`), readable in browser placement with zero server.
- `handle`: user-picked folder (`picked:${root.id}`), addressable directly by the page.
- `machine`: host filesystem path (`machine:${root.path}`).

`reduceTask` matches roots portably:
```ts
const expectedRoot = record.root.kind === "handle"
  ? `picked:${record.root.id}`
  : `${record.root.kind}:${record.root.path}`;
if (record.instance !== entry.instance || entry.root !== expectedRoot) {
  throw new Error("task writer or root mismatch");
}
```

### 2. Execution Bounds (`PLACEMENT_BOUNDS`)

Defined in `core/tasks.ts` and enforced in `lib/task-placement.mjs`:
```ts
export const PLACEMENT_BOUNDS: Record<TaskPlacement, TaskPlacementBounds> = {
  browser: { defaultDeadlineMs: 30000, maxDeadlineMs: 300000, maxOutputBytes: 65536, maxActiveTasks: 4 },
  machine: { defaultDeadlineMs: 60000, maxDeadlineMs: 3600000, maxOutputBytes: 65536, maxActiveTasks: 8 },
  remote:  { defaultDeadlineMs: 60000, maxDeadlineMs: 3600000, maxOutputBytes: 65536, maxActiveTasks: 8 },
};
```
Bounds must be validated synchronously at admission via `validatePlacementBounds(placement, bounds)`.
Exceeding the placement limits refuses with `unbounded-executor`.

### 3. Browser Task Host (`lib/task-placement.mjs`)

`createBrowserTaskHost(options)` provides zero-server delegation:
- **Zero Node imports**: Uses standard Web Crypto (`globalThis.crypto.subtle`) for sealing task addresses rather than `node:crypto`.
- **Zero process spawning**: Executes via web standards (`queueMicrotask`, `AbortController`, in-client model/Wasm executors).
- **Same coordination invariants**:
  - `delegate_task`: returns `{ ok: true, task: taskView(record) }` with `placement: "browser"`.
  - `task_status`: verifies caller ownership and returns honest observations.
  - `cancel_task`: sends abort signal, bounds wait, and settles to `cancelled` or `cancel_unconfirmed`.
  - Terminal fencing: late resolves cannot rewrite completed/failed/cancelled states.

### 4. Zero Central Broker

`createPlacementDispatcher({ hosts })` routes task tools (`delegate_task`, `task_status`, `cancel_task`)
directly to the host matching the target environment's placement. An in-page task communicates
directly with the browser host, a machine task communicates with the machine host, and a remote
task communicates with the remote paired host. No centralized broker or mandatory proxy is required.

## Verification

Unit test suite in `tests/task-placement.test.mjs`:
- Verifies placement derivation across environment kinds and reach states.
- Verifies placement bounds enforcement (rejection of excessive deadlines/outputs).
- Drives browser task admission, OPFS root execution, handle root cancellation honesty, and capacity limits.
- Verifies portable root reduction across `opfs`, `handle`, and `machine` descriptors.
