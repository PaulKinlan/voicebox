// browser/task-card.ts — D8: Result card DOM component + non-speech status/cancel (voicebox-beads-snp).
//
// WHAT: one task/result card showing agent, environment/root, state, last update;
// the same status/cancel commands work without speech; "No update since …" for silence;
// stale-labelled cache for an unreachable environment.
//
// PLAIN LANGUAGE: no internal jargon (executor, admitted, placement, envelope).
// All text uses clear, human words.
//
// RUNS ANYWHERE: works with a remote server via /api/call, or entirely in a browser
// client with LocalTaskStore (zero Voicebox server or local bridge).

import {
  deriveCardData,
  formatTaskState,
  formatRoot,
  type TaskCardData,
  type TaskOutcome,
  type CancelOutcome,
  type Freshness,
} from "../core/task-card.ts";
import type { TaskRecord, TaskState, TaskView } from "../core/tasks.ts";

export interface TaskCardClient {
  status(address: string): Promise<{ ok: true; task: TaskRecord | TaskView; stale?: boolean } | { ok: false; refused: string; why: string; stale?: boolean }>;
  cancel(address: string): Promise<{ ok: true; state: TaskState; observed: boolean } | { ok: false; refused: string; why: string }>;
}

export interface TaskCardOptions {
  client?: TaskCardClient;
  onCancel?: (address: string) => Promise<unknown> | void;
  onRefresh?: (address: string) => Promise<unknown> | void;
  silenceThresholdMs?: number;
}

/**
 * RemoteTaskClient: connects over HTTP to the Voicebox proxy (/api/call) or direct /api/execute.
 * If the environment is unreachable, reports stale: true rather than failing silently.
 */
export class RemoteTaskClient implements TaskCardClient {
  private envKey: string;
  private callEndpoint: string;
  private fetchImpl: typeof fetch;
  private cache = new Map<string, TaskRecord | TaskView>();

  constructor(options: { envKey?: string; callEndpoint?: string; fetchImpl?: typeof fetch } = {}) {
    this.envKey = options.envKey ?? "local";
    this.callEndpoint = options.callEndpoint ?? "/api/call";
    const rawFetch = options.fetchImpl ?? globalThis.fetch;
    this.fetchImpl = typeof rawFetch === "function" ? rawFetch.bind(globalThis) : rawFetch;
  }

  setEnvKey(key: string) {
    this.envKey = key;
  }

  async status(address: string) {
    try {
      const response = await this.fetchImpl(this.callEndpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ envKey: this.envKey, tool: "task_status", args: { address } }),
      });
      const data = await response.json();
      if (!response.ok || data.ok === false) {
        const cached = this.cache.get(address);
        if (cached && (data.refused === "environment-unreachable" || response.status === 502)) {
          return { ok: true as const, task: cached, stale: true };
        }
        return { ok: false as const, refused: data.refused ?? "status-failed", why: data.why ?? "could not read task status", stale: true };
      }
      if (data.task) this.cache.set(address, data.task);
      return { ok: true as const, task: data.task, stale: false };
    } catch (err) {
      const cached = this.cache.get(address);
      if (cached) return { ok: true as const, task: cached, stale: true };
      return { ok: false as const, refused: "environment-unreachable", why: String(err), stale: true };
    }
  }

  async cancel(address: string) {
    try {
      const response = await this.fetchImpl(this.callEndpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ envKey: this.envKey, tool: "cancel_task", args: { address } }),
      });
      const data = await response.json();
      if (!response.ok || data.ok === false) {
        return { ok: false as const, refused: data.refused ?? "cancel-failed", why: data.why ?? "could not cancel task" };
      }
      return { ok: true as const, state: data.state, observed: data.observed ?? true };
    } catch (err) {
      return { ok: false as const, refused: "environment-unreachable", why: String(err) };
    }
  }
}

/**
 * Render the task card DOM structure into container.
 */
export function renderTaskCard(
  container: HTMLElement,
  data: TaskCardData,
  actions: { onCancel?: () => void; onRefresh?: () => void } = {}
) {
  container.dataset.outcome = data.outcome;
  container.dataset.state = data.state;
  container.dataset.freshness = data.freshness;
  container.dataset.cancelState = data.cancelOutcome;
  container.dataset.silent = String(data.isSilent);

  // Clear previous children
  container.replaceChildren();

  // Header
  const header = document.createElement("div");
  header.className = "task-card-header";

  const title = document.createElement("h3");
  title.className = "task-card-title";
  title.id = "task-card-title";
  title.textContent = `Task: ${data.address}`;
  header.append(title);

  // Badges
  const badges = document.createElement("div");
  badges.className = "task-badges";

  const stateBadge = document.createElement("span");
  stateBadge.className = `task-badge task-badge-${data.state}`;
  stateBadge.id = "task-card-state-badge";
  stateBadge.textContent = formatTaskState(data.state);
  badges.append(stateBadge);

  const outcomeBadge = document.createElement("span");
  outcomeBadge.className = `task-badge task-badge-outcome-${data.outcome}`;
  outcomeBadge.id = "task-card-outcome-badge";
  outcomeBadge.textContent = data.outcome;
  badges.append(outcomeBadge);

  if (data.freshness === "stale") {
    const staleBadge = document.createElement("span");
    staleBadge.className = "task-badge task-badge-stale";
    staleBadge.id = "task-card-stale-badge";
    staleBadge.textContent = "Offline cached status (stale)";
    badges.append(staleBadge);
  }

  if (data.cancelOutcome !== "none") {
    const cancelBadge = document.createElement("span");
    cancelBadge.className = `task-badge task-badge-cancel-${data.cancelOutcome}`;
    cancelBadge.id = "task-card-cancel-badge";
    cancelBadge.textContent =
      data.cancelOutcome === "stopped" ? "Stopped" :
      data.cancelOutcome === "asked-to-stop-and-did-not" ? "Asked to stop and it did not" :
      data.cancelOutcome === "requested" ? "Cancel requested" : "Cancel refused";
    badges.append(cancelBadge);
  }

  header.append(badges);
  container.append(header);

  // Stale notice if offline
  if (data.freshness === "stale" && data.staleReason) {
    const notice = document.createElement("p");
    notice.className = "task-stale-notice";
    notice.id = "task-stale-notice";
    notice.textContent = data.staleReason;
    container.append(notice);
  }

  // Meta grid
  const metaList = document.createElement("dl");
  metaList.className = "task-meta-grid";

  const addMeta = (label: string, value: string, id: string) => {
    const dt = document.createElement("dt");
    dt.textContent = label;
    const dd = document.createElement("dd");
    dd.id = id;
    dd.textContent = value;
    metaList.append(dt, dd);
  };

  addMeta("Agent", data.agent, "task-card-agent");
  addMeta("Environment", data.environment, "task-card-env");
  addMeta("Project folder", formatRoot(data.root), "task-card-root");
  addMeta("Last update", data.lastUpdateText, "task-card-update");

  container.append(metaList);

  // Progress if active
  if (data.progress) {
    const progressBlock = document.createElement("div");
    progressBlock.className = "task-progress-block";
    progressBlock.id = "task-card-progress";
    const pLabel = document.createElement("span");
    pLabel.className = "task-section-label";
    pLabel.textContent = "Progress: ";
    const pText = document.createElement("span");
    pText.className = "task-progress-text";
    pText.textContent = data.progress;
    progressBlock.append(pLabel, pText);
    container.append(progressBlock);
  }

  // Result / Answer
  if (data.answer !== undefined) {
    const answerBlock = document.createElement("div");
    answerBlock.className = "task-answer-block";
    answerBlock.id = "task-card-answer";
    const h4 = document.createElement("h4");
    h4.textContent = "Answer";
    const pre = document.createElement("pre");
    pre.className = "task-output-text";
    pre.textContent = data.answer;
    answerBlock.append(h4, pre);
    container.append(answerBlock);
  }

  // Partial output
  if (data.partial !== undefined) {
    const partialBlock = document.createElement("div");
    partialBlock.className = "task-partial-block";
    partialBlock.id = "task-card-partial";
    const h4 = document.createElement("h4");
    h4.textContent = "Partial output";
    const pre = document.createElement("pre");
    pre.className = "task-output-text";
    pre.textContent = data.partial;
    partialBlock.append(h4, pre);
    container.append(partialBlock);
  }

  // Reason / Refusal
  if (data.reason) {
    const reasonBlock = document.createElement("div");
    reasonBlock.className = "task-reason-block";
    reasonBlock.id = "task-card-reason";
    const rLabel = document.createElement("span");
    rLabel.className = "task-section-label";
    rLabel.textContent = "Reason: ";
    const rText = document.createElement("span");
    rText.className = "task-reason-text";
    rText.textContent = data.reason;
    reasonBlock.append(rLabel, rText);
    container.append(reasonBlock);
  }

  // Actions: Non-speech status and cancel
  const actionsBlock = document.createElement("div");
  actionsBlock.className = "task-card-actions";

  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "quiet task-cancel-btn";
  cancelBtn.id = "task-cancel-btn";
  cancelBtn.textContent = "Cancel task";
  // Enabled only when working; disabled when finished
  cancelBtn.disabled = data.outcome !== "working";
  if (actions.onCancel) {
    cancelBtn.addEventListener("click", () => actions.onCancel!());
  }
  actionsBlock.append(cancelBtn);

  const refreshBtn = document.createElement("button");
  refreshBtn.type = "button";
  refreshBtn.className = "quiet task-refresh-btn";
  refreshBtn.id = "task-refresh-btn";
  refreshBtn.textContent = "Check status";
  if (actions.onRefresh) {
    refreshBtn.addEventListener("click", () => actions.onRefresh!());
  }
  actionsBlock.append(refreshBtn);

  const feedback = document.createElement("span");
  feedback.className = "task-action-feedback";
  feedback.id = "task-action-feedback";
  feedback.setAttribute("role", "status");
  actionsBlock.append(feedback);

  container.append(actionsBlock);
}

/**
 * Controller for one TaskCard instance, mounting into a container.
 */
export function createTaskCard(container: HTMLElement, options: TaskCardOptions = {}) {
  let currentTask: TaskRecord | TaskView | null = null;
  let isStale = false;
  let cancelRequested = false;
  let cancelRefusal: string | undefined;
  let currentData: TaskCardData | null = null;

  const client = options.client;

  function update() {
    if (!currentTask) {
      container.hidden = true;
      container.replaceChildren();
      currentData = null;
      return;
    }
    container.hidden = false;
    currentData = deriveCardData({
      task: currentTask,
      stale: isStale,
      cancelRequested,
      cancelRefusal,
      now: Date.now(),
      silenceThresholdMs: options.silenceThresholdMs ?? 5000,
    });
    if (currentData) {
      renderTaskCard(container, currentData, {
        onCancel: () => void cancel(),
        onRefresh: () => void refresh(),
      });
    }
  }

  async function cancel(targetAddress?: string) {
    const address = targetAddress || currentTask?.address;
    if (!address) return;
    cancelRequested = true;
    update();

    const feedback = container.querySelector("#task-action-feedback");
    if (feedback) feedback.textContent = "Cancel requested…";

    if (options.onCancel) {
      await options.onCancel(address);
    } else if (client) {
      const res = await client.cancel(address);
      if (res.ok) {
        if (res.state === "cancelled") {
          currentTask = { ...(currentTask ?? { address, agent: "unknown", environment: "unknown", root: { kind: "opfs", path: "" }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }), state: "cancelled" };
          cancelRequested = false;
          update();
          const fb = container.querySelector("#task-action-feedback");
          if (fb) fb.textContent = "Stopped";
        } else if (res.state === "cancel_unconfirmed") {
          currentTask = { ...(currentTask ?? { address, agent: "unknown", environment: "unknown", root: { kind: "opfs", path: "" }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }), state: "cancel_unconfirmed", reason: "Runner did not confirm stop" };
          cancelRequested = false;
          update();
          const fb = container.querySelector("#task-action-feedback");
          if (fb) fb.textContent = "Asked to stop and it did not";
        }
      } else {
        cancelRefusal = res.why;
        update();
        const fb = container.querySelector("#task-action-feedback");
        if (fb) fb.textContent = res.why;
      }
    }
  }

  async function refresh(targetAddress?: string) {
    const address = targetAddress || currentTask?.address;
    if (!address) return;

    const feedback = container.querySelector("#task-action-feedback");
    if (feedback) feedback.textContent = "Checking status…";

    if (options.onRefresh) {
      await options.onRefresh(address);
    } else if (client) {
      const res = await client.status(address);
      if (res.ok) {
        currentTask = res.task;
        isStale = Boolean(res.stale);
        update();
        const fb = container.querySelector("#task-action-feedback");
        if (fb) fb.textContent = isStale ? "Status is from offline cache (stale)" : "Status updated";
      } else {
        isStale = Boolean(res.stale);
        update();
        const fb = container.querySelector("#task-action-feedback");
        if (fb) fb.textContent = res.why;
      }
    }
  }

  function setTask(task: TaskRecord | TaskView | null, extra: { stale?: boolean; now?: number } = {}) {
    currentTask = task;
    isStale = extra.stale ?? false;
    cancelRequested = false;
    cancelRefusal = undefined;
    update();
  }

  function setStale(stale: boolean) {
    isStale = stale;
    update();
  }

  return {
    element: container,
    setTask,
    setStale,
    cancel,
    refresh,
    status: refresh,
    getData: () => currentData,
    getTask: () => currentTask,
  };
}
