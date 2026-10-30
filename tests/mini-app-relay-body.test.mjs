// tests/mini-app-relay-body.test.mjs — the mini-app fetch relay carries the body it was given, or refuses it
// out loud (voicebox-beads-182c).
//
// The finding: both halves of the relay tested `typeof body === "string"`, so every non-string body became
// `undefined` and the relayed request went out BODYLESS — `new URLSearchParams({a:"1"})`, `FormData`, `Blob`,
// `ArrayBuffer` all silently became an empty POST/PUT/PATCH. No error, no warning, and the server saw a
// different request than the app wrote.
//
// This file runs the real policy (public/relay-body.mjs) over real body objects, and pins that the frame SDK
// and the bridge are both built from it — a second hand-written copy is how the halves drifted apart before.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { relayBody } from "../public/relay-body.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bridge = readFileSync(path.join(root, "public", "mini-app-bridge.js"), "utf8");
const LIMITS = { maxBytes: 65536 };

test("a string body is carried as written, and bounded", () => {
  assert.deepEqual(relayBody('{"a":1}', LIMITS), { ok: true, body: '{"a":1}' });
  assert.equal(relayBody("x".repeat(LIMITS.maxBytes + 1), LIMITS).ok, false);
});

test("URLSearchParams is serialised with the form content-type fetch would have set", () => {
  const carried = relayBody(new URLSearchParams({ a: "1", b: "two words" }), LIMITS);
  assert.equal(carried.ok, true);
  assert.equal(carried.body, "a=1&b=two+words");
  assert.equal(carried.contentType, "application/x-www-form-urlencoded;charset=UTF-8");
});

test("Blob, File, ArrayBuffer and views are carried whole rather than dropped", () => {
  const blob = new Blob(['{"kind":"blob"}'], { type: "application/json" });
  assert.deepEqual(relayBody(blob, LIMITS), { ok: true, body: blob });

  const buffer = new TextEncoder().encode('{"kind":"buffer"}').buffer;
  assert.deepEqual(relayBody(buffer, LIMITS), { ok: true, body: buffer });

  const view = new Uint8Array([1, 2, 3]);
  assert.deepEqual(relayBody(view, LIMITS), { ok: true, body: view });
});

test("FormData crosses as an entries envelope, never as itself — the port cannot clone it (voicebox-beads-ctmt)", () => {
  const form = new FormData();
  form.append("a", "1");
  form.append("file", new Blob(["hello"]), "hello.txt");
  const carried = relayBody(form, LIMITS);
  assert.equal(carried.ok, true);
  // THE PORT PROPERTY: what crosses must not BE a FormData — Chrome's postMessage throws DataCloneError on
  // one (rev-v1k6 measured it), so identity-carrying is the defect this test exists to catch.
  assert.notEqual(Object.prototype.toString.call(carried.body), "[object FormData]", "a FormData must never be handed to postMessage");
  assert.ok(Array.isArray(carried.body.voiceboxRelayFormData), "what crosses is the entries envelope");
  assert.equal(carried.contentType, undefined, "no content-type is set: the REBUILT FormData lets fetch choose the multipart boundary");
});

test("the bridge half rebuilds the envelope into a real FormData (the round trip)", () => {
  const form = new FormData();
  form.append("a", "1");
  form.append("file", new Blob(["hello"]), "hello.txt");
  const arrived = relayBody(relayBody(form, LIMITS).body, LIMITS);
  assert.equal(arrived.ok, true);
  assert.equal(Object.prototype.toString.call(arrived.body), "[object FormData]", "the bridge rebuilds a real FormData for fetch");
  assert.equal(arrived.body.get("a"), "1");
  const file = arrived.body.get("file");
  assert.equal(typeof file.size, "number");
  assert.equal(file.size, 5);

  // Malformed envelopes are refused, never rebuilt blind.
  assert.equal(relayBody({ voiceboxRelayFormData: "not-an-array" }, LIMITS).ok, false);
  assert.equal(relayBody({ voiceboxRelayFormData: [["k"]] }, LIMITS).ok, false);
  assert.equal(relayBody({ voiceboxRelayFormData: [["k", 42]] }, LIMITS).ok, false, "a non-string non-Blob entry is refused");
});

test("a body larger than the bound is refused, not truncated", () => {
  const big = new Blob([new Uint8Array(2048)], { type: "application/octet-stream" });
  const refused = relayBody(big, { maxBytes: 1024 });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /2048 byte body exceeds the relay's 1024 byte bound/);

  const form = new FormData();
  form.append("big", "x".repeat(2000));
  assert.equal(relayBody(form, { maxBytes: 1024 }).ok, false, "a FormData is bounded by summing its parts");
});

test("a body the relay cannot carry is refused with a reason, never silently emptied", () => {
  const stream = new ReadableStream({ start(c) { c.close(); } });
  const refusedStream = relayBody(stream, LIMITS);
  assert.equal(refusedStream.ok, false);
  assert.match(refusedStream.error, /streaming body cannot cross the relay/);

  const refusedUnknown = relayBody({ not: "a body" }, LIMITS);
  assert.equal(refusedUnknown.ok, false);
  assert.match(refusedUnknown.error, /cannot carry a Object body/);

  assert.equal(relayBody(undefined, LIMITS).ok, true, "no body stays no body");
  assert.equal(relayBody(null, LIMITS).ok, true);
  assert.equal(relayBody("x", null).ok, false, "a caller with no bound is refused rather than trusted");
});

test("both halves of the relay are built from this one function", () => {
  assert.match(bridge, /import \{ relayBody \} from "\.\/relay-body\.mjs";/, "the bridge must import the policy");
  assert.match(bridge, /var relayBody = \(\$\{String\(relayBody\)\}\);/, "the injected SDK must embed this function's source");
  // The body each side actually sends comes from the policy — not from a string-type test.
  assert.match(bridge, /var carried = relayBody\(init && init\.body, \{ maxBytes: RELAY_BODY_LIMIT \}\);/, "the frame must run the policy");
  assert.match(bridge, /body: carried\.body\s*,/, "the frame must send the carried body");
  assert.match(
    bridge,
    /const carried = method === "GET" \|\| method === "HEAD" \? \{ ok: true \} : relayBody\(data\.body, \{ maxBytes: BOUNDS\.maxArgsBytes \}\);/,
    "the bridge must re-run the policy at the port boundary",
  );
  assert.doesNotMatch(bridge, /typeof data\.body === "string"/, "the string-only body test is the defect");
});
