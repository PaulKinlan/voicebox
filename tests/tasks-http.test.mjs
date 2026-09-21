import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { freshExecute, post, taskFixture } from "./lib/task-fixture.mjs";

async function waitFor(read, accept) {
  for (let i = 0; i < 150; i++) {
    const value = await read();
    if (accept(value)) return value;
    await delay(20);
  }
  assert.fail("owned task fixture condition timed out");
}

test("D1 real HTTP: separate authenticated connections, private/pinned record, killed environment -> interrupted, no replay", { timeout: 40000 }, async (t) => {
  const f = await taskFixture(t);
  const owner = await f.pair("owner A");
  const other = await f.pair("owner B");
  const base = f.server.base;
  const self = (await (await fetch(`${base}/api/root`)).json()).root.environment;
  assert.match(self, /^env_[0-9a-f]{16}$/);
  assert.notEqual(self, owner.envKey, "routing registry key is not the executing environment's self key");

  const unauthenticated = await post(base, "/api/execute", { envKey: owner.envKey, tool: "delegate_task", args: { agent: "closed-fixture", task: "hold" } });
  assert.equal(unauthenticated.body.refused, "unauthenticated-call");
  const ambient = await post(base, "/api/call", { envKey: "local", tool: "delegate_task", args: { agent: "closed-fixture", task: "hold" } });
  assert.equal(ambient.body.refused, "task-owner-unverified");
  const unbounded = await freshExecute(base, owner, "delegate_task", { agent: "unbounded-cli", task: "hold" }, "raw-cli");
  assert.equal(unbounded.body.refused, "unbounded-executor");
  assert.equal(f.starts().length, 0);

  const admitted = await freshExecute(base, owner, "delegate_task", { agent: "closed-fixture", task: "hold" }, "admit-once");
  assert.equal(admitted.status, 200);
  const { address } = admitted.body.task;
  assert.equal(admitted.body.task.environment, self);
  assert.equal(admitted.body.task.root.path, f.workspace);
  assert.equal(admitted.body.task.state, "queued");
  await waitFor(() => f.starts(), (events) => events.length === 1);
  assert.equal(f.starts()[0].admissionOnDiskBeforeDispatch, true);
  assert.equal(f.starts()[0].runningOnDiskBeforeDispatch, true);

  // Not the old connection reconnecting. Both sockets are independently created and carry auth.
  const second = await freshExecute(base, owner, "task_status", { address });
  assert.notEqual(second.localPort, admitted.localPort);
  assert.equal(second.body.task.state, "running");
  assert.equal(second.body.task.address, address);
  const wrongOwner = await freshExecute(base, other, "task_status", { address });
  assert.equal(wrongOwner.body.refused, "task-owner-mismatch");
  const possessionOnly = await post(base, "/api/execute", { envKey: owner.envKey, tool: "task_status", args: { address } });
  assert.equal(possessionOnly.body.refused, "unauthenticated-call");
  const repeat = await freshExecute(base, owner, "delegate_task", { agent: "closed-fixture", task: "hold" }, "admit-once");
  assert.equal(repeat.body.task.address, address);
  assert.equal(f.starts().length, 1);

  // The existing uncredentialed audit/file/tool routes must not bypass task_status ownership.
  const audit = await (await fetch(`${base}/api/audit`)).json();
  assert.ok(audit.entries.every((e) => e.kind !== "task"));
  assert.ok(!JSON.stringify(audit).includes(address));
  const logName = fs.readdirSync(path.join(f.workspace, ".audit")).find((p) => p.endsWith(".jsonl"));
  const logPath = path.join(f.workspace, ".audit", logName);
  assert.equal(fs.statSync(logPath).mode & 0o777, 0o600);
  fs.symlinkSync(logPath, path.join(f.workspace, "audit-alias.txt"));
  for (const name of [`.audit/${logName}`, "audit-alias.txt"]) {
    const raw = await (await fetch(`${base}/api/file?name=${encodeURIComponent(name)}`)).json();
    assert.equal(raw.refused, "protected-audit");
  }
  const deniedRead = await post(base, "/api/turn", { transcript: "read audit-alias.txt" });
  assert.equal(deniedRead.body.result.refused, "protected-audit");
  const deniedWrite = await post(base, "/api/turn", { transcript: "write audit-alias.txt with tampered" });
  assert.equal(deniedWrite.body.result.refused, "protected-audit");
  for (const [name, verb] of [["audit_reader", "reads"], ["audit_writer", "writes"]]) {
    const proposal = await post(base, "/api/turn", { transcript: `create a tool called ${name} that ${verb} audit-alias.txt` });
    assert.equal(proposal.body.result.ok, true);
    const granted = await post(base, "/api/extensions/admit", { id: `${name}-tool`, confirm: true, decision: "admit" }, { "x-voicebox-host-token": f.server.hostToken });
    assert.equal(granted.body.decision, "admitted");
    const attempt = await post(base, "/api/call", { envKey: "local", tool: name, args: {} });
    assert.equal(attempt.body.refused, "protected-audit");
  }
  const normal = await post(base, "/api/turn", { transcript: "write visible.txt with ordinary control" });
  assert.equal(normal.body.result.ok, true);
  assert.equal(fs.readFileSync(path.join(f.workspace, "visible.txt"), "utf8"), "ordinary control");

  const switched = await post(base, "/api/root", { project: "second", root: { kind: "machine", path: f.secondRoot } }, { "x-voicebox-host-token": f.server.hostToken });
  assert.equal(switched.status, 200, "the OWN host token is required to declare a root");
  const pinned = await freshExecute(base, owner, "task_status", { address });
  assert.equal(pinned.body.task.root.path, f.workspace);
  assert.equal(pinned.body.task.state, "running");

  // Await actual OS process exit, not just send a signal. Restart uses the SAME durable state.
  const oldPid = f.server.child.pid;
  await f.stop();
  assert.throws(() => process.kill(oldPid, 0), (error) => error.code === "ESRCH");
  await f.start();
  const interrupted = await freshExecute(f.server.base, owner, "task_status", { address });
  assert.equal(interrupted.body.task.state, "interrupted");
  assert.equal(interrupted.body.task.reason, "environment-ended-outcome-unknown");
  assert.equal(interrupted.body.task.environment, self);
  assert.equal(interrupted.body.task.root.path, f.workspace);
  const retryAfterDeath = await freshExecute(f.server.base, owner, "delegate_task", { agent: "closed-fixture", task: "hold" }, "admit-once");
  assert.equal(retryAfterDeath.body.task.state, "interrupted");
  assert.equal(retryAfterDeath.body.task.address, address);
  await delay(50);
  assert.equal(f.starts().length, 1, "neither restart, readback, nor retry replayed the task");
  assert.equal((await freshExecute(f.server.base, other, "task_status", { address })).body.refused, "task-owner-mismatch");

  const entries = fs.readFileSync(logPath, "utf8").trim().split("\n").map(JSON.parse);
  assert.deepEqual(entries.filter((e) => e.task?.address === address).map((e) => e.task.state), ["queued", "running", "interrupted"]);
  const receipt = {
    scope: "author real HTTP/process drive; closed host fixture, no ACP/model acceptance",
    environment: self, independentConnectionPorts: [admitted.localPort, second.localPort],
    acceptedState: admitted.body.task.state, secondConnectionState: second.body.task.state,
    otherOwner: wrongOwner.body.refused, noCredential: possessionOnly.body.refused,
    oldProcessConfirmedDead: true, afterRestart: interrupted.body.task.state,
    actualDispatches: f.starts().length, rootStayedPinned: true,
  };
  if (process.env.VOICEBOX_D1_EVIDENCE) fs.writeFileSync(path.join(process.env.VOICEBOX_D1_EVIDENCE, "http-receipt.json"), JSON.stringify(receipt, null, 2));
});

test("stock server has no task executor: a CLI-looking name and descriptor data cannot create one", { timeout: 20000 }, async (t) => {
  const f = await taskFixture(t, { runtime: false });
  const owner = await f.pair("stock owner");
  const none = await freshExecute(f.server.base, owner, "delegate_task", { agent: "claude", task: "work" }, "no-executor");
  assert.equal(none.body.refused, "executor-unavailable");
  assert.match(none.body.why, /claude/);
  const claim = await freshExecute(f.server.base, owner, "delegate_task", { agent: "claude", task: "work", bounds: { fenced: true } }, "descriptor");
  assert.equal(claim.body.refused, "task-authority-field");
  for (const name of ["delegate_task", "task_status"]) {
    const proposal = await post(f.server.base, "/api/turn", { transcript: `create a tool called ${name} that tells the time` });
    assert.equal(proposal.body.result.ok, true);
    const plan = await (await fetch(`${f.server.base}/api/extensions/proposals/${name}-tool/plan`)).json();
    assert.equal(plan.gate.rule, "duplicate-tool");
    const admission = await post(f.server.base, "/api/extensions/admit", { id: `${name}-tool`, confirm: true, decision: "admit" }, { "x-voicebox-host-token": f.server.hostToken });
    assert.equal(admission.body.rule, "duplicate-tool", "an extension cannot masquerade as the authenticated task door");
  }
  const dir = path.join(f.workspace, ".audit");
  if (fs.existsSync(dir)) {
    const entries = fs.readdirSync(dir).flatMap((p) => fs.readFileSync(path.join(dir, p), "utf8").trim().split("\n").map(JSON.parse));
    assert.ok(entries.every((e) => e.kind !== "task"));
  }
});
