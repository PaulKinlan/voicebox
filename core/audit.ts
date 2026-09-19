// core/audit.ts — entry construction and append ordering.
//
// The audit reads the world, not the transcript: `observed` is written by the
// host after the act, from the filesystem — never from the model's account.
// Refusals are entries with `decision: "refuse"` and the rule id.
// Append-only, one file per root; readers merge by (instance, seq).

export interface AuditAct {
  kind: string;
  target: string;
  tool?: string;
}

export interface Observed {
  exists: boolean;
  bytes?: number;
  mtime?: string;
}

export interface AuditEntry {
  seq: number;          // per-instance monotonic, from 1
  instance: string;     // "phone" — one instance in M0
  project: string;      // "atlas@phone"
  root: string;         // "v1/projects/atlas"
  turn: string | null;
  at: string;           // ISO wall clock — a HINT, never an ordering key
  act: AuditAct;
  decision: "allow" | "confirm" | "refuse";
  rule: string | null;
  result: "ok" | "error" | "refused";
  observed: Observed | null; // from the filesystem, never from the model
  read?: { path: string; bytes: number }[];
}

let seq = 0;

export function nextSeq(): number {
  return ++seq;
}

export function makeEntry(
  project: string,
  root: string,
  instance: string,
  act: AuditAct,
  decision: AuditEntry["decision"],
  rule: string | null,
  result: AuditEntry["result"],
  observed: Observed | null,
  turn: string | null = null,
  read?: { path: string; bytes: number }[],
): AuditEntry {
  return {
    seq: nextSeq(),
    instance,
    project,
    root,
    turn,
    at: new Date().toISOString(),
    act,
    decision,
    rule,
    result,
    observed,
    ...(read ? { read } : {}),
  };
}
