// tests/tasks-progress.test.mjs — Task host live onProgress and onConsole contract (voicebox-beads-i8kg).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTaskHost } from "../lib/tasks.mjs";

test("tasks host: onProgress receives live progress and console events with redacted secrets", async (t) => {
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "vb-tasks-prog-")));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));

  const environment = "env_0123456789abcdef";
  const progressEvents = [];
  const host = createTaskHost({
    environment,
    instance: "inst_test_progress",
    boot: "boot_test_progress",
    addressKey: "test-only-host-key-not-a-live-credential",
    root: () => ({ project: "test", root: { kind: "machine", path: scratch, environment } }),
    executor: () => ({
      check: () => ({ ok: true, mechanism: "test", bounds: { deadlineMs: 5000, maxOutputBytes: 1024 } }),
      run: async ({ report, onConsole }) => {
        report("initializing claude-code");
        onConsole({ source: "stderr", text: "Connecting with key sk-ant-secretkey9876543210" });
        report("claude-code: using tool ReadFile");
        onConsole({ source: "stderr", text: "Read 42 lines from file.js successfully" });
        return "task finished";
      },
    }),
    onProgress: (view) => progressEvents.push(view),
  });

  const admitted = host.call("delegate_task", { agent: "claude-code", task: "inspect repo" }, { owner: "user-1", callId: "prog-1" });
  assert.equal(admitted.ok, true);

  // Poll until the runner completes and all onProgress events arrive
  for (let i = 0; i < 50 && progressEvents.length < 5; i++) {
    await new Promise((r) => setTimeout(r, 20));
  }

  assert.ok(progressEvents.length >= 4, `expected at least 4 progress/console events, got ${progressEvents.length}`);

  // Initial running transition
  assert.equal(progressEvents[0].state, "running");

  // Stage progress event
  const stageEvt = progressEvents.find((e) => e.progress === "initializing claude-code");
  assert.ok(stageEvt, "must capture stage progress event");

  // Console event with secret redaction
  const consoleEvt = progressEvents.find((e) => e.console && e.console.text.includes("Connecting with key"));
  assert.ok(consoleEvt, "must capture console event");
  assert.equal(consoleEvt.console.text, "Connecting with key [redacted]");
  assert.doesNotMatch(consoleEvt.console.text, /secretkey/);

  // Tool call stage
  const toolEvt = progressEvents.find((e) => e.progress === "claude-code: using tool ReadFile");
  assert.ok(toolEvt, "must capture tool call stage progress");
});

test("tasks host: late onConsole after settle never emits running state (finding P1-C)", async (t) => {
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "vb-tasks-late-")));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));

  const environment = "env_0123456789abcdef";
  const progressAfterSettle = [];
  let isSettled = false;

  const host = createTaskHost({
    environment,
    instance: "inst_test_late",
    boot: "boot_test_late",
    addressKey: "test-only-host-key-not-a-live-credential",
    root: () => ({ project: "test", root: { kind: "machine", path: scratch, environment } }),
    executor: () => ({
      check: () => ({ ok: true, mechanism: "test", bounds: { deadlineMs: 50, maxOutputBytes: 1024 } }),
      run: async ({ report, onConsole }) => {
        report("starting slow job");
        // Hold past deadline
        await new Promise((r) => setTimeout(r, 100));
        // Late stderr emission after settle
        onConsole({ source: "stderr", text: "Late message after deadline elapsed" });
        return "late done";
      },
    }),
    onProgress: (view) => {
      if (isSettled) progressAfterSettle.push(view);
    },
    onUpdate: (view) => {
      if (view.state !== "running") isSettled = true;
    },
  });

  const admitted = host.call("delegate_task", { agent: "claude-code", task: "late task" }, { owner: "user-1", callId: "late-1" });
  assert.equal(admitted.ok, true);

  await new Promise((r) => setTimeout(r, 200));
  assert.equal(progressAfterSettle.length, 0, "must not emit progress/running state after settlement");
});
