// core/root.ts — THE ROOT SEAM: one root, three kinds, one containment entry.
//
// WHY THIS FILE EXISTS. The product had two roots and one of them was a convention: the environment
// page had projects (OPFS, or a folder the user picked) and the turn loop wrote loose files into a
// hard-coded `workspace/`. That is a demo standing beside the product, and it is exactly the drift
// N18 names: two things that mean "where the files are", each with its own path-building, each
// silently disagreeing with the other about what "inside" means.
//
// So the root becomes DATA that both sides read — the environment that owns a project and the loop
// that acts on one — and containment has ONE implementation (`core/paths.ts`, which refuses `..` at
// any depth) reached through one function. What differs by kind is not the rule but the FACTS: where
// the files physically are, who can reach them, and whether a gesture is needed. Those facts are
// data here, so a placement can ask "may I act on this root?" and get an answer it can print,
// instead of discovering it by failing.
//
// THE THREE KINDS, and the honest limit of each:
//
//   opfs     — this origin's private storage. Reachable by the PAGE only: a machine process has no
//              path to it and never will.
//   handle   — a folder the user picked. Reachable by the PAGE only, and this is not a limitation to
//              fix later: a handle deliberately does not expose a path, so nothing else can address it.
//   machine  — a folder both the page and a machine process can name by path. Reachable by the
//              MACHINE (which also gets the realpath pass below); the page cannot write there, because
//              it has no handle for it.
//
// A root the acting placement cannot reach is REFUSED BY NAME, naming who can act on it. That refusal
// is the seam's whole point: it is what stops "the loop writes to workspace/" from being how a second
// root stays alive.

import { resolveInsideRoot, type ResolveResult } from "./paths.ts";
import type { Peer } from "./wire.ts";
import type { ProjectRecord } from "./project.ts";

export type RootKind = "opfs" | "handle" | "machine";

/** Where a project's files are. A descriptor is small, serialisable, and enough to act on. */
export type RootDescriptor =
  | { kind: "opfs"; path: string } // origin-private, relative to the origin's storage root
  | { kind: "handle"; id: string; label?: string } // a picked folder, named by the project it belongs to
  | { kind: "machine"; path: string }; // a path a machine process can name (usually absolute)

export interface RootFacts {
  /** A sentence a person can read, for a record or a panel. */
  where: string;
  /** Who else can see the files. Not a permission claim — a fact about the storage. */
  whoCanSee: string;
  /** Which peers may ACT on this root. The rest refuse, by name. */
  reachableFrom: Peer[];
  /** How "inside" is decided. Both kinds use `core/paths.ts`; the machine adds a realpath pass. */
  containment: "prefix" | "realpath";
  /** Whether re-acquiring access may need a click (N20: OPFS never does; a picked folder may). */
  needsGesture: boolean;
  /** Whether the files outlive the tab. True for every kind here — that is the point of a project. */
  survivesTabClose: boolean;
}

export const ROOT_FACTS: Record<RootKind, RootFacts> = {
  opfs: {
    where: "this origin's private file system, inside the browser",
    whoCanSee: "nothing outside this origin — not even the user's own editor",
    reachableFrom: ["page"],
    containment: "prefix",
    needsGesture: false,
    survivesTabClose: true,
  },
  handle: {
    where: "a real folder on this machine — the one the user picked",
    whoCanSee: "anything on this machine, and the user in their own editor",
    // A handle is a page-only capability: it exposes no path, so no other process can address it.
    reachableFrom: ["page"],
    containment: "prefix",
    needsGesture: true,
    survivesTabClose: true,
  },
  machine: {
    where: "a folder on the machine running the process",
    whoCanSee: "anything on that machine — the user's own tools, editors and shells",
    reachableFrom: ["machine"],
    containment: "realpath",
    needsGesture: false,
    survivesTabClose: true,
  },
};

/**
 * The string containment measures against.
 *
 * An OPFS path means nothing outside its origin, and a handle has no path at all — so both get a
 * VIRTUAL root and an adapter strips it (browser/storage.ts). That is not a workaround: it is the
 * truthful answer to "what is the boundary called here", and it is why one containment implementation
 * can serve all three kinds without any of them pretending to be a filesystem path it is not.
 */
export function virtualRootOf(root: RootDescriptor): string {
  return root.kind === "handle" ? `picked:${root.id}` : root.path;
}

/**
 * THE containment entry: resolve a candidate inside a root, or refuse with the rule and the reason.
 *
 * One function, so there is one answer to "is this inside". The machine kind's realpath pass is the
 * caller's addition (it needs the filesystem), and `ROOT_FACTS.machine.containment` says so — a
 * lexical check that follows a symlink out is precisely the defect the design already recorded.
 */
export function resolveInRoot(root: RootDescriptor, candidate: unknown): ResolveResult {
  return resolveInsideRoot(virtualRootOf(root), typeof candidate === "string" ? candidate : "");
}

export type Reachability = { ok: true } | { ok: false; refused: string; why: string };

/**
 * THE TWO NAMED ABSENCES, and they are a pair rather than one code:
 *
 *   root-not-declared          — nobody has said where the files are yet
 *   root-not-reachable-from-here — somebody has, and this placement cannot act on it
 *
 * They must not collapse. "There is no root yet" is answered by declaring one (the environment's
 * job); "that root is not mine to touch" is answered by letting the other side act. A single
 * "no root" would send the reader looking for a permission problem that does not exist — the same
 * shape as "has not run yet" versus "has run and read nothing" in the shared log.
 */
export const ROOT_NOT_DECLARED = "root-not-declared";
export const ROOT_NOT_REACHABLE = "root-not-reachable-from-here";
export const ROOT_VANISHED = "root-vanished";

/**
 * The declared root was there when it was declared and is not there now.
 *
 * This exists because the alternative is a HANG, and a hang is the one behaviour this whole
 * vocabulary exists to prevent: measured on a live server, deleting a declared directory and then
 * acting left the request unanswered forever (an unawaited async route threw ENOENT and nothing wrote
 * a response). Every other failure in this system says what is wrong and what to do next; a vanished
 * root has to as well.
 */
export function rootVanished(path: string, detail?: string): { ok: false; refused: string; why: string; detail?: string } {
  return {
    ok: false,
    refused: ROOT_VANISHED,
    why:
      `the declared root '${path}' is not there any more, so there is nowhere to act: declare it again ` +
      `(POST /api/root with the path that exists now), or let the environment re-declare it when it opens the project`,
    ...(detail ? { detail } : {}),
  };
}

/** No root has been declared: the answer names the side whose job it is. */
export function noRootDeclared(): { ok: false; refused: string; why: string } {
  return {
    ok: false,
    refused: ROOT_NOT_DECLARED,
    why:
      "no project root is declared, so there is nothing to write into: the environment declares one " +
      "(POST /api/root) when it opens or adopts a project — a loop has no root of its own",
  };
}

/**
 * May `peer` act on this root? A refusal NAMES who can — "not allowed" is a description, and the
 * person reading it cannot tell whether to pick a folder, open the page, or give up.
 */
export function reachableFrom(root: RootDescriptor, peer: Peer): Reachability {
  const facts = ROOT_FACTS[root.kind];
  if (facts.reachableFrom.includes(peer)) return { ok: true };
  const who = facts.reachableFrom.join(" and ");
  return {
    ok: false,
    refused: ROOT_NOT_REACHABLE,
    why:
      `this project's root is ${facts.where}, and this placement is the ${peer === "page" ? "page" : "machine"}; ` +
      `only the ${who} can act on it — the act belongs to that side, not to this one`,
  };
}

/** The descriptor a project record describes. */
export function descriptorOf(record: ProjectRecord): RootDescriptor {
  if (record.root.kind === "opfs") return { kind: "opfs", path: record.root.path };
  if (record.root.kind === "machine") return { kind: "machine", path: record.root.path };
  const label = record.location.kind === "handle" ? record.location.label : undefined;
  return { kind: "handle", id: record.root.id, ...(label ? { label } : {}) };
}

/** A one-line answer for a panel: which root, and who can act on it. */
export function describeRoot(root: RootDescriptor): string {
  const facts = ROOT_FACTS[root.kind];
  const who = facts.reachableFrom.join(" and ");
  return `${root.kind} — ${facts.where}. Visible to: ${facts.whoCanSee}. Acts come from the ${who}.`;
}
