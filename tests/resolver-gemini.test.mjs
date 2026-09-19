// tests/resolver-gemini.test.mjs — the model resolver's contract, pinned with
// the model stubbed. No network: fetchImpl is fake, so these never leave the
// machine. What is pinned: EVERY off-contract answer becomes `unresolved` —
// the resolver never invents a verb the executor does not know.
import test from "node:test";
import assert from "node:assert/strict";
import { makeGeminiResolver } from "../lib/resolver.mjs";

const stubFetch = (fn) => fn;
const jsonResponse = (payload, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => payload,
});
const modelSays = (text) => jsonResponse({ candidates: [{ content: { parts: [{ text }] } }] });

test("a write answer maps to the contract, byte-exact", async () => {
  const resolve = makeGeminiResolver({ key: "k", fetchImpl: stubFetch(async () => modelSays('{"verb":"write","name":"moon.txt","content":"the moon was bright"}')) });
  const action = await resolve("create a file called moon.txt with the moon was bright");
  assert.deepEqual(action, { verb: "write", name: "moon.txt", content: "the moon was bright" });
});

test("read and list answers map to the contract", async () => {
  const read = makeGeminiResolver({ key: "k", fetchImpl: stubFetch(async () => modelSays('{"verb":"read","name":"moon.txt"}')) });
  assert.deepEqual(await read("read moon.txt"), { verb: "read", name: "moon.txt" });
  const list = makeGeminiResolver({ key: "k", fetchImpl: stubFetch(async () => modelSays('{"verb":"list","name":""}')) });
  assert.deepEqual(await list("what files exist"), { verb: "list", name: "" });
});

test("the model's own unresolved passes through with its message", async () => {
  const resolve = makeGeminiResolver({ key: "k", fetchImpl: stubFetch(async () => modelSays('{"verb":"unresolved","content":"I can only create, read and list files."}')) });
  const action = await resolve("delete everything");
  assert.deepEqual(action, { unresolved: "I can only create, read and list files." });
});

test("a verb outside the contract is unresolved — never dispatched", async () => {
  const resolve = makeGeminiResolver({ key: "k", fetchImpl: stubFetch(async () => modelSays('{"verb":"delete","name":"everything"}')) });
  const action = await resolve("delete everything");
  assert.match(action.unresolved, /outside the contract/);
  assert.equal(action.verb, undefined, "no verb leaks through");
});

test("a write with no name is unresolved", async () => {
  const resolve = makeGeminiResolver({ key: "k", fetchImpl: stubFetch(async () => modelSays('{"verb":"write","content":"orphan"}')) });
  const action = await resolve("write something");
  assert.match(action.unresolved, /no file name/);
});

test("non-JSON model output is unresolved, quoting what came back", async () => {
  const resolve = makeGeminiResolver({ key: "k", fetchImpl: stubFetch(async () => modelSays("sure! I created that for you")) });
  const action = await resolve("create a file");
  assert.match(action.unresolved, /not JSON/);
});

test("an empty candidates envelope is unresolved", async () => {
  const resolve = makeGeminiResolver({ key: "k", fetchImpl: stubFetch(async () => jsonResponse({ candidates: [] })) });
  const action = await resolve("create a file");
  assert.match(action.unresolved, /not JSON/);
});

test("an HTTP error is unresolved with the status", async () => {
  const resolve = makeGeminiResolver({ key: "k", fetchImpl: stubFetch(async () => jsonResponse({}, 500)) });
  const action = await resolve("create a file");
  assert.match(action.unresolved, /HTTP 500/);
});

test("a network failure is unresolved — the turn path degrades, it does not die", async () => {
  const resolve = makeGeminiResolver({ key: "k", fetchImpl: stubFetch(async () => { throw new Error("ECONNREFUSED"); }) });
  const action = await resolve("create a file");
  assert.match(action.unresolved, /could not reach the model.*ECONNREFUSED/);
});

test("no key is unresolved immediately, without a network call", async () => {
  let called = 0;
  const resolve = makeGeminiResolver({ key: "", fetchImpl: stubFetch(async () => { called++; return modelSays("{}"); }) });
  const action = await resolve("create a file");
  assert.equal(called, 0);
  assert.match(action.unresolved, /GEMINI_API_KEY/);
});
