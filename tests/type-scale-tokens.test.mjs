// tests/type-scale-tokens.test.mjs — the type scale's STATIC contract (voicebox-beads-3674, voicebox-beads-dche).
//
// The browser half of this bead's evidence is in tests/type-scale.test.mjs (a real Chromium over CDP,
// which makes that file LIVE tier). Nothing here needs a browser or a server, so scripts/test-lanes.mjs
// reads this file as UNIT and the fast gate runs it — which is the point: a CSS-only change that
// reintroduces a sub-12px size is refused by `fleet-check --fast` instead of waiting for the full gate's
// serialised browser tier (voicebox-beads-buy8, voicebox-beads-zjpm).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC = path.join(ROOT, "public");

/** The floor this bead establishes: 12px, spelled as the 0.75rem token. */
const FLOOR_PX = 12;

const TOKENS = {
  "text-xs": "0.75rem",
  "text-sm": "0.8125rem",
  "text-base": "0.875rem",
  "text-md": "0.9375rem",
  "text-lg": "1rem",
  "text-xl": "1.125rem",
  "text-2xl": "1.25rem",
};

/** Surfaces the floor applies to. `designs/prototype.html` is not shipped, but it is the design spec
 *  the shipped surfaces are supposed to model, so a size below the floor there would be imported back. */
const SURFACES = [
  ["public/style.css", path.join(PUBLIC, "style.css")],
  ["public/apps/agent-monitor.html", path.join(PUBLIC, "apps", "agent-monitor.html")],
  ["public/apps/landing-inspector.html", path.join(PUBLIC, "apps", "landing-inspector.html")],
  ["designs/prototype.html", path.join(ROOT, "designs", "prototype.html")],
];

/** A comment is not a declaration. Blank them out but keep every newline, so a failure still names the
 *  real line of the file. */
const withoutComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "));

/**
 * Every font size a stylesheet declares, as {line, decl, px}. Reads `font-size: <length>` and the size
 * slot of the `font:` shorthand (`font: 13px/1.4 …`) — a shorthand is how three sizes in this repo are
 * spelled, and the earlier regex-only check could not see them. A value it cannot resolve to a number
 * is reported with `px: null` and is not a floor violation.
 */
function declaredSizes(text) {
  const out = [];
  const length = /(\d*\.?\d+)(rem|px)/g;
  const toPx = (num, unit) => (unit === "rem" ? num * 16 : num);
  withoutComments(text).split("\n").forEach((line, i) => {
    for (const match of line.matchAll(/(?:^|[\s;{])(font-size|font)\s*:\s*([^;}]+)/g)) {
      const [, prop, value] = match;
      if (prop === "font") {
        // In the shorthand the SIZE is the first length, optionally followed by `/line-height`.
        const size = /^\s*(\d*\.?\d+)(rem|px)(?=\s*\/|\s|$)/.exec(value);
        if (size) {
          out.push({ line: i + 1, decl: `${prop}:${value.trim()}`, px: toPx(parseFloat(size[1]), size[2]) });
        }
        continue;
      }
      for (const size of value.matchAll(length)) {
        out.push({ line: i + 1, decl: `${prop}: ${value.trim()}`, px: toPx(parseFloat(size[1]), size[2]) });
      }
    }
  });
  return out;
}

const belowFloor = (text) => declaredSizes(text).filter((d) => d.px !== null && d.px < FLOOR_PX);

test("the room declares the legible type scale as named tokens with a 0.75rem floor", () => {
  const css = readFileSync(path.join(PUBLIC, "style.css"), "utf8");
  for (const [name, value] of Object.entries(TOKENS)) {
    const escaped = value.replace(/[.]/g, "\\.");
    assert.match(css, new RegExp(`--${name}:\\s*${escaped}\\s*;`), `public/style.css must declare --${name}: ${value}`);
  }
  for (const [label, file] of SURFACES.slice(1)) {
    assert.match(readFileSync(file, "utf8"), /--text-xs:\s*0\.75rem\s*;/, `${label} must declare --text-xs: 0.75rem`);
  }
});

test("no shipped surface declares a font size below the 12px floor", () => {
  for (const [label, file] of SURFACES) {
    const offenders = belowFloor(readFileSync(file, "utf8"));
    assert.deepEqual(
      offenders.map((d) => `${label}:${d.line} ${d.decl} = ${d.px}px`),
      [],
      `${label} must declare no font size below ${FLOOR_PX}px — lift it to var(--text-xs) (voicebox-beads-3674); above is the full list`,
    );
  }
});

test("the room's .sr-only clips instead of scrolling (voicebox-beads-dche)", () => {
  const css = withoutComments(readFileSync(path.join(PUBLIC, "style.css"), "utf8"));
  const rule = /\.sr-only\s*\{([^}]*)\}/.exec(css);
  assert.ok(rule, "public/style.css must declare a .sr-only rule");
  assert.match(rule[1], /overflow:\s*clip/, "public/style.css .sr-only must clip without creating a scroll container");
  assert.doesNotMatch(rule[1], /overflow:\s*(?:hidden|auto|scroll)/, "public/style.css .sr-only must not create a scroll container");
});
