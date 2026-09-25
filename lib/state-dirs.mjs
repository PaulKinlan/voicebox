// lib/state-dirs.mjs — the ONE owner of the directories this process keeps state in.
//
// WHY (bead voicebox-beads-y5k, fifth instance of the pattern). A component that answers from its own
// copy of a fact instead of asking the owner of the fact is how two answers to one question start
// disagreeing — and the disagreement is invisible until somebody is burnt by it. The recognition
// signals are named in that bead; three of them were sitting in this tree at once:
//
//   * a module reading `process.env` for a fact another module owns — `VOICEBOX_EXTENSIONS_DIR` was
//     computed in THREE places (`lib/extensions.mjs` for the descriptors, the same file again for the
//     pending-approval file, `server.mjs` for the pairing store, `tools/approval-code.mjs` for the
//     operator's view), each with its own copy of the same fallback;
//   * two places computing the same answer — `VOICEBOX_WASM_SHELF_DIR` with its `~/.isocan/...`
//     fallback appeared three times inside `lib/extensions.mjs` alone;
//   * a value resolved at import/boot that can change later, next to a getter for the same fact —
//     the extensions directory was a constant at line 38 and a five-line-later function at line 248.
//
// HOW IT WAS FIXED, and why this module rather than a tidy-up: the facts get ONE computing site, here,
// and the callers ask. `scripts/single-owner.mjs` is the mechanism that keeps it that way — it reads
// `FACTS` from this module and refuses any other site in the tree that reads the variable or rebuilds
// the default, so a fourth copy goes red in the gate instead of silently drifting. The pattern's own
// test is `tests/single-owner.test.mjs`.
//
// WHAT THIS MODULE OWNS, and what it deliberately does NOT:
//   * it owns the state-DIRECTORY facts — where the extension system writes, where the host keeps
//     descriptors and the pairing store, where the wasm shelf is read from, and where a fence's
//     writable home is bound from. It does not own paths derived inside a directory
//     (`proposals/`, `audit.jsonl`, `.pairings.json`) — those have one site each already, and
//     deriving two different names inside one owned root is not the defect this is about;
//   * `value()` reads the variable at CALL time. A caller that stores the result in a constant has
//     taken a copy at import; for these three facts that is fine (the environment is fixed at boot),
//     but a fact that can change while the process lives needs a getter, which is what `value()` is;
//   * an EMPTY value is not an answer: `set()` is the rule `server.mjs` already used for the boot
//     declaration, and `value()` now applies it to the directory too. Two callers used `??`, which
//     let `VOICEBOX_EXTENSIONS_DIR=` resolve to `""` and every path under it become relative —
//     "unset" and "set to nothing" are one state, and it is the default.
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The checkout this module is in. The state defaults below hang off it. */
export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const set = (v) => v != null && v !== "";

/**
 * One owned fact. The variable's name is written down ONCE, here: `value()` and `declared()` both read
 * it through this closure, so a second copy of the name — the thing this module exists to prevent —
 * is not expressible in its own owner.
 *
 * `recomputed` is the fact's default expression, as a pattern. It is here, next to the default it
 * describes, so the check derives both signatures from the declaration instead of keeping a second
 * list in the script. It is deliberately narrow: the checkout-root form (`path.join(REPO, "workspace")`)
 * rather than any `path.join(x, "workspace")` — a sandbox home's `workspace` (lib/fence-provider.mjs)
 * is a DIFFERENT fact that happens to share a leaf name.
 */
const fact = ({ id, env, why, asks, defaulted, recomputed }) => ({
  id,
  env,
  why,
  asks,
  recomputed,
  /** The directory in use: the environment's answer when it gives one, the default otherwise. */
  value: () => (set(process.env[env]) ? process.env[env] : defaulted()),
  /** The operator's DECLARATION, or null. No default, because a default is a decision nobody made. */
  declared: () => (set(process.env[env]) ? process.env[env] : null),
});

export const FACTS = {
  workspace: fact({
    id: "workspace",
    env: "VOICEBOX_WORKSPACE",
    why: "where the extension system keeps proposals/ and audit.jsonl — and, when it is set, the machine root declared at boot",
    asks: "workspaceDir() for the directory, workspaceDeclared() for the operator's declaration",
    defaulted: () => path.join(REPO, "workspace"),
    recomputed: /path\s*\.\s*join\(\s*(?:REPO|ROOT)\s*,\s*["']workspace["']/,
  }),
  extensions: fact({
    id: "extensions",
    env: "VOICEBOX_EXTENSIONS_DIR",
    why: "the host's own directory — outside every root the model can write: admitted descriptors, .host-token (0600), .ledger.jsonl, .pairings.json",
    asks: "extensionsDir()",
    defaulted: () => path.join(REPO, "extensions"),
    recomputed: /path\s*\.\s*join\(\s*(?:REPO|ROOT)\s*,\s*["']extensions["']/,
  }),
  wasmShelf: fact({
    id: "wasmShelf",
    env: "VOICEBOX_WASM_SHELF_DIR",
    why: "the isocan wasm tool shelf an admitted wasm tool is read from (manifest.json and .wasm modules)",
    asks: "wasmShelfDir()",
    defaulted: () => path.join(os.homedir(), ".isocan", "modules", "wasm-tools"),
    recomputed: /path\s*\.\s*join\(\s*os\s*\.\s*homedir\(\)\s*,\s*["']\.isocan["']/,
  }),
  sandboxHomes: fact({
    id: "sandboxHomes",
    env: "VOICEBOX_SANDBOX_HOMES",
    why: "where a fence's writable home is bound from — the one place a fenced environment may write, and it must live OUTSIDE /tmp (PrivateTmp hides it and the bind fails, status 226/NAMESPACE)",
    asks: "sandboxHomesDir() — read at USE time, so a test's before-hook or an operator's restart is seen",
    defaulted: () => path.join(os.homedir(), "sandbox-homes"),
    recomputed: /path\s*\.\s*join\(\s*os\s*\.\s*homedir\(\)\s*,\s*["']sandbox-homes["']/,
  }),
};

/** Where the extension system's state lives (`proposals/`, `audit.jsonl`). */
export const workspaceDir = FACTS.workspace.value;
/** Host tooling (CLI flags) declaring an override — the env write happens HERE, in the fact's owner, nowhere else (voicebox-beads-y5k). */
export function declareOverrides({ workspace, extensions } = {}) {
  if (workspace) process.env[FACTS.workspace.env] = path.resolve(workspace);
  if (extensions) process.env[FACTS.extensions.env] = path.resolve(extensions);
}

/** The operator's boot declaration, or null: the root seam's "nobody declared one" state. */
export const workspaceDeclared = FACTS.workspace.declared;
/** The host's own directory: descriptors, `.host-token`, `.ledger.jsonl`, `.pairings.json`. */
export const extensionsDir = FACTS.extensions.value;
/** The wasm tool shelf the host reads admitted wasm tools from. */
export const wasmShelfDir = FACTS.wasmShelf.value;
/** Where a fence's writable home is bound from — read at use time, never captured at import. */
export const sandboxHomesDir = FACTS.sandboxHomes.value;
