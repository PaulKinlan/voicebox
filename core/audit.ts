// core/audit.ts — entry construction and append ordering.
//
// The audit reads the world, not the transcript: `observed` is written by the
// host after the act, from the filesystem — never from the model's account.
// Refusals are entries with `decision: "refuse"` and the rule id.
// Append-only, one file per root; readers merge by (instance, seq).
//
// WHY THE SHAPE IS (instance, seq) AND NOT `at`: two machines have no shared clock, so a wall
// clock can order two entries wrongly and will do so exactly when the order matters. `at` is a
// hint for humans; (instance, seq) is the only ordering the merge is allowed to claim. And the
// merge claims no GLOBAL order — two instances' sequences cannot be interleaved by anything but
// arrival, so the honest answer is a per-instance order plus a deterministic tie-break.

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

/** The one instance M0 runs. §2.3's several live instances are E2. */
export const M0_INSTANCE = "phone";

let seq = 0;

export function nextSeq(): number {
  return ++seq;
}

/**
 * Continue this instance's sequence from what is already on disk.
 *
 * Without this a reload restarts `seq` at 1 and the log contains two entries numbered 1 — which
 * is not a cosmetic problem: the merge is *ordered by* (instance, seq), so a duplicate seq is an
 * ambiguous order, and the entry a reader would have to disambiguate is the one that says what
 * the agent did after the reload.
 */
export function resumeSeq(entries: AuditEntry[], instance: string = M0_INSTANCE): number {
  let max = 0;
  for (const e of entries) if (e.instance === instance && e.seq > max) max = e.seq;
  seq = max;
  return max;
}

/** FNV-1a, 8 hex characters. A file name, not a security boundary. */
export function hashRoot(root: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < root.length; i++) {
    h ^= root.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/**
 * One file per root: `v1/projects/atlas/.audit/<instance>-<root-hash>.jsonl`.
 *
 * One file per root is what lets two roots append without interleaving — the design serialises
 * one writer per root (§2.3), so a file per root has exactly one writer and needs no lock.
 */
export function auditFileName(instance: string, root: string): string {
  return `${instance}-${hashRoot(root)}.jsonl`;
}

export function serializeEntry(entry: AuditEntry): string {
  return JSON.stringify(entry);
}

export function parseEntry(line: string): AuditEntry | null {
  const text = line.trim();
  if (!text) return null;
  try {
    return JSON.parse(text) as AuditEntry;
  } catch {
    return null; // a torn last line from a killed append is not a fatal read
  }
}

/**
 * The read: many roots' files, ordered by (instance, seq), with no global order claimed.
 * Ties (same instance, same seq — only possible if a file was hand-edited) break on root then
 * `at`, so the read is deterministic without pretending the clock ordered anything.
 */
export function mergeAudit(entries: AuditEntry[]): AuditEntry[] {
  return [...entries].sort(
    (a, b) =>
      a.instance.localeCompare(b.instance) ||
      a.seq - b.seq ||
      a.root.localeCompare(b.root) ||
      (a.at < b.at ? -1 : a.at > b.at ? 1 : 0),
  );
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
