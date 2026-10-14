// tests/icon-sprite.test.mjs — every icon reference must resolve to a defined symbol.
//
// voicebox-beads-1540: #i-spark was born dangling in e2672ac (2026-10-02) and survived four days
// of green gates because nothing asserted that sprite references resolve — the reader bubble wore
// an empty svg until voicebox-beads-um60. This is the guard for the class: static, unit-lane, no
// browser — the sprite and its references are all in shipped text.
//
// Two surfaces can name an icon:
//   1. public/index.html's own <use href="#i-…">;
//   2. JS that writes an href at runtime: fused.js's folder/expand writers and the theme writer that now
//      lives in theme.mjs (voicebox-beads-ri9x moved it out of fused.js), plus the icon("i-…") /
//      icon(pip.document, "i-…") builder in fused.js and pip-mic.mjs.
// Both must name a <symbol id> the sprite defines, and the sprite must not define an id twice.
//
// Two traps, named so the next edit doesn't fall into them (deepseek-flash review, 2df426f):
//   - the scan reads RAW TEXT, so prose counts: write "#i-whatever" in a comment here or in
//     index.html and the guard will demand a symbol for it. Mention icons unquoted, like this.
//   - the surface list below is hardcoded and complete TODAY (repo-wide grep). The invariant:
//     if you add a file that names an icon, add it to the file list in the test below. The extracted
//     `public/components/*.mjs` modules are swept by GLOB for exactly that reason: voicebox-beads-uei2.7
//     moved the mini-app card's four literals into `public/components/mini-app-surface.mjs` and this
//     guard caught it (fused.js fell to 1 ref against a floor of 5), so the next slice must not be able
//     to repeat that by forgetting a line here.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
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
  const themeJs = readFileSync(path.join(PUBLIC, "theme.mjs"), "utf8");
  const pipMic = readFileSync(path.join(PUBLIC, "pip-mic.mjs"), "utf8");
  // Every extracted room component is swept by glob, so a slice that moves icon writers out of fused.js
  // keeps being checked without a hardcoded list to forget (voicebox-beads-uei2.7).
  const componentFiles = readdirSync(path.join(PUBLIC, "components"))
    .filter((f) => f.endsWith(".mjs"))
    .sort();
  const componentTexts = componentFiles.map((f) => [f, readFileSync(path.join(PUBLIC, "components", f), "utf8")]);
  const definitions = spriteDefinitions(html);
  assert(definitions.length > 0, "the sprite itself was not found in index.html — the extraction broke, not the page");
  assert.deepEqual(duplicates(definitions), [], "the sprite defines an id twice");

  const htmlRefs = iconReferences(html);
  const fusedRefs = iconReferences(fusedJs);
  const themeRefs = iconReferences(themeJs);
  const pipRefs = iconReferences(pipMic);
  const componentRefs = componentTexts.flatMap(([, text]) => iconReferences(text));
  // Floors pin each EXTRACTION surface itself (voicebox-beads-jvek): before them, the reviewer's
  // mutants — iconReferences body -> return [], and dropping the markup surface from the union —
  // both passed 2/2 because every assertion was satisfiable from the builder sweep alone.
  assert(
    htmlRefs.length >= 40 && new Set(htmlRefs).size >= 20,
    `the markup surface shrank: ${htmlRefs.length} literal refs, ${new Set(htmlRefs).size} distinct — the markup extraction broke or the page lost icons`,
  );
  assert(
    fusedRefs.length + componentRefs.length >= 5 && themeRefs.length >= 2 && pipRefs.length >= 2,
    `a JS literal surface shrank: fused.js ${fusedRefs.length} + components ${componentRefs.length} refs, theme.mjs ${themeRefs.length} refs, pip-mic.mjs ${pipRefs.length}`,
  );
  // The component surface has its own floor: the literals that moved must still exist where they moved
  // TO, or the floor above would be satisfiable after a slice silently dropped them.
  assert(
    componentRefs.length >= 4,
    `the extracted component literal surface shrank: ${componentRefs.length} refs in public/components/*.mjs`,
  );

  // The union must actually CARRY every extraction surface (dropping a surface from the union was
  // the reviewer's green mutant — on markup first, and again on the JS literal surfaces in the
  // jvek review): every extracted id, from every surface, is in the checked set.
  const builderRefs = [
    ...builderReferences(fusedJs),
    ...builderReferences(themeJs),
    ...builderReferences(pipMic),
    ...componentTexts.flatMap(([, text]) => builderReferences(text)),
  ];
  const references = [
    ...htmlRefs,
    ...fusedRefs,
    ...themeRefs,
    ...pipRefs,
    ...componentRefs,
    ...builderRefs,
  ];
  assert(references.length > 0, "no icon references found at all — the extraction broke, not the page");
  // The subset loop below is BLIND when a dropped surface's ids also appear in another surface (i-maximize
  // and i-minimize are written by index.html's markup too, so removing a surface from the union stayed
  // GREEN in a probe — voicebox-beads-uei2.7). Pin the arithmetic instead: the union must be exactly the
  // surfaces it claims to carry, so dropping or duplicating one fails whatever the ids are.
  assert.equal(
    references.length,
    htmlRefs.length + fusedRefs.length + themeRefs.length + pipRefs.length + componentRefs.length + builderRefs.length,
    "the union no longer equals the surfaces it claims to carry — a surface was dropped from it (or counted twice)",
  );
  for (const [surface, ids] of [["markup", htmlRefs], ["fused literals", fusedRefs], ["theme literals", themeRefs], ["pip literals", pipRefs], ["component literals", componentRefs], ["builder sweep", builderRefs]]) {
    assert(
      ids.every((id) => references.includes(id)),
      `the union no longer carries the ${surface} surface — those references are unchecked`,
    );
  }
  // Completeness anchors: a narrowed regex must not quietly shrink coverage. The builder sweep pins
  // both its call-site COUNT and its id SET (the set alone cannot see a lost site whose id survives
  // elsewhere; the count alone cannot see a swap).
  assert.equal(builderRefs.length, 4, `the icon() builder sweep lost or gained call sites silently: ${builderRefs.length}`);
  assert.deepEqual(
    [...new Set(builderRefs)].sort(),
    ["i-close", "i-folder", "i-mic", "i-trash"],
    "the icon() builder sweep lost call sites",
  );
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
