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
import { readShelf, descriptorFor } from "../lib/wasm-shelf.mjs";
import { admit } from "../core/extensions.ts";

const REAL_SHELF = path.join(os.homedir(), ".isocan", "modules", "wasm-tools");
const SHA256_ABC = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

let scratch;
let shelf; // the scratch COPY of the real shelf — the real one is never touched

/** A FRESH copy per test that mutates: a tamper in one test must never leak into another's admission. */
function freshShelf(name) {
  const dir = path.join(scratch, name);
  cpSync(REAL_SHELF, dir, { recursive: true });
  return dir;
}

test.before(() => {
  scratch = mkdtempSync(path.join(os.tmpdir(), "voicebox-wasm-shelf-"));
  shelf = freshShelf("shelf");
});

test.after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

test("admission rehash: an untampered shelf admits, and the digest in the manifest is the one measured", () => {
  const out = readShelf(shelf);
  assert.equal(out.ok, true, JSON.stringify(out));
  const hash = out.tools.find((t) => t.id === "hash");
  assert.equal(hash.admitted, true, "the hash tool passes admission on untampered bytes");
  // diff is admission-verified too, but NOT emitted: its ABI is undeclared and undriven —
  // an ABI nobody drives is not a mechanism, and the reader must SAY so.
  const diff = out.tools.find((t) => t.id === "diff");
  assert.equal(diff.admitted, true, "diff's bytes verify against its manifest digest");
  assert.equal(diff.abi, null, "diff carries no driven ABI, named as a note, never silently emitted");
  assert.match(diff.note, /not emitted/);
});

test("ADMISSION TAMPER: one flipped byte in the module is digest-mismatch, named with both digests", () => {
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

test("the gate: a wasm tool without a digest is under-declared; an undriven ABI is unsupported-abi; buffer-abi/1 with a 64-hex digest passes", () => {
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
test("through the seam: the KAT passes, and a post-admission swap is digest-mismatch at call time", async () => {
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

test("a module whose memory does not cover the declared ABI is a NAMED refusal, never an uncaught throw (vb-resolver's crash, driven)", async () => {
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
  const started = Date.now();
  const out = await callWasmTool(tool, { input: "abc" });
  const elapsed = Date.now() - started;
  assert.equal(out.ok, false);
  assert.equal(out.refused, "time-exceeded", "the hang dies by name, not by someone's kill switch");
  assert.ok(elapsed < WASM_CALL_DEADLINE_MS + 5000, `terminated near the deadline (${elapsed}ms), never hung`);
  assert.match(out.why, /bounded by the host/, "the refusal names whose bound it is");

  // The host's event loop never noticed: the KAT answers immediately after.
  const shelfOut = readShelf(shelf);
  const descriptor = descriptorFor(shelfOut.tools.find((t) => t.id === "hash"));
  const kat = await import("../lib/wasm-shelf.mjs").then((m) => m.callWasmTool(descriptor.tools[0], { input: "abc" }));
  assert.equal(kat.ok, true, "the host is alive and answering after the attack");
  assert.equal(kat.output, SHA256_ABC);
});

test("LGW: the grow module dies against the host's bounds, named — and the host's memory is untouched (vb-resolver's grow-loop)", async () => {
  const file = path.join(scratch, "grow.wasm");
  writeFileSync(file, GROW_MODULE);
  const tool = attackTool(GROW_MODULE);
  tool.wasm.path = file;
  const { callWasmTool } = await import("../lib/wasm-shelf.mjs");
  const hostBefore = process.memoryUsage().rss;
  const out = await callWasmTool(tool, { input: "abc" });
  assert.equal(out.ok, false);
  assert.ok(["resource-exceeded", "time-exceeded"].includes(out.refused), `the grow dies by a named bound (got ${out.refused})`);
  const hostDelta = process.memoryUsage().rss - hostBefore;
  assert.ok(hostDelta < 256 * 1024 * 1024, `the HOST's memory is untouched by the module's growth (delta ${Math.round(hostDelta / 1048576)}MB)`);

  const shelfOut = readShelf(shelf);
  const descriptor = descriptorFor(shelfOut.tools.find((t) => t.id === "hash"));
  const kat = await import("../lib/wasm-shelf.mjs").then((m) => m.callWasmTool(descriptor.tools[0], { input: "abc" }));
  assert.equal(kat.ok, true, "the host is alive and answering after the attack");
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
