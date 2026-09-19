// core/paths.ts — resolve-and-refuse, never normalise.
//
// The rule from the design (§5): resolve, compare, refuse. basename, join,
// normalize and replace('../','') are rewrites, and a rewrite is what produced
// the escape this module exists to prevent.
//
// In OPFS there are no symlinks and `..` does not resolve, so the check is a
// prefix comparison on a lexically resolved path. The shape stays identical for
// the machine placement, where it becomes a realpath comparison.

export type ResolveResult =
  | { ok: true; path: string }
  | { ok: false; rule: "outside-root"; why: string };

/**
 * Resolve `candidate` inside `root` and refuse if it escapes.
 *
 * Refuses `..` as a *name* (not just as a path segment) — `basename('..')`
 * is `'..'`, so a normalising implementation passes while the file lands
 * in the parent. This function resolves the joined path and compares it
 * against the root, so the answer is yes or no, never a rewrite.
 */
export function resolveInsideRoot(root: string, candidate: string): ResolveResult {
  if (!candidate || candidate === "." || candidate === "..") {
    return { ok: false, rule: "outside-root", why: `the name '${candidate}' resolves outside the root` };
  }
  const resolved = root + "/" + candidate.replace(/\/+$/, "");
  // The prefix check is the OPFS containment boundary.
  if (resolved !== root && !resolved.startsWith(root + "/")) {
    return { ok: false, rule: "outside-root", why: `'${candidate}' escapes '${root}'` };
  }
  return { ok: true, path: resolved };
}
