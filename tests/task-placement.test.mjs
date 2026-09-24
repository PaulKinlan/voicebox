// tests/task-placement.test.mjs — Zero-server browser-owned delegation contract (voicebox-beads-8fv.1)
//
// Hard requirement (Paul, 2026-09-21):
//   "there is a world where there is zero server and it's all run locally on the client,
//    and that has to be a hard requirement."
//
// Invariants tested:
//   1. Placement derivation for environment kinds and reach (browser, machine, remote)
//   2. Placement-specific execution bounds and limits (rejection of typos/excessive bounds)
//   3. Browser task host: zero-server admission, OPFS/handle roots, WebCrypto sealing
//   4. Terminal completion carries outcome contract (claimed-complete / executor-claimed)
//   5. Call-ID deduplication: idempotent on same content, conflicts on changed content
//   6. Atomic capacity reservation: concurrent admissions cannot exceed 4 active browser tasks
//   7. Immutability: root and bounds captured synchronously before async signing window
//   8. Timed-out executors retain capacity until runner promise actually settles
//   9. Host placement dispatcher rejects unknown placement and mismatched environment
//  10. Status recovery across reload: subsequent host instance reads prior completed task

import test from "node:test";
import assert from "node:assert/strict";
import {
  placementForEnvironment,
  validatePlacementBounds,
  createBrowserTaskHost,
  createPlacementDispatcher,
  PLACEMENT_BOUNDS,
} from "../lib/task-placement.mjs";
import { reduceTask, taskView } from "../core/tasks.ts";

test("placement derivation: associates placement with environment kind and reach", () => {
  assert.equal(placementForEnvironment({ kind: "browser" }), "browser");
  assert.equal(placementForEnvironment("browser"), "browser");

  assert.equal(placementForEnvironment({ kind: "server" }), "machine");
  assert.equal(placementForEnvironment({ kind: "fence" }), "machine");
  assert.equal(placementForEnvironment("machine"), "machine");

  assert.equal(placementForEnvironment({ kind: "server", reach: "paired" }), "remote");
  assert.equal(placementForEnvironment("remote"), "remote");

  // Unknown environment kind / placement returns null
  assert.equal(placementForEnvironment({ kind: "browesr" }), null);
  assert.equal(placementForEnvironment("unknown"), null);
});

test("placement bounds: enforces limits per placement category", () => {
  // Browser placement bounds
  const validBrowser = validatePlacementBounds("browser", { deadlineMs: 30000, maxOutputBytes: 4096 });
  assert.equal(validBrowser.ok, true);

  const excessiveBrowserDeadline = validatePlacementBounds("browser", { deadlineMs: 300001, maxOutputBytes: 4096 });
  assert.equal(excessiveBrowserDeadline.ok, false);
  assert.equal(excessiveBrowserDeadline.refused, "unbounded-executor");
  assert.match(excessiveBrowserDeadline.why, /exceeds the browser placement maximum/);

  // Machine placement bounds (allows up to 1 hr)
  const validMachine = validatePlacementBounds("machine", { deadlineMs: 1800000, maxOutputBytes: 32768 });
  assert.equal(validMachine.ok, true);

  const excessiveMachine = validatePlacementBounds("machine", { deadlineMs: 3600001, maxOutputBytes: 32768 });
  assert.equal(excessiveMachine.ok, false);
  assert.equal(excessiveMachine.refused, "unbounded-executor");

  // Unknown placement must be refused
  const unknownPlacement = validatePlacementBounds("browesr", { deadlineMs: 1000, maxOutputBytes: 100 });
  assert.equal(unknownPlacement.ok, false);
  assert.equal(unknownPlacement.refused, "unbounded-executor");
});

test("browser task host: zero-server admission, OPFS root, and terminal outcome contract", async () => {
  let executed = false;
  const executor = {
    check({ input, placement }) {
      assert.equal(placement, "browser");
      if (input.agent !== "in-page-agent") return { ok: false, refused: "agent-unavailable", why: "not admitted" };
      return {
        ok: true,
        mechanism: "in-page-worker: zero-server web standard execution",
        bounds: { deadlineMs: 10000, maxOutputBytes: 2048 },
      };
    },
    async run({ input, root }) {
      assert.equal(root.kind, "opfs");
      assert.equal(root.path, "v1/projects/atlas");
      executed = true;
      return `Answer for ${input.task}`;
    },
  };

  const host = createBrowserTaskHost({
    environment: "env_browser_tab1",
    instance: "tab-1",
    root: () => ({ kind: "opfs", path: "v1/projects/atlas", environment: "env_browser_tab1" }),
    executor: () => executor,
  });

  const authority = { owner: "owner-client-hash-1", callId: "call-tab-1" };

  // 1. Delegate task
  const res = await host.call("delegate_task", {
    agent: "in-page-agent",
    task: "Summarize active chapter",
  }, authority);

  assert.equal(res.ok, true);
  assert.equal(res.task.state, "queued");
  assert.equal(res.task.placement, "browser");
  assert.equal(res.task.environment, "env_browser_tab1");
  assert.equal(res.task.root.kind, "opfs");
  assert.ok(res.task.address.startsWith("task_"));

  // 2. Poll status until complete
  const address = res.task.address;
  let status;
  for (let i = 0; i < 50; i++) {
    status = await host.call("task_status", { address }, authority);
    assert.equal(status.ok, true);
    if (["completed", "failed"].includes(status.task.state)) break;
    await new Promise((r) => setTimeout(r, 20));
  }

  assert.equal(status.task.state, "completed");
  assert.equal(status.task.answer, "Answer for Summarize active chapter");
  assert.equal(executed, true);

  // Outcome contract verified
  assert.equal(status.task.outcome?.class, "claimed-complete");
  assert.equal(status.task.outcome?.basis, "executor-claimed");
});

test("call-ID deduplication: idempotent on same content, conflicts on changed content", async () => {
  let writes = 0;
  const executor = {
    check: () => ({ ok: true, mechanism: "test", bounds: { deadlineMs: 5000, maxOutputBytes: 1024 } }),
    run: async () => {
      writes++;
      return "done";
    },
  };

  const host = createBrowserTaskHost({
    environment: "env_browser_dup",
    instance: "tab-dup",
    executor: () => executor,
  });

  const auth = { owner: "client-owner-1", callId: "stable-call-100" };

  // First call
  const first = await host.call("delegate_task", { agent: "test", task: "same task" }, auth);
  assert.equal(first.ok, true);
  assert.equal(first.existing, false);

  // Poll until completed
  for (let i = 0; i < 30; i++) {
    const st = await host.call("task_status", { address: first.task.address }, auth);
    if (st.task?.state === "completed") break;
    await new Promise((r) => setTimeout(r, 10));
  }

  // Second call with same ID and same content -> idempotent return of existing task
  const second = await host.call("delegate_task", { agent: "test", task: "same task" }, auth);
  assert.equal(second.ok, true);
  assert.equal(second.existing, true);
  assert.equal(second.task.address, first.task.address);
  assert.equal(writes, 1, "executor must not execute a second time for duplicate callId");

  // Third call with same ID but different content -> conflict
  const conflict = await host.call("delegate_task", { agent: "test", task: "different task content" }, auth);
  assert.equal(conflict.ok, false);
  assert.equal(conflict.refused, "task-call-id-conflict");
});

test("atomic capacity reservation: concurrent admissions cannot exceed four browser executions", async () => {
  let running = 0;
  let peak = 0;
  const releases = [];

  const executor = {
    check: () => ({ ok: true, mechanism: "test", bounds: { deadlineMs: 5000, maxOutputBytes: 1024 } }),
    run: async () => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => releases.push(r));
      running--;
      return "finished";
    },
  };

  const host = createBrowserTaskHost({
    environment: "env_browser_conc",
    instance: "tab-conc",
    executor: () => executor,
  });

  // Launch 9 concurrent admissions via Promise.all
  const attempts = await Promise.all(
    Array.from({ length: 9 }, (_, i) =>
      host.call(
        "delegate_task",
        { agent: "test", task: `concurrent task ${i}` },
        { owner: "owner-conc", callId: `call-conc-${i}` },
      ),
    ),
  );

  const accepted = attempts.filter((r) => r.ok);
  const refused = attempts.filter((r) => !r.ok);

  // Exactly 4 admitted, exactly 5 refused
  assert.equal(accepted.length, 4, "must accept exactly 4 tasks");
  assert.equal(refused.length, 5, "must reject 5 overflow tasks");
  assert.ok(refused.every((r) => r.refused === "task-capacity-exhausted"));

  // Release running tasks
  releases.forEach((r) => r());
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(peak <= 4, "peak concurrency must not exceed 4");
});

test("immutability: root and bounds captured before async signing window", async () => {
  const selectedRoot = { kind: "opfs", path: "captured-before", environment: "env_immut" };
  const bounds = { deadlineMs: 1000, maxOutputBytes: 4 };
  let capturedAtRun = null;

  const executor = {
    check: () => ({ ok: true, mechanism: "test", bounds }),
    run: async ({ root, bounds: b }) => {
      capturedAtRun = { root, bounds: b };
      return "more than four bytes";
    },
  };

  const host = createBrowserTaskHost({
    environment: "env_immut",
    instance: "tab-immut",
    root: () => selectedRoot,
    executor: () => executor,
  });

  const auth = { owner: "owner-immut", callId: "call-immut" };

  // Dispatch admission
  const pending = host.call("delegate_task", { agent: "test", task: "immutability task" }, auth);

  // Mutate caller objects synchronously while signing is pending
  selectedRoot.path = "captured-after";
  bounds.maxOutputBytes = 1024;

  const admitted = await pending;
  assert.equal(admitted.ok, true);

  // Poll until terminal
  let status;
  for (let i = 0; i < 50; i++) {
    status = await host.call("task_status", { address: admitted.task.address }, auth);
    if (["completed", "failed"].includes(status.task?.state)) break;
    await new Promise((r) => setTimeout(r, 20));
  }

  // The runner saw the frozen values captured at admission
  assert.equal(capturedAtRun.root.path, "captured-before");
  assert.equal(capturedAtRun.bounds.maxOutputBytes, 4);

  // Because the runner captured 4 bytes max and output was >4, it failed output-over-budget
  assert.equal(status.task.state, "failed");
  assert.equal(status.task.reason, "task-output-over-budget");
});

test("alive check: timed-out executors retain capacity until runner promise settles", async () => {
  let alive = 0;
  const finishes = [];

  const executor = {
    check: () => ({ ok: true, mechanism: "test", bounds: { deadlineMs: 30, maxOutputBytes: 100 } }),
    run: async () => {
      alive++;
      await new Promise((r) => finishes.push(r));
      alive--;
      return "finished late";
    },
  };

  const host = createBrowserTaskHost({
    environment: "env_browser_alive",
    instance: "tab-alive",
    executor: () => executor,
  });

  // Admit 4 tasks
  const tasks = [];
  for (let i = 0; i < 4; i++) {
    tasks.push(await host.call("delegate_task", { agent: "test", task: `timed ${i}` }, { owner: "owner-alive", callId: `call-timed-${i}` }));
  }

  // Wait for 30ms deadlines to elapse and tasks to record interrupted
  for (const t of tasks) {
    for (let i = 0; i < 50; i++) {
      const st = await host.call("task_status", { address: t.task.address }, { owner: "owner-alive" });
      if (st.task?.state === "interrupted") break;
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  // The 4 runners are still alive in the background
  assert.equal(alive, 4, "all 4 runners must still be alive");

  // Attempting 5th task while 4 are still alive MUST refuse capacity-exhausted
  const overflow = await host.call("delegate_task", { agent: "test", task: "fifth task" }, { owner: "owner-alive", callId: "call-overflow" });
  assert.equal(overflow.ok, false);
  assert.equal(overflow.refused, "task-capacity-exhausted");

  // Finish background executions
  finishes.forEach((r) => r());
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(alive, 0);

  // Now that capacity is released, 5th task can be admitted
  const retry5 = await host.call("delegate_task", { agent: "test", task: "fifth task" }, { owner: "owner-alive", callId: "call-retry-5" });
  assert.equal(retry5.ok, true);
  finishes.forEach((r) => r());
});

test("placement dispatcher: rejects unknown placement and mismatched environment", () => {
  const machineHost = { call: () => "machine", placement: "machine", environment: "env_machine_a" };
  const browserHost = { call: () => "browser", placement: "browser", environment: "env_browser_a" };

  const dispatcher = createPlacementDispatcher({
    machine: machineHost,
    browser: browserHost,
  });

  // Typo placement
  const typo = dispatcher.dispatch({ key: "env_typo", kind: "browesr" });
  assert.equal(typo.ok, false);
  assert.equal(typo.refused, "placement-unavailable");

  // Mismatched environment key
  const mismatch = dispatcher.dispatch({ key: "env_browser_b", kind: "browser" });
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.refused, "environment-mismatch");

  // Matched environment
  const match = dispatcher.dispatch({ key: "env_browser_a", kind: "browser" });
  assert.equal(match.ok, true);
  assert.equal(match.host.call(), "browser");
});

test("tuple identity: distinct owner/callId pairs cannot share or alias deduplication records", async () => {
  let writes = 0;
  const executor = {
    check: () => ({ ok: true, mechanism: "test", bounds: { deadlineMs: 5000, maxOutputBytes: 1024 } }),
    run: async () => {
      writes++;
      return "done";
    },
  };

  const host = createBrowserTaskHost({
    environment: "env_tuple_test",
    instance: "tab-tuple",
    executor: () => executor,
  });

  // Two distinct (owner, callId) pairs that would alias under naive colon concatenation: ("a:b", "c") vs ("a", "b:c")
  const authA = { owner: "a:b", callId: "c" };
  const authB = { owner: "a", callId: "b:c" };

  const first = await host.call("delegate_task", { agent: "test", task: "first" }, authA);
  assert.equal(first.ok, true);
  assert.equal(first.existing, false);

  const second = await host.call("delegate_task", { agent: "test", task: "second" }, authB);
  assert.equal(second.ok, true);
  assert.equal(second.existing, false);
  assert.notEqual(second.task.address, first.task.address, "distinct principals must get distinct task addresses");
  assert.equal(writes, 2, "both tasks must execute independently");

  // Foreign owner cannot read first task
  const foreignRead = await host.call("task_status", { address: first.task.address }, authB);
  assert.equal(foreignRead.ok, false);
  assert.equal(foreignRead.refused, "task-owner-mismatch");
});

test("durable persistence failure: quota error fails closed and forbids execution", async () => {
  let ran = false;
  const executor = {
    check: () => ({ ok: true, mechanism: "test", bounds: { deadlineMs: 5000, maxOutputBytes: 1024 } }),
    run: async () => {
      ran = true;
      return "should not run";
    },
  };

  // Mock localStorage that throws QuotaExceededError
  const origStorage = globalThis.localStorage;
  try {
    globalThis.localStorage = {
      getItem: () => null,
      setItem: () => {
        const err = new Error("Quota exceeded");
        err.name = "QuotaExceededError";
        throw err;
      },
      removeItem: () => {},
    };

    const host = createBrowserTaskHost({
      environment: "env_quota_test",
      instance: "tab-quota",
      executor: () => executor,
    });

    const res = await host.call(
      "delegate_task",
      { agent: "test", task: "quota test" },
      { owner: "quota-owner", callId: "call-quota" },
    );

    assert.equal(res.ok, false);
    assert.equal(res.refused, "task-persistence-failed");
    assert.equal(ran, false, "execution must not be authorized when durable persistence fails");
  } finally {
    if (origStorage) globalThis.localStorage = origStorage;
    else delete globalThis.localStorage;
  }
});

test("lost runner reconciliation: dead prior generation reconciles to interrupted on status read", async () => {
  let hostRan = false;
  const executor = {
    check: () => ({ ok: true, mechanism: "test", bounds: { deadlineMs: 5000, maxOutputBytes: 1024 } }),
    run: () => new Promise(() => { hostRan = true; }), // held running
  };

  const keyBytes = new Uint8Array(32).fill(88);
  const hostOld = createBrowserTaskHost({
    environment: "env_dead_gen",
    instance: "tab-gen",
    boot: "boot-generation-1",
    keyBytes,
    executor: () => executor,
  });

  const auth = { owner: "owner-gen", callId: "call-gen-1" };
  const admitted = await hostOld.call("delegate_task", { agent: "test", task: "held task" }, auth);
  assert.equal(admitted.ok, true);
  const address = admitted.task.address;

  // Let task enter running state
  for (let i = 0; i < 20; i++) {
    const st = await hostOld.call("task_status", { address }, auth);
    if (st.task?.state === "running") break;
    await new Promise((r) => setTimeout(r, 10));
  }

  // Create new host from a different boot generation (simulating page reload after crash/close)
  const hostNew = createBrowserTaskHost({
    environment: "env_dead_gen",
    instance: "tab-gen",
    boot: "boot-generation-2",
    keyBytes,
    executor: () => { throw new Error("must not rerun"); },
  });

  const stNew = await hostNew.call("task_status", { address }, auth);
  assert.equal(stNew.ok, true);
  assert.equal(stNew.task.state, "interrupted", "lost runner from dead generation must be reconciled to interrupted");
  assert.equal(stNew.task.reason, "environment-ended-outcome-unknown");
  assert.equal(stNew.task.outcome?.class, "observed-interruption");
});

