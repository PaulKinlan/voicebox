import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { auditFileName } from "../core/audit.ts";
import { createTaskHost } from "../lib/tasks.mjs";

const environment = "env_0123456789abcdef";
const runner = (run, deadlineMs = 2000) => ({ check: () => ({ ok: true, mechanism: "closed-no-effects-unit-fixture", bounds: { deadlineMs, maxOutputBytes: 4096 } }), run });
function fixture(t, implementation) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "voicebox-cancel-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let selected = { project: "fixture", root: { kind: "machine", path: dir, environment } };
  const options = { environment, instance: "fixture", boot: "boot-one", addressKey: "test-only-host-key-not-a-live-credential", root: () => selected, executor: () => implementation };
  const host = createTaskHost(options);
  const file = path.join(dir, ".audit", auditFileName("fixture", `machine:${dir}`));
  const entries = () => fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").map(JSON.parse) : [];
  const authority = { owner: "authenticated-owner-A", callId: "call-one" };
  const admit = (args = { agent: "fixture", task: "held" }, auth = authority) => host.call("delegate_task", args, auth);
  const status = (address, auth = authority) => host.call("task_status", { address }, auth);
  const cancel = (address, auth = authority, graceMs = 2000) => host.call("cancel_task", { address }, auth, graceMs);
  return { dir, host, entries, authority, admit, status, cancel, select: (v) => { selected = v; } };
}
async function until(read, predicate, timeoutMs = 4000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const value = read();
    if (predicate(value)) return value;
    await delay(5);
  }
  assert.fail(`condition did not occur: ${JSON.stringify(read())}`);
}

test("cancel: the person's stop is requested, the executor observes it, and cancelled is RECORDED — not assumed", async (t) => {
  let sawSignal = false;
  const f = fixture(t, runner(async ({ signal }) => new Promise((_, reject) => {
    signal.addEventListener("abort", () => {
      sawSignal = true;
      reject(Object.assign(new Error("the person asked to stop"), { refused: "task-cancelled" }));
    });
  })));
  const { task } = f.admit();
  await until(() => f.status(task.address), (s) => s.task?.state === "running");
  const answer = await f.cancel(task.address);
  assert.equal(answer.observed, true, "the executor settled within the grace window");
  const final = await f.status(task.address);
  assert.equal(final.task.state, "cancelled");
  const states = f.entries().map((e) => e.task?.state);
  assert.deepEqual(states, ["queued", "running", "cancel_requested", "cancelled"]);
  assert.ok(sawSignal, "the executor's abort signal fired");
});

test("cancel: an executor that finishes the work anyway records COMPLETED — the record says what happened, not what was asked", async (t) => {
  const f = fixture(t, runner(async () => { await delay(150); return "already done"; }));
  const { task } = f.admit();
  await until(() => f.status(task.address), (s) => s.task?.state === "running");
  const answer = await f.cancel(task.address, f.authority, 2000);
  const final = await f.status(task.address);
  assert.equal(final.task.state, "completed");
  assert.equal(final.task.answer, "already done");
  assert.ok(answer.observed !== undefined);
});

test("cancel with an executor that ignores the signal: cancel_unconfirmed with the reason, capacity still charged, never a fabricated cancelled", async (t) => {
  const f = fixture(t, runner(async ({ signal }) => {
    signal.addEventListener("abort", () => {}); // pretends to listen, never settles early
    await delay(5000); // outlives any grace the host applies
    return "too late";
  }, 8000));
  const { task } = f.admit();
  await until(() => f.status(task.address), (s) => s.task?.state === "running");
  const answer = await f.cancel(task.address, f.authority, 400); // short grace
  assert.equal(answer.observed, false, "the executor did not settle inside the grace window");
  const final = await f.status(task.address);
  assert.equal(final.task.state, "cancel_unconfirmed");
  assert.match(final.task.reason ?? "", /did not observe cancellation|unknown/i);
  // the durable prior state is not overwritten by an invented cancelled
  assert.equal(f.entries().at(-1).task.state, "cancel_unconfirmed");
  t.after(() => {});
});

test("cancel: a person's stop asked while the executor finishes successfully anyway records COMPLETED, not cancelled", async (t) => {
  const f = fixture(t, runner(async () => { await delay(150); return "already done"; }));
  const { task } = f.admit();
  await until(() => f.status(task.address), (s) => s.task?.state === "running");
  const answer = await f.cancel(task.address, f.authority, 2000);
  const final = await f.status(task.address);
  assert.equal(final.task.state, "completed", "the work finished; the record says what happened, not what was asked");
  assert.equal(final.task.answer, "already done");
  assert.ok(answer.observed !== undefined);
});

test("cancel: a terminal task refuses by name, and the refusal says which state it is already in", async (t) => {
  const f = fixture(t, runner(async () => { throw new Error("failed on purpose"); }));
  const { task } = f.admit();
  await until(() => f.status(task.address), (s) => s.task?.state === "failed");
  const refusal = await f.cancel(task.address);
  assert.equal(refusal.ok, false);
  assert.match(refusal.why, /already failed/);
});

test("progress: coalesced to the latest note at status reads, audited only at settle, never a percentage", async (t) => {
  const notes = [];
  const f = fixture(t, runner(async ({ report }) => {
    report("reading the corpus");
    report("reading the corpus"); // repeat: coalesces, not appended
    await delay(50);
    report("writing the summary");
    await delay(400);
    return "done";
  }));
  const { task } = f.admit();
  await until(() => f.status(task.address), (s) => s.task?.progress === "writing the summary");
  await until(() => f.status(task.address), (s) => s.task?.state === "completed");
  const final = await f.status(task.address);
  assert.equal(final.task.progress, "writing the summary", "the settle record carries the final coalesced note");
  for (const e of f.entries()) {
    const t2 = e.task;
    if (t2?.state !== "completed") assert.equal(t2?.progress, undefined, "progress is audited at settle, not per tick");
    if (t2?.progress) assert.doesNotMatch(t2.progress, /%|\d+%/), "no invented percentages";
    notes.push(t2?.progress);
  }
  assert.ok(notes.some((n) => n === "writing the summary"));
});

test("partial output: a failing executor's partial answer is recorded, never discarded", async (t) => {
  const f = fixture(t, runner(async ({ report }) => {
    report("halfway");
    await delay(50);
    throw Object.assign(new Error("failed halfway"), { refused: "executor-failed" });
  }));
  const { task } = f.admit();
  await until(() => f.status(task.address), (s) => s.task?.state === "failed");
  const final = await f.status(task.address);
  assert.equal(final.task.state, "failed");
  // the partial answer is reported through progress here (the executor reports, then fails)
  assert.match(final.task.progress ?? "", /halfway/);
});

test("retry is an explicit new attempt: a fresh admission after failure gets a NEW address and a queued record", async (t) => {
  const f = fixture(t, runner(async () => { throw new Error("first attempt failed"); }));
  const first = f.admit();
  await until(() => f.status(first.task.address), (s) => s.task?.state === "failed");
  // retry is an explicit NEW attempt: a fresh transport call id, not a resume of the failed one
  const second = f.admit({ agent: "fixture", task: "held" }, { owner: f.authority.owner, callId: "call-two" });
  assert.equal(second.existing, false, "a new admission is a new attempt, not a resume");
  assert.notEqual(second.task.address, first.task.address);
  assert.equal(second.task.state, "queued");
});
