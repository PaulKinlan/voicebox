// WHAT A DELEGATION'S OUTCOME MEANS, AND WHO SAYS SO — voicebox-beads-m9u.
//
// The record said `state: "completed"` and handed over the executor's text, and nothing said that this is
// a CLAIM. The rule this project keeps is that a claimed success is never promoted to verified
// effectiveness, so the class carries its basis: `executor-claimed` for a completion, `host-observed`
// for the things the host watched happen. And the record is explicitly NOT a ranking input — there is a
// guard at the bottom so a score or an ordering cannot be added quietly.
//
//   node --test tests/task-outcome.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { auditFileName } from "../core/audit.ts";
import { outcomeFor, reduceTask } from "../core/tasks.ts";
import { createTaskHost } from "../lib/tasks.mjs";

const environment = "env_0123456789abcdef";

function fixture(t, implementation, deadlineMs = 2000) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "voicebox-outcome-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const selected = { project: "fixture", root: { kind: "machine", path: dir, environment } };
  const host = createTaskHost({
    environment, instance: "fixture", boot: "boot-one", addressKey: "test-only-host-key-not-a-live-credential",
    root: () => selected,
    executor: () => ({ check: () => ({ ok: true, mechanism: "closed-no-effects-unit-fixture", bounds: { deadlineMs, maxOutputBytes: 4096 } }), run: implementation }),
  });
  const file = path.join(dir, ".audit", auditFileName("fixture", `machine:${dir}`));
  const entries = () => (fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").map(JSON.parse) : []);
  const authority = { owner: "authenticated-owner-A", callId: "call-one" };
  return {
    host, entries, authority,
    admit: (args = { agent: "fixture", task: "do the thing" }) => host.call("delegate_task", args, authority),
    status: (address) => host.call("task_status", { address }, authority),
    record: (address) => reduceTask(entries(), address),
  };
}

async function until(read, predicate, timeoutMs = 4000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) { const value = read(); if (predicate(value)) return value; await delay(10); }
  assert.fail(`condition did not occur: ${JSON.stringify(read())}`);
}

test("a completed delegation records a CLAIM — never verified effectiveness", async (t) => {
  const f = fixture(t, async () => "the work is done");
  const admitted = f.admit();
  assert.equal(admitted.ok, true, JSON.stringify(admitted));
  const view = (await until(() => f.status(admitted.task.address), (r) => r.ok && r.task.state !== "queued" && r.task.state !== "running")).task;
  assert.equal(view.state, "completed");
  assert.deepEqual(view.outcome, { class: "claimed-complete", basis: "executor-claimed" },
    "a completion is the EXECUTOR'S claim: the record must say so rather than looking like an effect");
  // and the row itself carries it, not only the view: a reader of the record sees the same thing
  assert.deepEqual(f.record(admitted.task.address).outcome, { class: "claimed-complete", basis: "executor-claimed" });
});

test("a failure the HOST observed says so, in the same vocabulary", async (t) => {
  // The executor returns a non-string, which the host refuses by name (task-invalid-result) — an outcome
  // the host watched, as opposed to a claim it received.
  const f = fixture(t, async () => 42);
  const admitted = f.admit();
  const view = (await until(() => f.status(admitted.task.address), (r) => r.task.state === "failed" || r.task.state === "interrupted")).task;
  assert.equal(view.state, "failed", JSON.stringify(view));
  assert.deepEqual(view.outcome, { class: "observed-failure", basis: "host-observed" });
});

test("a task still in flight claims NO outcome at all", async (t) => {
  const f = fixture(t, async () => { await delay(3000); return "late"; }, 5000);
  const admitted = f.admit();
  const running = (await until(() => f.status(admitted.task.address), (r) => r.task.state === "running")).task;
  assert.equal("outcome" in running, false, `a running task must not claim an outcome: ${JSON.stringify(running)}`);
  assert.equal(outcomeFor("queued"), null);
  assert.equal(outcomeFor("running"), null);
  assert.equal(outcomeFor("cancel_requested"), null);
  // NOT TERMINAL, so it has no outcome to claim: it can still settle to cancelled, completed, failed or
  // interrupted. The state name carries the uncertainty; the record does not invent a class for it.
  assert.equal(outcomeFor("cancel_unconfirmed"), null, "cancel_unconfirmed is not an outcome, it is an open question");
});

test("nothing in the record ranks one delegation above another — the guard", async (t) => {
  const f = fixture(t, async () => "done");
  const admitted = f.admit();
  const view = (await until(() => f.status(admitted.task.address), (r) => r.task.state === "completed")).task;
  // voicebox-beads-m9u: "no automatic ranking mechanism". A record that quietly reorders anything has
  // taken authority nobody gave it, so the fields that would do the reordering are refused here by name.
  const RANKING = /(rank|score|weight|order|priorit|percent|confidence|rating)/i;
  for (const key of Object.keys(view)) {
    assert.doesNotMatch(key, RANKING, `the record carries '${key}', which would let it rank delegations`);
  }
  for (const key of Object.keys(view.outcome)) {
    assert.doesNotMatch(key, RANKING, `the outcome carries '${key}'; a class that ranks is a policy`);
  }
  assert.deepEqual(Object.keys(view.outcome).sort(), ["basis", "class"], "the outcome is a class and its basis, and nothing else");
});
