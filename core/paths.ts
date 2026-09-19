// core/paths.ts — resolve-and-refuse, never normalise.
//
// The rule from the design (§5): resolve, compare, refuse. basename, join, normalize and
// replace('../','') are rewrites, and a rewrite is what produced the escape this module exists
// to prevent.
//
// In OPFS there are no symlinks and `..` does not resolve, so the check is a lexical one. The
// shape stays identical for the machine placement, where it becomes a realpath comparison.
//
// WHY THIS FILE CHANGED (the defect, exactly):
//   The first version refused only candidates EXACTLY equal to "." or "..", then built
//   `root + "/" + candidate` by string concatenation and prefix-checked the result. For
//   `../../evil.sh` that produced `root/../../evil.sh`, which DOES start with `root/`, so the
//   check passed and the function returned ok:true for a path that escapes the root — while
//   line 28's own comment called that the containment boundary, `docs/02-environment.md` relied
//   on it, and N20 says the picked-root write path reuses it. Measured, before the fix:
//     resolveInsideRoot("v1/projects/atlas", "../../evil.sh")
//       → { ok: true, path: "v1/projects/atlas/../../evil.sh" }
//
// THE FIX, and why it is a refusal rather than a tidy-up: a candidate containing a `..` segment
// is REFUSED OUTRIGHT, at any depth, even when it would climb back inside (`a/../b`). Collapsing
// segments before comparing would also be correct, but it is the rewrite this module's own
// doctrine forbids, and the caller has no legitimate need for one: there are no callers, and the
// write path only ever names a file inside the root. Refusing keeps the answer binary — yes or
// no — which is what makes it checkable. The prefix comparison stays as the second line of
// defence, for the paths that reach it.

export type ResolveResult =
  | { ok: true; path: string }
  | { ok: false; rule: "outside-root"; why: string };

const refuse = (why: string): ResolveResult => ({ ok: false, rule: "outside-root", why });

/**
 * Resolve `candidate` inside `root` and refuse if it escapes.
 *
 * Refuses `..` as a *name* (not just as a path segment) — `basename('..')` is `'..'`, so a
 * normalising implementation passes while the file lands in the parent — and refuses it as a
 * segment too, at any depth. Absolute candidates are refused for the same reason: they do not
 * name something *inside* the root, which is the only thing this function is allowed to return.
 */
export function resolveInsideRoot(root: string, candidate: string): ResolveResult {
  if (typeof candidate !== "string" || candidate.trim() === "") {
    return refuse("an empty candidate names nothing inside the root");
  }
  if (candidate.startsWith("/")) {
    return refuse(`'${candidate}' is absolute; the root is the only place a tool may touch`);
  }

  const segments = candidate.split("/").filter((s) => s !== "" && s !== ".");
  if (segments.length === 0) {
    return refuse(`'${candidate}' names no file inside the root`);
  }
  if (segments.some((s) => s === "..")) {
    // The case that escaped, and every variant of it. Refused rather than collapsed.
    return refuse(
      `'${candidate}' contains a '..' segment, which resolves outside the root — ` +
        `'${root}' is the containment boundary and a name of '..' is not a file inside it`,
    );
  }

  const resolved = `${root}/${segments.join("/")}`;
  // Second line of defence: unreachable for an escape, because every escape is refused above.
  if (resolved !== root && !resolved.startsWith(`${root}/`)) {
    return refuse(`'${candidate}' escapes '${root}'`);
  }
  return { ok: true, path: resolved };
}
