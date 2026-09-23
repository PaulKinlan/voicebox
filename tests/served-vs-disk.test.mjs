// tests/served-vs-disk.test.mjs — can the currency check FAIL on the case it was built for?
//
// It could not, before this: it took the single longest line of the disk copy as a marker and asked
// whether the served copy contained it, so two different revisions passed as current whenever their
// longest line was a shared comment. Measured 2026-09-23 — a branch whose public/fused.js differed from
// the served front's copy cleared the pre-push gate with `[gate] clear` (voicebox-beads-590).
//
// The rule is now every non-empty line, with ONE documented exception class: the lines Vite rewrites by
// definition (module specifiers and asset URLs — measured: 1734/1734, 594/595 and 143/143 non-empty lines
// survive for the three page modules, the single miss being an import specifier). These tests pin both
// halves: the drift that must be caught, and the transform's own rewrites that must not be reported.
//
//   node --test tests/served-vs-disk.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { stripTypeScriptTypes } from "node:module";
import { driftBetween, rewrittenByTransform, fallbackCompiledDrift } from "../tools/served-vs-disk.mjs";

test("the drift the old marker could not see: a SHORT line changed, the longest line untouched", () => {
  const disk = ["// a very long shared comment that both revisions contain, so it makes a useless marker", "const ready = true;", "export const x = 1;"].join("\n");
  const served = ["// a very long shared comment that both revisions contain, so it makes a useless marker", "const ready = false;", "export const x = 1;"].join("\n");
  // the old rule: the longest line is the comment and it is present in both -> "current"
  const longest = disk.split("\n").reduce((a, b) => (b.length > a.length ? b : a), "");
  assert.ok(served.includes(longest), "precondition: the old marker IS shared by both revisions");
  const drift = driftBetween(disk, served, { ref: "fused.js" });
  assert.ok(drift, "a changed line must be reported as drift");
  assert.match(drift, /fused\.js/, "the reason names the module");
  assert.match(drift, /const ready = true;/, "the reason names the line that drifted");
});

test("identical copies are current — no drift on the happy path", () => {
  const text = ["const a = 1;", "// comment", "export function f() { return a; }"].join("\n");
  assert.equal(driftBetween(text, text, { ref: "fused.js" }), null);
});

test("the transform's own rewrites are NOT drift: module specifiers and asset URLs", () => {
  const disk = [
    'import { floatToPcm16 } from "./pcm.js";',
    'import "./styles.css";',
    'const art = new URL("./icon.svg", import.meta.url);',
    "const ready = true;",
  ].join("\n");
  // what Vite serves: specifiers resolved (with its timestamp stamp), assets rewritten
  const served = [
    'import { floatToPcm16 } from "/pcm.js?t=1758625644637";',
    'import "/styles.css";',
    'const art = new URL("/icon.svg", import.meta.url);',
    "const ready = true;",
  ].join("\n");
  assert.equal(driftBetween(disk, served, { ref: "audio-client.js" }), null,
    "a rewritten import or asset URL must not be reported as a stale file");
  assert.ok(rewrittenByTransform('import { floatToPcm16 } from "./pcm.js";'));
  assert.ok(rewrittenByTransform('const art = new URL("./icon.svg", import.meta.url);'));
  assert.ok(!rewrittenByTransform("const ready = true;"), "an ordinary line is not exempt");
});

test("a REMOVED line is drift; an added one is not — the asymmetry is real and is stated", () => {
  const disk = "const a = 1;\nconst b = 2;\nconst c = 3;";
  assert.ok(driftBetween(disk, "const a = 1;\nconst c = 3;", { ref: "fused.js" }), "a line of this tree missing from the front is drift");
  // The served copy is legitimately a SUPERSET: Vite wraps and injects its own code (measured: fused.js
  // serves 461 KB against an 86 KB source). So "the front has a line this tree does not" cannot be drift,
  // and the check does not pretend otherwise — it asks the one question that has an answer: is this
  // tree's content present?
  assert.equal(driftBetween("const a = 1;", "const a = 1;\n/* vite injected */ const b = 2;", { ref: "fused.js" }), null,
    "Vite's own injected lines are not drift");
});

test("stylesheets: the DECLARATION SET is compared (tokens verbatim, urls excluded, whitespace collapsed)", () => {
  const disk = ":root { --ink: #101014; --paper: #fff; }\n.some-long-selector { background: url(./x.png); color: red; }";
  const served = ":root{--ink:#101014;--paper:#fff}.some-long-selector{background:url(/x.png);color:red}";
  assert.equal(driftBetween(disk, served, { ref: "style.css", kind: "stylesheet" }), null,
    "a reflowed stylesheet with the same declarations is current");

  const changed = driftBetween(":root { --ink: #101014; color: red; }", ":root{--ink:#101014;color:blue}", { ref: "style.css", kind: "stylesheet" });
  assert.ok(changed, "a changed declaration value must be reported even though the stylesheet is minified");
  assert.match(changed, /color:red/, "the reason names the declaration that differs");

  const missingToken = driftBetween(":root { --ink: #101014; --new-token: 3px; }", ":root{--ink:#101014}", { ref: "style.css", kind: "stylesheet" });
  assert.ok(missingToken, "a design token this tree defines but the front does not serve must be reported");
  assert.match(missingToken, /--new-token/, "the reason names the token");

  // the same exception class as modules: the transform rewrites asset URLs, so `src:` is excluded
  assert.equal(driftBetween("@font-face { src: url(./inter.woff2) format(\"woff2\"); }", "@font-face{src:url(/inter.woff2)format(\"woff2\")}", { ref: "style.css", kind: "stylesheet" }), null,
    "a rewritten font URL is the transform's work, not drift");
});
test("a COMPILED module is compared against what this tree COMPILES TO — a code-only edit is drift", () => {
  // The server serves a `.ts` module as stripTypeScriptTypes(source, { mode: "strip" }), so the check
  // computes that same output and compares it — no second implementation, no normal form to disagree about.
  const disk = [
    "// acting on the declared root, one call at a time",
    "type Reply = { id: number; ok: boolean } & Record<string, any>;",
    "const LIMIT = 2000;",
    "export function bound() { return LIMIT; }",
  ].join("\n");
  const compiled = stripTypeScriptTypes(disk, { mode: "strip" });
  assert.equal(driftBetween(disk, compiled, { ref: "acts.ts", kind: "compiled" }), null,
    "a module the front is serving exactly as this tree compiles it is current");

  // vb-resolver's repro, which the comments-and-strings rule could not see: a constant changed, no string
  // and no comment touched.
  const codeEdit = compiled.replace("const LIMIT = 2000;", "const LIMIT = 2500;");
  const drift = driftBetween(disk, codeEdit, { ref: "acts.ts", kind: "compiled" });
  assert.ok(drift, "a code-only edit must be drift once the comparison is exact");
  assert.match(drift, /LIMIT = 2000/, "the reason quotes what this tree compiles to");
  assert.match(drift, /LIMIT = 2500/, "and what the front is serving");

  // a comment or user-visible string change is still drift, and still named
  const stringEdit = compiled.replace("one call at a time", "one turn at a time");
  const stringDrift = driftBetween(disk, stringEdit, { ref: "acts.ts", kind: "compiled" });
  assert.ok(stringDrift, "a changed comment must remain drift");
});

test("the comments-and-strings rule is the FALLBACK for a runtime that cannot strip types", () => {
  // Not a choice: `stripTypeScriptTypes` is what server.mjs serves .ts with, and where it is unavailable
  // the comparison degrades to what survives compilation (comments and strings) rather than reporting
  // every compiled module as stale. The fallback is exercised directly so its behaviour is pinned even
  // though the primary path is what normally runs.
  const disk = [
    "// the host answers what the page asks",
    "type Reply = { id: number; ok: boolean };",
    'const label = "this machine: omarchy";',
  ].join("\n");
  // what the fallback sees when handed a copy with the type line gone (the compiled shape)
  const served = ["// the host answers what the page asks", 'const label = "this machine: omarchy";'].join("\n");
  const stripped = disk.split("\n").filter((l) => !l.startsWith("type ")).join("\n");
  assert.equal(stripped, served, "the fixture models a compiled module");
  const hits = fallbackCompiledDrift(disk, served, { ref: "ui.ts" });
  assert.equal(hits, null, "the fallback passes a compiled module whose comments and strings survived");
  const changed = fallbackCompiledDrift(disk, served.replace("this machine: omarchy", "this machine: elsewhere"), { ref: "ui.ts" });
  assert.ok(changed, "and it still catches a changed user-visible string");
  assert.match(changed, /not visible here/i, "with its limit stated in the failure");
});
