// lib/routes/tool-catalog.mjs — the room's tool catalogue over HTTP.
//
// Extracted from server.mjs (voicebox-beads-r9hv.2, the pilot slice of the voicebox-beads-r9hv ADR).
// One route, one module: `GET /api/tools` was 18 lines inside a 5859-line file that 214 commits touched
// in the last 30 days, and this is the smallest surface in that file with no module-level mutable state.
//
// WHY THIS SLICE EXISTS. server.mjs is the repo's collision hotspot (214 commits / 30 days against 1-2 for
// each lib/routes module). The ADR measured that this does NOT make the fast gate faster: scripts/test-changed.mjs
// maps a change to a lib/routes module to ~137 tests, because server.mjs imports the module and 137 test
// files name server.mjs. So the win is collision and ownership, not gate time. Do not claim otherwise here
// or in a landing summary.
//
// THE BODY IS MOVED VERBATIM, with exactly one seam change and one no-op-friendly guard:
//
//   · `active` → `getActiveRoot()`. This is the one that matters. In server.mjs `active` is a module-level
//     `let` that is REASSIGNED when a machine root is declared or deleted, and this handler decides which
//     tree it lists from that value (`active.root.path` for a machine root, `ROOT` otherwise). Handing the
//     value over would capture a SNAPSHOT and the route would answer from the root that was active when the
//     server booted — the voicebox-beads-w1f9 shape: green tests, wrong answer, visible only when someone
//     declares a root and then lists tools. So the caller passes a live accessor and the module reads it on
//     EVERY request. tests/tool-catalog-route-seam.test.mjs calls the route twice with the accessor changing
//     in between, which is what turns that mistake red instead of shipping it.
//   · the harness pair is read through the same "inventory may be unavailable" fallback the inline handler
//     had (`harnesses = []` on failure), so a harness inventory that throws still lists the tools.
//
// WHAT DID NOT MOVE, deliberately: the `limit`/`kind`/`q` parsing (including its unchanged `Number(...)`
// behaviour on junk — not a moment to "improve" query semantics), the `miniAppTools` read happening BEFORE
// the harness inventory attempt, and the caller's own deps (`json`, the two tool-index functions, the
// registries, `ROOT`), which stay owned by server.mjs — this module receives them, it does not reach for
// them. Nothing here touches the static/CSP surface (cspReportOnlyHeaders / resolvePublicFile), which is
// fenced off while the CSP work is in flight.

/**
 * Build the tool catalogue routes.
 *
 * @param {object} deps
 * @param {(res: any, status: number, payload: any) => any} deps.json      server.mjs's JSON responder (identical envelope)
 * @param {(q: string, opts: object) => Promise<any>} deps.searchTools     lib/tool-index.mjs searchTools
 * @param {(opts: object) => Promise<any>} deps.listTools                 lib/tool-index.mjs listTools
 * @param {() => any} deps.getActiveRoot                                  LIVE read of server.mjs's `active` binding — never a snapshot
 * @param {string} deps.rootDir                                           the fallback root when no machine root is declared (server.mjs's ROOT)
 * @param {{ getAllTools: () => any[] }} deps.activeMiniAppRegistry       the room's mini-app tool registry
 * @param {() => Promise<any>} [deps.harnessInventory]                    harness inventory; unavailable ⇒ []
 * @param {(inv: any, registry: any) => Promise<any>} [deps.listHarnessesWithConfiguredAgents]
 * @param {any} [deps.agentRegistry]                                      passed through to listHarnessesWithConfiguredAgents
 * @returns {Record<string, (req: any, res: any, url: any) => Promise<any>>} the route table entries
 */
export function createToolCatalogRoutes({
  json,
  searchTools,
  listTools,
  getActiveRoot,
  rootDir,
  activeMiniAppRegistry,
  harnessInventory,
  listHarnessesWithConfiguredAgents,
  agentRegistry,
}) {
  return {
    "GET /api/tools": async (req, res, url) => {
      const q = (url.searchParams.get("q") ?? "").trim();
      const kind = (url.searchParams.get("kind") ?? "").trim() || undefined;
      const limitParam = url.searchParams.get("limit");
      const limit = limitParam ? Number(limitParam) : undefined;
      const miniAppTools = activeMiniAppRegistry.getAllTools();
      let harnesses = [];
      try {
        const inv = typeof harnessInventory === "function" ? await harnessInventory() : [];
        const combined = typeof listHarnessesWithConfiguredAgents === "function"
          ? await listHarnessesWithConfiguredAgents(inv, agentRegistry)
          : { harnesses: inv };
        harnesses = combined.harnesses ?? [];
      } catch {}
      // LIVE, on every request: see the header. A snapshot of this read is the defect this seam exists to avoid.
      const activeRoot = typeof getActiveRoot === "function" ? getActiveRoot() : null;
      const rootPath = activeRoot?.root?.kind === "machine" ? activeRoot.root.path : rootDir;
      const result = q
        ? await searchTools(q, { rootPath, kind, limit, miniAppTools, harnesses })
        : await listTools({ rootPath, kind, limit, miniAppTools, harnesses });
      return json(res, 200, result);
    },
  };
}
