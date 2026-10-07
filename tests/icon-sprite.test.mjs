// tests/icon-sprite.test.mjs — every icon reference must resolve to a defined symbol.
//
// voicebox-beads-1540: #i-spark was born dangling in e2672ac (2026-10-02) and survived four days
// of green gates because nothing asserted that sprite references resolve — the reader bubble wore
// an empty svg until voicebox-beads-um60. This is the guard for the class: static, unit-lane, no
// browser — the sprite and its references are all in shipped text.
//
// Two surfaces can name an icon:
//   1. public/index.html's own <use href="#i-…">;
//   2. JS that writes an href at runtime: fused.js's theme/folder/expand writers and the
//      icon("i-…") / icon(pip.document, "i-…") builder in fused.js and pip-mic.mjs.
// Both must name a <symbol id> the sprite defines, and the sprite must not define an id twice.
//
// Two traps, named so the next edit doesn't fall into them (deepseek-flash review, 2df426f):
//   - the scan reads RAW TEXT, so prose counts: write "#i-whatever" in a comment here or in
//     index.html and the guard will demand a symbol for it. Mention icons unquoted, like this.
//   - the surface list below is hardcoded and complete TODAY (repo-wide grep). The invariant:
//     if you add a file that names an icon, add it to the file list in the test below.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PUBLIC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "public");

/** The defined symbol ids and the referenced icon ids in a text. Exported nowhere — checked below. */
function spriteDefinitions(html) {
  return [...html.matchAll(/<symbol id="([^"]+)"/g)].map((m) => m[1]);
}
function iconReferences(text) {
  // <use href="#i-…"> in markup and "#i-…" string literals in JS writers — one shape covers both.
  return [...text.matchAll(/"#(i-[a-z0-9-]+)"/g)].map((m) => m[1]);
}
function builderReferences(text) {
  // The icon(…) builder takes the BARE id: icon("i-folder") / icon(pip.document, "i-mic").
  // Missing this shape is what the reviewer's mutation probe caught (icon("i-gone") stayed green).
  return [...text.matchAll(/\bicon\(\s*(?:[a-zA-Z_$][\w$.]*\s*,\s*)?"(i-[a-z0-9-]+)"/g)].map((m) => m[1]);
}
function dangling(definitions, references) {
  const defined = new Set(definitions);
  return [...new Set(references)].filter((id) => !defined.has(id));
}
function duplicates(definitions) {
  const seen = new Set();
  return [...new Set(definitions.filter((id) => (seen.has(id) ? true : (seen.add(id), false))))];
}

test("every icon reference in the room and its JS writers resolves to a defined symbol", () => {
  const html = readFileSync(path.join(PUBLIC, "index.html"), "utf8");
  const fusedJs = readFileSync(path.join(PUBLIC, "fused.js"), "utf8");
  const pipMic = readFileSync(path.join(PUBLIC, "pip-mic.mjs"), "utf8");
  const definitions = spriteDefinitions(html);
  assert(definitions.length > 0, "the sprite itself was not found in index.html — the extraction broke, not the page");
  assert.deepEqual(duplicates(definitions), [], "the sprite defines an id twice");

  const references = [
    ...iconReferences(html),
    ...iconReferences(fusedJs),
    ...iconReferences(pipMic),
    ...builderReferences(fusedJs),
    ...builderReferences(pipMic),
  ];
  assert(references.length > 0, "no icon references found at all — the extraction broke, not the page");
  // Completeness anchors: a narrowed regex must not quietly shrink coverage. Pin the BUILDER SWEEP
  // itself, not just the union — every anchor id is also reachable from markup, so union-level
  // assertions stay green when the builder sweep is lost or narrowed (measured by the reviewer:
  // deleting both builderReferences() calls passed 2/2).
  const builderRefs = [...builderReferences(fusedJs), ...builderReferences(pipMic)];
  assert.deepEqual(
    [...new Set(builderRefs)].sort(),
    ["i-close", "i-folder", "i-mic", "i-trash"],
    "the icon() builder sweep lost call sites",
  );
  for (const known of ["i-close", "i-mic", "i-folder", "i-trash"]) {
    assert(references.includes(known), `the extraction no longer sees ${known} — coverage shrank silently`);
  }
  assert.deepEqual(dangling(definitions, references), [], "an icon is referenced but never defined");
});

// The guard must refuse: a dangling reference and a duplicated id are each driven into a scratch
// sprite and the checker has to name both, or the test above proves nothing.
test("the checker refuses a dangling reference and a duplicated id", () => {
  const defined = spriteDefinitions('<symbol id="i-a"/><symbol id="i-a"/><symbol id="i-b"/>');
  assert.deepEqual(duplicates(defined), ["i-a"]);
  assert.deepEqual(dangling(defined, ["i-a", "i-gone"]), ["i-gone"]);
  assert.deepEqual(dangling(defined, ["i-a", "i-b"]), [], "the checker refuses a reference that resolves — it over-refuses");
});
