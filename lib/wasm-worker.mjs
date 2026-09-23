// lib/wasm-worker.mjs — the bounded execution cell for buffer-abi/1 modules (voicebox-beads-lgw).
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
    parentPort.postMessage({ ok: false, refused: "import-undeclared", why: `buffer-abi/1 is ZERO imports; this module asks for ${imports.map((i) => `${i.module}.${i.name}`).join(", ")}` });
  } else {
    const instance = new WebAssembly.Instance(module_, {});
    const fn = instance.exports[spec.call.export];
    const memory = instance.exports.memory;
    if (typeof fn !== "function" || !(memory instanceof WebAssembly.Memory)) {
      parentPort.postMessage({ ok: false, refused: "unsupported-abi", why: `the module exports no '${spec.call.export}' function or no memory — the bytes are not buffer-abi/1` });
    } else {
      // The declared addresses are TRUSTED input, not verified fact (vb-resolver's crash):
      // the memory must cover everything the ABI declares BEFORE the view is touched.
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
    }
  }
} catch (err) {
  parentPort.postMessage({ ok: false, refused: "wasm-trapped", why: `the module trapped: ${String(err?.message ?? err).slice(0, 140)}` });
}
