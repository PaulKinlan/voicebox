# WebAssembly Tool Shelf Guide

Voicebox includes a **WebAssembly Tool Shelf** (`lib/wasm-shelf.mjs`, `lib/wasm-worker.mjs`, `tools/build-wasm.mjs`) for executing standalone, zero-import `.wasm` binaries inside isolated worker processes with cryptographic digest verification and strict resource ceilings.

---

## 1. Shelf Manifest & Digest Admission

WebAssembly shelf tools live in `VOICEBOX_WASM_SHELF_DIR` (default `~/.isocan/modules/wasm-tools`) alongside a `manifest.json` file that pins each module's expected SHA-256 digest:

```json
{
  "id": "hash",
  "wasm": "hash.wasm",
  "digest": "<sha256-hex-digest-of-wasm-bytes>",
  "description": "Compute SHA-256 digest of up to 8192 bytes",
  "capability": "hash",
  "abi": "buffer-abi/1"
}
```

### Continuous Digest Verification (`readShelf()`)
Unlike extension proposals that require interactive approval, shelf tools are admitted by their cryptographic digest:
- `readShelf()` in `lib/wasm-shelf.mjs` hashes the `.wasm` binary on disk and compares it against `manifest.json`.
- If the file is missing (`wasm-unreadable`) or the bytes do not match the pinned digest (`digest-mismatch`), the tool is refused immediately.
- The SHA-256 digest is re-verified on **every invocation**, so modifying a `.wasm` file on disk without updating `manifest.json` immediately blocks execution.

---

## 2. Supported Buffer ABIs (`MEASURED_ABI`)

Every shelf module must export linear memory, declare **zero imports** (any import is refused with `import-undeclared`), and implement one of the two supported buffer ABIs:

### 1. `buffer-abi/1` (Single Buffer Input → Fixed Digest Output)
Used by `hash.wasm` (`sha256` export):

| Parameter | Specification |
|---|---|
| **Imports** | `0` (refuses with `import-undeclared` if any import is present) |
| **Input Buffer** | Written at linear memory offset `0x400`, up to **`8,192` bytes** |
| **Exported Function** | `sha256(byteLength)` |
| **Output Buffer** | `32` bytes read from offset `0x2400` (returns `-1` if input exceeds `8,192` bytes) |

### 2. `buffer-abi/diff` (Two Input Buffers → Structured Diff Output)
Used by `diff.wasm` (`diff` export), which `lib/wasm-shelf.mjs` decodes into structured Hirschberg line-diff blocks:

| Parameter | Specification |
|---|---|
| **Input Buffer A** | Offset `0x10000`, up to **`65,536` bytes** |
| **Input Buffer B** | Offset `0x20000`, up to **`65,536` bytes** |
| **Output Buffer** | Offset `0x30000`, up to **`262,144` bytes** |
| **Exported Function** | `diff(lenA, lenB)` |

### Pre-Flight Module Refusals
- **`unsupported-abi`**: Module has zero linear memory pages or does not export the required ABI function.
- **`import-undeclared`**: Module declares WASI or host imports.
- **Oversized Module**: Files larger than `WASM_MODULE_MAX_BYTES` (`16 MB`) are rejected before loading.

---

## 3. Compiling `.wat` Modules (`tools/build-wasm.mjs`)

Voicebox compiles WebAssembly Text (`.wat`) files offline using `wabt`:

```bash
npm run build:wasm
```

- `tools/build-wasm.mjs` exports `compile(watSource)` and `compileFile(path)` for tests and build scripts.
- The test suite verifies that committed `.wasm` binaries match their `.wat` sources byte-for-byte.
- You can also compile modules using Clang, Rust, or Zig (`wasm32-unknown-unknown`) provided the resulting `.wasm` binary has zero imports, conforms to the buffer ABI offsets above, and has its SHA-256 digest recorded in `manifest.json`.

---

## 4. Isolated Worker Execution & Resource Bounds

Every WASM tool call executes in a fresh subprocess (`lib/wasm-worker.mjs`) governed by fixed host limits that a module cannot override:

| Resource Bound | Host Constant | Refusal / Behavior |
|---|---|---|
| **Wall-Clock Deadline** | `WASM_CALL_DEADLINE_MS` = `5,000ms` | Worker terminated; returns `time-exceeded` |
| **Old-Generation Heap** | `64 MB` | Worker terminated; returns `resource-exceeded` |
| **Young-Generation Heap** | `16 MB` | Worker terminated; returns `resource-exceeded` |
| **Max Module File Size** | `WASM_MODULE_MAX_BYTES` = `16 MB` | Refused before reading into memory |
| **Max Child Stdout** | `WASM_CHILD_MAX_STDOUT_BYTES` = `2 MB` | Worker killed; returns `resource-exceeded` |
| **Child Watchdog Ceiling** | `WASM_CHILD_WATCHDOG_MS` = `6,000ms` | Child process self-exits if orphaned |

---

## 5. Live Voice & Extension Integration

1. **Direct Voice Tool Declarations**: Admitted shelf tools are automatically included in live voice session handshakes (`liveToolDeclarations(wasmShelfDir())` in `server.mjs`) and execute through the shared server executor.
2. **Measured Latency Readout (`durationMs`)**: Each execution measures wall-clock duration and emits `durationMs` on the `{ type: "tool" }` frame, updating the latency badge in the **Extensions → WASM Shelf** UI panel in real time.
3. **Extension Discovery (`list_extensions` / `call_extension`)**: Shelf tools also appear in `list_extensions` with their verified ABI and digest metadata and can be invoked via `call_extension`.

### Verification Suites
```bash
node --test tests/wasm-shelf.test.mjs tests/live-wasm-room.test.mjs tests/wasm-room-ui.test.mjs
```
