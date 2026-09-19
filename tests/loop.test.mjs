// tests/loop.test.mjs — the cycle, pinned without a server or a network.
// The loop (lib/loop.mjs) is placement-neutral: these tests drive it with
// stub seams, the same way the page and server drive it with real ones.
import test from "node:test";
import assert from "node:assert/strict";
import { createLoop } from "../lib/loop.mjs";

test("runTurn runs the whole cycle: decide → dispatch → result → record", async () => {
  const calls = [];
  const loop = createLoop({
    execute: (action) => { calls.push(["execute", action]); return { ok: true, did: action.verb }; },
    record: (entry) => calls.push(["record", entry]),
  });
  loop.registerResolver("stub", (t) => { calls.push(["resolve", t]); return { verb: "write", name: "a.txt", content: "hi" }; });

  const outcome = await loop.runTurn("make a.txt", { provider: "stub" });
  assert.deepEqual(calls.map(([stage]) => stage), ["resolve", "execute", "record"], "the cycle ran in order");
  assert.equal(outcome.action.verb, "write");
  assert.equal(outcome.result.did, "write");
  assert.equal(loop.log.length, 1, "the loop keeps its own record");
  assert.equal(loop.log[0].transcript, "make a.txt");
  assert.ok(loop.log[0].at, "the record is timestamped");
});

test("an unresolved turn short-circuits dispatch and is still recorded", async () => {
  let executed = 0;
  const loop = createLoop({ execute: () => { executed++; return { ok: true }; } });
  loop.registerResolver("stub", () => ({ unresolved: "cannot map this" }));

  const outcome = await loop.runTurn("flurb the widget", { provider: "stub" });
  assert.equal(executed, 0, "the executor must never see an unmapped turn");
  assert.equal(outcome.action, null);
  assert.equal(outcome.note, "cannot map this");
  assert.equal(loop.log.length, 1);
  assert.equal(loop.log[0].action, null, "the record shows the miss");
});

test("an unknown provider is unresolved, not a throw", async () => {
  const loop = createLoop();
  const outcome = await loop.runTurn("anything", { provider: "ghost" });
  assert.equal(outcome.action, null);
  assert.match(outcome.note, /no resolver registered/);
});

test("a loop with no executor still decides, and says so", async () => {
  const loop = createLoop();
  loop.registerResolver("stub", () => ({ verb: "list", name: "" }));
  const outcome = await loop.runTurn("list", { provider: "stub" });
  assert.equal(outcome.result.ok, false);
  assert.match(outcome.result.error, /no executor/);
});

test("async resolvers are awaited — a network-shaped provider needs no call-site change", async () => {
  const loop = createLoop({ execute: (a) => ({ ok: true, a }) });
  loop.registerResolver("slow", async (t) => {
    await new Promise((r) => setTimeout(r, 10));
    return { verb: "read", name: t };
  });
  const outcome = await loop.runTurn("x.txt", { provider: "slow" });
  assert.equal(outcome.action.verb, "read");
});

test("use() is the extension point: an extension registers on the loop, by name when it breaks", async () => {
  const loop = createLoop();
  const myExtension = (l) => l.registerResolver("ext", () => ({ verb: "list", name: "" }));
  loop.use(myExtension);
  const outcome = await loop.runTurn("anything", { provider: "ext" });
  assert.equal(outcome.action.verb, "list", "the extension's resolver is live");

  assert.throws(
    () => loop.use(() => { throw new Error("boom"); }, "broken-ext"),
    /extension 'broken-ext' failed to load: boom/,
    "a broken extension is loud and named, not swallowed",
  );
});
