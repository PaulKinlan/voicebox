// core/task-card.ts — D8: Result card + non-speech status/cancel model & store (voicebox-beads-snp).
//
// WHAT THIS MODULE SUPPLIES (pure data, models, formatters, and local store):
//   1. States and high-level outcomes:
//      - Raw TaskState: queued, running, cancel_requested, cancelled, cancel_unconfirmed, completed, failed, interrupted
//      - Outcome (coord's four categories): idle, working, finished, finished-but-unconfirmed
//      - Cancel outcome: none, requested, stopped, asked-to-stop-and-did-not, refused
//      - Freshness: live vs stale (stale-labelled cache for an unreachable environment)
//   2. Plain-language formatters (avoiding forbidden jargon):
//      - formatTaskState(state) -> human readable ("Running", "Stopped", "Asked to stop and it did not", etc.)
//      - formatSilence(updatedAt, now, thresholdMs) -> "No update since <time>" or "Updated <time>"
//      - formatRoot(root) -> readable root description ("machine: /...", "browser storage: ...", "picked folder: ...")
//   3. LocalTaskStore:
//      - BINDING REQUIREMENT (Paul, 2026-09-21): "the harness must run anywhere, including entirely
//        in a browser client with zero Voicebox server or local bridge. Render the same task/result
//        contract from browser-local ownership as well as a remote server. Offline cached status must
//        be stale, not evidence of continuing execution; do not require a server merely to read
//        local records."
//
// Pure: no DOM references, zero external dependencies. Runs in browser or Node (N18).

import type { TaskRecord, TaskState, TaskView, TaskBounds, TaskInput } from "./tasks.ts";
import type { RootDescriptor } from "./root.ts";

export type TaskOutcome = "idle" | "working" | "finished" | "finished-but-unconfirmed";
export type CancelOutcome = "none" | "requested" | "stopped" | "asked-to-stop-and-did-not" | "refused";
export type Freshness = "live" | "stale";

export interface TaskCardData {
  address: string;
  agent: string;
  environment: string;
  root: RootDescriptor | { kind: string; path?: string; id?: string };
  state: TaskState;
  outcome: TaskOutcome;
  cancelOutcome: CancelOutcome;
  freshness: Freshness;
  createdAt: string;
  updatedAt: string;
  lastUpdateText: string;
  isSilent: boolean;
  progress?: string;
  answer?: string;
  partial?: string;
  reason?: string;
  staleReason?: string;
}

/**
 * Derive the high-level outcome from the task state.
 * idle: no task loaded
 * working: queued, running, cancel_requested
 * finished: completed, cancelled, failed, interrupted
 * finished-but-unconfirmed: cancel_unconfirmed
 */
export function deriveOutcome(state: TaskState | null | undefined): TaskOutcome {
  if (!state) return "idle";
  if (state === "queued" || state === "running" || state === "cancel_requested") return "working";
  if (state === "cancel_unconfirmed") return "finished-but-unconfirmed";
  return "finished";
}

/**
 * Derive the cancellation state from the task state and request flags.
 * "cancel" has at least "stopped" and "asked to stop and it did not" — coord.
 */
export function deriveCancelOutcome(
  state: TaskState | null | undefined,
  requested = false,
  refusedReason?: string
): CancelOutcome {
  if (refusedReason) return "refused";
  if (state === "cancelled") return "stopped";
  if (state === "cancel_unconfirmed") return "asked-to-stop-and-did-not";
  if (requested && state !== "completed" && state !== "failed" && state !== "interrupted") {
    return "requested";
  }
  return "none";
}

/**
 * Convert a TaskState into plain human language.
 */
export function formatTaskState(state: TaskState): string {
  switch (state) {
    case "queued": return "Queued";
    case "running": return "Running";
    case "cancel_requested": return "Cancel requested";
    case "cancelled": return "Stopped";
    case "cancel_unconfirmed": return "Asked to stop and it did not";
    case "completed": return "Completed";
    case "failed": return "Failed";
    case "interrupted": return "Interrupted";
    default: return String(state);
  }
}

/**
 * Format the root descriptor for human reading.
 */
export function formatRoot(root?: RootDescriptor | { kind: string; path?: string; id?: string } | null): string {
  if (!root) return "none";
  if (root.kind === "machine" && "path" in root) return `machine: ${root.path}`;
  if (root.kind === "opfs" && "path" in root) return `browser storage: ${root.path}`;
  if (root.kind === "handle" && "id" in root) return `picked folder: ${root.id}`;
  return `${root.kind}`;
}

/**
 * Format timestamp and detect silence.
 * Returns { isSilent, text }: "No update since <time>" if elapsed >= thresholdMs.
 */
export function formatSilence(
  updatedAt: string,
  now: number = Date.now(),
  thresholdMs: number = 5000
): { isSilent: boolean; text: string } {
  const updatedMs = Date.parse(updatedAt);
  if (Number.isNaN(updatedMs)) {
    return { isSilent: false, text: "No timestamp" };
  }
  const elapsed = Math.max(0, now - updatedMs);
  const timeStr = new Date(updatedMs).toLocaleTimeString();
  if (elapsed >= thresholdMs) {
    return {
      isSilent: true,
      text: `No update since ${timeStr}`,
    };
  }
  return {
    isSilent: false,
    text: `Updated ${timeStr}`,
  };
}

/**
 * Combine task view/record and state flags into a coherent TaskCardData model.
 */
export function deriveCardData(options: {
  task: TaskRecord | TaskView | null;
  stale?: boolean;
  cancelRequested?: boolean;
  cancelRefusal?: string;
  now?: number;
  silenceThresholdMs?: number;
}): TaskCardData | null {
  const {
    task,
    stale = false,
    cancelRequested = false,
    cancelRefusal,
    now = Date.now(),
    silenceThresholdMs = 5000,
  } = options;

  if (!task) return null;

  const outcome = deriveOutcome(task.state);
  const cancelOutcome = deriveCancelOutcome(task.state, cancelRequested, cancelRefusal);
  const freshness: Freshness = stale ? "stale" : "live";
  const updatedAt = task.updatedAt || task.createdAt;
  const silenceInfo = formatSilence(updatedAt, now, silenceThresholdMs);

  const agent = ("agent" in task && typeof task.agent === "string")
    ? task.agent
    : ("input" in task && task.input && typeof task.input.agent === "string")
      ? task.input.agent
      : "unknown";

  return {
    address: task.address,
    agent,
    environment: task.environment || "local",
    root: task.root,
    state: task.state,
    outcome,
    cancelOutcome,
    freshness,
    createdAt: task.createdAt,
    updatedAt,
    lastUpdateText: silenceInfo.text,
    isSilent: silenceInfo.isSilent && outcome === "working",
    ...(task.progress ? { progress: task.progress } : {}),
    ...(task.answer !== undefined ? { answer: task.answer } : {}),
    ...(task.partial !== undefined ? { partial: task.partial } : {}),
    ...(task.reason ? { reason: task.reason } : {}),
    ...(stale ? { staleReason: "Offline cached status: environment is unreachable. This is not evidence of continuing execution." } : {}),
  };
}

/**
 * LocalTaskStore — pure in-memory / browser-local task client and store.
 * Allows running the task lifecycle entirely in a browser with zero server.
 */
export class LocalTaskStore {
  private tasks = new Map<string, TaskRecord>();
  private reachable = true;
  private cancelResolutions = new Map<string, "cancel" | "ignore" | "finish">();

  private environment: string;

  constructor(environment = "browser-local") {
    this.environment = environment;
  }

  setReachable(reachable: boolean) {
    this.reachable = reachable;
  }

  isReachable() {
    return this.reachable;
  }

  setCancelBehavior(address: string, behavior: "cancel" | "ignore" | "finish") {
    this.cancelResolutions.set(address, behavior);
  }

  admit(input: TaskInput, bounds: TaskBounds = { deadlineMs: 5000, maxOutputBytes: 4096 }, root?: RootDescriptor): TaskRecord {
    const id = `loc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const address = `task_local_${id}`;
    const now = new Date().toISOString();
    const taskRoot: RootDescriptor = root ?? { kind: "opfs", path: "v1/tasks" };
    const record: TaskRecord = {
      address,
      environment: this.environment,
      owner: "browser-local-owner",
      root: taskRoot,
      project: "local-project",
      instance: "browser",
      callId: `call_${id}`,
      input,
      bounds,
      mechanism: "browser-local-runner",
      boot: "boot-local",
      pid: 1,
      state: "queued",
      createdAt: now,
      updatedAt: now,
    };
    this.tasks.set(address, record);
    return record;
  }

  updateState(address: string, state: TaskState, extra: { reason?: string; answer?: string; progress?: string; partial?: string } = {}) {
    const existing = this.tasks.get(address);
    if (!existing) return null;
    const now = new Date().toISOString();
    const updated: TaskRecord = {
      ...existing,
      state,
      updatedAt: now,
      ...(extra.reason ? { reason: extra.reason } : {}),
      ...(extra.answer !== undefined ? { answer: extra.answer } : {}),
      ...(extra.progress !== undefined ? { progress: extra.progress } : {}),
      ...(extra.partial !== undefined ? { partial: extra.partial } : {}),
    };
    this.tasks.set(address, updated);
    return updated;
  }

  async status(address: string): Promise<{ ok: true; task: TaskRecord; stale: boolean } | { ok: false; refused: string; why: string; stale?: boolean }> {
    const record = this.tasks.get(address);
    if (!record) {
      return { ok: false, refused: "task-not-found", why: `no task with address '${address}'` };
    }
    if (!this.reachable) {
      // Offline cached status is stale!
      return { ok: true, task: record, stale: true };
    }
    return { ok: true, task: record, stale: false };
  }

  async cancel(address: string, graceMs = 50): Promise<{ ok: true; state: TaskState; observed: boolean } | { ok: false; refused: string; why: string }> {
    const record = this.tasks.get(address);
    if (!record) {
      return { ok: false, refused: "task-not-found", why: `no task with address '${address}'` };
    }
    if (["completed", "cancelled", "failed", "interrupted"].includes(record.state)) {
      return { ok: false, refused: "task-not-running", why: `the task is already ${record.state}; cancel applies to a running task` };
    }

    const behavior = this.cancelResolutions.get(address) ?? "cancel";
    if (behavior === "finish") {
      this.updateState(address, "completed", { answer: "finished before cancel confirmed" });
      return { ok: true, state: "completed", observed: true };
    }
    if (behavior === "ignore") {
      // Simulates executor ignoring abort signal: grace expires -> cancel_unconfirmed
      this.updateState(address, "cancel_requested", { reason: "cancellation requested" });
      await new Promise((r) => setTimeout(r, graceMs));
      this.updateState(address, "cancel_unconfirmed", { reason: "the runner did not confirm cancellation within grace window" });
      return { ok: true, state: "cancel_unconfirmed", observed: false };
    }

    // Default: observed cancellation
    this.updateState(address, "cancel_requested", { reason: "cancellation requested" });
    this.updateState(address, "cancelled", { reason: "stopped by user" });
    return { ok: true, state: "cancelled", observed: true };
  }
}
