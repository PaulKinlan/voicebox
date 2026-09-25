// lib/wasm-worker.mjs — the bounded execution cell for wasm modules (voicebox-beads-lgw, voicebox-beads-9nk).
//
// Runs OFF the host's event loop: the host spawns this worker per call, hands it the VERIFIED
// bytes (the digest check happens in the parent, before anything here), and terminates it at a
// deadline. An infinite loop dies by name at the deadline; a memory.grow loop dies against the
// worker's resourceLimits. Nothing here is trusted with the host's process.
import { parentPort, workerData } from "node:worker_threads";

const { bytes, spec, input } = workerData;

try {
  const module_ = new WebAssembly.Module(bytes);
  const imports = WebAssembly.Module.imports(module_);
  if (imports.length > 0) {
    parentPort.postMessage({ ok: false, refused: "import-undeclared", why: `wasm tools require ZERO imports; this module asks for ${imports.map((i) => `${i.module}.${i.name}`).join(", ")}` });
  } else {
    const instance = new WebAssembly.Instance(module_, {});
    const fn = instance.exports[spec.call.export];
    const memory = instance.exports.memory;
    if (typeof fn !== "function" || !(memory instanceof WebAssembly.Memory)) {
      parentPort.postMessage({ ok: false, refused: "unsupported-abi", why: `the module exports no '${spec.call.export}' function or no memory — the bytes do not match declared abi '${spec.abi}'` });
    } else if (spec.abi === "buffer-abi/1") {
      const needed = Math.max(spec.input.addr + spec.input.maxBytes, spec.output.addr + spec.output.bytes);
      if (memory.buffer.byteLength < needed) {
        parentPort.postMessage({ ok: false, refused: "unsupported-abi", why: `the module's memory is ${memory.buffer.byteLength} bytes but the declared ABI needs ${needed} (input at ${spec.input.addr}+${spec.input.maxBytes}, output at ${spec.output.addr}+${spec.output.bytes}) — the bytes are not buffer-abi/1` });
      } else {
        const view = new Uint8Array(memory.buffer);
        view.set(input, spec.input.addr);
        const returned = fn(input.length);
        const output = Buffer.from(memory.buffer, spec.output.addr, spec.output.bytes);
        parentPort.postMessage({ ok: true, returned, output: output.toString("hex") });
      }
    } else if (spec.abi === "buffer-abi/diff") {
      const needed = Math.max(
        spec.inputA.addr + spec.inputA.maxBytes,
        spec.inputB.addr + spec.inputB.maxBytes,
        spec.output.addr + spec.output.maxBytes,
      );
      if (memory.buffer.byteLength < needed) {
        parentPort.postMessage({ ok: false, refused: "unsupported-abi", why: `the module's memory is ${memory.buffer.byteLength} bytes but the declared ABI needs ${needed}` });
      } else {
        const inputA = input?.inputA || Buffer.alloc(0);
        const inputB = input?.inputB || Buffer.alloc(0);
        const view = new Uint8Array(memory.buffer);
        view.set(inputA, spec.inputA.addr);
        view.set(inputB, spec.inputB.addr);
        const returned = fn(inputA.length, inputB.length);
        if (returned < 0) {
          parentPort.postMessage({ ok: false, refused: "diff-failed", why: "diff calculation returned negative length (script overflow or invalid inputs)" });
        } else {
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
            blocks.push({
              op: OP_NAMES[op] || op,
              aLine,
              aCount,
              bLine,
              bCount,
            });
            off += 17;
          }
          const rawHex = Buffer.from(memory.buffer, spec.output.addr, outLen).toString("hex");
          parentPort.postMessage({ ok: true, returned, blocks, rawHex, output: rawHex });
        }
      }
    } else {
      parentPort.postMessage({ ok: false, refused: "unsupported-abi", why: `unknown wasm abi '${spec.abi}'` });
    }
  }
} catch (err) {
  parentPort.postMessage({ ok: false, refused: "wasm-trapped", why: `the module trapped: ${String(err?.message ?? err).slice(0, 140)}` });
}
