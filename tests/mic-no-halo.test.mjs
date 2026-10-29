// tests/mic-no-halo.test.mjs — the microphone paints no ring around itself (voicebox-beads-a68n).
//
// THE DEFECT THIS PINS. voicebox-beads-yf33 asked for the rings around the microphone to go; main hid the
// arc markup (`display: none`, public/styles/stage.css) and the 10px halo survived — a `box-shadow: 0 0 0
// 10px` on the mic in the listening and speaking states, i.e. a solid disc 10px proud of the button, which
// reads as a radar rather than as a voice state. Colour and border already carry the state, so the halo was
// pure decoration. Measured in a real Chromium before the change (`#mic`, room page, room served from this
// tree): listening `color(srgb 0.121569 0.247059 0.815686 / 0.1) 0px 0px 0px 10px`, speaking
// `color(srgb 0.113725 0.419608 0.196078 / 0.11) 0px 0px 0px 10px`.
//
// WHY A STATIC TEST AND NOT A BROWSER ONE: the property is a declaration in a stylesheet, so the fast gate
// can answer it with no browser. The old branch (feat/remove-mic-rings-yf33) pinned the same property by
// parsing `public/style.css`; that file is now a 9-line `@import` composer (voicebox-beads-4gyw) and the
// rules live in `public/styles/*.css`, so this reads the COMPOSED sheet — exactly the text the browser
// loads — rather than one file that may or may not still hold the rule.
//
// IT REFUSES BY NAMING THE RULE, and it fails closed on a scan that sees nothing: if the mic rules are
// renamed or moved out of the composer, `enumerated` below fails rather than passing vacuously — answering
// "no halo" about rules the check could not see is the defect this whole file exists to prevent.
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readComposedCss, PUBLIC } from "./lib/css-bundle.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Every rule in the composed room stylesheet, with the at-rule context it sits inside. */
function rules(cssText) {
  const text = cssText.replace(/\/\*[\s\S]*?\*\//g, "");
  const out = [];
  for (const match of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = match[1].trim();
    if (!selector || selector.startsWith("@")) continue; // an at-rule prelude: its inner rules match on their own
    out.push({ selector, body: match[2] });
  }
  return out;
}

/** Declarations of one rule body, honouring parentheses so a `color-mix(...)` value stays one declaration. */
function declarations(body) {
  const out = [];
  let depth = 0;
  let buffer = "";
  for (const ch of body) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === ";" && depth === 0) {
      const declaration = buffer.trim();
      buffer = "";
      if (!declaration) continue;
      const at = declaration.indexOf(":");
      if (at === -1) continue;
      out.push({ property: declaration.slice(0, at).trim().toLowerCase(), value: declaration.slice(at + 1).trim() });
    } else buffer += ch;
  }
  const declaration = buffer.trim();
  if (declaration.includes(":")) {
    const at = declaration.indexOf(":");
    out.push({ property: declaration.slice(0, at).trim().toLowerCase(), value: declaration.slice(at + 1).trim() });
  }
  return out;
}

/** The comma-separated shadow layers of a box-shadow value, split at depth 0. */
function shadowLayers(value) {
  const layers = [];
  let depth = 0;
  let buffer = "";
  for (const ch of value) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      layers.push(buffer.trim());
      buffer = "";
    } else buffer += ch;
  }
  if (buffer.trim()) layers.push(buffer.trim());
  return layers;
}

/**
 * A halo is a shadow layer with NO offset and NO blur and a NON-ZERO spread: `0 0 0 10px <colour>`.
 *
 * ITS COLOUR MOVES, SO ONLY THE GEOMETRY IS READ. The declared spelling puts the geometry first
 * (`0 0 0 10px color-mix(in srgb, …)`); the computed one puts the colour first
 * (`color(srgb 0.12 0.24 0.81 / 0.1) 0px 0px 0px 10px`). An earlier draft of this check anchored the
 * geometry to the END of the layer and therefore found no halo in a sheet that was painting one — the
 * control test below holds both spellings for exactly that reason. Colour functions are stripped
 * innermost-first so their own numbers (`rgba(20, 22, 26, 0.09)`) can never be read as geometry.
 */
function ringSpread(layer) {
  let geometry = layer;
  for (let previous = null; geometry !== previous; ) {
    previous = geometry;
    // The function NAME goes with its arguments: stripping only the parentheses would leave `color-mix`
    // behind and make a geometry-first declaration look like it had trailing words.
    geometry = geometry.replace(/[a-zA-Z-]*\([^()]*\)/g, " ");
  }
  const text = geometry.replace(/\s+/g, " ").trim();
  // The four-number geometry run, wherever the colour sits: a named or hex colour needs no stripping and
  // leaves words behind the run, so the match is not anchored to the end of the layer.
  const match = text.match(/(?:^| )0(?:px)? 0(?:px)? 0(?:px)? (\d+(?:\.\d+)?)(px|rem|em)\b/);
  if (!match) return 0;
  const amount = Number(match[1]);
  return match[2] === "rem" || match[2] === "em" ? amount * 16 : amount;
}

/** The class names in one compound selector, e.g. `[data-voice="listening"] .mic` -> ["mic"]. */
function classesOf(compound) {
  return [...compound.matchAll(/\.([A-Za-z0-9_-]+)/g)].map((m) => m[1]);
}

/** The subject of one selector (its last compound), which is the element the declarations apply to. */
function subjectOf(selector) {
  const compounds = selector.trim().split(/\s+/).filter(Boolean);
  return compounds[compounds.length - 1] ?? "";
}

const composed = readComposedCss(path.join(PUBLIC, "style.css"));
const roomRules = rules(composed);

/** Every rule whose SUBJECT is the stage mic button itself (`.mic`), not one of its parts (`.mic-glyph`, `.mic-dock`). */
const micRules = roomRules.filter((rule) =>
  rule.selector
    .split(",")
    .some((selector) => classesOf(subjectOf(selector)).includes("mic")));

/** …narrowed to the two voice states the halo was painted in. */
const voiceStateMicRules = micRules.filter(
  (rule) => /\[data-voice="(listening|speaking)"\]/.test(rule.selector) || /\[data-voice='(listening|speaking)'\]/.test(rule.selector),
);

test("the detector sees the halo in both the declared and the computed spelling", () => {
  // THE CONTROL ARM. Both strings below were read off the tree this bead fixed: the declaration from
  // public/styles/stage.css, the computed value from a real Chromium on the room page. A detector that
  // answers 0 for either of them is blind, and every other assertion in this file would pass on a sheet
  // that is painting a ring — which is why this test exists rather than a comment claiming coverage.
  assert.equal(
    ringSpread("0 0 0 10px color-mix(in srgb, var(--accent) 10%, transparent)"),
    10,
    "the declared halo (geometry first) must be seen as a 10px ring",
  );
  assert.equal(
    ringSpread("color(srgb 0.121569 0.247059 0.815686 / 0.1) 0px 0px 0px 10px"),
    10,
    "the computed halo (colour first) must be seen as a 10px ring",
  );
  assert.equal(ringSpread("0 0 0 0.6rem #1d6b32"), 9.6, "a rem spread converts at 16px to the root");
  // …and it must NOT call an elevation a ring: these are the button's own shadows, before and computed.
  assert.equal(ringSpread("0 12px 32px rgba(20, 22, 26, 0.09)"), 0);
  assert.equal(ringSpread("rgba(20, 22, 26, 0.09) 0px 12px 32px 0px"), 0, "a zero spread is not a ring, whatever the offsets");
});

test("the scan can see the mic rules it is about to answer for — a scan that sees none proves nothing", () => {
  assert.ok(
    micRules.length >= 1,
    "no rule in the composed room stylesheet has the mic button (`.mic`) as its subject: the halo check below would pass without looking at anything. If the mic's rules moved, point this check at their new home.",
  );
  assert.ok(
    voiceStateMicRules.length >= 2,
    `expected the listening and speaking mic rules, found ${voiceStateMicRules.length} (${voiceStateMicRules.map((r) => r.selector).join(" | ") || "none"}) — the states the halo was painted in are no longer visible to this check`,
  );
});

test("the mic paints no halo in the listening or speaking state", () => {
  for (const rule of voiceStateMicRules) {
    for (const { property, value } of declarations(rule.body)) {
      if (property !== "box-shadow") continue;
      for (const layer of shadowLayers(value)) {
        assert.equal(
          ringSpread(layer),
          0,
          `${rule.selector} paints a ring around the microphone: "${layer}". Colour and border carry the voice state; a zero-offset, zero-blur, spread shadow is the halo voicebox-beads-a68n removed (see voicebox-beads-yf33).`,
        );
      }
    }
  }
});

test("the button keeps its elevation — the halo went, the shadow did not", () => {
  const base = micRules.find((rule) => rule.selector.split(",").some((selector) => subjectOf(selector) === ".mic"));
  assert.ok(base, "the base `.mic` rule is missing from the composed sheet");
  const shadow = declarations(base.body).find((d) => d.property === "box-shadow");
  assert.ok(shadow, "`.mic` no longer declares a box-shadow: removing the halo must not flatten the button");
  const layers = shadowLayers(shadow.value);
  assert.ok(
    layers.some((layer) => /^0\s+\d+(?:\.\d+)?(?:px)?\s+\d+(?:\.\d+)?(?:px)?\s/.test(layer.replace(/\s+/g, " ").trim())),
    `\`.mic\`'s shadow must keep a real offset/blur elevation, found "${shadow.value}"`,
  );
});

test("the decorative arcs stay hidden, so no ring returns by another route", () => {
  const arcs = roomRules.filter((rule) => rule.selector.split(",").some((selector) => subjectOf(selector) === ".sqeh-arcs"));
  assert.ok(arcs.length >= 1, "the `.sqeh-arcs` rule is missing — the arc markup would paint if its display rule moved");
  assert.ok(
    arcs.some((rule) => declarations(rule.body).some((d) => d.property === "display" && d.value === "none")),
    "`.sqeh-arcs` must stay `display: none`: voicebox-beads-yf33 removed the rings around the microphone and voicebox-beads-a68n removed the last halo",
  );
});
