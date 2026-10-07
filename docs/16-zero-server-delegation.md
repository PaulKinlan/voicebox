# Zero-Server Browser Delegation & Task Placement

Voicebox supports running task delegation (`delegate_task`, `task_status`, `cancel_task`) across browser-only, local machine, and remote server environments. Where a task executes is determined by the target environment's **placement** (`browser`, `machine`, or `remote`) rather than requiring a central server broker (`core/tasks.ts`, `lib/task-placement.mjs`).

---

## 1. The Three Execution Placements

| Placement | Execution Runtime | Supported Root Kinds | Max Deadline | Max Active Tasks | Transport |
|---|---|---|---|---|---|
| **`browser`** | In-page / Web Worker | `opfs`, `handle` | `300s` (5 min) | `4` | In-memory / `MessagePort` |
| **`machine`** | Local host process / stdio | `machine` | `3600s` (1 hr) | `8` | Local process / stdio pipe |
| **`remote`** | Paired remote server | `machine` (on remote) | `3600s` (1 hr) | `8` | Paired HTTP / WebSocket |

Placement is derived automatically from the environment descriptor:
- `kind: "browser"` → `placement: "browser"`
- `kind: "server"` or `"fence"` → `placement: "machine"`
- `reach: "paired"` → `placement: "remote"`

---

## 2. Core Contracts & Bounds

### 1. Portable Task Roots (`core/tasks.ts`)
`reduceTask` in `core/tasks.ts` validates task log entries across all three workspace root types without assuming a local POSIX filesystem path:
- **`opfs`**: Origin Private File System (`opfs:${root.path}`), accessible directly in browser placement with zero server.
- **`handle`**: User-picked local directory via the File System Access API (`picked:${root.id}`).
- **`machine`**: Host filesystem directory (`machine:${root.path}`).

```ts
const expectedRoot = record.root.kind === "handle"
  ? `picked:${record.root.id}`
  : `${record.root.kind}:${record.root.path}`;
if (record.instance !== entry.instance || entry.root !== expectedRoot) {
  throw new Error("task writer or root mismatch");
}
```

### 2. Placement Execution Bounds (`PLACEMENT_BOUNDS`)
Defined in `core/tasks.ts` and enforced synchronously at admission via `validatePlacementBounds(placement, bounds)` in `lib/task-placement.mjs`:

```ts
export const PLACEMENT_BOUNDS: Record<TaskPlacement, TaskPlacementBounds> = {
  browser: { defaultDeadlineMs: 30000, maxDeadlineMs: 300000, maxOutputBytes: 65536, maxActiveTasks: 4 },
  machine: { defaultDeadlineMs: 60000, maxDeadlineMs: 3600000, maxOutputBytes: 65536, maxActiveTasks: 8 },
  remote:  { defaultDeadlineMs: 60000, maxDeadlineMs: 3600000, maxOutputBytes: 65536, maxActiveTasks: 8 },
};
```
Requests exceeding the target placement's deadline or output ceiling are refused at admission with `unbounded-executor`.

---

## 3. Browser Task Host (`lib/task-placement.mjs`)

`createBrowserTaskHost(options)` implements full task admission, execution, and cancellation inside the browser runtime with zero Node.js dependencies:
- **Web Crypto Sealing**: Uses `globalThis.crypto.subtle` (HMAC-SHA256) to sign and verify sealed task addresses without `node:crypto`.
- **Browser-Native Execution**: Dispatches tasks via `queueMicrotask` and `AbortController` against in-browser model or WebAssembly executors.
- **Unified Lifecycle Guarantees**:
  - `delegate_task` returns `{ ok: true, task: taskView(record) }` with `placement: "browser"`.
  - `task_status` verifies caller ownership and returns current state and outcome classifications.
  - `cancel_task` triggers the task's `AbortController` and transitions to `cancelled` or `cancel_unconfirmed`.
  - Terminal fencing prevents late completions from overwriting settled `completed`, `failed`, or `cancelled` states.
- **Redaction at the storage boundary**: terminal answers, partials, and progress notes are scrubbed by `redactSecrets` in `persistTaskQuiet` before they reach `localStorage` (the same rule the server host's `settle()` enforces — voicebox-beads-fcx9/5lzv). Note the truthful status: this host is currently **not wired into the served app** (only its test imports it); the boundary scrub exists so a future wiring cannot introduce verbatim secret persistence.

### Direct Placement Dispatch (`createPlacementDispatcher`)
`createPlacementDispatcher({ hosts })` routes `delegate_task`, `task_status`, and `cancel_task` directly to the host responsible for the target environment's placement (`browser`, `machine`, or `remote`), avoiding any mandatory server round-trip for browser-local tasks.

### Verification Suite
```bash
node --test tests/task-placement.test.mjs
```
