// tests/theme-tokens.test.mjs — the palette is still exactly the palette, and the shadow is still a
// shadow. (voicebox-beads-7xse)
//
// WHY THIS FILE EXISTS. The change it guards is a REFACTOR with no intended visual effect: the two
// hardcoded token blocks became one block of `light-dark(light, dark)` pairs, and the override became
// `color-scheme` alone. A refactor like that can be wrong in two silent ways, and both are cheap to
// check here rather than in a screenshot:
//
//   1. A MIS-PAIRED ARGUMENT. Swapping two values inside a pair changes one scheme's colour and
//      nothing else, so it survives every "does it look right" glance taken in the other scheme.
//      The table below is the palette as it was before the refactor, so any drift has to be deliberate.
//   2. THE SHADOW TRAP. `light-dark()` resolves to a <color>, so wrapping a box-shadow in it makes the
//      declaration invalid and the computed shadow `none` — silently. Writing `--shadow` as a
//      light-dark() pair is exactly the mistake this refactor invites, so the shape is asserted here
//      as well as the computed value in tests/theme-os-fallback.test.mjs.
//
// A text-only check cannot see (2) on its own — that is why both files exist, and why the browser test
// asserts `box-shadow !== "none"` rather than only comparing tokens.
//
//   node --test tests/theme-tokens.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const ROOT = new URL("..", import.meta.url).pathname;
const css = readFileSync(`${ROOT}public/style.css`, "utf8");
// Parse from a comment-free copy: a comment sitting between a rule's `{` and its first declaration has
// no semicolon in front of it, so splitting on `;` would otherwise take the comment's own prose as the
// declaration name and lose the real one. (Found by this test failing on its own first run.)
const cssWithoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");

/** The palette exactly as it stood before the refactor, quoted rather than derived from the file. */
const PALETTE = {
  "--ground": ["#fbfbf9", "#0b0f19"],
  "--card": ["#ffffff", "#151d2f"],
  "--shade": ["#f3f4f6", "#1e293b"],
  "--line": ["#d8dcdf", "rgba(255, 255, 255, 0.12)"],
  "--ink": ["#23262b", "#f8fafc"],
  "--muted": ["#59636d", "#94a3b8"],
  "--accent": ["#1f3fd0", "#38bdf8"],
  "--good": ["#1d6b32", "#34d399"],
  "--warn": ["#8a4b00", "#fbbf24"],
  "--bad": ["#b3261e", "#f87171"],
};
const SHADOW_INK = ["rgba(38, 48, 60, 0.2)", "rgba(0, 0, 0, 0.7)"];

/** Pull the declarations out of a rule body by selector, whitespace-insensitively. */
const bodyOf = (selector) => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, "m").exec(cssWithoutComments);
  assert.ok(match, `style.css must contain a rule for ${selector}`);
  return match[1];
};
const declarationsIn = (body) =>
  Object.fromEntries(
    body
      .split(";")
      .map((d) => d.trim())
      .filter((d) => d.includes(":"))
      .map((d) => [d.slice(0, d.indexOf(":")).trim(), d.slice(d.indexOf(":") + 1).trim()]),
  );

const root = declarationsIn(bodyOf(":root"));

test("every colour token is one light-dark() pair holding exactly the pre-refactor values", () => {
  for (const [token, [light, dark]] of Object.entries(PALETTE)) {
    assert.equal(
      root[token],
      `light-dark(${light}, ${dark})`,
      `${token} must pair the light and dark values it had before the refactor, in that order — a swapped pair changes one scheme silently`,
    );
  }
});

test("the shadow stays a shadow: only its colour is a light-dark() pair", () => {
  assert.equal(
    root["--shadow-ink"],
    `light-dark(${SHADOW_INK[0]}, ${SHADOW_INK[1]})`,
    "the shadow's colour must be the light-dark() pair, with the pre-refactor alphas",
  );
  assert.equal(
    root["--shadow"],
    "0 18px 40px -20px var(--shadow-ink)",
    "the shadow must keep box-shadow syntax around the colour token",
  );
  assert.doesNotMatch(
    root["--shadow"],
    /light-dark\(/,
    "wrapping the shadow itself in light-dark() makes the declaration invalid — light-dark() resolves to a <color>, and the computed shadow becomes `none` with no error",
  );
  // The geometry must survive too: a zero-offset halo is decoration, and the craft floor wants a real one.
  assert.match(root["--shadow"], /^\s*0 18px 40px -20px /, "the offset and blur must be unchanged");
});

test("the OS is the default and an explicit choice is expressed only as a colour scheme", () => {
  assert.equal(
    root["color-scheme"],
    "light dark",
    "`:root` must allow both schemes, or a browser with no script can never follow the OS",
  );
  assert.deepEqual(
    declarationsIn(bodyOf(':root[data-theme="light"]')),
    { "color-scheme": "light" },
    "the light override must set the colour scheme and nothing else — a second copy of the tokens would be a second place computing them",
  );
  assert.deepEqual(
    declarationsIn(bodyOf(':root[data-theme="dark"]')),
    { "color-scheme": "dark" },
    "the dark override must set the colour scheme and nothing else",
  );
  assert.equal(
    /prefers-color-scheme/.test(css),
    false,
    "no media-query fallback is needed any more, and one would be a second computing site for the same decision — the OS default and the explicit override are both expressed as color-scheme now",
  );
});

test("nothing forces a scheme in the served HTML, which is what made the fallback impossible", () => {
  for (const page of ["index.html", "help.html"]) {
    const html = readFileSync(`${ROOT}public/${page}`, "utf8");
    assert.doesNotMatch(
      html,
      /<html[^>]*data-theme=/,
      `${page} must not force a scheme on <html>: an attribute selector outranks any media query, so it made a CSS-only OS fallback impossible`,
    );
  }
});
