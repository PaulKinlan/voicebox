// tests/path-auth.test.mjs — the ONE owner of machine-side path authorization, driven.
//
// voicebox-beads-q0a3: realpath containment + dotfile denial were re-implemented per verb and per
// store; this file drives the extracted owner (lib/path-auth.mjs) the way every caller now uses it,
// so the drives double as the acceptance evidence for the bead: every verb shape at a "." segment
// and a ".." escape, plus an allowed-path control — and the refusal must arrive BY NAME.
//
// The live per-route drives (PUT/GET/DELETE/PATCH /api/file, list, saveAs) live in
// tests/file-actions.test.mjs and tests/path-auth-verbs.test.mjs; this file is the owner's own
// unit surface: pure, no server.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { authorizeMachinePath, authorizeResolvedPath, containedIn, realContainedIn, dotfileSegmentInside } from "../lib/path-auth.mjs";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "vb-path-auth-"));
const root = path.join(scratch, "root");
const outside = path.join(scratch, "outside");
fs.mkdirSync(path.join(root, "sub"), { recursive: true });
fs.mkdirSync(path.join(root, "sub", "deep"), { recursive: true });
fs.mkdirSync(outside, { recursive: true });
fs.writeFileSync(path.join(root, "notes.txt"), "control\n");
// A symlink OUT of the root and a symlink IN to a directory inside it — the lexical pass follows
// a symlink out, which is exactly why the realpath pass exists.
fs.symlinkSync(outside, path.join(root, "link-out"));
fs.symlinkSync(path.join(root, "sub"), path.join(root, "link-in"));
// The host-owned audit tree the spine must refuse behind its own name.
fs.mkdirSync(path.join(root, ".audit"), { recursive: true });

const rootDesc = { kind: "machine", path: root };
test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));

test("containedIn: inside yes, parent no, sibling no, equal only when allowed", () => {
  assert.equal(containedIn(root, path.join(root, "a.txt")), true);
  assert.equal(containedIn(root, path.join(root, "sub", "a.txt")), true);
  assert.equal(containedIn(root, path.dirname(root)), false);
  assert.equal(containedIn(root, `${root}-sibling`), false, "a string prefix is not containment");
  assert.equal(containedIn(root, root), false, "the base itself is not 'inside' by default");
  assert.equal(containedIn(root, root, { allowEqual: true }), true, "unless the caller allows it (a cwd may be the root)");
});

test("realContainedIn: follows a symlink out, admits a symlink in, and probes a missing file at its nearest existing ancestor", () => {
  const rootReal = fs.realpathSync(root);
  assert.equal(realContainedIn(rootReal, path.join(root, "notes.txt")), true);
  assert.equal(realContainedIn(rootReal, path.join(root, "link-out", "evil.sh")), false, "a symlinked directory out of the root is not contained");
  assert.equal(realContainedIn(rootReal, path.join(root, "link-in", "notes.txt")), true, "a symlink to a directory inside the root is contained");
  // A NEW file (ENOENT) is checked by the symlinked directory it would be created through —
  // the hole the extensions write path used to have (ENOENT swallowed, path written unchecked).
  assert.equal(realContainedIn(rootReal, path.join(root, "link-out", "new.txt")), false);
  assert.equal(realContainedIn(rootReal, path.join(root, "sub", "new", "file.txt")), true, "a new file under a real directory is fine");
});

test("authorizeMachinePath: every file-verb shape at a '..' escape refuses outside-root, by name", () => {
  for (const escape of ["../evil.sh", "sub/../../evil.sh", "..", "sub/.."]) {
    const verdict = authorizeMachinePath(rootDesc, escape);
    assert.equal(verdict.ok, false, `'${escape}' must not pass`);
    assert.equal(verdict.refused, "outside-root", `'${escape}' keeps the stronger refusal`);
    assert.match(verdict.why, /'\.\.'|\.\.' segment|outside/, "and the why names the mechanism");
  }
});

test("authorizeMachinePath: a '.' dotfile segment refuses dotfile-refused — leaf, nested and deep", () => {
  for (const dot of [".env", ".host-token", "sub/.env", "sub/.config/settings.json", ".audit/records.jsonl"]) {
    const verdict = authorizeMachinePath(rootDesc, dot);
    if (dot.startsWith(".audit")) {
      assert.equal(verdict.refused, "protected-audit", "the audit keeps its own name — a dotfile inside .audit does not re-label it");
    } else {
      assert.equal(verdict.ok, false, `'${dot}' must not pass`);
      assert.equal(verdict.refused, "dotfile-refused", `'${dot}' refused by name`);
    }
  }
});

test("authorizeMachinePath: containment FIRST — an escape that is also a dotfile is outside-root, not dotfile-refused", () => {
  const verdict = authorizeMachinePath(rootDesc, "../.ssh/authorized_keys");
  assert.equal(verdict.refused, "outside-root", "`..` keeps its own, stronger refusal (the pinned order)");
});

test("authorizeMachinePath: the allowed controls pass", () => {
  for (const fine of ["notes.txt", "sub/notes.txt", "sub/deep/file.ts"]) {
    const verdict = authorizeMachinePath(rootDesc, fine);
    assert.equal(verdict.ok, true, `'${fine}' is an ordinary inside path`);
    assert.equal(verdict.path, path.join(root, fine));
  }
  // A literal "." segment is normalised by the shared lexical resolver, not refused:
  // resolveInsideRoot filters '.' — the refusal this bead pins is the DOTFILE ('.env'), not '.'.
  const dotSegment = authorizeMachinePath(rootDesc, "sub/./notes.txt");
  assert.equal(dotSegment.ok, true, "'.' segments collapse inside the root and stay allowed");
});

test("authorizeMachinePath: root-kind handling — no root and a page root both refuse by name", () => {
  const none = authorizeMachinePath(null, "notes.txt");
  assert.equal(none.refused, "root-not-declared");
  const page = authorizeMachinePath({ kind: "opfs", path: "v1/projects/atlas" }, "notes.txt");
  assert.equal(page.ok, false);
  assert.equal(page.refused, "root-not-reachable-from-here", "the act belongs to the page, and the refusal says so");
  const handle = authorizeMachinePath({ kind: "handle", id: "abc" }, "notes.txt");
  assert.equal(handle.refused, "root-not-reachable-from-here");
});

test("authorizeMachinePath: a machine root owned by another environment refuses, naming its owner", () => {
  const verdict = authorizeMachinePath({ kind: "machine", path: root, environment: "env_someoneelse0000" }, "notes.txt", { environment: "env_mine000000000000" });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.refused, "not-reachable-from-this-environment");
  // The same ask with the owner's own environment passes — ownership is the question, not refusal.
  assert.equal(authorizeMachinePath({ kind: "machine", path: root, environment: "env_mine000000000000" }, "notes.txt", { environment: "env_mine000000000000" }).ok, true);
});

test("authorizeResolvedPath: the store-writer's door — same spine on a joined path", () => {
  assert.equal(authorizeResolvedPath(root, path.join(root, "app.html")).ok, true);
  assert.equal(authorizeResolvedPath(root, path.join(outside, "app.html")).refused, "outside-root", "a hand-rolled join cannot escape the realpath pass");
  assert.equal(authorizeResolvedPath(root, path.join(root, ".hidden.html")).refused, "dotfile-refused", "a dotfile save is refused, not silently written");
  assert.equal(authorizeResolvedPath(root, path.join(root, "sub", ".env")).refused, "dotfile-refused");
  assert.equal(authorizeResolvedPath(root, path.join(root, ".audit", "x.jsonl")).refused, "protected-audit");
});

test("dotfileSegmentInside: names the offending segment for the refusal's why", () => {
  assert.equal(dotfileSegmentInside(root, path.join(root, "sub", ".env")), ".env");
  assert.equal(dotfileSegmentInside(root, path.join(root, "sub", "fine.ts")), null);
});
