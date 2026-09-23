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
