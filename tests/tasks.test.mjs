import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { auditFileName } from "../core/audit.ts";
import { reduceTask, taskInput } from "../core/tasks.ts";
import { createTaskHost } from "../lib/tasks.mjs";

const environment = "env_0123456789abcdef";
function fixture(t, implementation) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "voicebox-tasks-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let selected = { project: "fixture", root: { kind: "machine", path: dir, environment } };
  const options = { environment, instance: "fixture", boot: "boot-one", addressKey: "test-only-host-key-not-a-live-credential", root: () => selected, executor: () => implementation };
  const host = createTaskHost(options);
  const file = path.join(dir, ".audit", auditFileName("fixture", `machine:${dir}`));
  const entries = () => fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").map(JSON.parse) : [];
  const authority = { owner: "authenticated-owner-A", callId: "call-one" };
  const admit = (args = { agent: "fixture", task: "held" }, auth = authority) => host.call("delegate_task", args, auth);
  const status = (address, auth = authority) => host.call("task_status", { address }, auth);
  return { dir, options, host, file, entries, authority, admit, status, select: (value) => { selected = value; } };
}
function runner(run, deadlineMs = 2000) {
  return { check: () => ({ ok: true, mechanism: "closed-no-effects-unit-fixture", bounds: { deadlineMs, maxOutputBytes: 32 } }), run };
}
async function until(read, predicate, timeoutMs = 3000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const value = read();
    if (predicate(value)) return value;
    await delay(5);
  }
  assert.fail(`condition did not occur: ${JSON.stringify(read())}`);
}

test("the model cannot supply authority or a context snapshot that does not exist", () => {
  for (const key of ["owner", "root", "environment", "command", "cwd", "bounds", "bearer", "callId"]) {
    assert.equal(taskInput({ agent: "fixture", task: "work", [key]: "forged" }).refused, "task-authority-field");
  }
  assert.equal(taskInput({ agent: "fixture", task: "work", context: ["private.txt"] }).refused, "task-context-unavailable");
  assert.equal(taskInput({ agent: "fixture", task: "💚".repeat(5000) }).refused, "task-input-over-budget");
});

test("durable handle precedes dispatch, held work, and completion; retry does not redispatch", async (t) => {
  let release, calls = 0;
  const held = new Promise((resolve) => { release = resolve; });
  const f = fixture(t, runner(() => {
    calls++;
    const events = f.entries();
    assert.equal(events[0].task.state, "queued");
    assert.equal(events[1].task.state, "running");
    return held;
  }));
  const admitted = f.admit();
  assert.equal(admitted.ok, true);
  assert.equal(admitted.task.state, "queued");
  assert.equal(calls, 0, "not even dispatch before the admission function returns");
  assert.equal(f.entries()[0].task.address, admitted.task.address, "actual disk record exists before acceptance");
  await until(() => calls, (n) => n === 1);
  assert.equal(f.status(admitted.task.address).task.state, "running");
  assert.equal(f.admit().task.address, admitted.task.address);
  assert.equal(f.admit({ agent: "fixture", task: "different" }).refused, "task-call-id-conflict");
  assert.equal(calls, 1);
  release("fixture result");
  const done = await until(() => f.status(admitted.task.address), (s) => s.task?.state === "completed");
  assert.equal(done.task.answer, "fixture result");
  assert.ok(!("owner" in done.task) && !("input" in done.task));
  assert.equal(f.admit().task.state, "completed");
  assert.equal(calls, 1);
});

test("handle possession is not owner authority, including another authenticated owner", async (t) => {
  const f = fixture(t, runner(() => "done"));
  assert.equal(f.admit(undefined, null).refused, "task-owner-unverified");
  assert.equal(f.entries().length, 0);
  const { task } = f.admit();
  assert.equal(f.status(task.address, null).refused, "task-owner-unverified");
  assert.equal(f.status(task.address, { owner: "authenticated-owner-B" }).refused, "task-owner-mismatch");
  assert.equal(f.status(task.address + "0").refused, "invalid-task-address");
  await until(() => f.status(task.address), (s) => s.task?.state === "completed");
});

test("unavailable, raw CLI and descriptor-only executors fail before an admission record", (t) => {
  for (const implementation of [null, { command: "claude", bounded: true }, { boundary: { observed: true }, bounds: { deadlineMs: 20 } }]) {
    const f = fixture(t, implementation);
    const result = f.admit();
    assert.equal(result.refused, implementation ? "unbounded-executor" : "executor-unavailable");
    assert.equal(f.entries().length, 0);
  }
  const f = fixture(t, { check: () => ({ ok: false, refused: "agent-boundary-unenforced", why: "no observed fence" }), run: () => assert.fail("must not dispatch") });
  assert.equal(f.admit().refused, "agent-boundary-unenforced");
  assert.equal(f.entries().length, 0);
});

test("an asynchronous or unbounded check cannot admit work", async (t) => {
  for (const check of [async () => { throw new Error("unobserved probe"); }, () => ({ ok: true, mechanism: "claim", bounds: { deadlineMs: Infinity, maxOutputBytes: 32 } })]) {
    const f = fixture(t, { check, run: () => assert.fail("must not run") });
    assert.equal(f.admit().refused, "unbounded-executor");
    assert.equal(f.entries().length, 0);
  }
  await delay(5); // rejected async check is observed, not an unhandled rejection
});

test("environment capacity is finite while duplicate admissions remain addressable", async (t) => {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const f = fixture(t, runner(() => held, 30));
  const admitted = Array.from({ length: 8 }, (_, n) => f.admit(undefined, { ...f.authority, callId: `bounded-${n}` }));
  assert.ok(admitted.every((result) => result.ok));
  assert.equal(f.admit(undefined, { ...f.authority, callId: "ninth" }).refused, "task-capacity-exhausted");
  assert.equal(f.admit(undefined, { ...f.authority, callId: "bounded-0" }).task.address, admitted[0].task.address);
  await until(() => admitted.map(({ task }) => f.status(task.address).task.state), (states) => states.every((s) => s === "interrupted"));
  assert.equal(f.admit(undefined, { ...f.authority, callId: "after-deadlines" }).refused, "task-capacity-exhausted", "deadline is not evidence that execution stopped");
  release("done");
  const next = await until(() => f.admit(undefined, { ...f.authority, callId: "after-settled" }), (r) => r.ok);
  await until(() => f.status(next.task.address), (s) => s.task?.state === "completed");
  assert.ok(admitted.every(({ task }) => f.status(task.address).task.state === "interrupted"));
});

test("a failed audit write or flush never dispatches; a visible but unconfirmed admission is interrupted", async (t) => {
  let calls = 0;
  const f = fixture(t, runner(() => { calls++; return "bad"; }));
  const realSync = fs.fsyncSync;
  const mock = t.mock.method(fs, "fsyncSync", (fd) => {
    if (fs.fstatSync(fd).isFile()) throw Object.assign(new Error("fixture flush failure"), { code: "EIO" });
    return realSync(fd);
  });
  assert.equal(f.admit().refused, "task-persistence-failed");
  mock.mock.restore();
  await delay(20);
  assert.equal(calls, 0);
  assert.equal(f.entries().length, 1, "retains the actual ambiguous write, rather than deleting evidence");
  const address = f.entries()[0].task.address;
  assert.equal(f.status(address).task.state, "interrupted");
  assert.equal(f.status(address).task.reason, "admission-unconfirmed");
  assert.equal(f.admit().task.state, "interrupted");
  assert.equal(calls, 0);
});

test("unreadable or torn audit refuses, rather than starting a fresh sequence", async (t) => {
  let calls = 0;
  const f = fixture(t, runner(() => { calls++; return "no"; }));
  fs.mkdirSync(path.dirname(f.file));
  fs.mkdirSync(f.file);
  assert.equal(f.admit().refused, "task-audit-unavailable");
  fs.rmdirSync(f.file);
  fs.writeFileSync(f.file, '{"seq":1');
  assert.equal(f.admit().refused, "task-audit-unavailable");
  await delay(20);
  assert.equal(calls, 0);
});

test("root switches do not retarget a task, and another host cannot inherit its address", async (t) => {
  const f = fixture(t, runner(() => "done"));
  const { task } = f.admit();
  await until(() => f.status(task.address), (s) => s.task?.state === "completed");
  f.select({ project: "page", root: { kind: "opfs", path: "other" } });
  assert.equal(f.status(task.address).task.root.path, f.dir);
  assert.equal(f.admit(undefined, { ...f.authority, callId: "second" }).refused, "task-root-unavailable");
  const replacement = createTaskHost({ ...f.options, environment: "env_fedcba9876543210" });
  assert.equal(replacement.call("task_status", { address: task.address }, f.authority).refused, "task-environment-changed");
  fs.renameSync(f.dir, `${f.dir}-retired`);
  t.after(() => fs.rmSync(`${f.dir}-retired`, { recursive: true, force: true }));
  fs.mkdirSync(f.dir);
  assert.equal(f.status(task.address).refused, "task-root-replaced");
});

test("a new boot does not call a live prior process dead", async (t) => {
  let release;
  const f = fixture(t, runner(() => new Promise((resolve) => { release = resolve; })));
  const { task } = f.admit();
  await until(() => release, Boolean);
  const other = createTaskHost({ ...f.options, boot: "second-boot" });
  assert.equal(other.call("task_status", { address: task.address }, f.authority).refused, "task-owner-unconfirmed");
  assert.equal(f.status(task.address).task.state, "running");
  release("done");
  await until(() => f.status(task.address), (s) => s.task?.state === "completed");
});

test("deadline reports interrupted, not stopped; late completion cannot rewrite it", async (t) => {
  let release;
  const f = fixture(t, runner(() => new Promise((resolve) => { release = resolve; }), 30));
  const { task } = f.admit();
  await until(() => f.status(task.address), (s) => s.task?.state === "interrupted");
  release("too late");
  await delay(20);
  assert.equal(f.status(task.address).task.state, "interrupted");
  assert.equal(f.status(task.address).task.reason, "task-deadline");
  assert.throws(() => reduceTask([...f.entries(), { ...f.entries().at(-1), seq: 99, task: { address: task.address, state: "completed", answer: "fabricated" } }], task.address), /live admission/);
});

test("the executor cannot widen captured bounds or rewrite the admitted input", async (t) => {
  const f = fixture(t, runner(({ input, bounds }) => {
    assert.throws(() => { bounds.maxOutputBytes = 1000; }, TypeError);
    assert.throws(() => { input.task = "changed"; }, TypeError);
    return "x".repeat(33);
  }));
  const { task } = f.admit();
  const result = await until(() => f.status(task.address), (s) => s.task?.state === "failed");
  assert.equal(result.task.reason, "task-output-over-budget");
  assert.equal(f.entries()[0].task.created.input.task, "held");
});

test("missing environment identity or sealing key never admits a task", (t) => {
  const f = fixture(t, runner(() => assert.fail("must not run")));
  for (const change of [{ environment: "local" }, { addressKey: "" }]) {
    const host = createTaskHost({ ...f.options, ...change });
    assert.equal(host.call("delegate_task", { agent: "fixture", task: "held" }, f.authority).refused, "task-environment-unverified");
  }
  assert.equal(f.entries().length, 0);
});

test("executor failure and oversized results are not successful tasks", async (t) => {
  for (const [execute, reason] of [[() => { throw new Error("fixture failure"); }, "executor-failed"], [() => "x".repeat(33), "task-output-over-budget"]]) {
    const f = fixture(t, runner(execute));
    const { task } = f.admit();
    const result = await until(() => f.status(task.address), (s) => s.task?.state === "failed");
    assert.equal(result.task.reason, reason);
    assert.ok(!("answer" in result.task));
  }
});
