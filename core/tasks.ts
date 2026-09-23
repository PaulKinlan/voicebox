// Task data and reduction only. The host authenticates, persists and executes.
import type { RootDescriptor } from "./root.ts";
import type { LogEntry } from "./audit.ts";

export type TaskState = "queued" | "running" | "cancel_requested" | "cancelled" | "cancel_unconfirmed" | "completed" | "failed" | "interrupted";
export interface TaskInput { agent: string; task: string; context: string[] }
export interface TaskBounds { deadlineMs: number; maxOutputBytes: number }
export interface TaskRecord {
  address: string;
  environment: string;
  owner: string; // opaque credential identity, never the credential
  root: RootDescriptor;
  project: string;
  instance: string;
  callId: string;
  input: TaskInput;
  bounds: TaskBounds;
  mechanism: string;
  boot: string;
  pid: number;
  state: TaskState;
  createdAt: string;
  updatedAt: string;
  reason?: string;
  answer?: string;
  progress?: string;
  partial?: string;
  /** Present once the task is terminal — see OutcomeClass for what the class does and does not mean. */
  outcome?: TaskOutcome;
}
/**
 * WHAT A DELEGATION'S OUTCOME IS, AND WHO SAYS SO (voicebox-beads-m9u).
 *
 * An executor is a CLAIMANT, not a witness: `completed` means it returned text inside its bounds — a claim
 * about the work, never verified effectiveness. This project's rule is that claimed success is never
 * promoted to verified effectiveness, so the claim is recorded AS a claim (`basis: "executor-claimed"`),
 * while the classes the HOST watched happen carry `basis: "host-observed"`. A reader can tell the two apart
 * without a policy, which is the point of recording a class at all.
 *
 * AND IT IS NOT A RANKING INPUT. There is deliberately no score, weight, order or percentage here: a record
 * can inform a person's choice without making it. A record that quietly reorders anything has taken
 * authority nobody gave it — the shape of an approval that escalates when nobody is watching.
 *
 * `cancel_unconfirmed` has no class on purpose: it is NOT terminal (it can still settle to cancelled,
 * completed, failed or interrupted), so the record says where it is through `state` and claims no outcome.
 */
export type OutcomeClass = "claimed-complete" | "observed-failure" | "observed-interruption" | "observed-cancellation";
export interface TaskOutcome {
  class: OutcomeClass;
  basis: "executor-claimed" | "host-observed";
}

/** The class a TERMINAL state carries; anything still in flight has no outcome yet and says so by omission. */
export function outcomeFor(state: TaskState): TaskOutcome | null {
  switch (state) {
    case "completed": return { class: "claimed-complete", basis: "executor-claimed" };
    case "failed": return { class: "observed-failure", basis: "host-observed" };
    case "interrupted": return { class: "observed-interruption", basis: "host-observed" };
    case "cancelled": return { class: "observed-cancellation", basis: "host-observed" };
    default: return null; // queued, running, cancel_requested, cancel_unconfirmed — no outcome to record
  }
}

export interface TaskEvent {
  address: string;
  state: TaskState;
  created?: TaskRecord;
  reason?: string;
  answer?: string;
  progress?: string;
  partial?: string;
}

type Refusal = { ok: false; refused: string; why: string };
const no = (refused: string, why: string): Refusal => ({ ok: false, refused, why });
const fields = new Set(["agent", "task", "context"]);

/** Model arguments contain no authority, filesystem location or execution configuration. */
export function taskInput(value: unknown): { ok: true; value: TaskInput } | Refusal {
  if (!value || typeof value !== "object" || Array.isArray(value)) return no("invalid-task", "a task is an argument object");
  const args = value as Record<string, unknown>;
  for (const field of Object.keys(args)) {
    if (!fields.has(field)) return no("task-authority-field", `'${field}' is not a task argument; the host supplies identity, root, bounds and executor configuration`);
  }
  if (typeof args.agent !== "string" || !/^[a-zA-Z0-9._-]{1,80}$/.test(args.agent)) return no("agent-required", "name a configured agent; D1 does not choose a default");
  if (typeof args.task !== "string" || !args.task.trim()) return no("invalid-task", "the task must contain text");
  if (new TextEncoder().encode(args.task).length > 16384) return no("task-input-over-budget", "task text exceeds 16384 UTF-8 bytes");
  const context = args.context ?? [];
  if (!Array.isArray(context)) return no("invalid-task-context", "context must be an array of references");
  // Context snapshots are not implemented here. Never claim an unresolved reference was pinned.
  if (context.length) return no("task-context-unavailable", "bounded context manifests are not implemented; D1 accepts task text only");
  return { ok: true, value: { agent: args.agent, task: args.task, context: [] } };
}

export function taskBounds(value: unknown): value is TaskBounds {
  if (!value || typeof value !== "object") return false;
  const b = value as TaskBounds;
  return Number.isSafeInteger(b.deadlineMs) && b.deadlineMs > 0 && b.deadlineMs <= 3600000 &&
    Number.isSafeInteger(b.maxOutputBytes) && b.maxOutputBytes > 0 && b.maxOutputBytes <= 65536;
}

export function taskTerminal(state: TaskState): boolean {
  return ["cancelled", "completed", "failed", "interrupted"].includes(state);
}

/** Per-writer order only. A terminal record cannot be rewritten by a late completion. */
export function reduceTask(entries: LogEntry[], address: string): TaskRecord | null {
  let record: TaskRecord | null = null;
  let previous = -1;
  for (const entry of [...entries].sort((a, b) => a.seq - b.seq)) {
    const event = entry.kind === "task" ? entry.task : undefined;
    if (!event || event.address !== address) continue;
    if (entry.seq <= previous) throw new Error("duplicate task event position");
    previous = entry.seq;
    if (event.created) {
      if (record || event.state !== "queued" || event.created.address !== address || event.created.state !== "queued") throw new Error("invalid task creation");
      record = { ...event.created };
    } else {
      if (!record || taskTerminal(record.state)) throw new Error("task event without a live admission");
      const allowed: Record<string, string[]> = {
        queued: ["running", "failed", "interrupted"],
        running: ["cancel_requested", "completed", "failed", "interrupted"],
        cancel_requested: ["cancelled", "cancel_unconfirmed", "completed", "failed", "interrupted"],
        cancel_unconfirmed: ["cancelled", "completed", "failed", "interrupted"],
      };
      if (!allowed[record.state]?.includes(event.state)) throw new Error("invalid task transition");
      record = { ...record, state: event.state, updatedAt: entry.at, ...(event.reason ? { reason: event.reason } : {}), ...(event.answer !== undefined ? { answer: event.answer } : {}), ...(event.progress !== undefined ? { progress: event.progress } : {}), ...(event.partial !== undefined ? { partial: event.partial } : {}) };
    }
    if (record.instance !== entry.instance || record.root.kind !== "machine" || entry.root !== `machine:${record.root.path}`) throw new Error("task writer or root mismatch");
  }
  if (record && taskTerminal(record.state)) record = { ...record, outcome: outcomeFor(record.state) ?? undefined };
  return record;
}

/** Readback intentionally excludes credential identity and the captured prompt. */
export function taskView(record: TaskRecord) {
  const { address, environment, root, state, createdAt, updatedAt, reason, answer, progress, partial, outcome } = record;
  // The readable half of the record: the class and its basis, and NOTHING that ranks one delegation
  // against another — no score, no weight, no ordering (voicebox-beads-m9u, "no automatic ranking").
  return { address, environment, root, state, agent: record.input.agent, createdAt, updatedAt, ...(reason ? { reason } : {}), ...(answer !== undefined ? { answer } : {}), ...(progress ? { progress } : {}), ...(partial ? { partial } : {}), ...(outcome ? { outcome } : {}) };
}
