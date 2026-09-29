// lib/wasm-worker.mjs — the bounded execution cell for wasm modules (voicebox-beads-lgw, 9nk, u2lx).
//
// Runs OFF the host's event loop and in its OWN PROCESS rather than a worker thread. voicebox-beads-u2lx
// measured why: a worker running a synchronous `memory.grow` loop survived worker.terminate() and kept
// burning ~3 cores for ~52s AFTER its deadline (V8 cannot preempt a thread that never returns to a
// safepoint), which cost the live lane ~52s on every push. SIGKILL cannot be ignored or deferred, so
// the host now spawns this file per call and kills it at the deadline: an infinite loop and a
// memory.grow loop both die by name AT the deadline, and the host's own process never holds the memory.
//
// The host hands over the VERIFIED bytes (the digest check happens in the parent, before anything
// here), a spec, and the input over stdin as JSON (buffers base64). One JSON line comes back on stdout.
import { Buffer } from "node:buffer";
import process from "node:process";
import { pathToFileURL } from "node:url";

/** The execution body: pure in/out, no transport. Returns the same result objects the host expects. */
export function executeWasm({ bytes, spec, input }) {
  try {
    const module_ = new WebAssembly.Module(bytes);
    const imports = WebAssembly.Module.imports(module_);
    if (imports.length > 0) {
      return {
        ok: false,
        refused: "import-undeclared",
        why: `wasm tools require ZERO imports; this module asks for ${
          imports.map((i) => `${i.module}.${i.name}`).join(", ")
        }`,
      };
    }
    const instance = new WebAssembly.Instance(module_, {});
    const fn = instance.exports[spec.call.export];
    const memory = instance.exports.memory;
    if (typeof fn !== "function" || !(memory instanceof WebAssembly.Memory)) {
      return {
        ok: false,
        refused: "unsupported-abi",
        why:
          `the module exports no '${spec.call.export}' function or no memory — the bytes do not match declared abi '${spec.abi}'`,
      };
    }
    if (spec.abi === "buffer-abi/1") {
      const needed = Math.max(spec.input.addr + spec.input.maxBytes, spec.output.addr + spec.output.bytes);
      if (memory.buffer.byteLength < needed) {
        return {
          ok: false,
          refused: "unsupported-abi",
          why:
            `the module's memory is ${memory.buffer.byteLength} bytes but the declared ABI needs ${needed} (input at ${spec.input.addr}+${spec.input.maxBytes}, output at ${spec.output.addr}+${spec.output.bytes}) — the bytes are not buffer-abi/1`,
        };
      }
      const view = new Uint8Array(memory.buffer);
      view.set(input, spec.input.addr);
      const returned = fn(input.length);
      const output = Buffer.from(memory.buffer, spec.output.addr, spec.output.bytes);
      return { ok: true, returned, output: output.toString("hex") };
    }
    if (spec.abi === "buffer-abi/diff") {
      const needed = Math.max(
        spec.inputA.addr + spec.inputA.maxBytes,
        spec.inputB.addr + spec.inputB.maxBytes,
        spec.output.addr + spec.output.maxBytes,
      );
      if (memory.buffer.byteLength < needed) {
        return {
          ok: false,
          refused: "unsupported-abi",
          why: `the module's memory is ${memory.buffer.byteLength} bytes but the declared ABI needs ${needed}`,
        };
      }
      const inputA = input?.inputA || Buffer.alloc(0);
      const inputB = input?.inputB || Buffer.alloc(0);
      const view = new Uint8Array(memory.buffer);
      view.set(inputA, spec.inputA.addr);
      view.set(inputB, spec.inputB.addr);
      const returned = fn(inputA.length, inputB.length);
      if (returned < 0) {
        return {
          ok: false,
          refused: "diff-failed",
          why: "diff calculation returned negative length (script overflow or invalid inputs)",
        };
      }
      // Decode 17-byte script blocks: { op: u8, aLine: u32, aCount: u32, bLine: u32, bCount: u32 }
      const outLen = returned;
      const dataView = new DataView(memory.buffer, spec.output.addr, outLen);
      const blocks = [];
      const OP_NAMES = { 0: "equal", 1: "delete", 2: "insert" };
      let off = 0;
      while (off + 17 <= outLen) {
        const op = dataView.getUint8(off);
        if (op === 255) break;
        const aLine = dataView.getUint32(off + 1, true);
        const aCount = dataView.getUint32(off + 5, true);
        const bLine = dataView.getUint32(off + 9, true);
        const bCount = dataView.getUint32(off + 13, true);
        blocks.push({ op: OP_NAMES[op] || op, aLine, aCount, bLine, bCount });
        off += 17;
      }
      const rawHex = Buffer.from(memory.buffer, spec.output.addr, outLen).toString("hex");
      return { ok: true, returned, blocks, rawHex, output: rawHex };
    }
    return { ok: false, refused: "unsupported-abi", why: `unknown wasm abi '${spec.abi}'` };
  } catch (err) {
    return {
      ok: false,
      refused: "wasm-trapped",
      why: `the module trapped: ${String(err?.message ?? err).slice(0, 140)}`,
    };
  }
}

/** stdin payload -> { bytes, spec, input }, with buffers carried as base64. */
function decodePayload(raw) {
  const payload = JSON.parse(raw);
  const input = payload.input?.kind === "diff"
    ? { inputA: Buffer.from(payload.input.a, "base64"), inputB: Buffer.from(payload.input.b, "base64") }
    : Buffer.from(payload.input?.b64 ?? "", "base64");
  return { bytes: Buffer.from(payload.bytes, "base64"), spec: payload.spec, input };
}

export const WASM_CHILD_WATCHDOG_MS = 6000;

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const watchdogMs = Number(process.argv[2]) || WASM_CHILD_WATCHDOG_MS;
  const watchdog = setTimeout(() => {
    // Child self-terminates if orphaned or stalled past the host deadline window.
    process.exit(1);
  }, watchdogMs);
  watchdog.unref();

  let raw = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    raw += chunk;
  });
  process.stdin.on("error", () => {
    process.exit(1);
  });
  process.stdin.on("end", () => {
    let result;
    try {
      result = executeWasm(decodePayload(raw));
    } catch (err) {
      result = { ok: false, refused: "wasm-invalid", why: `the payload was not readable: ${String(err?.message ?? err).slice(0, 140)}` };
    }
    process.stdout.on("error", () => {
      process.exit(1);
    });
    process.stdout.write(`${JSON.stringify(result)}\n`, () => {
      clearTimeout(watchdog);
      process.exit(0);
    });
  });
}
