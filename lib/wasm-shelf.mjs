// lib/wasm-shelf.mjs — the digest half of voicebox-beads-4vz (voicebox-beads-qph): the isocan
// wasm shelf at voicebox's OWN gate, provider-under-gate.
//
// THE REASONING, IN THREE SENTENCES (coord, 2026-09-23):
//  1. "The delegation hypothesis names an owner that has not formed" — isocan's invocation
//     runtime is open design (isocan-ti5); there is nothing to delegate to, so the act executes
//     here.
//  2. "An act inherits the boundary of where it executes" — hash/diff are pure functions of
//     caller-supplied bytes; they need no authority that lives in isocan, so voicebox's boundary
//     is the one the act gets.
//  3. "A digest binds bytes to a manifest, not the manifest to an authority" — so the trust root
//     is the HOST'S ADMISSION, and the digest checks bind bytes to what was admitted.
//
// TWO CHECKS, TWO JOBS. The second is NOT belt-and-braces: ~/.isocan/modules/ is mutable by any
// process running as this user, so an admission-time pass says nothing about the bytes at call
// time. (i) ADMISSION: readShelf rehashes each module against the manifest (CAP
// wasm-package-authority's inventory). (ii) CALL TIME: callWasmTool rehashes the file before
// EVERY instantiation (CAP wasm-offscreen-host's rehash-before-worker).
//
// WHAT BOUNDS AN ADMITTED MODULE (voicebox-beads-lgw, answering vb-resolver's three attack
// modules): every call runs in a fresh child process (lib/wasm-worker.mjs), OFF the host's event loop,
// under WASM_CALL_DEADLINE_MS wall-clock and the worker's resourceLimits. An infinite loop dies
// by name (time-exceeded); a memory.grow loop dies against the limits (resource-exceeded); a
// zero-page memory is refused before it is touched (unsupported-abi). The digest still binds
// BYTES, never behavior — the bounds bound behavior's COST, and they are HOST CONSTANTS, not
// admission data: no descriptor may buy itself more time or memory by declaration.
//
// THE ABI FINDING: the shelf manifest declares NO calling convention. The values below were
// MEASURED by driving the modules (2026-09-23): hash.wasm reads its input at a FIXED 0x400 (max
// 8192 bytes), is called with the input LENGTH, returns 32 and writes the digest at 0x2400 (or
// -1 over 8192) — KAT 'abc' → ba7816bf VERIFIED. diff.wasm's buffers are A 0x10000, B 0x20000,
// out 0x30000, but its output format is undecoded, so it is NOT emitted: an ABI nobody drives is
// not a mechanism. When the manifest learns to declare ABIs, this table goes away.

import { readFileSync, statSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { wasmShelfDir } from "./state-dirs.mjs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

/** The measured ABI for shelf tools driven end-to-end (voicebox-beads-9nk). */
export const MEASURED_ABI = {
  hash: {
    abi: "buffer-abi/1",
    input: { addr: 0x400, maxBytes: 8192 },
    output: { addr: 0x2400, bytes: 32 },
    call: { export: "sha256" },
  },
  diff: {
    abi: "buffer-abi/diff",
    inputA: { addr: 0x10000, maxBytes: 65536 },
    inputB: { addr: 0x20000, maxBytes: 65536 },
    output: { addr: 0x30000, maxBytes: 262144 },
    call: { export: "diff" },
  },
};

const sha256hex = (bytes) => createHash("sha256").update(bytes).digest("hex");

/**
 * Read a shelf manifest and ADMISSION-REHASH every tool: data, never a side effect.
 * @returns {{ ok: boolean, refused?: string, why?: string, dir: string, tools: Array<object> }}
 *   Each tool: { id, digest, admitted, refused?, why?, wasmPath, description, capability, abi? }.
 *   `admitted` is the ADMISSION-time verdict only — bytes can change after; call time re-checks.
 */
export function readShelf(dir) {
  const manifestPath = path.join(dir, "manifest.json");
  if (!existsSync(manifestPath)) {
    return { ok: false, refused: "shelf-unavailable", why: `no manifest at ${manifestPath} — a shelf is its manifest, and there is none here`, dir, tools: [] };
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (err) {
    return { ok: false, refused: "shelf-unreadable", why: `the manifest at ${manifestPath} is not JSON: ${String(err?.message ?? err).slice(0, 120)}`, dir, tools: [] };
  }
  const tools = [];
  for (const entry of manifest.tools ?? []) {
    const wasmPath = path.join(dir, entry.wasm ?? "");
    if (!entry.id || !entry.wasm || !existsSync(wasmPath)) {
      tools.push({ id: entry.id ?? "(unnamed)", digest: entry.digest ?? null, admitted: false, refused: "wasm-unreadable", why: `no module at ${wasmPath}`, wasmPath, description: entry.description ?? "", capability: entry.capability ?? "" });
      continue;
    }
    const bytes = readFileSync(wasmPath);
    const measured = sha256hex(bytes);
    if (measured !== entry.digest) {
      tools.push({
        id: entry.id, digest: entry.digest, admitted: false, refused: "digest-mismatch",
        why: `the module at ${wasmPath} hashes ${measured.slice(0, 16)}… but the manifest pins ${String(entry.digest).slice(0, 16)}… — the bytes are not what the catalogue claims; a digest binds bytes to a manifest and these do not bind`,
        wasmPath, description: entry.description ?? "", capability: entry.capability ?? "",
      });
      continue;
    }
    const abi = MEASURED_ABI[entry.id];
    tools.push({
      id: entry.id, digest: entry.digest, admitted: true, wasmPath,
      description: entry.description ?? "", capability: entry.capability ?? "",
      // The ABI is the measured table, and SAYS it is measured — the manifest does not declare it.
      abi: abi ?? null,
      ...(abi ? {} : { note: "admission passed but this tool's calling convention is undeclared and undriven — not emitted as a voicebox tool" }),
    });
  }
  return { ok: true, dir, name: manifest.name ?? path.basename(dir), version: manifest.version ?? "0", tools };
}

/**
 * Map an admitted shelf tool to a voicebox ExtensionDescriptor — the shape the GATE validates
 * and admits. Returns null when the tool has no driven ABI (an ABI nobody drives is not a mechanism).
 */
export function descriptorFor(shelfTool, source = "catalogue") {
  if (!shelfTool.admitted || !shelfTool.abi) return null;
  return {
    id: `wasm-shelf-${shelfTool.id}`,
    name: `wasm shelf: ${shelfTool.id}`,
    description: `${shelfTool.description} (wasm shelf, digest-pinned)`,
    source,
    runsIn: "host",
    capabilities: [],
    bounds: {},
    tools: [
      {
        name: shelfTool.id,
        description: `${shelfTool.description} — wasm, digest ${String(shelfTool.digest).slice(0, 12)}…`,
        primitive: "wasm",
        params: {},
        wasm: { path: shelfTool.wasmPath, digest: shelfTool.digest, ...shelfTool.abi },
      },
    ],
  };
}

/** The host's bounds, not the descriptor's: no declaration buys a module more of either. */
export const WASM_CALL_DEADLINE_MS = 5000;

/**
 * Function declarations for the ADMITTED, DRIVEN shelf tools (voicebox-beads-ri4k) — the live
 * session's tool catalogue carries them beside the fixed commands, so the model can call a
 * shelf tool BY NAME instead of knowing to route through call_extension. Same admission rule
 * as descriptorFor: admitted AND driven-ABI, or the tool does not declare. The schemas mirror
 * what callWasmTool actually reads (input; or a+b for the diff ABI).
 */
export function liveToolDeclarations(dir = wasmShelfDir(), reservedNames = new Set()) {
  const shelf = readShelf(dir);
  if (!shelf.ok) return [];
  const declarations = [];
  for (const tool of shelf.tools) {
    if (!tool.admitted || !tool.abi) continue;
    if (reservedNames.has(tool.id)) continue; // a shelf id never shadows a fixed command (hmco review nit 3)
    const parameters = (tool.abi?.abi ?? tool.abi) === "buffer-abi/diff"
      ? { type: "object", properties: { a: { type: "string", description: "old text" }, b: { type: "string", description: "new text" } }, required: ["a", "b"] }
      : { type: "object", properties: { input: { type: "string", description: "input text to compute over" } }, required: ["input"] };
    declarations.push({
      name: tool.id,
      description: `${tool.description} (wasm shelf, digest-pinned)`,
      parameters,
    });
  }
  return declarations;
}
export const WASM_WORKER_RESOURCE_LIMITS = { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16 };
export const WASM_CHILD_MAX_STDOUT_BYTES = 2 * 1024 * 1024;
// The execution cell is a CHILD PROCESS (voicebox-beads-u2lx), so its bounds are the child's own V8
// flags rather than worker_threads options: the same heap caps, plus a wasm-memory page ceiling so a
// runaway grow loop fails its allocations instead of churning the box on the way to the deadline.
const WASM_CHILD_EXEC_ARGV = [
  `--max-old-space-size=${WASM_WORKER_RESOURCE_LIMITS.maxOldGenerationSizeMb}`,
  `--max-semi-space-size=${WASM_WORKER_RESOURCE_LIMITS.maxYoungGenerationSizeMb}`,
  "--wasm-max-mem-pages=4096",
];
const WASM_CHILD_PATH = fileURLToPath(new URL("./wasm-worker.mjs", import.meta.url));
/** The parent's half runs on the HOST'S event loop (read, hash, compile) before any worker
 *  exists — so the FILE has a size bound too, checked before the read (vb-resolver's fan-out
 *  review: a giant module in the mutable shelf dir would cost host time before any other bound
 *  applies). Call FAN-OUT (voicebox-beads-mbk): concurrent child cells are bounded by a FIFO
 *  semaphore (WASM_MAX_CONCURRENT_WORKERS active, WASM_MAX_QUEUE_DEPTH queued) so parallel
 *  turns cannot spawn unbounded processes. */
export const WASM_MODULE_MAX_BYTES = 16 * 1024 * 1024;
export const WASM_MAX_CONCURRENT_WORKERS = 4;
export const WASM_MAX_QUEUE_DEPTH = 32;

/**
 * Deterministic FIFO concurrency semaphore bounding active wasm child-process cells
 * and waiting callers (voicebox-beads-mbk).
 */
export function createWasmSemaphore({
  maxConcurrent = WASM_MAX_CONCURRENT_WORKERS,
  maxQueueDepth = WASM_MAX_QUEUE_DEPTH,
} = {}) {
  let active = 0;
  let maxObservedActive = 0;
  const queue = [];

  const makeRelease = () => {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      active -= 1;
      if (queue.length > 0) {
        const next = queue.shift();
        active += 1;
        if (active > maxObservedActive) maxObservedActive = active;
        next({ ok: true, release: makeRelease() });
      }
    };
  };

  function acquire({ maxConcurrentOverride, maxQueueDepthOverride } = {}) {
    const limit = Number.isFinite(maxConcurrentOverride) && maxConcurrentOverride > 0
      ? maxConcurrentOverride
      : maxConcurrent;
    const queueCap = Number.isFinite(maxQueueDepthOverride) && maxQueueDepthOverride >= 0
      ? maxQueueDepthOverride
      : maxQueueDepth;

    if (active < limit) {
      active += 1;
      if (active > maxObservedActive) maxObservedActive = active;
      return Promise.resolve({ ok: true, release: makeRelease() });
    }
    if (queue.length >= queueCap) {
      return Promise.resolve({
        ok: false,
        refused: "over-budget",
        why: `the host runs at most ${limit} concurrent wasm cells with ${queueCap} queued (${active} running, ${queue.length} waiting) — call fan-out is bounded by the host`,
      });
    }
    return new Promise((resolve) => {
      queue.push(resolve);
    });
  }

  function stats() {
    return {
      active,
      queued: queue.length,
      maxConcurrent,
      maxQueueDepth,
      maxObservedActive,
    };
  }

  return { acquire, stats };
}

const defaultWasmSemaphore = createWasmSemaphore();

export function getWasmSemaphoreStats() {
  return defaultWasmSemaphore.stats();
}

/**
 * Execute an admitted wasm tool — the CALL-TIME check lives here, in the only path a tool runs.
 * The parent keeps the trusted half (read, rehash, compile, imports); the worker gets only
 * VERIFIED bytes and never touches the host's event loop. buffer-abi/1: input at a fixed
 * address, the export called with the input LENGTH, output read back from a fixed address.
 *
 * @returns {Promise<{ok: boolean, refused?: string, why?: string}>}
 */
export async function callWasmTool(tool, args = {}, options = {}) {
  const spec = tool.wasm;
  // (ii) CALL-TIME REHASH: the bytes about to execute, bound to the admitted digest. The shelf
  // directory is mutable as this user — admission's pass is a fact about THEN, not NOW.
  // The file-size bound comes BEFORE the read: everything in this half runs on the host's own
  // event loop, and a giant file would cost host time before a worker ever exists.
  let stat;
  try {
    stat = statSync(spec.path);
  } catch (err) {
    return { ok: false, refused: "wasm-unreadable", why: `the module at ${spec.path} cannot be read: ${err.code ?? err.message}` };
  }
  if (stat.size > WASM_MODULE_MAX_BYTES) {
    return { ok: false, refused: "over-budget", why: `the module file is ${stat.size} bytes; the host reads and hashes at most ${WASM_MODULE_MAX_BYTES} on its own loop before any other bound — the bound is the host's, not the module's` };
  }
  let bytes;
  try {
    bytes = readFileSync(spec.path);
  } catch (err) {
    return { ok: false, refused: "wasm-unreadable", why: `the module at ${spec.path} cannot be read: ${err.code ?? err.message}` };
  }
  const measured = sha256hex(bytes);
  if (measured !== spec.digest) {
    return {
      ok: false, refused: "digest-mismatch",
      why: `the module at ${spec.path} hashes ${measured.slice(0, 16)}… but admission pinned ${String(spec.digest).slice(0, 16)}… — the bytes changed since admission, so nothing runs`,
    };
  }
  let module_;
  try {
    module_ = new WebAssembly.Module(bytes);
  } catch (err) {
    return { ok: false, refused: "wasm-invalid", why: `the bytes hash correctly but do not compile: ${String(err?.message ?? err).slice(0, 140)}` };
  }
  const imports = WebAssembly.Module.imports(module_);
  if (imports.length > 0) {
    return { ok: false, refused: "import-undeclared", why: `buffer-abi/1 is ZERO imports; this module asks for ${imports.map((i) => `${i.module}.${i.name}`).join(", ")} — a capability the descriptor never declared` };
  }
  let inputPayload;
  let totalInputBytes = 0;
  if (spec.abi === "buffer-abi/diff") {
    const inputA = Buffer.from(String(args.a ?? args.inputA ?? args.oldText ?? ""), "utf8");
    const inputB = Buffer.from(String(args.b ?? args.inputB ?? args.newText ?? ""), "utf8");
    if (inputA.length > spec.inputA.maxBytes || inputB.length > spec.inputB.maxBytes) {
      return { ok: false, refused: "over-budget", why: `input exceeds maximum allowed buffer size (${spec.inputA.maxBytes} bytes)` };
    }
    inputPayload = { inputA, inputB };
    totalInputBytes = inputA.length + inputB.length;
  } else {
    const input = Buffer.from(String(args.input ?? ""), "utf8");
    if (input.length > spec.input.maxBytes) {
      return { ok: false, refused: "over-budget", why: `the input is ${input.length} bytes; this tool's buffer holds ${spec.input.maxBytes} — the bound is part of the admission` };
    }
    inputPayload = input;
    totalInputBytes = input.length;
  }
  // The bounded half: the module runs in a fresh child process with verified bytes, never on this
  // event loop. The deadline, concurrency semaphore, and limits are the host's constants.
  const deadlineMs = Number.isFinite(options?.deadlineMs) && options.deadlineMs > 0
    ? options.deadlineMs
    : (Number.isFinite(spec?.deadlineMs) && spec.deadlineMs > 0 ? spec.deadlineMs : WASM_CALL_DEADLINE_MS);
  const semaphore = options?.semaphore ?? defaultWasmSemaphore;
  const permit = await semaphore.acquire({
    maxConcurrentOverride: options?.maxConcurrent,
    maxQueueDepthOverride: options?.maxQueueDepth,
  });
  if (!permit.ok) {
    return { ok: false, refused: permit.refused, why: permit.why };
  }
  let result;
  try {
    result = await runInWorker(bytes, spec, inputPayload, deadlineMs);
  } finally {
    permit.release();
  }
  if (!result.ok) return result;
  return {
    ok: true,
    action: "wasm",
    tool: tool.name,
    returned: result.returned,
    output: result.output,
    ...(result.blocks ? { blocks: result.blocks } : {}),
    // OBSERVED, not claimed: which bytes ran, and what the input was, so the audit can re-derive.
    digest: spec.digest,
    inputBytes: totalInputBytes,
  };
}

/**
 * Run verified bytes in a fresh CHILD PROCESS under the host's deadline and resource bounds.
 *
 * A worker thread was the first design, and it has a hole voicebox-beads-u2lx measured: a synchronous
 * `memory.grow` loop cannot be preempted, so `worker.terminate()` resolved the promise while the thread
 * kept running ~52s at ~3 cores. Nothing the host can do to a thread beats SIGKILL to a process, so the
 * cell is a process: the deadline kills it outright, the child's V8 flags replace resourceLimits, and
 * the module's growth lands in the child's address space instead of the host's.
 */
function runInWorker(bytes, spec, input, deadlineMs = WASM_CALL_DEADLINE_MS) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [...WASM_CHILD_EXEC_ARGV, WASM_CHILD_PATH], {
      // No inherited environment: the cell gets bytes, a spec and input, nothing else.
      env: {},
      stdio: ["pipe", "pipe", "pipe"],
    });
    let settled = false;
    let stdout = "";
    const finish = (out) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
      resolve(out);
    };
    const timer = setTimeout(() => {
      finish({
        ok: false,
        refused: "time-exceeded",
        why:
          `the module ran past the host's ${deadlineMs}ms deadline and was killed — an admitted module's time is bounded by the host, never by the module`,
      });
    }, deadlineMs);
    timer.unref();
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.length > WASM_CHILD_MAX_STDOUT_BYTES) {
        try {
          child.stdout.destroy();
        } catch {}
        finish({
          ok: false,
          refused: "resource-exceeded",
          why: `the execution cell exceeded the host's stdout bound (${WASM_CHILD_MAX_STDOUT_BYTES} bytes) — unbounded stdout is not permitted`,
        });
      }
    });
    child.stderr.on("data", () => {});
    child.once("error", (err) => {
      finish({
        ok: false,
        refused: "resource-exceeded",
        why: `the execution cell died against the host's resource bounds: ${String(err?.message ?? err).slice(0, 140)}`,
      });
    });
    child.once("close", (code) => {
      const line = stdout.trim().split("\n").filter(Boolean).pop() ?? "";
      let parsed = null;
      try {
        parsed = JSON.parse(line);
      } catch {
        parsed = null;
      }
      if (parsed && typeof parsed === "object" && typeof parsed.ok === "boolean") {
        finish(parsed);
      } else if (code === 0) {
        finish({ ok: false, refused: "wasm-worker-silent", why: "the execution cell exited without a result — an answer nobody observed is not an answer" });
      } else {
        finish({ ok: false, refused: "resource-exceeded", why: `the execution cell exited ${code} against the host's resource bounds` });
      }
    });
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify({
      bytes: Buffer.from(bytes).toString("base64"),
      spec,
      input: input && typeof input === "object" && !Buffer.isBuffer(input)
        ? { kind: "diff", a: Buffer.from(input.inputA ?? []).toString("base64"), b: Buffer.from(input.inputB ?? []).toString("base64") }
        : { b64: Buffer.from(input ?? []).toString("base64") },
    }));
  });
}
