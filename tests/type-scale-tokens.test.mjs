// tests/type-scale-tokens.test.mjs — the type scale's STATIC contract (voicebox-beads-3674, voicebox-beads-dche).
//
// The browser half of this bead's evidence is in tests/type-scale.test.mjs (a real Chromium over CDP,
// which makes that file LIVE tier). Nothing here needs a browser or a server, so scripts/test-lanes.mjs
// reads this file as UNIT and the fast gate runs it — which is the point: a CSS-only change that
// reintroduces a sub-12px size is refused by `fleet-check --fast` instead of waiting for the full gate's
// serialised browser tier (voicebox-beads-buy8, voicebox-beads-zjpm).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
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

function htmlFiles(dir, prefix) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isDirectory()) out.push(...htmlFiles(path.join(dir, entry.name), `${prefix}${entry.name}/`));
    else if (entry.name.endsWith(".html")) out.push([`${prefix}${entry.name}`, path.join(dir, entry.name)]);
  }
  return out;
}

/**
 * Surfaces the floor applies to: every stylesheet the browser can load (`public/*.css`), every page that can
 * carry an inline `style` attribute or its own `<style>` block (every page under public/, plus
 * designs/prototype.html),
 * and the one JS module that injects a stylesheet of its own (public/pip-mic.mjs, the Document-PiP window).
 * `designs/prototype.html` is not shipped, but it is the design spec the shipped surfaces model, so a size
 * below the floor there would be imported back.
 *
 * NAMED LIMIT (voicebox-beads-3674): this reads source text, so a size a script sets at runtime
 * (`element.style.fontSize = "11px"`) is not seen. `tests/type-scale.test.mjs` measures what actually ships.
 */
const SURFACES = [
  ...readdirSync(PUBLIC)
    .filter((f) => f.endsWith(".css"))
    .sort()
    .map((f) => [`public/${f}`, path.join(PUBLIC, f)]),
  ["public/pip-mic.mjs", path.join(PUBLIC, "pip-mic.mjs")],
  ...htmlFiles(PUBLIC, "public/"),
  ["designs/prototype.html", path.join(ROOT, "designs", "prototype.html")],
];

/** A comment is not a declaration — CSS or HTML. Blank them out but keep every newline, so a failure still
 *  names the real line of the file. */
const withoutComments = (text) =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
    .replace(/<!--[\s\S]*?-->/g, (block) => block.replace(/[^\n]/g, " "));

/**
 * Every font size a stylesheet declares, as {line, decl, px}. Reads `font-size: <length>` and the size slot
 * of the `font:` shorthand — `font: 13px/1.4 …`, but equally `font: 600 11px/1.4 …` or `font: italic 11px
 * …`, because the shorthand's size is the first length AFTER any style/variant/weight/stretch, not the first
 * token. (A regex anchored to the start of the value read only the first shape, which is how four sizes hid
 * here — the whole reason this scanner exists.) A value it cannot resolve to a number is reported with
 * `px: null` and is not a floor violation.
 */
function declaredSizes(text) {
  const out = [];
  const length = /(\d*\.?\d+)(rem|px)/g;
  const toPx = (num, unit) => (unit === "rem" ? num * 16 : num);
  withoutComments(text).split("\n").forEach((line, i) => {
    for (const match of line.matchAll(/(?:^|[\s;{"'])(font-size|font)\s*:\s*([^;}"']+)/g)) {
      const [, prop, value] = match;
      if (prop === "font") {
        const size = /(?:^|\s)(\d*\.?\d+)(rem|px)(?=\s*\/|\s|$)/.exec(value);
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

/** The surfaces that declare the scale themselves: the room owns the full scale, and the pages that stand
 *  alone carry the floor token their own rules reference (they do not load style.css). */
const TOKEN_OWNERS = [
  { label: "public/style.css", file: path.join(PUBLIC, "style.css"), tokens: Object.keys(TOKENS) },
  { label: "public/apps/agent-monitor.html", file: path.join(PUBLIC, "apps", "agent-monitor.html"), tokens: ["text-xs"] },
  { label: "public/apps/landing-inspector.html", file: path.join(PUBLIC, "apps", "landing-inspector.html"), tokens: ["text-xs"] },
  { label: "designs/prototype.html", file: path.join(ROOT, "designs", "prototype.html"), tokens: ["text-xs"] },
];

test("the room declares the legible type scale as named tokens with a 0.75rem floor", () => {
  for (const { label, file, tokens } of TOKEN_OWNERS) {
    const text = readFileSync(file, "utf8");
    for (const name of tokens) {
      const value = TOKENS[name];
      const escaped = value.replace(/[.]/g, "\\.");
      assert.match(text, new RegExp(`--${name}:\\s*${escaped}\\s*;`), `${label} must declare --${name}: ${value}`);
    }
  }
});

test("no shipped surface declares a font size below the 12px floor", () => {
  assert.ok(SURFACES.length >= 15, `the surface list must enumerate the shipped trees, got ${SURFACES.length}`);
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
