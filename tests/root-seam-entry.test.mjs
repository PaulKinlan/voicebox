// tests/root-seam-entry.test.mjs — the root seam's own entry points, driven directly.
//
// WHY (voicebox-beads-8why, from a test-gap station run): resolveInRoot is where an untrusted
// candidate path is accepted or refused for every kind of root, and virtualRootOf is the
// handle-to-virtual-path mapping the whole containment scheme depends on — but both were only
// asserted transitively (through server routes and tier tables). descriptorOf, describeRoot,
// noRootDeclared() and rootVanished() had no direct drives at all. This file drives them the way
// tests/containment-paths.test.mjs drives the lexical layer: refusals asserted by RULE with the
// mechanism's own words, and every refusal set paired with a positive control.
//
// Deliberately NOT repeated here: ownerOf / reachableFrom / reachableFromEnvironment are owned by
// tests/reachability-actor.test.mjs — one behavioural surface, one driving file.
//
//   node --test tests/root-seam-entry.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import {
  ROOT_NOT_DECLARED,
  ROOT_NOT_REACHABLE,
  ROOT_NOT_REACHABLE_FROM_ENVIRONMENT,
  ROOT_VANISHED,
  ROOT_FACTS,
  descriptorOf,
  describeRoot,
  noRootDeclared,
  resolveInRoot,
  rootVanished,
  virtualRootOf,
} from "../core/root.ts";

const OPFS = { kind: "opfs", path: "v1/projects/atlas" };
const MACHINE = { kind: "machine", path: "/tmp/some-root" };
const HANDLE = { kind: "handle", id: "abc123" };

// ── resolveInRoot: THE containment entry, one answer for all three kinds ──────

test("resolveInRoot: an ordinary nested candidate is ALLOWED through every kind, with the same shape", () => {
  for (const [label, root, virtualRoot] of [["opfs", OPFS, "v1/projects/atlas"], ["machine", MACHINE, "/tmp/some-root"], ["handle", HANDLE, "picked:abc123"]]) {
    const r = resolveInRoot(root, "sub/notes.txt");
    assert.equal(r.ok, true, `${label}: an inside path resolves`);
    assert.equal(r.path, `${virtualRoot}/sub/notes.txt`, `${label}: against the kind's own virtual root`);
  }
});

test("resolveInRoot: a '..' escape is refused BY RULE for every kind — the entry delegates to the one lexical owner", () => {
  for (const [label, root] of [["opfs", OPFS], ["machine", MACHINE], ["handle", HANDLE]]) {
    const r = resolveInRoot(root, "../evil.sh");
    assert.equal(r.ok, false, `${label}: an escape must not pass`);
    if (!r.ok) {
      assert.equal(r.rule, "outside-root", `${label}: the refusal names its rule`);
      assert.match(r.why, /resolves outside the root/i, `${label}: and the mechanism's own words`);
    }
  }
});

test("resolveInRoot: a non-string candidate is refused AS NAMING NOTHING, not coerced into a path", () => {
  // The entry's own guard: a non-string candidate is handed to the resolver as "" and refused as
  // naming nothing — a number, null, or a toString object must never become a path by coercion
  // (String(42) → "42", {toString} → "notes.txt" would each resolve ok on a coercion regression).
  for (const bad of [42, null, undefined, { toString: () => "notes.txt" }]) {
    const r = resolveInRoot(OPFS, bad);
    assert.equal(r.ok, false, `${JSON.stringify(bad)} must not resolve`);
    if (!r.ok) {
      assert.equal(r.rule, "outside-root");
      assert.match(r.why, /names no file inside the root|empty candidate/i, `refused as naming nothing, not for some other reason: ${r.why}`);
    }
  }
});

test("resolveInRoot: an ABSOLUTE candidate is refused by name — it does not name something INSIDE the root", () => {
  for (const [label, root] of [["opfs", OPFS], ["machine", MACHINE], ["handle", HANDLE]]) {
    const r = resolveInRoot(root, "/etc/passwd");
    assert.equal(r.ok, false, `${label}: an absolute path must not resolve against a root`);
    if (!r.ok) {
      assert.equal(r.rule, "outside-root");
      assert.match(r.why, /absolute/i, `the refusal names absoluteness, not a generic escape: ${r.why}`);
    }
  }
});

test("resolveInRoot: '..' as a NAME is refused too (basename('..') is '..'), and the root itself is not a file name", () => {
  assert.equal(resolveInRoot(MACHINE, "..").ok, false);
  assert.equal(resolveInRoot(MACHINE, ".").ok, false);
  assert.equal(resolveInRoot(MACHINE, "").ok, false, "empty names no file inside the root — the routes special-case the root, the entry does not");
});

// ── virtualRootOf: the string containment measures against ────────────────────

test("virtualRootOf: a handle has no path, so it is named by its id behind the virtual prefix", () => {
  assert.equal(virtualRootOf({ kind: "handle", id: "xyz" }), "picked:xyz");
  assert.equal(virtualRootOf(OPFS), "v1/projects/atlas", "an opfs root IS its path");
  assert.equal(virtualRootOf(MACHINE), "/tmp/some-root", "a machine root IS its path");
  // A dot-prefixed root KEEPS its dot, segments and all — the virtual root is the containment
  // boundary verbatim, and a hand-rolled strip that tidies '.secret/project' into
  // 'secret/project' would move the boundary itself (mutation 2 of the third-party review).
  assert.equal(virtualRootOf({ kind: "opfs", path: ".secret/project" }), ".secret/project");
  assert.equal(virtualRootOf({ kind: "machine", path: "/tmp/.roots/one" }), "/tmp/.roots/one");
});

test("virtualRootOf + resolveInRoot compose: a handle's files are addressed through the virtual root only", () => {
  const root = { kind: "handle", id: "h1" };
  const virtual = virtualRootOf(root);
  const inside = resolveInRoot(root, "notes.txt");
  assert.equal(inside.ok, true);
  if (inside.ok) assert.equal(inside.path, `${virtual}/notes.txt`, "the resolved path carries the virtual root, never a filesystem guess");
});

// ── ROOT_FACTS: the table root-kind handling is derived from ─────────────────

test("ROOT_FACTS: containment is lexical for the page's kinds and realpath for the machine's", () => {
  assert.equal(ROOT_FACTS.opfs.containment, "prefix");
  assert.equal(ROOT_FACTS.handle.containment, "prefix");
  assert.equal(ROOT_FACTS.machine.containment, "realpath", "the machine's realpath pass is a declared fact, not an implementation detail");
});

test("ROOT_FACTS: exactly one peer may act per kind — page kinds are page-only, machine is machine-only", () => {
  assert.deepEqual(ROOT_FACTS.opfs.reachableFrom, ["page"]);
  assert.deepEqual(ROOT_FACTS.handle.reachableFrom, ["page"]);
  assert.deepEqual(ROOT_FACTS.machine.reachableFrom, ["machine"]);
});

// ── the two named absences (and their actor-named sibling), by exact code ─────

test("noRootDeclared(): the refusal names the rule, the side whose job it is, and nothing else claims it", () => {
  const r = noRootDeclared();
  assert.equal(r.ok, false);
  assert.equal(r.refused, ROOT_NOT_DECLARED);
  assert.equal(ROOT_NOT_DECLARED, "root-not-declared", "callers match on this string; changing it is a conscious break");
  assert.match(r.why, /environment declares one/, "the why names the remedy, not just the absence");
});

test("rootVanished(): names the rule, the remedy, and carries an optional detail", () => {
  const bare = rootVanished("/tmp/gone");
  assert.equal(bare.ok, false);
  assert.equal(bare.refused, ROOT_VANISHED);
  assert.equal(ROOT_VANISHED, "root-vanished");
  assert.match(bare.why, /declare it again/, "the why says what to do next — the anti-hang contract's whole point");
  assert.equal("detail" in bare, false, "no detail unless one is given");
  const detailed = rootVanished("/tmp/gone", "ENOENT after unlink");
  assert.equal(detailed.detail, "ENOENT after unlink", "the detail travels, for a log that names the cause");
});

test("the four codes are distinct, exactly-pinned strings — callers match on them, so changing one is a conscious break", () => {
  assert.equal(ROOT_NOT_DECLARED, "root-not-declared");
  assert.equal(ROOT_NOT_REACHABLE, "root-not-reachable-from-here");
  assert.equal(ROOT_NOT_REACHABLE_FROM_ENVIRONMENT, "not-reachable-from-this-environment", "this literal is asserted nowhere else in the tree");
  assert.equal(ROOT_VANISHED, "root-vanished");
  const codes = [ROOT_NOT_DECLARED, ROOT_NOT_REACHABLE, ROOT_NOT_REACHABLE_FROM_ENVIRONMENT, ROOT_VANISHED];
  assert.equal(new Set(codes).size, 4, "four names, four meanings — the vocabulary never collapses");
});

// ── descriptorOf: the record a project carries, to the descriptor acts use ────

test("descriptorOf: opfs and machine records pass their path through; a handle keeps its id and takes its label from the LOCATION", () => {
  const base = { id: "atlas@local", name: "atlas", placement: "local", capabilities: [], undoKind: "written-file-list", createdAt: "2026-01-01T00:00:00Z", lastUsed: "2026-01-01T00:00:00Z", durability: { kind: "opfs", persisted: true, checkedAt: "2026-01-01T00:00:00Z" } };
  // The pathed kinds: location.path DELIBERATELY differs from root.path, so a regression that builds
  // the descriptor from the location fails here (review finding, 8why).
  const opfs = descriptorOf({ ...base, location: { kind: "opfs", path: "v1/projects/other" }, root: { kind: "opfs", path: "v1/projects/atlas" } });
  assert.deepEqual(opfs, { kind: "opfs", path: "v1/projects/atlas" }, "the boundary is the ROOT's path, not the location's");
  const machine = descriptorOf({ ...base, location: { kind: "machine", path: "/tmp/elsewhere" }, root: { kind: "machine", path: "/tmp/root" } });
  assert.deepEqual(machine, { kind: "machine", path: "/tmp/root" });
  // A handle: the label travels from the LOCATION, the ID from the ROOT — the fixture
  // DELIBERATELY gives them different ids, so a regression that answers the descriptor's id
  // from the location fails here instead of passing vacuously (mutation 3 of the review).
  const handle = descriptorOf({ ...base, location: { kind: "handle", id: "loc-1", label: "My Atlas" }, root: { kind: "handle", id: "root-9" } });
  assert.deepEqual(handle, { kind: "handle", id: "root-9", label: "My Atlas" }, "id from the ROOT (the containment boundary), label from the LOCATION");
  // An EMPTY label is the record-shaped way to have no label (a handle location always carries
  // the field), and the descriptor drops it rather than carrying a lie (review finding, 8why).
  const emptyLabel = descriptorOf({ ...base, location: { kind: "handle", id: "loc-2", label: "" }, root: { kind: "handle", id: "root-3" } });
  assert.deepEqual(emptyLabel, { kind: "handle", id: "root-3" }, "an empty label is dropped — undefined is not carried");
});

// ── describeRoot: the one-line answer for a panel ─────────────────────────────

test("describeRoot: names the kind, where it is, and who acts — every kind answers all three", () => {
  for (const [label, root] of [["opfs", OPFS], ["machine", MACHINE], ["handle", HANDLE]]) {
    const facts = ROOT_FACTS[root.kind];
    const line = describeRoot(root);
    assert.equal(typeof line, "string");
    assert.match(line, new RegExp(`^${label} — `), `${label}: the line opens with the kind`);
    assert.ok(line.includes(facts.where), `${label}: carries the table's own 'where' sentence`);
    // The VALUES, not just the clauses (mutation 4 of the review: presence-only assertions let a
    // wrong visibility fact or a wrong acting peer through while green).
    assert.ok(line.includes(`Visible to: ${facts.whoCanSee}`), `${label}: the visibility VALUE is the table's own`);
    assert.ok(line.includes(`Acts come from the ${facts.reachableFrom.join(" and ")}`), `${label}: the acting peer is the table's own`);
  }
});
