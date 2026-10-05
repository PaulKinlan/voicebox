// lib/path-auth.mjs — the ONE owner of "may this path be touched through the loop" (machine side).
//
// WHY THIS MODULE EXISTS (bead voicebox-beads-q0a3). Realpath containment and dotfile denial were
// re-implemented per verb and per store — a per-verb allowlist in server.mjs, two more dotfile
// copies behind `list` and `GET /api/file`, a private `contained()` in lib/extensions.mjs, raw
// `startsWith(root + sep)` compares in the mini-app store, `containedOrEqual` in lib/tool-index.mjs,
// and a sixth shape in tools/env-serve.mjs. The guards were enforced — vuln-verify disproved the
// security claim — but the SHAPE is the recurrence: a new file verb or store writer inherits none of
// the copies and silently misses one of the two checks. This module is the single computing site for
// both checks, and `scripts/single-owner.mjs` refuses any new copy (see SITES at the bottom).
//
// WHAT IT OWNS, in the order every caller gets:
//   1. ROOT-KIND HANDLING — the reachability seam in core/root.ts decides which side may act; a
//      page-owned root (opfs, a picked handle) is refused here BY NAME because the act belongs to
//      the page, and "machine" is the only kind with a real path to realpath against.
//   2. LEXICAL CONTAINMENT — core/paths.ts (`resolveInsideRoot` through `resolveInRoot`): refuse,
//      never normalise. `..` at any depth keeps its own stronger refusal (`outside-root`).
//   3. REALPATH CONTAINMENT — the machine placement's addition: a lexical check follows a symlink
//      out, so the candidate's real path (of the file if it exists, of its nearest existing
//      ancestor if it does not) must land inside the root's real path.
//   4. THE AUDIT — protectedAuditPath (lib/tasks.mjs) guards the host-owned `.audit` tree.
//   5. DOTFILE DENIAL — containment FIRST (so `..` keeps its refusal), then a hidden file inside
//      the root is refused: a declared root pointed at a sensitive directory (the host's own
//      extensions dir) would otherwise hand over its secrets — including the admission token —
//      through a read, or lose them to a write over it (driven chain, 2026-09-20).
//
// THE ORDER IS THE CONTRACT: lexical → realpath → audit → dotfile. A `.audit` path keeps its
// `protected-audit` refusal rather than the dotfile one, and an escape keeps `outside-root` rather
// than either — tests pin all three.
//
// WHAT IT DELIBERATELY DOES NOT OWN:
//   * the PAGE's containment — core/paths.ts is that placement's owner (OPFS has no symlinks and
//     `..` does not resolve; the page cannot import node:fs, so it cannot ask this module);
//   * `protectedAuditPath` — the audit's own guard stays in lib/tasks.mjs, its one computing site;
//   * root admission (`open_workspace` / `POST /api/root` canonicalise a DECLARED root with
//     realpathSync + isDirectory) — declaring is a different question from acting, and has its own
//     site in server.mjs.
//
// THE ROOT MAY VANISH: this module realpaths the root on every question (as the server's private
// copy did before it), which throws ENOENT if the root was deleted after declaration. Callers keep
// asking `rootMissing()` first — the anti-hang contract (a throw inside an unawaited handler leaves
// the caller waiting forever) is theirs to keep, and moving it here would not move the routes.
import path from "node:path";
import { realpathSync } from "node:fs";
import { noRootDeclared, reachableFrom, reachableFromEnvironment, resolveInRoot } from "../core/root.ts";
import { protectedAuditPath } from "./tasks.mjs";

/**
 * Lexical containment: is `target` inside `base`? Normalising is not checking — `path.relative`
 * collapses nothing here, the answer is yes-or-no (`basename("..")` is `".."`, so a join+basename
 * silently rewrote the chrome-agent-platform-0j1a escape instead of refusing it).
 *
 * `rel === ""` — the target IS the base — is NOT containment by default; pass `allowEqual` when the
 * base itself is a valid answer (a cwd may be the root; a file name inside the root may not).
 */
export function containedIn(base, target, { allowEqual = false } = {}) {
  const rel = path.relative(base, target);
  if (rel === "") return allowEqual;
  return !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * REALPATH containment against an ALREADY-REALIZED base. A lexical check follows a symlink out, so
 * the candidate's real path must land inside `rootReal` (the root's own real path — realpath it
 * once per root, not once per probe).
 *
 * A target that does not exist yet is probed at its NEAREST EXISTING ANCESTOR and the tail is
 * carried: a new file under a symlinked directory is checked by the symlink it would be created
 * through, which is the only place it can escape from. (`realpathSync(candidate)` alone throws
 * ENOENT and a caller that swallows it — as the extensions write path once did — writes the
 * unresolved path and the check never ran.)
 */
export function realContainedIn(rootReal, target, { allowEqual = false } = {}) {
  let probe = target;
  for (;;) {
    try {
      const real = realpathSync(probe);
      return containedIn(rootReal, real, { allowEqual });
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
      const parent = path.dirname(probe);
      if (parent === probe) throw e;
      probe = parent;
    }
  }
}

/** The dotfile denial, segment-wise — any relative segment beginning with a dot, not just the leaf. */
export function dotfileSegmentInside(rootPath, resolvedPath) {
  return path.relative(rootPath, resolvedPath).split(path.sep).filter(Boolean).find((seg) => seg.startsWith(".")) ?? null;
}

/**
 * The shared spine — realpath containment, the audit guard, the dotfile denial — on an
 * already-resolved absolute path. Everything below composes this with its own front door;
 * it is not exported because "an already-joined path" is only an answer when something owns
 * the join, and both public entry points say which one that is.
 */
function authorizeReal(rootPath, resolvedPath, label) {
  const rootReal = realpathSync(rootPath);
  if (!realContainedIn(rootReal, resolvedPath, { allowEqual: true })) {
    return { ok: false, refused: "outside-root", why: `'${label}' resolves outside '${rootPath}' by real path` };
  }
  if (protectedAuditPath(rootPath, resolvedPath)) {
    return { ok: false, refused: "protected-audit", why: "the audit is host-owned; task records require authenticated task_status, not a raw file read or write" };
  }
  const dot = dotfileSegmentInside(rootPath, resolvedPath);
  if (dot) {
    return { ok: false, refused: "dotfile-refused", why: `dotfiles are neither readable nor writable through the loop — the listing hides them and so does this verb ('${dot}'); host secrets live behind that line` };
  }
  return { ok: true, path: resolvedPath };
}

/**
 * THE PATH-AUTHORIZATION FUNCTION for every machine-side file verb (read/write/delete/edit/diff/
 * mkdir/list, the REST file routes, the image saveAs) and every admitted extension tool: resolve a
 * name inside the declared root, or the named refusal that says why.
 *
 * `root` is the root descriptor; a missing root answers `root-not-declared`, and a page-owned root
 * answers the reachability seam's own refusal — the act belongs to that side (root-kind handling is
 * the seam's question, asked here so no caller re-derives it). `environment`, when the caller HAS a
 * self identity (the server's minted key), upgrades the positional check to "may THIS environment
 * act"; callers without one (the extension runtime) ask the positional question only, exactly as
 * they did before this module existed.
 */
export function authorizeMachinePath(root, name, { environment = null } = {}) {
  if (!root || typeof root !== "object") return { ...noRootDeclared() };
  const reach = environment != null
    ? reachableFromEnvironment(root, { peer: "machine", environment })
    : reachableFrom(root, "machine");
  if (!reach.ok) return { ok: false, refused: reach.refused, why: reach.why };
  const resolved = resolveInRoot(root, name);
  if (!resolved.ok) return { ok: false, refused: resolved.rule, why: resolved.why };
  return authorizeReal(root.path, resolved.path, String(name));
}

/**
 * The same authorization for a writer that JOINS the path itself (the mini-app store: it derives a
 * file name, not a user-supplied relative name). The realpath spine is what makes a hand-rolled
 * join unable to escape: `path.resolve` collapses `..` silently, but where it lands is still
 * checked by real path, and dotfiles and the audit are refused behind the same line as the verbs.
 */
export function authorizeResolvedPath(rootPath, resolvedPath) {
  return authorizeReal(rootPath, resolvedPath, path.relative(rootPath, resolvedPath) || resolvedPath);
}

// ── THE DECLARATION `scripts/single-owner.mjs` ENFORCES ──────────────────────────────────────────
//
// Same doctrine as lib/state-dirs.mjs FACTS: the fact declares the shapes that identify a second
// computing site, and the gate refuses them anywhere else in the tree. These are CODE-SHAPE facts
// (there is no environment variable to read), so the gate drives this module's exports instead of
// probing a variable — a declaration whose implementation vanished is refused, not passed.
export const SITES = {
  pathAuthorization: {
    id: "path-authorization",
    why: "realpath containment + dotfile denial had six host-side near-copies (server verbs ×3, extensions tools, mini-app store ×2, tool-index cwd, env-serve cwd, env-transport walk, system-tools binary) — a new file verb or store writer inherits none of them (voicebox-beads-q0a3)",
    asks: "authorizeMachinePath(root, name) / authorizeResolvedPath(rootPath, joined) / containedIn / realContainedIn from lib/path-auth.mjs",
    // The PAGE tree (core/, browser/, public/) cannot import lib/ — core/paths.ts is that
    // placement's lexical owner, so its shapes are out of this site's scope by design, not by
    // oversight.
    skipDirs: ["core", "browser", "public"],
    patterns: [
      { id: "lexical-contained", re: /\.startsWith\(\s*["'`]\.\.["'`]\s*\)/, what: "a lexical containment refusal (path.relative + startsWith('..'))" },
      { id: "prefix-contained", re: /\.startsWith\(\s*(?:`[^`]*\$\{[^}]*\}\s*(?:\$\{\s*path\s*\.\s*sep\s*\}|\/)`|\w+\s*\+\s*(?:path\s*\.\s*sep|["']\/["'])\s*)\)/, what: "a raw prefix containment compare (startsWith(root + sep))" },
      { id: "prefix-built", re: /path\s*\.\s*(?:join|resolve)\s*\([^)]*\)\s*\+\s*(?:path\s*\.\s*sep|["']\/["'])/, what: "building a sep-suffixed prefix — the INDIRECTED form of the prefix compare (const allowed = path.join(...) + path.sep; startsWith(allowed)) — review P2, q0a3: the direct form's pattern cannot see it" },
      { id: "dotfile-segment", re: /\.some\(\s*\(?\s*\w+\s*\)?\s*=>\s*\w+\s*\.\s*startsWith\(\s*["']\.["']\s*\)\s*\)/, what: "a segment-wise dotfile denial" },
    ],
    // A named exemption is a recorded decision, never a silent skip — the gate prints these.
    except: {
      "lib/tasks.mjs": "protectedAuditPath answers the INVERSE question ('is this THE reserved .audit tree'), its own fact at its own single site; folding it in would merge two refusals the vocabulary keeps apart",
    },
  },
};
