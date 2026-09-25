// tests/task-card.test.mjs — D8: Result card + non-speech status/cancel (voicebox-beads-snp).
//
// WHAT THIS SUITE PROVES (driven, not read from descriptions):
//   1. core/task-card.ts unit tests:
//      - Four outcomes: idle, working, finished, finished-but-unconfirmed
//      - Cancel states: none, requested, stopped, asked-to-stop-and-did-not, refused
//      - Formatters: formatTaskState, formatRoot, formatSilence
//      - Silence: "No update since …" when elapsed >= threshold
//      - LocalTaskStore (Paul, 2026-09-21): zero-server browser-local ownership,
//        offline cached status is stale, not evidence of continuing execution.
//   2. Browser CDP driven tests against real page:
//      - Card renders each state (queued, running, completed, cancelled,
//        cancel_unconfirmed, failed, interrupted)
//      - Non-speech cancel driven from the card alone (#task-cancel-btn)
//      - Stale-labelled cache for unreachable environment
//      - Silence indicator on the card ("No update since …")
//      - Non-speech commands in text form (status/cancel)
//      - Plain-language check (zero jargon: executor, admitted, placement, envelope)
//
//   node --test tests/task-card.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ACP_AGENT } from "../lib/acp-client.mjs";
import { setTimeout as sleep } from "node:timers/promises";
import { startServer } from "./lib/server.mjs";
import { launch } from "./lib/cdp.mjs";
import {
  deriveOutcome,
  deriveCancelOutcome,
  formatTaskState,
  formatRoot,
  formatSilence,
  deriveCardData,
  LocalTaskStore,
} from "../core/task-card.ts";
import {
  refusalVocabulary,
  identifiersInRenderedText,
  READ_VISIBLE_TEXT,
} from "../tools/rendered-plain-language.mjs";

// ── 1. Unit tests: core/task-card.ts ─────────────────────────────────────────

test("task-card core: deriveOutcome maps states to coord's four categories", () => {
  assert.equal(deriveOutcome(null), "idle");
  assert.equal(deriveOutcome(undefined), "idle");

  assert.equal(deriveOutcome("queued"), "working");
  assert.equal(deriveOutcome("running"), "working");
  assert.equal(deriveOutcome("cancel_requested"), "working");

  assert.equal(deriveOutcome("cancel_unconfirmed"), "finished-but-unconfirmed");

  assert.equal(deriveOutcome("completed"), "finished");
  assert.equal(deriveOutcome("cancelled"), "finished");
  assert.equal(deriveOutcome("failed"), "finished");
  assert.equal(deriveOutcome("interrupted"), "finished");
});

test("task-card core: deriveCancelOutcome has at least stopped and asked-to-stop-and-did-not", () => {
  assert.equal(deriveCancelOutcome("running", false), "none");
  assert.equal(deriveCancelOutcome("running", true), "requested");
  assert.equal(deriveCancelOutcome("cancel_requested", false), "none");
  assert.equal(deriveCancelOutcome("cancel_requested", true), "requested");

  // Escalated outcomes:
  assert.equal(deriveCancelOutcome("cancelled", false), "stopped");
  assert.equal(deriveCancelOutcome("cancel_unconfirmed", false), "asked-to-stop-and-did-not");

  // Refusal:
  assert.equal(deriveCancelOutcome("completed", true, "task-not-running"), "refused");
});

test("task-card core: formatters use plain language", () => {
  assert.equal(formatTaskState("queued"), "Queued");
  assert.equal(formatTaskState("running"), "Running");
  assert.equal(formatTaskState("cancel_requested"), "Cancel requested");
  assert.equal(formatTaskState("cancelled"), "Stopped");
  assert.equal(formatTaskState("cancel_unconfirmed"), "Asked to stop and it did not");
  assert.equal(formatTaskState("completed"), "Completed");
  assert.equal(formatTaskState("failed"), "Failed");
  assert.equal(formatTaskState("interrupted"), "Interrupted");

  assert.equal(formatRoot({ kind: "machine", path: "/tmp/workspace" }), "machine: /tmp/workspace");
  assert.equal(formatRoot({ kind: "opfs", path: "v1/projects/atlas" }), "browser storage: v1/projects/atlas");
  assert.equal(formatRoot({ kind: "handle", id: "my-folder" }), "picked folder: my-folder");
});

test("task-card core: formatSilence shows 'No update since …' for silence", () => {
  const now = Date.now();
  const recent = new Date(now - 1000).toISOString();
  const sRecent = formatSilence(recent, now, 5000);
  assert.equal(sRecent.isSilent, false);
  assert.match(sRecent.text, /^Updated /);

  const silent = new Date(now - 8000).toISOString();
  const sSilent = formatSilence(silent, now, 5000);
  assert.equal(sSilent.isSilent, true);
  assert.match(sSilent.text, /^No update since /);
});

test("task-card core: LocalTaskStore runs entirely in browser-local placement with zero server", async () => {
  const store = new LocalTaskStore("browser-local");
  const admitted = store.admit({ agent: "local-agent", task: "build widget", context: [] });
  assert.ok(admitted.address.startsWith("task_local_"));
  assert.equal(admitted.state, "queued");

  // Status when reachable:
  const st1 = await store.status(admitted.address);
  assert.equal(st1.ok, true);
  assert.equal(st1.stale, false);
  assert.equal(st1.task.state, "queued");

  // Transition to running with progress:
  store.updateState(admitted.address, "running", { progress: "compiling assets" });
  const st2 = await store.status(admitted.address);
  assert.equal(st2.task.state, "running");
  assert.equal(st2.task.progress, "compiling assets");

  // Paul's requirement: "Offline cached status must be stale, not evidence of continuing execution"
  store.setReachable(false);
  const stStale = await store.status(admitted.address);
  assert.equal(stStale.ok, true);
  assert.equal(stStale.stale, true, "offline cached status must report stale: true");
  store.setReachable(true);

  // Non-speech cancel: observed stop
  const cancelRes = await store.cancel(admitted.address);
  assert.equal(cancelRes.ok, true);
  assert.equal(cancelRes.state, "cancelled");
  assert.equal(cancelRes.observed, true);

  // Once terminal, cancel refuses with task-not-running
  const cancelAgain = await store.cancel(admitted.address);
  assert.equal(cancelAgain.ok, false);
  assert.equal(cancelAgain.refused, "task-not-running");
});

test("task-card core: LocalTaskStore cancel escalation (ignoring runner -> cancel_unconfirmed)", async () => {
  const store = new LocalTaskStore("browser-local");
  const task = store.admit({ agent: "stubborn-agent", task: "long work", context: [] });
  store.updateState(task.address, "running");
  store.setCancelBehavior(task.address, "ignore");

  const cancelRes = await store.cancel(task.address, 20);
  assert.equal(cancelRes.ok, true);
  assert.equal(cancelRes.state, "cancel_unconfirmed");
  assert.equal(cancelRes.observed, false);

  const st = await store.status(task.address);
  assert.equal(st.task.state, "cancel_unconfirmed");
});

// ── 2. Browser CDP driven tests ─────────────────────────────────────────────

test("task-card browser: card renders each state and cancel works from the card alone", { timeout: 60000 }, async () => {
  const server = await startServer();
  const page = await launch();

  try {
    await page.goto(`${server.base}/`);
    await page.waitFor(() => window.__voiceboxTaskCard !== undefined, { label: "task card controller" });

    // Helper to evaluate in page
    const evaluate = (fn, ...args) => page.evaluate(fn, ...args);

    // 1. QUEUED STATE
    await evaluate(() => {
      window.__voiceboxTaskCard.setTask({
        address: "task_test_queued_123",
        agent: "test-agent",
        environment: "env_test1",
        root: { kind: "opfs", path: "v1/projects/demo" },
        state: "queued",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    });
    await sleep(200);

    const sQueued = await evaluate(() => {
      const card = document.querySelector("#task-card");
      const title = document.querySelector("#task-card-title")?.textContent;
      const stateBadge = document.querySelector("#task-card-state-badge")?.textContent;
      const outcomeBadge = document.querySelector("#task-card-outcome-badge")?.textContent;
      const cancelBtn = document.querySelector("#task-cancel-btn");
      return {
        hidden: card?.hidden,
        dataset: { ...card?.dataset },
        title,
        stateBadge,
        outcomeBadge,
        cancelDisabled: cancelBtn?.disabled,
      };
    });

    assert.equal(sQueued.hidden, false, "card should be visible");
    assert.equal(sQueued.dataset.state, "queued");
    assert.equal(sQueued.dataset.outcome, "working");
    assert.equal(sQueued.stateBadge, "Queued");
    assert.equal(sQueued.outcomeBadge, "working");
    assert.equal(sQueued.cancelDisabled, false, "cancel button must be enabled when working");

    // 2. RUNNING STATE WITH PROGRESS
    await evaluate(() => {
      window.__voiceboxTaskCard.setTask({
        address: "task_test_running_123",
        agent: "test-agent",
        environment: "env_test1",
        root: { kind: "machine", path: "/tmp/test-project" },
        state: "running",
        progress: "compiling assets 42%",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    });
    await sleep(200);

    const sRunning = await evaluate(() => {
      const card = document.querySelector("#task-card");
      const stateBadge = document.querySelector("#task-card-state-badge")?.textContent;
      const progress = document.querySelector("#task-card-progress")?.textContent;
      return { dataset: { ...card?.dataset }, stateBadge, progress };
    });

    assert.equal(sRunning.dataset.state, "running");
    assert.equal(sRunning.dataset.outcome, "working");
    assert.equal(sRunning.stateBadge, "Running");
    assert.match(sRunning.progress ?? "", /compiling assets/);

    // 3. CANCEL FROM THE CARD ALONE (Non-speech cancel)
    // When the cancel button is clicked on the card with ambient client:
    // Server refuses ambient access with named refusal, and feedback displays the refusal:
    await evaluate(() => {
      document.querySelector("#task-cancel-btn")?.click();
    });
    await sleep(200);

    const sCancelRefusal = await evaluate(() => {
      const feedback = document.querySelector("#task-action-feedback")?.textContent;
      return { feedback };
    });
    assert.match(sCancelRefusal.feedback ?? "", /authenticated paired caller/);

    // Now test cancel from the card with a client that resolves cancellation:
    // (a) Observed cancellation -> transitions to Stopped
    await evaluate(async () => {
      const { createTaskCard } = await import("/browser/task-card.ts");
      const localStore = {
        async status(addr) { return { ok: true, task: { address: addr, state: "running", agent: "agent-a", environment: "local", root: { kind: "opfs", path: "v1/t" }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } }; },
        async cancel(addr) { return { ok: true, state: "cancelled", observed: true }; },
      };
      const card = createTaskCard(document.querySelector("#task-card"), { client: localStore });
      window.__voiceboxTaskCard = card;
      card.setTask({
        address: "task_test_live_cancel",
        agent: "agent-a",
        environment: "local",
        root: { kind: "opfs", path: "v1/t" },
        state: "running",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      // Click cancel button on card alone:
      document.querySelector("#task-cancel-btn")?.click();
    });
    await sleep(200);

    const sObservedCancel = await evaluate(() => {
      const stateBadge = document.querySelector("#task-card-state-badge")?.textContent;
      const cancelBadge = document.querySelector("#task-card-cancel-badge")?.textContent;
      const feedback = document.querySelector("#task-action-feedback")?.textContent;
      const cancelBtn = document.querySelector("#task-cancel-btn");
      return { stateBadge, cancelBadge, feedback, cancelDisabled: cancelBtn?.disabled };
    });
    assert.equal(sObservedCancel.stateBadge, "Stopped");
    assert.equal(sObservedCancel.cancelBadge, "Stopped");
    assert.equal(sObservedCancel.feedback, "Stopped");
    assert.equal(sObservedCancel.cancelDisabled, true, "cancel button must be disabled after cancellation");

    // (b) Cancel unconfirmed -> transitions to "Asked to stop and it did not"
    await evaluate(async () => {
      const { createTaskCard } = await import("/browser/task-card.ts");
      const localStoreUnconfirmed = {
        async status(addr) { return { ok: true, task: { address: addr, state: "running", agent: "agent-a", environment: "local", root: { kind: "opfs", path: "v1/t" }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } }; },
        async cancel(addr) { return { ok: true, state: "cancel_unconfirmed", observed: false }; },
      };
      const card = createTaskCard(document.querySelector("#task-card"), { client: localStoreUnconfirmed });
      window.__voiceboxTaskCard = card;
      card.setTask({
        address: "task_test_live_unconfirmed",
        agent: "agent-a",
        environment: "local",
        root: { kind: "opfs", path: "v1/t" },
        state: "running",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      // Click cancel button on card alone:
      document.querySelector("#task-cancel-btn")?.click();
    });
    await sleep(200);

    const sUnconfirmedCancel = await evaluate(() => {
      const stateBadge = document.querySelector("#task-card-state-badge")?.textContent;
      const cancelBadge = document.querySelector("#task-card-cancel-badge")?.textContent;
      const feedback = document.querySelector("#task-action-feedback")?.textContent;
      return { stateBadge, cancelBadge, feedback };
    });
    assert.equal(sUnconfirmedCancel.stateBadge, "Asked to stop and it did not");
    assert.equal(sUnconfirmedCancel.cancelBadge, "Asked to stop and it did not");
    assert.equal(sUnconfirmedCancel.feedback, "Asked to stop and it did not");

    // 4. CANCELLED (STOPPED) STATE
    await evaluate(() => {
      window.__voiceboxTaskCard.setTask({
        address: "task_test_cancelled_123",
        agent: "test-agent",
        environment: "env_test1",
        root: { kind: "machine", path: "/tmp/test-project" },
        state: "cancelled",
        reason: "stopped by user",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    });
    await sleep(200);

    const sCancelled = await evaluate(() => {
      const card = document.querySelector("#task-card");
      const stateBadge = document.querySelector("#task-card-state-badge")?.textContent;
      const cancelBadge = document.querySelector("#task-card-cancel-badge")?.textContent;
      const cancelBtn = document.querySelector("#task-cancel-btn");
      return { dataset: { ...card?.dataset }, stateBadge, cancelBadge, cancelDisabled: cancelBtn?.disabled };
    });

    assert.equal(sCancelled.dataset.state, "cancelled");
    assert.equal(sCancelled.dataset.outcome, "finished");
    assert.equal(sCancelled.stateBadge, "Stopped");
    assert.equal(sCancelled.cancelBadge, "Stopped");
    assert.equal(sCancelled.cancelDisabled, true, "cancel button must be disabled when finished");

    // 5. CANCEL_UNCONFIRMED ("Asked to stop and it did not")
    await evaluate(() => {
      window.__voiceboxTaskCard.setTask({
        address: "task_test_unconfirmed_123",
        agent: "test-agent",
        environment: "env_test1",
        root: { kind: "machine", path: "/tmp/test-project" },
        state: "cancel_unconfirmed",
        reason: "executor did not observe cancellation within grace window",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    });
    await sleep(200);

    const sUnconfirmed = await evaluate(() => {
      const card = document.querySelector("#task-card");
      const stateBadge = document.querySelector("#task-card-state-badge")?.textContent;
      const cancelBadge = document.querySelector("#task-card-cancel-badge")?.textContent;
      return { dataset: { ...card?.dataset }, stateBadge, cancelBadge };
    });

    assert.equal(sUnconfirmed.dataset.state, "cancel_unconfirmed");
    assert.equal(sUnconfirmed.dataset.outcome, "finished-but-unconfirmed");
    assert.equal(sUnconfirmed.stateBadge, "Asked to stop and it did not");
    assert.equal(sUnconfirmed.cancelBadge, "Asked to stop and it did not");

    // 6. COMPLETED STATE WITH ANSWER
    await evaluate(() => {
      window.__voiceboxTaskCard.setTask({
        address: "task_test_completed_123",
        agent: "test-agent",
        environment: "env_test1",
        root: { kind: "machine", path: "/tmp/test-project" },
        state: "completed",
        answer: "built 3 assets successfully",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    });
    await sleep(200);

    const sCompleted = await evaluate(() => {
      const card = document.querySelector("#task-card");
      const stateBadge = document.querySelector("#task-card-state-badge")?.textContent;
      const answer = document.querySelector("#task-card-answer")?.textContent;
      const cancelBtn = document.querySelector("#task-cancel-btn");
      const viewFilesBtn = document.querySelector("#task-view-files-btn");
      const dismissBtn = document.querySelector("#task-dismiss-btn");
      return {
        dataset: { ...card?.dataset },
        stateBadge,
        answer,
        cancelDisabled: cancelBtn?.disabled,
        hasViewFiles: Boolean(viewFilesBtn),
        hasDismiss: Boolean(dismissBtn),
      };
    });

    assert.equal(sCompleted.dataset.state, "completed");
    assert.equal(sCompleted.dataset.outcome, "finished");
    assert.equal(sCompleted.stateBadge, "Completed");
    assert.match(sCompleted.answer ?? "", /built 3 assets successfully/);
    assert.equal(sCompleted.cancelDisabled, true);
    assert.equal(sCompleted.hasViewFiles, true, "completed task card must render view files button");
    assert.equal(sCompleted.hasDismiss, true, "completed task card must render dismiss button");

    // Dismiss action clears the card
    await evaluate(() => {
      document.querySelector("#task-dismiss-btn")?.click();
    });
    await sleep(200);
    const sDismissed = await evaluate(() => document.querySelector("#task-card")?.hidden);
    assert.equal(sDismissed, true, "clicking dismiss button must hide the card");

    // 7. FAILED STATE WITH PARTIAL OUTPUT
    await evaluate(() => {
      window.__voiceboxTaskCard.setTask({
        address: "task_test_failed_123",
        agent: "test-agent",
        environment: "env_test1",
        root: { kind: "machine", path: "/tmp/test-project" },
        state: "failed",
        reason: "build step failed with exit code 1",
        partial: "intermediate build log line 1\nintermediate build log line 2",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    });
    await sleep(200);

    const sFailed = await evaluate(() => {
      const card = document.querySelector("#task-card");
      const stateBadge = document.querySelector("#task-card-state-badge")?.textContent;
      const reason = document.querySelector("#task-card-reason")?.textContent;
      const partial = document.querySelector("#task-card-partial")?.textContent;
      return { dataset: { ...card?.dataset }, stateBadge, reason, partial };
    });

    assert.equal(sFailed.dataset.state, "failed");
    assert.equal(sFailed.dataset.outcome, "finished");
    assert.equal(sFailed.stateBadge, "Failed");
    assert.match(sFailed.reason ?? "", /build step failed/);
    assert.match(sFailed.partial ?? "", /intermediate build log/);

    // 8. INTERRUPTED STATE
    await evaluate(() => {
      window.__voiceboxTaskCard.setTask({
        address: "task_test_interrupted_123",
        agent: "test-agent",
        environment: "env_test1",
        root: { kind: "machine", path: "/tmp/test-project" },
        state: "interrupted",
        reason: "task deadline elapsed",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    });
    await sleep(200);

    const sInterrupted = await evaluate(() => {
      const card = document.querySelector("#task-card");
      const stateBadge = document.querySelector("#task-card-state-badge")?.textContent;
      const reason = document.querySelector("#task-card-reason")?.textContent;
      return { dataset: { ...card?.dataset }, stateBadge, reason };
    });

    assert.equal(sInterrupted.dataset.state, "interrupted");
    assert.equal(sInterrupted.dataset.outcome, "finished");
    assert.equal(sInterrupted.stateBadge, "Interrupted");
    assert.match(sInterrupted.reason ?? "", /deadline elapsed/);

    // 9. SILENCE: "No update since …"
    await evaluate(() => {
      const tenSecsAgo = new Date(Date.now() - 10000).toISOString();
      window.__voiceboxTaskCard.setTask({
        address: "task_test_silent_123",
        agent: "test-agent",
        environment: "env_test1",
        root: { kind: "machine", path: "/tmp/test-project" },
        state: "running",
        createdAt: tenSecsAgo,
        updatedAt: tenSecsAgo,
      });
    });
    await sleep(200);

    const sSilent = await evaluate(() => {
      const card = document.querySelector("#task-card");
      const updateText = document.querySelector("#task-card-update")?.textContent;
      return { dataset: { ...card?.dataset }, updateText };
    });

    assert.equal(sSilent.dataset.silent, "true");
    assert.match(sSilent.updateText ?? "", /^No update since /);

    // 10. STALE-LABELLED CACHE FOR UNREACHABLE ENVIRONMENT
    await evaluate(() => {
      window.__voiceboxTaskCard.setTask({
        address: "task_test_stale_123",
        agent: "test-agent",
        environment: "env_remote_offline",
        root: { kind: "machine", path: "/remote/path" },
        state: "running",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }, { stale: true });
    });
    await sleep(200);

    const sStale = await evaluate(() => {
      const card = document.querySelector("#task-card");
      const staleBadge = document.querySelector("#task-card-stale-badge")?.textContent;
      const staleNotice = document.querySelector("#task-stale-notice")?.textContent;
      return { dataset: { ...card?.dataset }, staleBadge, staleNotice };
    });

    assert.equal(sStale.dataset.freshness, "stale");
    assert.match(sStale.staleBadge ?? "", /Offline cached status \(stale\)/);
    assert.match(sStale.staleNotice ?? "", /not evidence of continuing execution/i);

    // 11. PLAIN LANGUAGE: ZERO JARGON IN VISIBLE TEXT
    const readVisible = new Function(`return ${READ_VISIBLE_TEXT};`);
    const visibleText = await evaluate(readVisible);
    const jargonHits = identifiersInRenderedText(visibleText);
    const forbidden = jargonHits.filter(h => h.label === "jargon");
    assert.deepEqual(forbidden, [], `task card rendered forbidden jargon: ${JSON.stringify(forbidden)}`);

    // 12. NON-SPEECH COMMAND IN COMPOSER TEXT FORM
    await evaluate(() => {
      const input = document.querySelector("#utterance");
      const form = document.querySelector("#text-form");
      if (input && form) {
        input.value = "status task_test_stale_123";
        form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      }
    });
    await sleep(300);

    const turnReport = await evaluate(() => document.querySelector("#turn-report")?.textContent);
    assert.match(turnReport ?? "", /checked task status/);

    // 13. DYNAMIC TASK CARD MOUNT VIA LIVE TASK FRAME WITHOUT TYPING STATUS
    // Dismiss first to ensure card is hidden
    await evaluate(() => {
      window.__voiceboxTaskCard.setTask(null);
    });
    await sleep(200);
    const beforeLive = await evaluate(() => document.querySelector("#task-card")?.hidden);
    assert.equal(beforeLive, true, "card must start hidden");

    // Deliver a task frame via the live voice hook (mirroring WebSocket {type: "task"})
    await evaluate(() => {
      window.__voiceboxOnTask?.({
        address: "task_dynamic_live_789",
        agent: "auto-agent",
        environment: "local",
        root: { kind: "opfs", path: "v1/live-project" },
        state: "running",
        progress: "delegated work in flight",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    });
    await sleep(200);

    const afterLive = await evaluate(() => {
      const card = document.querySelector("#task-card");
      const agent = document.querySelector("#task-card-agent")?.textContent;
      const stateBadge = document.querySelector("#task-card-state-badge")?.textContent;
      const progress = document.querySelector("#task-card-progress")?.textContent;
      return {
        hidden: card?.hidden,
        agent,
        stateBadge,
        progress,
      };
    });

    assert.equal(afterLive.hidden, false, "task frame must dynamically mount and unhide task card without typing status");
    assert.equal(afterLive.agent, "auto-agent");
    assert.equal(afterLive.stateBadge, "Running");
    assert.match(afterLive.progress ?? "", /delegated work in flight/);
  } finally {
    await page.close();
    await server.stop();
  }
});

test("task-card browser: delegation turn automatically mounts task card without typing status", { timeout: 30000 }, async (t) => {
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "vb-card-turn-")));
  const workspace = path.join(scratch, "project");
  fs.mkdirSync(workspace, { recursive: true });

  const defaultAdapter = path.join(os.homedir(), ".pi/agent/npm/node_modules/pi-acp");
  let adapterDir = process.env.VOICEBOX_ACP_ADAPTER ?? defaultAdapter;
  if (!fs.existsSync(path.join(adapterDir, "dist", "index.js"))) {
    adapterDir = path.join(scratch, "pi-acp-stub");
    fs.mkdirSync(path.join(adapterDir, "dist"), { recursive: true });
    fs.writeFileSync(path.join(adapterDir, "package.json"), JSON.stringify({ name: "pi-acp", version: ACP_AGENT.version }));
    fs.writeFileSync(path.join(adapterDir, "dist", "index.js"), "setTimeout(() => {}, 5000);\n");
  }

  const server = await startServer({
    env: {
      VOICEBOX_WORKSPACE: workspace,
      VOICEBOX_RESOLVER: "script",
      VOICEBOX_HARNESS: "pi",
      VOICEBOX_ACP_ADAPTER: adapterDir,
    },
  });
  t.after(async () => {
    await server.stop();
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  const page = await launch();
  t.after(() => page.close());

  await page.goto(`${server.base}/`);
  await page.waitFor(() => window.__voiceboxTaskCard !== undefined, { label: "task card controller" });

  // Initially hidden
  const initHidden = await page.evaluate(() => document.querySelector("#task-card")?.hidden);
  assert.equal(initHidden, true, "task card should start hidden");

  // Send turn through composer: "ask pi to review code"
  await page.evaluate(() => {
    const input = document.querySelector("#utterance");
    const form = document.querySelector("#text-form");
    input.value = "ask pi to review code";
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });

  // Wait for task-card to become visible
  await page.waitFor(() => {
    const card = document.querySelector("#task-card");
    return card && !card.hidden && document.querySelector("#task-card-agent")?.textContent === "pi";
  }, { label: "task card appearing automatically" });

  const cardData = await page.evaluate(() => {
    const card = document.querySelector("#task-card");
    const agent = document.querySelector("#task-card-agent")?.textContent;
    const title = document.querySelector("#task-card-title")?.textContent;
    const stateBadge = document.querySelector("#task-card-state-badge")?.textContent;
    return {
      hidden: card?.hidden,
      agent,
      title,
      stateBadge,
    };
  });

  assert.equal(cardData.hidden, false, "task card must be visible after delegation turn");
  assert.equal(cardData.agent, "pi");
  assert.match(cardData.title, /^Task: task_/);
});
