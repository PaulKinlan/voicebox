// tests/containment-paths.test.mjs — the containment boundary, with the case that escaped.
//
// The defect this pins (voicebox PR #9 review, and coord's own measurement on main):
// `resolveInsideRoot` refused only candidates EXACTLY equal to "." or "..", built
// `root + "/" + candidate` by string concatenation, and then prefix-checked the result. For
// `../../evil.sh` that produced `root/../../evil.sh`, which DOES start with `root/` — so the
// check passed and the function returned ok:true for a path that escapes the root. The doc
// (`docs/02-environment.md`) and `core/paths.ts:28`'s own comment both called that the
// containment boundary, and N20 says the picked-root write path reuses it.
//
// So this file is written to be RED on the old resolver and GREEN on the fixed one:
//   node --test tests/containment-paths.test.mjs
//
// Refusals are asserted by RULE (the mechanism's own words), and every refusal case is paired
// with a positive control in the same suite — a suite of refusals proves nothing until one
// request succeeds.

import test from "node:test";
import assert from "node:assert/strict";
import { resolveInsideRoot } from "../core/paths.ts";

const ROOT = "v1/projects/atlas";

test("containment: `../../evil.sh` is REFUSED (the case that escaped)", () => {
  const r = resolveInsideRoot(ROOT, "../../evil.sh");
  assert.equal(r.ok, false, `an escaping candidate must be refused; got ${JSON.stringify(r)}`);
  if (!r.ok) {
    assert.equal(r.rule, "outside-root", "the refusal must name its rule");
    // Assert the mechanism's OWN words (the refusal names the reason it actually gives),
    // rather than a wording the test author imagined. My first version of this line looked for
    // /outside-root|escapes|above the root/ and went red on the FIXED tree, because the reason
    // says "resolves outside the root" — an instrument that cannot do its job, caught by reading
    // its output instead of its exit code.
    assert.match(r.why, /resolves outside the root|escapes|absolute|names no file/i, `refusal must say why: ${r.why}`);
  }
});

test("containment: `..` is refused AS A NAME, not only as a segment", () => {
  // basename('..') is '..' — the case a normalising implementation passes while looking correct.
  assert.equal(resolveInsideRoot(ROOT, "..").ok, false);
  // and `..` as a segment, at any depth
  assert.equal(resolveInsideRoot(ROOT, "assets/../../evil.sh").ok, false);
  assert.equal(resolveInsideRoot(ROOT, "assets/../..").ok, false);
});

test("containment: absolute paths are refused", () => {
  assert.equal(resolveInsideRoot(ROOT, "/etc/passwd").ok, false);
});

test("containment: a `.`-only or empty candidate is refused", () => {
  assert.equal(resolveInsideRoot(ROOT, ".").ok, false);
  assert.equal(resolveInsideRoot(ROOT, "").ok, false);
});

test("containment: POSITIVE CONTROL — ordinary nested paths are ALLOWED, with a good path", () => {
  for (const name of ["assets/logo.svg", "assets/nested/deep/a.txt", "notes.md"]) {
    const r = resolveInsideRoot(ROOT, name);
    assert.equal(r.ok, true, `'${name}' must be allowed; got ${JSON.stringify(r)}`);
    if (r.ok) {
      assert.equal(r.path, `${ROOT}/${name}`, "the returned path is the root-joined candidate");
      assert.ok(
        r.path === ROOT || r.path.startsWith(`${ROOT}/`),
        `an allowed path must sit inside the root: ${r.path}`,
      );
    }
  }
});

test("containment: no allowed result can sit outside the root (the invariant, not just the cases)", () => {
  const candidates = [
    "a/b/c.txt", "../x", "a/../../x", "..", ".", "/abs", "", "a/./b.txt", "a//b.txt",
  ];
  for (const c of candidates) {
    const r = resolveInsideRoot(ROOT, c);
    if (r.ok) {
      assert.ok(
        r.path === ROOT || r.path.startsWith(`${ROOT}/`),
        `INVARIANT BROKEN: '${c}' was allowed and produced '${r.path}'`,
      );
    }
  }
});
