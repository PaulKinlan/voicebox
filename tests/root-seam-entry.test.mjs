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

test("resolveInRoot: the two shapes that are NOT strings are refused, not coerced", () => {
  // The entry's own guard: a non-string candidate is handed to the resolver as "" and refused as
  // naming nothing — a number or null must never become a path by coercion.
  for (const bad of [42, null, undefined, { toString: () => "notes.txt" }]) {
    const r = resolveInRoot(OPFS, bad);
    assert.equal(r.ok, false, `${JSON.stringify(bad)} must not resolve`);
    if (!r.ok) assert.equal(r.rule, "outside-root");
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
});

test("virtualRootOf + resolveInRoot compose: a handle's files are addressed through the virtual root only", () => {
  const root = { kind: "handle", id: "h1" };
  const virtual = virtualRootOf(root);
  const inside = resolveInRoot(root, "notes.txt");
  assert.equal(inside.ok, true);
  if (inside.ok) assert.match(inside.path, new RegExp(`^${virtual}/`), "the resolved path carries the virtual root, never a filesystem guess");
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

test("the three reachability codes are distinct strings — the vocabulary never collapses", () => {
  const codes = [ROOT_NOT_DECLARED, ROOT_NOT_REACHABLE, ROOT_NOT_REACHABLE_FROM_ENVIRONMENT, ROOT_VANISHED];
  assert.equal(new Set(codes).size, 4, "four names, four meanings");
});

// ── descriptorOf: the record a project carries, to the descriptor acts use ────

test("descriptorOf: opfs and machine records pass their path through; a handle keeps its id and takes its label from the LOCATION", () => {
  const base = { id: "atlas@local", name: "atlas", placement: "local", capabilities: [], undoKind: "written-file-list", createdAt: "2026-01-01T00:00:00Z", lastUsed: "2026-01-01T00:00:00Z", durability: { kind: "opfs", persisted: true, checkedAt: "2026-01-01T00:00:00Z" } };
  const opfs = descriptorOf({ ...base, location: { kind: "opfs", path: "v1/projects/atlas" }, root: { kind: "opfs", path: "v1/projects/atlas" } });
  assert.deepEqual(opfs, { kind: "opfs", path: "v1/projects/atlas" });
  const machine = descriptorOf({ ...base, location: { kind: "machine", path: "/tmp/r" }, root: { kind: "machine", path: "/tmp/r" } });
  assert.deepEqual(machine, { kind: "machine", path: "/tmp/r" });
  const handle = descriptorOf({ ...base, location: { kind: "handle", id: "h1", label: "My Atlas" }, root: { kind: "handle", id: "h1" } });
  assert.deepEqual(handle, { kind: "handle", id: "h1", label: "My Atlas" }, "the label the user gave the picked folder travels from the location");
  const handleNoLabel = descriptorOf({ ...base, location: { kind: "opfs", path: "v1/other" }, root: { kind: "handle", id: "h2" } });
  assert.deepEqual(handleNoLabel, { kind: "handle", id: "h2" }, "no handle location means no label — undefined is not carried");
});

// ── describeRoot: the one-line answer for a panel ─────────────────────────────

test("describeRoot: names the kind, where it is, and who acts — every kind answers all three", () => {
  for (const [label, root] of [["opfs", OPFS], ["machine", MACHINE], ["handle", HANDLE]]) {
    const line = describeRoot(root);
    assert.equal(typeof line, "string");
    assert.match(line, new RegExp(`^${label} — `), `${label}: the line opens with the kind`);
    assert.match(line, /Acts come from the /, `${label}: and closes with who acts`);
  }
});
