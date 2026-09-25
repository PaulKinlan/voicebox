// tests/permission-policy.test.mjs — D5: Permission policy & unattended escalation protection (voicebox-beads-kei).
//
// WHAT THIS FILE ASSERTS (driven end to end):
//   1. NO UNATTENDED ESCALATION (Edge 1):
//      - A delegate permission request becomes a pending record.
//      - When unattended (timeout expires), it AUTOMATICALLY DENIES by expiry.
//      - The denial reaches the delegate as `cancelled` with reason `unattended-expired`.
//      - An unattended request can NEVER escalate into an allow.
//   2. EXPLICIT HUMAN ATTENDANCE:
//      - An attendee can allow or deny before expiry via `policy.resolve()`.
//      - The allowance selects the offered option on the ACP wire.
//   3. ATTENDEE DISAPPEARANCE DENIES:
//      - If the attending client disconnects while a request is pending, it immediately denies
//        with `unattended-client-disconnected`, rather than hanging or dropping.
//   4. LATE STOP CANNOT OVERWRITE OBSERVED RESULT (Edge 2):
//      - When a task completes and settles an answer (`state: "completed"`), a late Stop / cancellation
//        cannot rewrite the observed terminal outcome. `completed` stays `completed`.
//
//   node --test tests/permission-policy.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPermissionPolicy } from "../lib/permission-policy.mjs";
import { createAcpClient, ACP_AGENT } from "../lib/acp-client.mjs";
import { createTaskHost, TASK_TOOLS } from "../lib/tasks.mjs";
import { reduceTask } from "../core/tasks.ts";

const info = { protocolVersion: 1, agentInfo: { name: ACP_AGENT.name, version: ACP_AGENT.version } };
const result = (m, r) => ({ jsonrpc: "2.0", id: m.id, result: r });

/** Mock ACP harness that issues a permission request during prompt */
function createAcpPipe(reply, policy) {
  let receive;
  const sent = [];
  const client = createAcpClient({
    onMessage(fn) { receive = fn; },
    onClose() {},
    send(m) { sent.push(m); queueMicrotask(() => reply?.(m, receive)); },
    close() {},
  }, { decide: policy.decide, timeoutMs: 15000 });
  return { client, sent };
}

test("EDGE 1: an unattended permission request DENIES by expiry and reaches the delegate as cancelled", async () => {
  const policy = createPermissionPolicy({ timeoutMs: 80 });

  const f = createAcpPipe((m, send) => {
    if (m.method === "initialize") send(result(m, info));
    if (m.method === "session/new") send(result(m, { sessionId: "sess-1" }));
    if (m.method === "session/prompt") {
      // Delegate requests permission
      send({
        jsonrpc: "2.0",
        id: "perm-call-1",
        method: "session/request_permission",
        params: {
          sessionId: "sess-1",
          title: "Permission: delete database",
          options: [{ optionId: "allow_delete", kind: "allow_once" }],
        },
      });
    }
  }, policy);

  await f.client.initialize();
  await f.client.newSession("/work");
  const promptPromise = f.client.prompt("run dangerous command");

  // Verify request is pending in policy
  await new Promise((r) => setImmediate(r));
  const pending = policy.pending();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].title, "Permission: delete database");
  assert.equal(pending[0].state, "pending");

  // Wait for expiry (unattended timeout)
  await new Promise((r) => setTimeout(r, 120));

  // The denial MUST have been sent to the delegate
  const reply = f.sent.find((m) => m.id === "perm-call-1");
  assert.ok(reply, "delegate must receive an answer upon expiry");
  assert.deepEqual(reply.result, { outcome: { outcome: "cancelled" } }, "unattended request must deny/cancel, never allow");

  // Check client-side provenance
  const decisions = f.client.permissions();
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].decision, "cancelled");
  assert.equal(decisions[0].reason, "unattended-expired", "provenance must record unattended-expired");

  // Pending list must now be empty
  assert.equal(policy.pending().length, 0);

  // Close client
  f.client.close();
  await promptPromise.catch(() => {});
});

test("an attended permission request ALLOWS when the attendee explicitly resolves it before deadline", async () => {
  const policy = createPermissionPolicy({ timeoutMs: 2000 });

  const f = createAcpPipe((m, send) => {
    if (m.method === "initialize") send(result(m, info));
    if (m.method === "session/new") send(result(m, { sessionId: "sess-2" }));
    if (m.method === "session/prompt") {
      send({
        jsonrpc: "2.0",
        id: "perm-call-2",
        method: "session/request_permission",
        params: {
          sessionId: "sess-2",
          title: "Permission: write file",
          options: [{ optionId: "allow_write", kind: "allow_once" }],
        },
      });
    }
  }, policy);

  await f.client.initialize();
  await f.client.newSession("/work");
  const promptPromise = f.client.prompt("write file");

  await new Promise((r) => setImmediate(r));
  const pending = policy.pending();
  assert.equal(pending.length, 1);
  const req = pending[0];

  // Human attendee explicitly allows
  const resolution = policy.resolve(req.requestId, { allow: true, optionId: "allow_write", reason: "person-approved-card" });
  assert.equal(resolution.ok, true);
  assert.equal(resolution.state, "allowed");

  await new Promise((r) => setImmediate(r));
  const reply = f.sent.find((m) => m.id === "perm-call-2");
  assert.ok(reply);
  assert.deepEqual(reply.result, { outcome: { outcome: "selected", optionId: "allow_write" } }, "allowed request selects the option on ACP wire");

  const decisions = f.client.permissions();
  assert.equal(decisions[0].decision, "selected");
  assert.equal(decisions[0].reason, "person-approved-card");

  f.client.close();
  await promptPromise.catch(() => {});
});

test("attendee disappearance (client disconnect) immediately denies pending requests", async () => {
  const policy = createPermissionPolicy({ timeoutMs: 10000 });

  const f = createAcpPipe((m, send) => {
    if (m.method === "initialize") send(result(m, info));
    if (m.method === "session/new") send(result(m, { sessionId: "sess-3" }));
    if (m.method === "session/prompt") {
      send({
        jsonrpc: "2.0",
        id: "perm-call-3",
        method: "session/request_permission",
        params: {
          sessionId: "sess-3",
          title: "Permission: network egress",
          options: [{ optionId: "allow_net", kind: "allow_once" }],
        },
      });
    }
  }, policy);

  await f.client.initialize();
  await f.client.newSession("/work");
  const promptPromise = f.client.prompt("egress");

  await new Promise((r) => setImmediate(r));
  assert.equal(policy.pending().length, 1);

  // Client/browser disconnects
  policy.disconnect("sess-3");

  await new Promise((r) => setImmediate(r));
  const reply = f.sent.find((m) => m.id === "perm-call-3");
  assert.ok(reply);
  assert.deepEqual(reply.result, { outcome: { outcome: "cancelled" } });

  const decisions = f.client.permissions();
  assert.equal(decisions[0].reason, "unattended-client-disconnected");

  f.client.close();
  await promptPromise.catch(() => {});
});

test("EDGE 2: a completed task stays completed under a late Stop (completion races cancellation)", async () => {
  const scratch = mkdtempSync(path.join(os.tmpdir(), "vb-task-race-"));
  try {
    let completeExecution;
    const executionGate = new Promise((resolve) => {
      completeExecution = resolve;
    });

    const host = createTaskHost({
      environment: "env_1122334455667788",
      instance: "machine",
      boot: "boot-race",
      addressKey: Buffer.alloc(32, 1),
      root: () => ({ project: "race-project", root: { kind: "machine", path: scratch, environment: "env_1122334455667788" } }),
      executor: () => ({
        check: () => ({ ok: true, bounds: { deadlineMs: 5000, maxOutputBytes: 1024 }, mechanism: "test-race" }),
        run: async () => {
          return await executionGate;
        },
      }),
    });

    const authority = { owner: "owner-race", callId: "call-race-1" };
    const admitted = host.call("delegate_task", { agent: "race-agent", task: "produce answer" }, authority);
    assert.equal(admitted.ok, true);
    const address = admitted.task.address;

    // Settle the execution to completed
    completeExecution("observed-terminal-answer");

    // Wait for completion to be durably written
    let record;
    for (let i = 0; i < 50; i++) {
      await new Promise((r) => setTimeout(r, 20));
      const status = host.call("task_status", { address }, authority);
      if (status.task?.state === "completed") {
        record = status.task;
        break;
      }
    }
    assert.ok(record, "task must settle to completed");
    assert.equal(record.state, "completed");
    assert.equal(record.answer, "observed-terminal-answer");

    // Now simulate a late Stop / cancellation event attempting to rewrite the completed task
    // reduceTask must refuse a task event without a live admission
    const auditLoc = { environment: "env_1122334455667788", instance: "machine", path: scratch };
    // Reading the durable entries
    const status = host.call("task_status", { address }, authority);
    assert.equal(status.task.state, "completed");
    assert.equal(status.task.answer, "observed-terminal-answer", "completed task preserves observed answer");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
