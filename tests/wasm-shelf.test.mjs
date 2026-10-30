// tests/wasm-shelf.test.mjs — the digest half of 4vz, driven (voicebox-beads-qph).
//
//   node --test tests/wasm-shelf.test.mjs
//
// TWO CHECKS, TWO JOBS: admission rehash binds the module's bytes to the catalogue entry;
// call-time rehash binds the bytes about to execute to the admitted digest — non-redundant
// because the shelf directory is MUTABLE AS THIS USER. The tamper cases are the artefact:
// a flipped byte at admission, and a swapped module AFTER admission, both refused by name.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, cpSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { readShelf, descriptorFor, liveToolDeclarations } from "../lib/wasm-shelf.mjs";
import { admit } from "../core/extensions.ts";

const REAL_SHELF = path.join(os.homedir(), ".isocan", "modules", "wasm-tools");
const SHA256_ABC = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

let scratch;
let shelf; // the scratch COPY of the real shelf — the real one is never touched

const hasShelf = existsSync(REAL_SHELF);
const needsShelf = (t) => {
  if (!hasShelf) {
    t.skip("no isocan shelf installed on this box");
    return true;
  }
  return false;
};

/** A FRESH copy per test that mutates: a tamper in one test must never leak into another's admission. */
function freshShelf(name) {
  const dir = path.join(scratch, name);
  cpSync(REAL_SHELF, dir, { recursive: true });
  return dir;
}

test.before(() => {
  scratch = mkdtempSync(path.join(os.tmpdir(), "voicebox-wasm-shelf-"));
  if (hasShelf) shelf = freshShelf("shelf");
});

test.after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

test("admission rehash: an untampered shelf admits, and the digest in the manifest is the one measured", (t) => {
  if (needsShelf(t)) return;
  const out = readShelf(shelf);
  assert.equal(out.ok, true, JSON.stringify(out));
  const hash = out.tools.find((t) => t.id === "hash");
  assert.equal(hash.admitted, true, "the hash tool passes admission on untampered bytes");
  assert.equal(hash.abi.abi, "buffer-abi/1");
  const diff = out.tools.find((t) => t.id === "diff");
  assert.equal(diff.admitted, true, "diff's bytes verify against its manifest digest");
  assert.equal(diff.abi.abi, "buffer-abi/diff", "diff's ABI is declared and driven (voicebox-beads-9nk)");
});

test("ADMISSION TAMPER: one flipped byte in the module is digest-mismatch, named with both digests", (t) => {
  if (needsShelf(t)) return;
  const tampered = freshShelf("tampered");
  const wasmPath = path.join(tampered, "assets", "hash.wasm");
  const bytes = readFileSync(wasmPath);
  bytes[100] ^= 0xff; // one byte — the smallest possible lie
  writeFileSync(wasmPath, bytes);
  const out = readShelf(tampered);
  const hash = out.tools.find((t) => t.id === "hash");
  assert.equal(hash.admitted, false);
  assert.equal(hash.refused, "digest-mismatch");
  assert.match(hash.why, /hashes [0-9a-f]{16}… but the manifest pins [0-9a-f]{16}…/, "the refusal shows BOTH digests — evidence, not just a verdict");
});

test("the gate: a wasm tool without a digest is under-declared; an undriven ABI is unsupported-abi; buffer-abi/1 with a 64-hex digest passes", (t) => {
  if (needsShelf(t)) return;
  const shelfOut = readShelf(shelf);
  const hash = shelfOut.tools.find((t) => t.id === "hash");
  const descriptor = descriptorFor(hash);
  assert.ok(descriptor, "an admitted shelf tool with a driven ABI maps to a descriptor");

  const good = admit(descriptor, "machine", new Set());
  assert.equal(good.decision, "admitted", JSON.stringify(good));

  const noDigest = JSON.parse(JSON.stringify(descriptor));
  delete noDigest.tools[0].wasm.digest;
  const refused1 = admit(noDigest, "machine", new Set());
  assert.equal(refused1.decision, "refused");
  assert.equal(refused1.rule, "under-declared", "no digest = a module nobody can verify = under-declared");

  const badAbi = JSON.parse(JSON.stringify(descriptor));
  badAbi.tools[0].wasm.abi = "wasi/preview2";
  const refused2 = admit(badAbi, "machine", new Set());
  assert.equal(refused2.decision, "refused");
  assert.equal(refused2.rule, "unsupported-abi", "an ABI nobody drives is not a mechanism");
});

// The full seam, in-process: propose → the host admits → callTool runs the module — and the
// CALL-TIME rehash refuses a module swapped AFTER admission. env is set BEFORE the import of
// lib/extensions.mjs, whose module state (workspace, host dir) is read at import.
test("through the seam: the KAT passes, and a post-admission swap is digest-mismatch at call time", async (t) => {
  if (needsShelf(t)) return;
  const ws = path.join(scratch, "seam-ws");
  const ext = path.join(scratch, "seam-ext");
  mkdirSync(ws, { recursive: true });
  mkdirSync(ext, { recursive: true });
  process.env.VOICEBOX_WORKSPACE = ws;
  process.env.VOICEBOX_EXTENSIONS_DIR = ext;
  const extensions = await import("../lib/extensions.mjs");

  const shelfOut = readShelf(shelf);
  const descriptor = descriptorFor(shelfOut.tools.find((t) => t.id === "hash"));
  const proposed = extensions.propose(descriptor, "catalogue");
  assert.equal(proposed.ok, true, JSON.stringify(proposed));
  const admitted = extensions.admitProposal(proposed.id, "admit", "test-host");
  assert.equal(admitted.ok, true, JSON.stringify(admitted));

  // THE HAPPY PATH IS A KNOWN-ANSWER TEST: sha256('abc') has exactly one right answer.
  const called = await extensions.callTool("hash", { input: "abc" });
  assert.equal(called.ok, true, JSON.stringify(called));
  assert.equal(called.output, SHA256_ABC, "the digest of 'abc' — the module really ran, and really is sha256");
  assert.equal(called.returned, 32);
  assert.equal(called.digest, descriptor.tools[0].wasm.digest, "the audit carries WHICH bytes ran");

  // THE SWAP: the admission passed a moment ago; the bytes on disk change now. The next call
  // must refuse — ~/.isocan/modules/ is mutable as this user, which is why the second check exists.
  const wasmPath = path.join(shelf, "assets", "hash.wasm");
  const original = readFileSync(wasmPath);
  const swapped = readFileSync(wasmPath);
  swapped[200] ^= 0xff;
  writeFileSync(wasmPath, swapped);
  const refused = await extensions.callTool("hash", { input: "abc" });
  assert.equal(refused.ok, false);
  assert.equal(refused.refused, "digest-mismatch");
  assert.match(refused.why, /the bytes changed since admission/, "the refusal names the call-time check, not a generic failure");
  writeFileSync(wasmPath, original); // restore — the shelf outlives the assertion
});

test("a module whose memory does not cover the declared ABI is a NAMED refusal, never an uncaught throw (vb-resolver's crash, driven)", async (t) => {
  if (needsShelf(t)) return;
  // vb-resolver's defect: a zero-page-memory module crashed the driver with an UNCAUGHT
  // RangeError — a 500 through the turn path, not a refusal. The fix checks the memory covers
  // everything the ABI declares BEFORE the view is touched. Driven here with the real module
  // and a descriptor that LIES about addresses (the same code path as a small-memory module).
  const shelfOut = readShelf(shelf);
  const descriptor = descriptorFor(shelfOut.tools.find((t) => t.id === "hash"));
  const liar = JSON.parse(JSON.stringify(descriptor));
  liar.tools[0].wasm.input.addr = 0x1f000; // + 8192 maxBytes exceeds the module's 128 KiB
  const { callWasmTool } = await import("../lib/wasm-shelf.mjs");
  const out = await callWasmTool(liar.tools[0], { input: "abc" });
  assert.equal(out.ok, false);
  assert.equal(out.refused, "unsupported-abi");
  assert.match(out.why, /memory is \d+ bytes but the declared ABI needs \d+/, "the refusal shows both sizes — evidence, not a stack trace");
});

// ── voicebox-beads-lgw: the resource bounds, proven against the reviewer's attacks ─────────

/** Hand-assembled attack modules (no wabt), equivalents of vb-resolver's originals. Each
 *  validates, and each hashes to whatever its descriptor pins — so admission passes them BY
 *  CONSTRUCTION, which is the point: the digest binds bytes, never behavior. */
const leb = (n) => { const out = []; do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; out.push(b); } while (n); return out; };
const section = (id, body) => [id, ...leb(body.length), ...body];
const name = (s) => [...leb(s.length), ...Buffer.from(s)];
const attackModule = (bodyBytes) => Buffer.from([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
  ...section(1, [...leb(1), 0x60, 0x01, 0x7f, 0x01, 0x7f]), // type: (i32) -> i32
  ...section(3, [...leb(1), 0x00]), // one function, type 0
  ...section(5, [...leb(1), 0x00, 0x01]), // one memory, min 1 page
  ...section(7, [...leb(2), ...name("memory"), 0x02, 0x00, ...name("sha256"), 0x00, 0x00]), // exports
  ...section(10, [...leb(1), ...leb(bodyBytes.length), ...bodyBytes]),
]);
// (loop (br 0)) then unreachable — an export that never returns (the trailing unreachable makes
// the fallthru explicitly dead; without it the body does not validate).
const LOOP_MODULE = attackModule([0x00, 0x03, 0x40, 0x0c, 0x00, 0x0b, 0x00, 0x0b]);
// (loop (drop (memory.grow (i32.const 1))) (br 0)) then unreachable — an export that grows forever.
const GROW_MODULE = attackModule([0x00, 0x03, 0x40, 0x41, 0x01, 0x40, 0x00, 0x1a, 0x0c, 0x00, 0x0b, 0x00, 0x0b]);

const attackTool = (bytes) => ({
  name: "attack",
  wasm: {
    path: null, // filled per test — the file must exist for the rehash
    digest: createHash("sha256").update(bytes).digest("hex"),
    abi: "buffer-abi/1",
    input: { addr: 0x400, maxBytes: 8192 },
    output: { addr: 0x2400, bytes: 32 },
    call: { export: "sha256" },
  },
});

test("LGW: the loop module is terminated BY NAME at the host's deadline — and the host answers after (vb-resolver's hang)", async () => {
  const file = path.join(scratch, "loop.wasm");
  writeFileSync(file, LOOP_MODULE);
  const tool = attackTool(LOOP_MODULE);
  tool.wasm.path = file;
  const { callWasmTool, WASM_CALL_DEADLINE_MS } = await import("../lib/wasm-shelf.mjs");
  assert.equal(WASM_CALL_DEADLINE_MS, 5000);
  const started = Date.now();
  const out = await callWasmTool(tool, { input: "abc" }, { deadlineMs: 200 });
  const elapsed = Date.now() - started;
  assert.equal(out.ok, false);
  assert.equal(out.refused, "time-exceeded", "the hang dies by name, not by someone's kill switch");
  assert.ok(elapsed < 2000, `terminated near the deadline (${elapsed}ms), never hung`);
  assert.match(out.why, /bounded by the host/, "the refusal names whose bound it is");

  // The host's event loop never noticed: the KAT answers immediately after.
  if (hasShelf) {
    const shelfOut = readShelf(shelf);
    const descriptor = descriptorFor(shelfOut.tools.find((t) => t.id === "hash"));
    const kat = await import("../lib/wasm-shelf.mjs").then((m) => m.callWasmTool(descriptor.tools[0], { input: "abc" }));
    assert.equal(kat.ok, true, "the host is alive and answering after the attack");
    assert.equal(kat.output, SHA256_ABC);
  }
});

test("LGW: the grow module dies against the host's bounds, named — and the host's memory is untouched (vb-resolver's grow-loop)", async () => {
  const file = path.join(scratch, "grow.wasm");
  writeFileSync(file, GROW_MODULE);
  const tool = attackTool(GROW_MODULE);
  tool.wasm.path = file;
  const { callWasmTool } = await import("../lib/wasm-shelf.mjs");
  const hostBefore = process.memoryUsage().rss;
  const out = await callWasmTool(tool, { input: "abc" }, { deadlineMs: 200 });
  assert.equal(out.ok, false);
  assert.ok(["resource-exceeded", "time-exceeded"].includes(out.refused), `the grow dies by a named bound (got ${out.refused})`);
  const hostDelta = process.memoryUsage().rss - hostBefore;
  assert.ok(hostDelta < 256 * 1024 * 1024, `the HOST's memory is untouched by the module's growth (delta ${Math.round(hostDelta / 1048576)}MB)`);

  if (hasShelf) {
    const shelfOut = readShelf(shelf);
    const descriptor = descriptorFor(shelfOut.tools.find((t) => t.id === "hash"));
    const kat = await import("../lib/wasm-shelf.mjs").then((m) => m.callWasmTool(descriptor.tools[0], { input: "abc" }));
    assert.equal(kat.ok, true, "the host is alive and answering after the attack");
  }
});

test("LGW follow-up: a module file over the host's read bound is refused BEFORE the read — the parent's half costs the host's own loop (vb-resolver's fan-out review)", async () => {
  const file = path.join(scratch, "giant.wasm");
  const { callWasmTool, WASM_MODULE_MAX_BYTES } = await import("../lib/wasm-shelf.mjs");
  writeFileSync(file, Buffer.alloc(WASM_MODULE_MAX_BYTES + 1, 0x60)); // one byte past the bound
  const tool = attackTool(readFileSync(file));
  tool.wasm.path = file;
  const out = await callWasmTool(tool, { input: "abc" });
  assert.equal(out.ok, false);
  assert.equal(out.refused, "over-budget");
  assert.match(out.why, /the module file is \d+ bytes; the host reads and hashes at most \d+/, "the refusal shows both sizes — and the read never happened");
});

test("u2lx advisory: child-side watchdog terminates orphan process when stdin is held open", async () => {
  const { spawn } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const wasmChildPath = fileURLToPath(new URL("../lib/wasm-worker.mjs", import.meta.url));
  const { WASM_CHILD_WATCHDOG_MS } = await import("../lib/wasm-worker.mjs");
  assert.equal(typeof WASM_CHILD_WATCHDOG_MS, "number");
  assert.ok(WASM_CHILD_WATCHDOG_MS >= 5000);

  // Spawn child with a 150ms watchdog and leave stdin open (simulating an orphaned child with unclosed stdin).
  // The elapsed time includes Node's startup in a separate process, which can exceed 2s in the
  // concurrent unit tier; the observed exit and the minimum elapsed time prove the child watchdog fired.
  // The wall-clock upper bound is NOT reintroduced (it flakes under concurrent load): instead the
  // child reports the deadline it actually armed on stderr when the watchdog fires, so an
  // implementation that silently ignores the argv[2] override and arms the 6000ms default fails
  // the deadline assertion below deterministically.
  const started = Date.now();
  const child = spawn(process.execPath, [wasmChildPath, "150"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderrText = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderrText += chunk; });

  const outcome = await new Promise((resolve, reject) => {
    const hangTimer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
      reject(new Error("child hung past watchdog deadline — watchdog failed to terminate orphan"));
      // 90s, not 10s (voicebox-beads-i9k0): this is a HANG detector. On the 2026-10-30 14:12 gate the box was at
      // load 9 and this fired while the child was still starting - spawning node and loading wasm inside a
      // 7-worker unit lane can take longer than ten seconds, and the assertions below (exit signal, elapsed >= 140,
      // the armed deadline on stderr) are what actually prove the watchdog works. A watchdog that never fires still
      // fails, at 90s instead of 10s.
    }, 90000);
    child.once("close", (c, s) => {
      clearTimeout(hangTimer);
      resolve({ code: c, signal: s });
    });
  });
  const elapsed = Date.now() - started;

  // The watchdog is a worker thread that cannot process.exit() the cell (node 24: that exits only the
  // worker), so it self-signals SIGKILL — observed as a signal death, never a clean exit.
  assert.ok(outcome.signal === "SIGKILL" || outcome.code === 1,
    `child self-terminates on watchdog expiry (code ${outcome.code}, signal ${outcome.signal})`);
  assert.ok(elapsed >= 140, `watchdog must not fire before its 150ms deadline (${elapsed}ms)`);
  assert.match(stderrText, /watchdog fired after 150ms/,
    "the child armed the 150ms argv[2] override — a child that reports the 6000ms default here is silently ignoring its override");
});

test("zpti: the watchdog fires with the main thread BLOCKED in a sync wasm loop — the parent-death guard", async () => {
  const { spawn } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const wasmChildPath = fileURLToPath(new URL("../lib/wasm-worker.mjs", import.meta.url));

  // The orphan case itself: the parent STAYS ALIVE and never kills (a live host's deadline would mask
  // the guard), the child is handed a module whose export is a synchronous infinite loop (u2lx's
  // un-preemptable case — the main thread never returns to a safepoint), and the ONLY thing that can
  // end it is a watchdog running OFF that thread. Before the worker-thread watchdog this test's child
  // spun until the hang timer SIGKILLed it and the test failed.
  const child = spawn(process.execPath, [wasmChildPath, "600"], { stdio: ["pipe", "pipe", "pipe"] });
  let stderrText = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderrText += chunk; });
  child.stdin.end(JSON.stringify({
    bytes: LOOP_MODULE.toString("base64"),
    spec: attackTool(LOOP_MODULE).wasm,
    input: { b64: Buffer.from("abc").toString("base64") },
  }));

  const started = Date.now();
  const outcome = await new Promise((resolve, reject) => {
    const hangTimer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
      reject(new Error("child outlived its 600ms watchdog while blocked in a sync loop — the parent-death guard failed"));
      // 90s, same reason as the arm above: a hang detector, not an assertion about how fast a loaded box can
      // start a child. The arm still fails if the parent-death guard never fires.
    }, 90000);
    child.once("close", (c, s) => {
      clearTimeout(hangTimer);
      resolve({ code: c, signal: s });
    });
  });
  const elapsed = Date.now() - started;

  assert.ok(outcome.signal === "SIGKILL" || outcome.code === 1,
    `the blocked child self-terminates on watchdog expiry (code ${outcome.code}, signal ${outcome.signal})`);
  assert.ok(elapsed >= 500, `watchdog must not fire before its 600ms deadline (${elapsed}ms)`);
  assert.match(stderrText, /watchdog fired after 600ms/, "the watchdog that fired is the one this child armed");
});

test("zpti: the host derives the child's watchdog deadline — strictly past the host's own, floored at the child default", async () => {
  const { wasmChildWatchdogMs, WASM_CHILD_WATCHDOG_SLACK_MS, WASM_CALL_DEADLINE_MS } = await import("../lib/wasm-shelf.mjs");
  const { WASM_CHILD_WATCHDOG_MS } = await import("../lib/wasm-worker.mjs");
  assert.equal(typeof wasmChildWatchdogMs, "function");
  assert.ok(WASM_CHILD_WATCHDOG_SLACK_MS > 0);
  // Strictly past the host deadline at every scale: a live host's SIGKILL must land FIRST, or the
  // orphan guard becomes the primary bound and the named time-exceeded refusal is lost.
  assert.ok(wasmChildWatchdogMs(200) > 200);
  assert.ok(wasmChildWatchdogMs(60_000) > 60_000);
  assert.equal(wasmChildWatchdogMs(60_000), 60_000 + WASM_CHILD_WATCHDOG_SLACK_MS, "past the floor, deadline plus slack exactly");
  // Floored at the child's own default: an orphan never spins longer than the guard the box already knows.
  assert.equal(wasmChildWatchdogMs(200), WASM_CHILD_WATCHDOG_MS);
  assert.equal(wasmChildWatchdogMs(WASM_CALL_DEADLINE_MS), WASM_CHILD_WATCHDOG_MS);
});

test("u2lx advisory: child stdout exceeding host bound is refused as resource-exceeded and killed with SIGKILL", async () => {
  const { callWasmTool, WASM_CHILD_MAX_STDOUT_BYTES } = await import("../lib/wasm-shelf.mjs");
  assert.equal(typeof WASM_CHILD_MAX_STDOUT_BYTES, "number");
  assert.ok(WASM_CHILD_MAX_STDOUT_BYTES > 0);

  // Module with 40 pages (2.5MB) of initial memory returning 32 and allocating a large output region
  const BIG_OUTPUT_MODULE = Buffer.from([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    ...section(1, [...leb(1), 0x60, 0x01, 0x7f, 0x01, 0x7f]), // type: (i32) -> i32
    ...section(3, [...leb(1), 0x00]), // one function, type 0
    ...section(5, [...leb(1), 0x00, 0x28]), // one memory, min 40 pages (2.5MB)
    ...section(7, [...leb(2), ...name("memory"), 0x02, 0x00, ...name("sha256"), 0x00, 0x00]), // exports
    ...section(10, [...leb(1), ...leb(4), 0x00, 0x41, 0x20, 0x0b]), // 0 locals, i32.const 32, end
  ]);

  const file = path.join(scratch, "big-output.wasm");
  writeFileSync(file, BIG_OUTPUT_MODULE);
  const tool = {
    name: "big-output",
    wasm: {
      path: file,
      digest: createHash("sha256").update(BIG_OUTPUT_MODULE).digest("hex"),
      abi: "buffer-abi/1",
      input: { addr: 0x400, maxBytes: 8192 },
      output: { addr: 0x1000, bytes: 1.5 * 1024 * 1024 }, // 1.5MB bytes -> 3MB hex on stdout (> 2MB bound)
      call: { export: "sha256" },
    },
  };

  // deadlineMs 30s: the deadline is NOT the thing under test — the stdout bound is. At the 5s default
  // the child (~2.4s of node boot + 3MB hex + pipe drain on this box) has only ~2.5s of headroom, and
  // under a concurrent unit tier the deadline fired first and masked the bound's verdict as
  // time-exceeded (measured red in the 2026-10-28 pre-push run, voicebox-beads-zpti).
  const out = await callWasmTool(tool, { input: "abc" }, { deadlineMs: 30000 });
  assert.equal(out.ok, false);
  assert.equal(out.refused, "resource-exceeded");
  assert.match(out.why, /stdout bound/);
  assert.match(out.why, new RegExp(String(WASM_CHILD_MAX_STDOUT_BYTES)));
});

test("the REAL shelf on this box, if present, admits hash and answers the KAT through the driver", async (t) => {
  if (!existsSync(REAL_SHELF)) return t.skip("no isocan shelf installed on this box");
  const out = readShelf(REAL_SHELF);
  assert.equal(out.ok, true);
  const hash = out.tools.find((t) => t.id === "hash");
  assert.equal(hash.admitted, true, "the installed shelf's hash module verifies against its manifest");
  const { callWasmTool } = await import("../lib/wasm-shelf.mjs");
  const descriptor = descriptorFor(hash);
  const called = await callWasmTool(descriptor.tools[0], { input: "abc" });
  assert.equal(called.ok, true, JSON.stringify(called));
  assert.equal(called.output, SHA256_ABC);
});

test("diff.wasm: output format decoded and declared (Hirschberg line edit script)", async (t) => {
  if (needsShelf(t)) return;
  const shelfOut = readShelf(shelf);
  const diffTool = shelfOut.tools.find((t) => t.id === "diff");
  assert.ok(diffTool.admitted);
  assert.equal(diffTool.abi.abi, "buffer-abi/diff");
  const descriptor = descriptorFor(diffTool);
  assert.ok(descriptor);
  assert.equal(descriptor.tools[0].wasm.abi, "buffer-abi/diff");

  const { callWasmTool } = await import("../lib/wasm-shelf.mjs");
  const textA = "alpha\nbeta\n";
  const textB = "alpha\ngamma\nbeta\n";
  const called = await callWasmTool(descriptor.tools[0], { a: textA, b: textB });
  assert.equal(called.ok, true, JSON.stringify(called));
  assert.equal(called.returned, 52);
  assert.equal(called.blocks.length, 3);
  assert.deepEqual(called.blocks[0], { op: "equal", aLine: 0, aCount: 1, bLine: 0, bCount: 1 });
  assert.deepEqual(called.blocks[1], { op: "insert", aLine: 0, aCount: 0, bLine: 1, bCount: 1 });
  assert.deepEqual(called.blocks[2], { op: "equal", aLine: 1, aCount: 1, bLine: 2, bCount: 1 });
});

test("wasm shelf hookup: catalogue discovery surfaces shelf tools and callTool executes via o45 seam", async (t) => {
  if (needsShelf(t)) return;
  const ws = path.join(scratch, "hookup-ws");
  const ext = path.join(scratch, "hookup-ext");
  mkdirSync(ws, { recursive: true });
  mkdirSync(ext, { recursive: true });
  process.env.VOICEBOX_WORKSPACE = ws;
  process.env.VOICEBOX_EXTENSIONS_DIR = ext;
  process.env.VOICEBOX_WASM_SHELF_DIR = shelf;
  const extensions = await import("../lib/extensions.mjs");

  // 1. Catalogue discovery: shelf tools surface with their measured boundary
  const cat = extensions.catalogue();
  const hashEntry = cat.find((e) => e.id === "wasm-shelf-hash");
  assert.ok(hashEntry, "wasm-shelf-hash must surface in catalogue");
  assert.equal(hashEntry.wasm.abi, "buffer-abi/1");
  assert.equal(hashEntry.wasm.imports, 0);
  assert.equal(hashEntry.preview.decision, "admitted");

  const diffEntry = cat.find((e) => e.id === "wasm-shelf-diff");
  assert.ok(diffEntry, "wasm-shelf-diff must surface in catalogue");
  assert.equal(diffEntry.wasm.abi, "buffer-abi/diff");
  assert.equal(diffEntry.wasm.imports, 0);
  assert.equal(diffEntry.preview.decision, "admitted");

  // 2. Sideload and admit diff tool through the shared seam
  const proposed = extensions.sideload("wasm-shelf-diff");
  assert.equal(proposed.ok, true, JSON.stringify(proposed));
  const admitted = extensions.admitProposal(proposed.id, "admit", "test-host");
  assert.equal(admitted.ok, true, JSON.stringify(admitted));

  // 3. callTool runs the admitted diff tool
  const result = await extensions.callTool("diff", {
    a: "line 1\nline 2\n",
    b: "line 1\nline 1.5\nline 2\n",
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.action, "wasm");
  assert.equal(result.tool, "diff");
  assert.ok(Array.isArray(result.blocks));
  assert.equal(result.blocks.length, 3);
  assert.equal(result.blocks[1].op, "insert");
});

test("live tool declarations: admitted+driven tools declare with per-ABI schemas; undriven tools do not (voicebox-beads-ri4k)", (t) => {
  if (needsShelf(t)) return;
  const out = readShelf(shelf);
  const declarations = liveToolDeclarations(shelf);
  const byName = Object.fromEntries(declarations.map((d) => [d.name, d]));

  const hash = out.tools.find((tool) => tool.id === "hash");
  assert.ok(hash?.admitted, "fixture: hash is admitted");
  assert.equal(byName.hash.name, "hash", "the declaration is named for direct calls");
  assert.equal(byName.hash.parameters.required[0], "input", "buffer-abi/1 takes input");
  assert.match(byName.hash.description, /digest-pinned/);

  const diff = out.tools.find((tool) => tool.id === "diff");
  assert.ok(diff?.admitted, "fixture: diff is admitted");
  assert.deepEqual(byName.diff.parameters.required, ["a", "b"], "the diff ABI takes a and b");
  assert.ok(byName.diff.parameters.properties.a && byName.diff.parameters.properties.b);
  // The reserved set pins the closure: a shelf id colliding with a fixed command never declares (hmco nit 3).
  const withReserved = liveToolDeclarations(shelf, new Set(["hash"]));
  assert.deepEqual(withReserved.map((d) => d.name), ["diff"], "a reserved shelf id is not declared");
});

test("mbk: FIFO concurrency semaphore caps active wasm worker cells and releases permits on completion/timeout", { timeout: 10000 }, async () => {
  const {
    callWasmTool,
    createWasmSemaphore,
    getWasmSemaphoreStats,
    WASM_MAX_CONCURRENT_WORKERS,
    WASM_MAX_QUEUE_DEPTH,
  } = await import("../lib/wasm-shelf.mjs");
  assert.equal(WASM_MAX_CONCURRENT_WORKERS, 4);
  assert.equal(WASM_MAX_QUEUE_DEPTH, 32);
  assert.equal(typeof getWasmSemaphoreStats().active, "number");

  const file = path.join(scratch, "mbk-loop-cap.wasm");
  writeFileSync(file, LOOP_MODULE);
  const tool = attackTool(LOOP_MODULE);
  tool.wasm.path = file;

  const semaphore = createWasmSemaphore({ maxConcurrent: 2, maxQueueDepth: 10 });
  const results = await Promise.all(
    Array.from({ length: 6 }, () => callWasmTool(tool, { input: "abc" }, { semaphore, deadlineMs: 60 })),
  );

  for (const res of results) {
    assert.equal(res.ok, false);
    assert.equal(res.refused, "time-exceeded");
  }
  const stats = semaphore.stats();
  assert.equal(stats.maxObservedActive, 2, "at most 2 worker cells ran concurrently across 6 parallel calls");
  assert.equal(stats.active, 0, "all permits released after completion");
  assert.equal(stats.queued, 0, "queue is empty after completion");
});

test("mbk: queue overflow is refused by name as over-budget when fan-out exceeds maxQueueDepth", { timeout: 10000 }, async () => {
  const { callWasmTool, createWasmSemaphore } = await import("../lib/wasm-shelf.mjs");
  const file = path.join(scratch, "mbk-loop-overflow.wasm");
  writeFileSync(file, LOOP_MODULE);
  const tool = attackTool(LOOP_MODULE);
  tool.wasm.path = file;

  const semaphore = createWasmSemaphore({ maxConcurrent: 1, maxQueueDepth: 1 });
  const [first, second, third] = await Promise.all([
    callWasmTool(tool, { input: "abc" }, { semaphore, deadlineMs: 60 }),
    callWasmTool(tool, { input: "abc" }, { semaphore, deadlineMs: 60 }),
    callWasmTool(tool, { input: "abc" }, { semaphore, deadlineMs: 60 }),
  ]);

  assert.equal(first.ok, false);
  assert.equal(first.refused, "time-exceeded");
  assert.equal(second.ok, false);
  assert.equal(second.refused, "time-exceeded");
  assert.equal(third.ok, false);
  assert.equal(third.refused, "over-budget", "3rd simultaneous call overflows queue and is refused immediately");
  assert.match(third.why, /call fan-out is bounded by the host/);

  const stats = semaphore.stats();
  assert.equal(stats.maxObservedActive, 1);
  assert.equal(stats.active, 0);
  assert.equal(stats.queued, 0);
});

// 120s, not 10s (voicebox-beads-i9k0): this arm spawns real wasm workers, and at load 9 on 2026-10-30 it was
// killed by its own budget before reaching any assertion (it passes in ~1s on a quiet box and 11/11 standalone).
test("3kr3: a real fast worker's completion releases exactly its own slot and never decrements another holder's (voicebox-beads-nhlr)", { timeout: 120000 }, async () => {
  const { callWasmTool, createWasmSemaphore } = await import("../lib/wasm-shelf.mjs");

  // 0 locals, i32.const 32, end — valid buffer-abi/1 module that returns immediately
  const FAST_MODULE = attackModule([0x00, 0x41, 0x20, 0x0b]);
  const fastFile = path.join(scratch, "3kr3-fast.wasm");
  writeFileSync(fastFile, FAST_MODULE);
  const fastTool = attackTool(FAST_MODULE);
  fastTool.wasm.path = fastFile;

  // Cap = 2, maxQueueDepth = 0 so any admission check against the remaining slot is immediate
  const semaphore = createWasmSemaphore({ maxConcurrent: 2, maxQueueDepth: 0 });

  // THE HOLDER IS DETERMINISTIC (voicebox-beads-nhlr). This slot used to be held by a loop module on a
  // 350ms deadline, and the case asserted — after a 30ms sleep — that the spinner was STILL RUNNING.
  // That asserts a property of the wall clock, not of the code: inside a loaded unit lane the deadline
  // expired first, `active` was legitimately 0, and the case failed because the BOX was busy (measured
  // in the fleet-check unit lane; the same tree passed 504/0 in an unloaded run). Held through the
  // semaphore's own acquire(), nothing can expire this slot, so the condition under test no longer
  // depends on scheduling. The deadline-terminated-loop case lives in its own test (voicebox-beads-LGW).
  const held = await semaphore.acquire();
  assert.equal(semaphore.stats().active, 1, "the test holds one slot deterministically");

  // 1. A real worker completes beside the held slot
  // This tests slot ownership, not worker startup latency (861ms in a contended gate run).
  const fastResult = await callWasmTool(fastTool, { input: "fast" }, { semaphore, deadlineMs: 5000 });
  assert.equal(fastResult.ok, true);
  // No sleep is needed and none is used: the worker's release reaches its OWN permit, and a permit's
  // release is exactly-once by construction, so whether its second completion event ('close') has
  // fired yet cannot change the count.
  assert.equal(semaphore.stats().active, 1, "the holder's slot survives the fast worker's completion — a repeat release never decrements another holder");

  // 2. Offer two calls at cap 2 while the holder holds 1 slot: exactly ONE must be admitted
  const [probe1, probe2] = await Promise.all([
    callWasmTool(fastTool, { input: "probe-1" }, { semaphore, deadlineMs: 5000 }),
    callWasmTool(fastTool, { input: "probe-2" }, { semaphore, deadlineMs: 5000 }),
  ]);
  const admittedCount = [probe1, probe2].filter((r) => r.ok).length;
  const refusedCount = [probe1, probe2].filter((r) => !r.ok && r.refused === "over-budget").length;
  assert.equal(admittedCount, 1, "exactly one call admitted into the single free slot alongside the holder");
  assert.equal(refusedCount, 1, "second concurrent probe refused over-budget because the holder still holds slot 1");

  held.release();
  assert.equal(semaphore.stats().active, 0, "the holder's own release is what empties the semaphore");
  assert.equal(semaphore.stats().queued, 0);
});

test("3kr3: the permit's release is EXACTLY ONCE — driven at the semaphore seam with no process, no deadline and no sleep (voicebox-beads-nhlr)", async () => {
  // The property the case above needs from below it, pinned deterministically. A worker reaches its
  // completion twice (the stdout line, then 'exit'/'close') and callWasmTool releases again in its
  // `finally`, so the same permit is released up to three times. A repeated release must be a no-op
  // and must NEVER decrement a DIFFERENT holder's slot — the underflow the old worker-thread design
  // had. No wasm child, no clock: this cannot fail because the box is busy, which is the whole point
  // of filing voicebox-beads-nhlr.
  const { createWasmSemaphore } = await import("../lib/wasm-shelf.mjs");
  const semaphore = createWasmSemaphore({ maxConcurrent: 2, maxQueueDepth: 0 });

  const held = await semaphore.acquire();
  const worker = await semaphore.acquire();
  assert.equal(semaphore.stats().active, 2, "both slots are held");

  worker.release(); // the worker's first completion event
  assert.equal(semaphore.stats().active, 1, "the worker gave back exactly its own slot");
  worker.release(); // its second completion event — the case 3kr3 exists for
  worker.release(); // and callWasmTool's own `finally`
  assert.equal(semaphore.stats().active, 1, "repeated releases are no-ops — they must never decrement the holder's slot");

  held.release();
  assert.equal(semaphore.stats().active, 0, "the holder's release is the one that empties the semaphore");
});


