#!/usr/bin/env node
// tools/build-wasm.mjs — .wat -> .wasm, offline, no toolchain beyond one devDependency.
//
//   npm run build:wasm
//
// WHY THE ARTEFACT IS COMMITTED: the browser cannot compile WebAssembly text, and the runtime is
// zero-dependency. So the .wat stays the source of truth (it is hand-written and readable) and
// the .wasm beside it is the build output of this script. `npm test` recompiles from source and
// fails if the committed bytes differ, which is what stops the two from drifting apart silently —
// the same failure mode N18 exists to prevent, one level down.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import wabt from "wabt";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PAIRS = [
  ["tools/create-asset.wat", "tools/create-asset.wasm"],
  ["tests/fixtures/fetch-import.wat", "tests/fixtures/fetch-import.wasm"],
  ["tests/fixtures/trap.wat", "tests/fixtures/trap.wasm"],
];

const wabtModule = await wabt();

export function compile(source) {
  const parsed = wabtModule.parseWat("tool.wat", source, { bulk_memory: false, sign_extension: false });
  const { buffer } = parsed.toBinary({ write_debug_names: false });
  parsed.destroy();
  return Buffer.from(buffer);
}

export function compileFile(watPath) {
  return compile(readFileSync(path.join(ROOT, watPath), "utf8"));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  for (const [wat, wasm] of PAIRS) {
    const bytes = compileFile(wat);
    writeFileSync(path.join(ROOT, wasm), bytes);
    console.log(`${wasm}: ${bytes.length} bytes`);
  }
}
