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
export const CORE_FS_VERBS = new Set(["write", "read", "list", "delete", "edit", "diff", "undo", "grep", "list_agents", "delegate_task", "contact_agent", "mini_app", "git_status", "git_diff", "git_log", "inspect_environment"]);

/** Compute a unified diff between two strings using prefix/suffix trimming and LCS. */
export function createUnifiedDiff(filename: string, oldStr: string, newStr: string): string {
  if (oldStr === newStr) return "";
  const oldLines = oldStr ? oldStr.split("\n") : [];
  const newLines = newStr ? newStr.split("\n") : [];
  const lines = [
    `--- a/${filename}`,
    `+++ b/${filename}`,
    `@@ -1,${oldLines.length} +1,${newLines.length} @@`,
  ];

  let start = 0;
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) {
    start++;
  }
  let endOld = oldLines.length;
  let endNew = newLines.length;
  while (endOld > start && endNew > start && oldLines[endOld - 1] === newLines[endNew - 1]) {
    endOld--;
    endNew--;
  }

  for (let idx = 0; idx < start; idx++) {
    lines.push(` ${oldLines[idx]}`);
  }

  const midOld = oldLines.slice(start, endOld);
  const midNew = newLines.slice(start, endNew);
  const m = midOld.length;
  const n = midNew.length;

  if (m * n <= 250_000) {
    const dp = Array.from({ length: m + 1 }, () => new Int32Array(n + 1));
    for (let i = m - 1; i >= 0; i--) {
      for (let j = n - 1; j >= 0; j--) {
        if (midOld[i] === midNew[j]) {
          dp[i][j] = dp[i + 1][j + 1] + 1;
        } else {
          dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
        }
      }
    }
    let i = 0;
    let j = 0;
    while (i < m || j < n) {
      if (i < m && j < n && midOld[i] === midNew[j]) {
        lines.push(` ${midOld[i]}`);
        i++;
        j++;
      } else if (i < m && (j === n || dp[i + 1][j] >= dp[i][j + 1])) {
        lines.push(`-${midOld[i]}`);
        i++;
      } else {
        lines.push(`+${midNew[j]}`);
        j++;
      }
    }
  } else {
    for (let i = 0; i < m; i++) lines.push(`-${midOld[i]}`);
    for (let j = 0; j < n; j++) lines.push(`+${midNew[j]}`);
  }

  for (let idx = endOld; idx < oldLines.length; idx++) {
    lines.push(` ${oldLines[idx]}`);
  }

  return lines.join("\n");
}
