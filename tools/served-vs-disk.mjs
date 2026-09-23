// tools/served-vs-disk.mjs — IS THE FRONT ACTUALLY SERVING THIS TREE'S FILE?
//
// The pre-push gate asks this of every module the page loads. The FIRST version of that check took the
// single longest line of the disk copy as a marker and asked whether the served copy contained it —
// so when the longest line was a long comment shared by two revisions, **two different files passed as
// current** (measured 2026-09-23: a branch whose public/fused.js differed from the served front's copy
// cleared the gate with `[gate] clear`). A check whose marker is content both versions share cannot fail
// on the case it exists for (voicebox-beads-590).
//
// WHAT IS TRUE OF THE TRANSFORM, measured rather than assumed (served front, 2026-09-23):
//   fused.js        1734 non-empty lines, 0 missing
//   audio-client.js  594 non-empty lines, 1 missing — an import specifier Vite rewrites
//   live-voice.js    143 non-empty lines, 0 missing
// So EVERY non-empty line can be required, with one narrow, documented exception class: the lines the
// transform rewrites BY DEFINITION (module specifiers, asset URLs). No thresholds, no sampling, no
// "substantial lines only" — a one-token change on a short line is a drift and is now caught.
//
// STYLESHEETS ARE THE ONE HONEST EXCEPTION, and it is compared rather than skipped: lines do not survive
// (75 of 325 absent on the real file), so the DECLARATION SET is compared with whitespace collapsed and
// asset URLs excluded — measured 311/311 present through the transform — plus the design tokens
// verbatim (9/9). The limits are in the failure message rather than in a comment nobody reads.

// THE SERVER'S OWN TRANSFORM, IMPORTED RATHER THAN IMITATED. server.mjs's serveSource() serves a `.ts`
// module as `stripTypeScriptTypes(readFileSync(file, "utf8"), { mode: "strip" })` — so the check can
// compute what the front WILL serve for a given disk file and compare that, exactly, instead of trying
// to re-derive a normal form. A second implementation would disagree with the first and produce false
// reds; the first implementation cannot disagree with itself.
import { stripTypeScriptTypes } from "node:module";

/** Lines the dev transform rewrites by definition. Each is a *shape*, not a list of known strings. */
const REWRITTEN_BY_TRANSFORM = [
  /^\s*(?:import|export)\b[^\n]*\bfrom\s*["'][^"']+["']/, // module specifiers -> resolved paths, ?t= stamps
  /^\s*import\s*["'][^"']+["'];?\s*$/, // side-effect imports
  // A DYNAMIC import() is rewritten to an /@fs/ absolute path even when it carries
  // @vite-ignore — measured 2026-09-23, when the task-card import made this check
  // refuse every lane's push for a line that was present in both copies. The
  // specifier is what changes, so the specifier is what is excluded.
  /(?<![\w$])import\s*\(\s*(?:\/\*[\s\S]*?\*\/\s*)?["'][^"']+["']/, // dynamic import() specifiers
  /["'`][^"'`]*\.(?:css|png|jpe?g|gif|svg|webp|woff2?|ttf)["'`]/, // asset URLs -> hashed/re-written
];

const isRewritten = (line) => REWRITTEN_BY_TRANSFORM.some((re) => re.test(line));

/**
 * Why the served copy of `ref` is NOT this tree's file, or null when it is.
 *
 * `kind` is "stylesheet" for refs Vite reflows (the caller knows the extension); everything else is
 * compared line for line.
 */
export function driftBetween(diskText, servedText, { ref = "", kind = "module" } = {}) {
  // kind: "module" (served verbatim — every line compared), "compiled" (a `.ts` the server compiles —
  // comments and strings compared), "stylesheet" (reflowed — declarations and tokens compared).
  if (kind === "stylesheet") {
    // STYLESHEETS ARE REFLOWED, so neither lines nor a marker survive: measured on style.css, 75 of 325
    // disk lines are absent from the served copy even after normalising whitespace, and the served form is
    // minified. What DOES survive — also measured, on the real file — is the DECLARATION SET: 311
    // declarations on both sides, all present, once whitespace is collapsed and asset URLs are excluded
    // (the same exception class the module rule uses: the transform rewrites them by definition). The
    // design tokens are compared verbatim on top of that, because those are what this project calls a
    // token and they need no normalisation (measured 9/9 through the transform).
    const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, " ");
    const normaliseValue = (v) => v.replace(/url\([^)]*\)/g, "url(*)").replace(/\s*,\s*/g, ",").replace(/\s+/g, " ").trim();
    // The terminator is `;` OR `}`: a minifier drops the last semicolon in a block, and requiring `;`
    // made every final declaration look missing (found by this file's own test, not by reading).
    const declarations = (t) => [...strip(t).matchAll(/([-a-z]+)\s*:\s*([^;{}]*)(?=;|\})/g)]
      // `src:` carries the font URL — an asset URL the transform rewrites, excluded for the same reason
      // the module rule excludes asset URLs, and `--token:` declarations are compared verbatim below.
      .filter(([, prop]) => prop !== "src" && !prop.startsWith("--"))
      .map(([, prop, value]) => `${prop}:${normaliseValue(value)}`);
    const servedDeclarations = new Set(declarations(servedText));
    const missingDeclarations = [...new Set(declarations(diskText))].filter((d) => !servedDeclarations.has(d));
    if (missingDeclarations.length > 0) {
      return `${ref}: ${missingDeclarations.length} declaration(s) differ between this tree's stylesheet and what the front serves — e.g. "${missingDeclarations[0].slice(0, 60)}"`;
    }
    const tokens = (t) => [...strip(t).matchAll(/(--[-a-z0-9]+)\s*:/g)].map((m) => m[1]);
    const servedTokens = new Set(tokens(servedText));
    const missingTokens = tokens(diskText).filter((t) => !servedTokens.has(t));
    if (missingTokens.length > 0) {
      return `${ref}: ${missingTokens.length} design token(s) in this tree's stylesheet are not in what the front serves — e.g. ${missingTokens[0]}`;
    }
    return null;
  }
  if (kind === "compiled") {
    // EXACT, using the server's own call. Measured on this tree (2026-09-23): strip-then-compare is
    // byte-identical for browser/ui/ui.ts, browser/acts.ts, core/paths.ts and core/root.ts — every
    // compiled module the page loads — so a CODE-ONLY edit (a constant, a bound, a renamed local) is
    // drift like any other, and the comments-and-strings rule below is the FALLBACK for a runtime whose
    // stripper is unavailable rather than the primary rule.
    let expected = null;
    try { expected = stripTypeScriptTypes(diskText, { mode: "strip" }); } catch { expected = null; }
    if (expected !== null) {
      if (expected === servedText) return null;
      const want = expected.split("\n");
      const got = servedText.split("\n");
      const at = want.findIndex((line, i) => line !== got[i]);
      const where = at === -1
        ? `the served copy has ${Math.abs(got.length - want.length)} line(s) this tree does not compile to`
        : `first difference at line ${at + 1}: this tree compiles to "${(want[at] ?? "").trim().slice(0, 70)}" and the front serves "${(got[at] ?? "").trim().slice(0, 70)}"`;
      return `${ref}: the front is not serving what this tree compiles to — ${where} (compared with the server's own transform)`;
    }

    return fallbackCompiledDrift(diskText, servedText, { ref });
  }
  const lines = diskText.split("\n").map((l) => l.trimEnd()).filter((l) => l.trim() !== "");
  const missing = lines.filter((l) => !isRewritten(l) && !servedText.includes(l));
  if (missing.length === 0) return null;
  const first = missing[0].trim().slice(0, 90);
  return `${ref}: ${missing.length} line(s) of this tree's copy are not in what the front serves — first: "${first}"`;
}

/**
 * THE FALLBACK, exported so it is pinned by a test rather than only by a branch in the code: what can be
 * compared about a compiled module when the runtime cannot strip types — its comments and its strings.
 */
export function fallbackCompiledDrift(diskText, servedText, { ref = "" } = {}) {
  // FALLBACK ONLY — reached when the runtime cannot strip types (an older Node), never as a choice.
  // Measured on browser/ui/ui.ts: 540 of 582 disk lines appear in the served copy, the 42 that do not
  // being exactly the type-annotated ones; comments (100/100) and string literals of 8+ characters
  // (142/142) survive. A code-only edit is invisible here, which is why the exact comparison above is
  // the rule and this is what remains when it cannot run.
  const comments = diskText.split("\n").map((l) => l.trimEnd()).filter((l) => /^\s*(\/\/|\*|\/\*)/.test(l));
  const missingComments = comments.filter((l) => !servedText.includes(l));
  if (missingComments.length > 0) {
    return `${ref}: ${missingComments.length} comment line(s) of this tree's copy are not in what the front serves — first: "${missingComments[0].trim().slice(0, 80)}"`;
  }
  const literals = (t) => [...t.matchAll(/"([^"\\\n]{8,})"|'([^'\\\n]{8,})'/g)].map((m) => m[1] ?? m[2]);
  const servedLiterals = new Set(literals(servedText));
  const missingLiterals = [...new Set(literals(diskText))].filter((l) => !servedLiterals.has(l));
  if (missingLiterals.length > 0) {
    return `${ref}: ${missingLiterals.length} string(s) of this tree's copy are not in what the front serves — first: "${missingLiterals[0].slice(0, 80)}" (a compiled module is compared by its strings and comments: a change that touches neither is not visible here)`;
  }
  return null;
}

/** Does a line count as one the transform is allowed to rewrite? Exported for the test and for readers. */
export const rewrittenByTransform = (line) => isRewritten(line);
