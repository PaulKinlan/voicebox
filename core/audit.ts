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

import type { Actor, LogEntryBase } from "./shared-log.ts";
import type { TaskEvent } from "./tasks.ts";

export interface AuditAct {
  kind: string;
  target: string;
  tool?: string;
}

export interface Observed {
  exists: boolean;
  bytes?: number;
  mtime?: string;
  servedBy?: string; // network: the URL that ACTUALLY served the bytes (redirects included)
  via?: string[]; // network: the full redirect chain, first entry = the requested URL
  requested?: string; // network refusals: what was asked for
}

/**
 * THE ENTRY SHAPE, extended for the shared side (N19 / §9) BEFORE anything wrote a shared entry.
 *
 * The log is one medium: an `act` entry is the tier decision and the observed result, and a
 * `presence` / `activity` / `see` entry is a shared fact (core/shared-log.ts). Keeping them in one
 * file per root is what makes "the global state is the log" true rather than aspirational — two logs
 * would be two things to read and two things to reconcile.
 *
 * The act fields are optional because the other three kinds do not have them; for `kind: "act"` they
 * are always present, and `makeEntry` is the only constructor that decides that.
 */
export interface LogEntry extends LogEntryBase {
  task?: TaskEvent;
  act?: AuditAct;
  decision?: "allow" | "confirm" | "refuse";
  rule?: string | null;
  result?: "ok" | "error" | "refused";
  observed?: Observed | null; // from the filesystem, never from the model
  read?: { path: string; bytes: number }[];
  /** The attempt this entry completes: an "attempt" entry is written BEFORE the act,
   *  and every outcome (allow, refuse, lost) carries the attempt's seq back to it. */
  attempt?: number;
  /** The process generation that wrote an ATTEMPT — a pending attempt from a dead
   *  generation is attempted-and-lost, which is exactly what a crash leaves behind. */
  boot?: string;
}

/** An act entry is the audit entry: the alias is kept because that is what it is. */
export type AuditEntry = LogEntry;

/**
 * THE DELIVERY VOCABULARY (voicebox-beads-y69): every act that passes pre-flight has a
 * delivery state answerable after the fact —
 *   attempted  an entry written BEFORE the act applies (decision "attempt", result "pending",
 *              boot = the process generation that wrote it)
 *   carried    the outcome entry is "allow", with `observed` facts from the world
 *   refused    the outcome entry is "refuse", with the rule id and the why
 *   lost       the process ended between the attempt and any outcome — recorded by the next
 *              boot's sweep, BY NAME, because "whether it landed" is then unknown and must
 *              not silently read as either success or refusal.
 * Three failure classes from the field (isocan item.addVersion, 2026-09-19) map onto this:
 * refused-before-apply and refused-with-no-partial are "refused" entries; the op that was
 * attempted and vanished is "lost". A log of successes and refusals cannot answer "did my
 * edit land?" when the process died mid-act — the dangling attempt is the record that it
 * was tried, and "lost" is the honest answer to the landing question.
 *
 * The decision and result unions above carry the two new states: decision "attempt" (with
 * result "pending") is the pre-act record; decision "lost" (result "lost") is the boot
 * sweep's completion for an attempt that never got one.
 */

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

/**
 * sweepLostAttempts(entries, currentBoot) — the boot-time answer to "what was tried and never
 * resolved?". PURE: returns one completion per DANGLING attempt — an entry with decision
 * "attempt" and result "pending", written by a DIFFERENT generation than the current boot,
 * with no later entry claiming it via `attempt`. The caller appends them (assigning
 * instance/seq/at in its own order), so the log stays append-only and the sweep is idempotent:
 * once a lost completion exists, the attempt is no longer dangling.
 */
export function sweepLostAttempts(entries: AuditEntry[], currentBoot: string): { attempt: number; act: AuditAct }[] {
  const resolved = new Set<number>();
  const dangling: { attempt: number; act: AuditAct }[] = [];
  for (const e of entries) {
    if (e.attempt !== undefined) resolved.add(e.attempt); // any outcome entry claims its attempt
    if (e.decision === "attempt" && e.result === "pending" && e.boot !== undefined && e.boot !== currentBoot) {
      dangling.push({ attempt: e.seq, act: e.act ?? { kind: "unknown", target: "unknown" } });
    }
  }
  return dangling.filter((d) => !resolved.has(d.attempt));
}

/** The only constructor that produces an `act` entry — so the absent fields cannot drift kind by kind. */
export function makeEntry(
  project: string,
  root: string,
  instance: string,
  actor: Actor | undefined,
  act: AuditAct,
  decision: AuditEntry["decision"],
  rule: string | null,
  result: AuditEntry["result"],
  observed: Observed | null,
  turn: string | null = null,
  read?: { path: string; bytes: number }[],
): AuditEntry {
  return {
    kind: "act" as const,
    seq: nextSeq(),
    instance,
    ...(actor ? { actor } : {}),
    ...(actor ? { actor } : {}),
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
