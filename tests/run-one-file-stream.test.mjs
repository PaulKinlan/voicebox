// voicebox-beads-9xvq: process exit may precede the TAP footer arriving on its stdout pipe.
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { setImmediate as nextTurn } from "node:timers/promises";
import { runOneFile, statusOf } from "../scripts/test-changed.mjs";

const childStub = () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = 999999;
  child.kill = () => {};
  return child;
};

test("per-file runner waits for pipe close before interpreting a successful child's TAP footer", async () => {
  const child = childStub();
  let resolved = false;
  const result = runOneFile("tests/resolver-script-url.test.mjs", { timeoutMs: 5000, spawnChild: () => child });
  void result.then(() => { resolved = true; });
  child.stdout.emit("data", "TAP version 13\n✔ first arm\n");
  child.emit("exit", 0, null);
  await nextTurn();
  assert.equal(resolved, false, "exit alone cannot prove the reporter pipe has drained");
  child.stdout.emit("data", "# tests 4\n# pass 4\n# fail 0\n# skipped 0\n");
  child.emit("close", 0, null);
  const done = await result;
  assert.equal(statusOf(done), "passed");
  assert.deepEqual(done.counts, { tests: 4, pass: 4, fail: 0, skipped: 0 });
});

test("closed child with genuinely absent TAP counts remains UNKNOWN", async () => {
  const child = childStub();
  const result = runOneFile("tests/resolver-script-url.test.mjs", { timeoutMs: 5000, spawnChild: () => child });
  child.emit("exit", 0, null);
  child.emit("close", 0, null);
  assert.equal(statusOf(await result), "unknown", "pipe drainage is not a waiver for a silent child");
});
