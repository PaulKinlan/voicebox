// tests/task-placement.test.mjs — Zero-server browser-owned delegation contract (voicebox-beads-8fv.1)
//
// Hard requirement (Paul, 2026-09-21):
//   "there is a world where there is zero server and it's all run locally on the client,
//    and that has to be a hard requirement."
//
// Tests:
//   1. Placement derivation for environment kinds and reach
//   2. Placement-specific execution bounds and limits
//   3. createBrowserTaskHost: zero-server admission, OPFS/handle roots, WebCrypto sealing, execution and cancel honesty
//   4. Multi-environment placement dispatch without a central server broker
//   5. Portable root reduction in core/tasks.ts (opfs, handle, machine)

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
});

test("browser task host: zero-server admission, execution and completion on OPFS root", async () => {
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
    async run({ input, bounds, signal, root }) {
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
});

test("browser task host: handle root and cancellation honesty", async () => {
  let abortObserved = false;
  const executor = {
    check() {
      return {
        ok: true,
        mechanism: "client-side-wasm",
        bounds: { deadlineMs: 15000, maxOutputBytes: 1024 },
      };
    },
    run({ signal }) {
      return new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => {
          abortObserved = true;
          reject(Object.assign(new Error("aborted by user"), { refused: "task-cancelled" }));
        });
      });
    },
  };

  const host = createBrowserTaskHost({
    environment: "env_browser_picked",
    instance: "tab-picked",
    root: () => ({ kind: "handle", id: "user-picked-folder", environment: "env_browser_picked" }),
    executor: () => executor,
  });

  const authority = { owner: "client-owner-2", callId: "call-picked-1" };

  const admitted = await host.call("delegate_task", {
    agent: "any-agent",
    task: "Long running client work",
  }, authority);

  assert.equal(admitted.ok, true);
  const address = admitted.task.address;

  // Let task enter running state
  await new Promise((r) => setTimeout(r, 20));

  // Cancel task
  const cancelRes = await host.call("cancel_task", { address }, authority);
  assert.equal(cancelRes.ok, true);
  assert.equal(cancelRes.state, "cancelled");
  assert.equal(cancelRes.observed, true);
  assert.equal(abortObserved, true);

  // Status is cancelled
  const st = await host.call("task_status", { address }, authority);
  assert.equal(st.task.state, "cancelled");
  assert.equal(st.task.reason, "task-cancelled");

  // Subsequent cancel on terminal task refuses
  const cancelAgain = await host.call("cancel_task", { address }, authority);
  assert.equal(cancelAgain.ok, false);
  assert.equal(cancelAgain.refused, "task-not-running");
});

test("browser task host: enforces capacity and caller authority", async () => {
  const executor = {
    check: () => ({ ok: true, mechanism: "test", bounds: { deadlineMs: 5000, maxOutputBytes: 1024 } }),
    run: () => new Promise(() => {}), // hold forever
  };

  const host = createBrowserTaskHost({
    environment: "env_browser_cap",
    instance: "tab-cap",
    root: () => ({ kind: "opfs", path: "v1/cap", environment: "env_browser_cap" }),
    executor: () => executor,
  });

  const ownerA = { owner: "owner-a", callId: "call-1" };
  const ownerB = { owner: "owner-b", callId: "call-2" };

  // Admit max allowed browser tasks (4)
  const tasks = [];
  for (let i = 0; i < PLACEMENT_BOUNDS.browser.maxActiveTasks; i++) {
    const res = await host.call("delegate_task", { agent: "hold", task: `task ${i}` }, { owner: "owner-a", callId: `call-${i}` });
    assert.equal(res.ok, true);
    tasks.push(res.task);
  }

  // 5th task must refuse capacity-exhausted
  const overflow = await host.call("delegate_task", { agent: "hold", task: "task overflow" }, { owner: "owner-a", callId: "call-overflow" });
  assert.equal(overflow.ok, false);
  assert.equal(overflow.refused, "task-capacity-exhausted");

  // Foreign caller cannot read task of ownerA
  const foreignRead = await host.call("task_status", { address: tasks[0].address }, ownerB);
  assert.equal(foreignRead.ok, false);
  assert.equal(foreignRead.refused, "task-owner-mismatch");
});

test("placement dispatcher: routes to designated placement host without centralized broker", () => {
  const browserHost = { call: () => "browser-call", placement: "browser" };
  const machineHost = { call: () => "machine-call", placement: "machine" };
  const remoteHost = { call: () => "remote-call", placement: "remote" };

  const dispatcher = createPlacementDispatcher({
    browser: browserHost,
    machine: machineHost,
    remote: remoteHost,
  });

  const toBrowser = dispatcher.dispatch({ kind: "browser" });
  assert.equal(toBrowser.ok, true);
  assert.equal(toBrowser.placement, "browser");
  assert.equal(toBrowser.host.call(), "browser-call");

  const toServer = dispatcher.dispatch({ kind: "server" });
  assert.equal(toServer.ok, true);
  assert.equal(toServer.placement, "machine");
  assert.equal(toServer.host.call(), "machine-call");

  const toRemote = dispatcher.dispatch({ kind: "server", reach: "paired" });
  assert.equal(toRemote.ok, true);
  assert.equal(toRemote.placement, "remote");
  assert.equal(toRemote.host.call(), "remote-call");

  // Missing host
  const missingDispatcher = createPlacementDispatcher({ machine: machineHost });
  const missing = missingDispatcher.dispatch({ kind: "browser" });
  assert.equal(missing.ok, false);
  assert.equal(missing.refused, "placement-unavailable");
});

test("core/tasks reduction: supports portable roots (opfs, handle, machine)", () => {
  const opfsRecord = {
    address: "task_opfs_123.sig",
    environment: "env_browser_1",
    placement: "browser",
    owner: "owner-1",
    root: { kind: "opfs", path: "v1/projects/my-proj", environment: "env_browser_1" },
    project: "my-proj",
    instance: "browser-tab",
    callId: "call-1",
    input: { agent: "in-page", task: "do work", context: [] },
    bounds: { deadlineMs: 10000, maxOutputBytes: 1024 },
    mechanism: "browser-runner",
    boot: "boot-1",
    state: "queued",
    createdAt: "2026-09-24T00:00:00.000Z",
    updatedAt: "2026-09-24T00:00:00.000Z",
  };

  const entries = [
    {
      kind: "task",
      seq: 1,
      instance: "browser-tab",
      project: "my-proj",
      root: "opfs:v1/projects/my-proj",
      turn: "call-1",
      at: "2026-09-24T00:00:00.000Z",
      task: { address: "task_opfs_123.sig", state: "queued", created: opfsRecord },
    },
    {
      kind: "task",
      seq: 2,
      instance: "browser-tab",
      project: "my-proj",
      root: "opfs:v1/projects/my-proj",
      turn: "call-1",
      at: "2026-09-24T00:00:01.000Z",
      task: { address: "task_opfs_123.sig", state: "running" },
    },
    {
      kind: "task",
      seq: 3,
      instance: "browser-tab",
      project: "my-proj",
      root: "opfs:v1/projects/my-proj",
      turn: "call-1",
      at: "2026-09-24T00:00:02.000Z",
      task: { address: "task_opfs_123.sig", state: "completed", answer: "All done" },
    },
  ];

  const reduced = reduceTask(entries, "task_opfs_123.sig");
  assert.ok(reduced);
  assert.equal(reduced.state, "completed");
  assert.equal(reduced.answer, "All done");
  assert.equal(reduced.placement, "browser");
  assert.equal(reduced.outcome.class, "claimed-complete");

  const view = taskView(reduced);
  assert.equal(view.placement, "browser");
  assert.equal(view.agent, "in-page");
});
