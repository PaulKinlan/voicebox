// lib/loop.mjs — the agent loop, as a library (brief N18).
//
// The cycle, in one place: turn → decide → dispatch → result → record.
// Before this module the cycle existed three times — lib/resolver.mjs mapped
// verbs, server.mjs dispatched, public/fused.js orchestrated — and three
// copies of one cycle is how placements drift ("a core that runs in one
// placement becomes two implementations that drift", docs/00-brief N18).
//
// PLACEMENT-NEUTRAL ON PURPOSE. No node:* imports, no DOM, no fetch, no
// transport of any kind — where the loop RUNS is still an open decision
// (docs/06 §3), so the seams take functions and the caller decides what they
// reach:
//
//   - the server (server.mjs) plugs in an in-process executor (node:fs) and
//     model resolvers (lib/resolver.mjs), and runs the whole cycle locally.
//   - the page (public/fused.js) plugs in HTTP seams — decide is POST
//     /api/resolve, dispatch is POST /api/execute — and drives the SAME
//     module, served byte-for-byte from this file (GET /lib/loop.mjs). The
//     page never has a copy to drift.
//   - a worker, a CLI, another harness (N15): same module, their own seams.
//
// THE EXTENSION POINT IS use() (N10/N16/N17). An extension is a function that
// receives the loop and registers on it — resolvers today; when dynamic
// tools land, the same door ("we will be able to build extensions just by
// using voice" — the voice path and the extension path are this one path).
// pi's own model, deliberately: registerTool-by-another-name, not an
// admission pipeline.

/**
 * @param {{ execute?: (action: object) => any, record?: (entry: object) => void }} seams
 *   execute — dispatches a resolved action and returns its result. Optional:
 *   a loop without one still decides, and runTurn says so rather than throwing.
 *   record — an extra sink for every completed turn (the loop always keeps
 *   its own in-memory log regardless; use this to persist or audit).
 */
export function createLoop({ execute, record } = {}) {
  const resolvers = {};
  const log = [];

  const loop = {
    /** The resolver seam: a resolver maps a transcript to an action or { unresolved }. */
    registerResolver(name, fn) {
      resolvers[name] = fn;
    },

    /** decide. A resolver may be sync or async. */
    async resolveTurn(transcript, provider = "script") {
      const fn = resolvers[provider];
      if (!fn) return { unresolved: `no resolver registered for '${provider}'` };
      return await fn(transcript);
    },

    /**
     * The whole cycle for one turn. Returns exactly one of:
     *   { transcript, action, result }           — decided and dispatched
     *   { transcript, action: null, note }       — the turn could not be mapped
     * Both shapes are recorded before they are returned.
     */
    async runTurn(transcript, { provider = "script" } = {}) {
      const action = await loop.resolveTurn(transcript, provider);
      const outcome = action.unresolved
        ? { transcript, action: null, note: action.unresolved }
        : {
            transcript,
            action,
            result: execute
              ? await execute(action)
              : { ok: false, error: "this loop has no executor — it decides only" },
          };
      const entry = { at: new Date().toISOString(), provider, ...outcome };
      log.push(entry);
      record?.(entry);
      return outcome;
    },

    /**
     * The extension point. `extension` is a function called with this loop,
     * immediately: (loop) => { loop.registerResolver(...); ... }. Errors are
     * named with the extension, not swallowed — a broken extension is loud.
     */
    use(extension, name = extension.name || "(anonymous)") {
      try {
        extension(loop);
      } catch (e) {
        throw new Error(`extension '${name}' failed to load: ${e?.message ?? e}`, { cause: e });
      }
      return loop;
    },

    /** Every turn this loop has run, oldest first. In-memory; persistence is the record seam's job. */
    get log() {
      return log;
    },
  };

  return loop;
}
