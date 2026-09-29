# 20 — WebAssembly tools: authoring, the buffer ABIs, compilation, admission, and execution

**This page is the developer guide for the WASM shelf** (`voicebox-beads-rgvi`): how a module is
written, compiled, admitted, executed, and observed. The runtime facts here are read from
[`lib/wasm-shelf.mjs`](../lib/wasm-shelf.mjs), [`lib/wasm-worker.mjs`](../lib/wasm-worker.mjs) and
[`tools/build-wasm.mjs`](../tools/build-wasm.mjs) — where this page and the code disagree, the code
wins. The boundary framing (digest binds bytes, never behavior) lives in
[`docs/15-sandbox.md`](15-sandbox.md); the shelf's place in the running product lives in
[`docs/08-how-it-runs.md`](08-how-it-runs.md).

## 1. What a shelf tool is

A shelf tool is a WebAssembly module plus a **digest-pinned manifest entry**, living in the shelf
directory (default `~/.isocan/modules/wasm-tools`, `VOICEBOX_WASM_SHELF_DIR` overrides). Unlike an
extension proposal, an admitted shelf tool is **callable immediately** — it was admitted by bytes,
not by review: the manifest records the sha256 digest, the loader re-hashes the file at every read
and again at every call, and the bytes that run are the bytes the digest names.

A manifest entry:

```json
{
  "id": "hash",
  "wasm": "hash.wasm",
  "digest": "<sha256 of the .wasm bytes>",
  "description": "SHA-256 of up to 8192 bytes",
  "capability": "hash",
  "abi": "buffer-abi/1"
}
```

`readShelf()` (`lib/wasm-shelf.mjs`) reads the manifest and produces the admission verdict per
tool: `admitted: true` when the on-disk bytes hash to the recorded digest, and named refusals
otherwise — `wasm-unreadable` (no module at the path), `digest-mismatch` (the bytes changed under a
pinned digest). An admission verdict is **admission-time only**: every call re-verifies, so editing
a `.wasm` under a stale digest takes the tool offline at the next call, not at the next boot.

## 2. The two buffer ABIs

The shelf manifest does not invent a calling convention — the conventions below were **measured by
driving the modules** and are enforced by the loader (`MEASURED_ABI` in `lib/wasm-shelf.mjs`). A
module that does not conform simply cannot be driven.

### `buffer-abi/1` — zero imports, one buffer, one integer in, fixed digest out

Used by `hash.wasm` (`sha256` export):

| aspect | contract |
|---|---|
| imports | **zero** — the loader refuses any import with `import-undeclared` before the module is touched; a capability the descriptor never declared is not a capability |
| input | bytes written at fixed address `0x400`, at most **8192** bytes |
| call | the `sha256` export, called with the input **length** as its only argument |
| output | **32** bytes (the digest) written at `0x2400`; the export returns `-1` if the input exceeded 8192 |
| known-good vector | `sha256("abc")` starts `ba7816bf` — the room-loop test drives exactly this and asserts the digest in the tool frame |

### `buffer-abi/diff` — two input buffers, one output buffer, structured diff out

Used by `diff.wasm` (`diff` export), decoded by the shelf into **Hirschberg line-diff blocks**
(`voicebox-beads-9nk`):

| aspect | contract |
|---|---|
| input A | at `0x10000`, at most **65536** bytes |
| input B | at `0x20000`, at most **65536** bytes |
| output | at `0x30000`, at most **262144** bytes |
| call | the `diff` export |

The output decode is the shelf's job, not the module's: `diff.wasm` returns raw comparison
structure and `lib/wasm-shelf.mjs` turns it into the structured blocks the model sees. An ABI
nobody drives is not a mechanism — that is why the decode ships with the ABI table rather than as
a promise.

### What both ABIs refuse before a module runs

- a **zero-page memory** (`unsupported-abi`) — a module with no memory cannot hold a buffer;
- an **undeclared import** (`import-undeclared`);
- a module file over `WASM_MODULE_MAX_BYTES` (16 MB) is never read onto the host event loop at all.

## 3. Compilation

The committed artefact is the `.wasm`; the `.wat` beside it is the readable source of truth.

- **Toolchain:** `tools/build-wasm.mjs` compiles WebAssembly text with `wabt` — offline, no
  toolchain install beyond that one devDependency.
- **Build:** `npm run build:wasm` compiles the committed `.wat`/`.wasm` pairs (the shelf's
  `create-asset` module and the test fixtures).
- **In code:** `compile(watSource)` and `compileFile(path)` are exported for tests and tools.
- **No drift:** `npm test` recompiles from the `.wat` and fails if the committed `.wasm` bytes
  differ — the same silent-drift failure mode the digest pinning prevents, one level down.
- **Any other toolchain works too:** the shelf consumes `.wasm` bytes and a digest; clang/rust
  output is welcome as long as it satisfies the ABI and the zero-import (or declared-import) rules.
  Recompute the digest in the manifest after every build — the digest is the admission.

## 4. Execution: what bounds a call

Every call runs in a **fresh worker** (`lib/wasm-worker.mjs`), off the host's event loop, under
host constants that no descriptor can raise:

| bound | value | refusal when hit |
|---|---|---|
| wall-clock deadline | `WASM_CALL_DEADLINE_MS` = 5000ms | `time-exceeded` (worker terminated) |
| worker old-generation heap | 64 MB | `resource-exceeded` |
| worker young-generation heap | 16 MB | `resource-exceeded` |
| module file size | 16 MB | never read onto the event loop |
| per-ABI buffer sizes | the table in §2 | written within the ABI's stated maximum |
| stdout buffer bound | `WASM_CHILD_MAX_STDOUT_BYTES` = 2 MB | `resource-exceeded` (worker killed) |
| child watchdog ceiling | `WASM_CHILD_WATCHDOG_MS` = 6000ms | child self-exits on orphan window |

The digest binds **bytes, never behavior** — the bounds above bound behavior's *cost*, and they
are host constants. There is no fuel/instruction metering today, and no concurrency cap on
parallel calls (`voicebox-beads-mbk` names the semaphore as the follow-up if turn volume ever
justifies it).

## 5. How a call travels

1. **The room loop (voice):** the model calls the tool **by name** — admitted shelf tools are
   declared beside the fixed commands (`liveToolDeclarations(wasmShelfDir())` in `server.mjs`) and
   answered by the **same shared executor** as every other verb: same containment, same refusal
   names, same audit.
2. **The measurement:** the executor times the call; the result frame (`type: "tool"`) carries
   `durationMs` per call.
3. **The room UI:** the Extensions → WASM shelf section renders one row per tool — "Callable now",
   the last run's ok/failed, **the measured latency in ms**, and how long ago; driven through the
   page's own tool-frame hook, so a call that happened in the voice loop is visible without a
   reload.
4. **Extensions surface:** shelf tools also appear in `list_extensions` with their measured
   boundary (zero imports, admitted digest, buffer ABI) and execute through `call_extension`.

The pin for all of the above: `tests/live-wasm-room.test.mjs` (the model drives `hash` end to end
and the frame carries the digest **and** the measured latency),
`tests/wasm-room-ui.test.mjs` (the shelf row shows the latency readout through the page's own
tool-frame hook), and `tests/wasm-shelf.test.mjs` (the ABIs, the bounds, the refusals).

## 6. Designed, not built

Named so nobody mistakes them for working parts: fuel/instruction metering (wall-clock only
today), a concurrency semaphore for parallel calls (`voicebox-beads-mbk`), the `awasm-noble`
crypto admission (`voicebox-beads-2uhx`, OPEN), and the Emscripten/pthreads runtime lane
(`voicebox-beads-ltkj`, OPEN). The catalogue research (65 categories) lives in the rest of this
file's siblings — the shelf admits what has a manifest and a matching digest, nothing else.
