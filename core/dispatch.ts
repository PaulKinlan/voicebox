// core/dispatch.ts — reachableFrom STOPPED BEING A REFUSAL AND BECAME A ROUTER.
//
// THE DEFECT THIS REMOVES (Paul, 2026-09-20: "page should be able to write"): with a picked
// folder or browser storage the room could read but never write — turns went to the local
// server, and a page-owned root has no path the server can address, so every writing act was
// refused `root-not-reachable-from-here`. Choosing a folder got you a room that could only
// look at it.
//
// THE CHANGE IN SHAPE (coord, same day): `reachableFrom(root, peer)` already answers "which
// peer can act on this root". That answer was a dead end; here it is a DISPATCH DECISION:
//
//   machine can act   → the server executes (unchanged path, unchanged code)
//   page can act      → the server ASKS the page over the channel (lib/channel.mjs,
//                       core/wire.ts envelopes); the page executes through its storage
//                       adapter and answers OBSERVED FACTS
//   neither can act   → the refusal survives, with its name and its remedy
//
// This file is the DECISION ONLY. It has no IO and no transport: the server maps `page` to a
// channel call, and the wire's own absence family (`no-page`, `page-timeout`, `page-closed`)
// answers when the page is not there — so the product never claims a capability the code
// lacks (vb-e1m0's condition for the shape).
//
// WHAT DOES NOT CHANGE: `reachableFrom` keeps its signature and its words (it is vb-e1m0's
// seam); the refusal family stays frozen (`root-not-declared`, `root-not-reachable-from-here`,
// `root-vanished`, `outside-root`); containment stays `resolveInRoot` → `core/paths.ts` on
// BOTH sides — the page re-resolves, it never trusts the server's resolved string.
//
// THE TRUST BOUNDARY, written where a reader can find it (coord's condition): the server
// CANNOT verify a page-side write by reading the file itself. The observation comes from the
// page. Results of a routed act therefore carry `via: "page"` and the observed facts the page
// reported — a reader can always tell whose bytes a result is quoting, and this comment is
// why.

import { reachableFromEnvironment, ROOT_NOT_REACHABLE, type RootDescriptor } from "./root.ts";
import type { Peer } from "./wire.ts";

export type Dispatch =
  | { executeOn: Peer }
  | { refuse: { refused: string; why: string } };

/**
 * Who performs the act on this root, from THIS environment? One question, one answer, one
 * place — both the REST turn path and the live tool-call path call THIS, so the routing can
 * never leak into a caller. Environment-aware: a root owned by ANOTHER environment refuses
 * with that environment's name — the same dispatch honesty one level up.
 */
export function dispatchFor(root: RootDescriptor, environment: string): Dispatch {
  if (reachableFromEnvironment(root, { peer: "machine", environment }).ok) return { executeOn: "machine" };
  if (reachableFromEnvironment(root, { peer: "page", environment }).ok) return { executeOn: "page" };
  // Neither side can act: the refusal survives — same name, same remedy, and the only case
  // that still produces it.
  const reach = reachableFromEnvironment(root, { peer: "machine", environment });
  return { refuse: { refused: reach.ok ? ROOT_NOT_REACHABLE : reach.refused, why: reach.ok ? "no placement can act on this root" : reach.why } };
}

/**
 * The built-in file-act descriptor: the attribution every routed file call carries
 * (`descriptorId` on the wire). The verbs it covers are the executor's file verbs —
 * write/read/list — the same set lib/commands.mjs declares for the model paths.
 */
export const CORE_FS_DESCRIPTOR = "voicebox-core-fs";
export const CORE_FS_VERBS = new Set(["write", "read", "list", "delete", "edit", "diff", "grep", "list_agents", "delegate_task"]);

/** Compute a unified diff between two strings. */
export function createUnifiedDiff(filename: string, oldStr: string, newStr: string): string {
  if (oldStr === newStr) return "";
  const oldLines = oldStr ? oldStr.split("\n") : [];
  const newLines = newStr ? newStr.split("\n") : [];
  const lines = [
    `--- a/${filename}`,
    `+++ b/${filename}`,
    `@@ -1,${oldLines.length} +1,${newLines.length} @@`,
  ];
  let i = 0;
  let j = 0;
  while (i < oldLines.length || j < newLines.length) {
    if (i < oldLines.length && j < newLines.length && oldLines[i] === newLines[j]) {
      lines.push(` ${oldLines[i]}`);
      i++;
      j++;
    } else if (i < oldLines.length && (j >= newLines.length || !newLines.includes(oldLines[i]))) {
      lines.push(`-${oldLines[i]}`);
      i++;
    } else if (j < newLines.length) {
      lines.push(`+${newLines[j]}`);
      j++;
    } else {
      lines.push(`-${oldLines[i++]}`);
      lines.push(`+${newLines[j++]}`);
    }
  }
  return lines.join("\n");
}
