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

/** CSS-wide keywords, and the system-font keywords `font:` accepts: neither of those is a declared size. */
const NOT_A_SIZE = /^(?:inherit|initial|unset|revert|revert-layer|caption|icon|menu|message-box|small-caption|status-bar)$/i;

/** A length in any unit. `rem` and `px` are the two the floor can be computed in; every other unit is a size
 *  this check cannot answer for, which is a refusal rather than a pass (voicebox-beads-94of). */
const LENGTH = /(-?\d*\.?\d+)(px|rem|em|%|pt|pc|q|mm|cm|in|ch|ex|cap|ic|lh|rlh|vw|vh|vmin|vmax)/g;

/** The 1-based line an offset falls on, so a refusal still names the real line of the file. */
const lineAt = (text, index) => text.slice(0, index).split("\n").length;

/** A declaration value as a person reads it: one line, internal whitespace collapsed. */
const tidy = (value) => value.trim().replace(/\s+/g, " ");

/**
 * Every custom property the file declares, by name, in EVERY scope — plus the pinned `--text-*` scale as the
 * default a page may lean on without declaring it (public/style.css's `:root` owns the scale, and the pages
 * that load it share the cascade). A scoped override is a real size for the elements it applies to, so all
 * declared values are kept and the floor is applied to the smallest of them: that is what catches
 * `.foot-fact { --text-xs: 0.6rem; font-size: var(--text-xs) }` (voicebox-beads-94of).
 *
 * Read over the whole text rather than line by line, because a declaration's value may start on the next
 * line — `--text-2xs:` then `0.75rem;` is valid CSS, and a line-at-a-time scan cannot see it
 * (voicebox-beads-jlfq). Custom property names are case-SENSITIVE in CSS, so this stays case-sensitive.
 */
function customProperties(text) {
  const props = new Map();
  const add = (name, value, line) => props.set(name, [...(props.get(name) ?? []), { value, line }]);
  for (const [name, value] of Object.entries(TOKENS)) add(`--${name}`, value, 0);
  for (const match of text.matchAll(/(--[A-Za-z0-9_-]+)\s*:\s*([^;}]+)/g)) {
    add(match[1], tidy(match[2]), lineAt(text, match.index));
  }
  return props;
}

/** The `var(--x[, fallback])` calls in a value, with a nested fallback read to its own matching paren. */
function varCalls(value) {
  const calls = [];
  let at = value.indexOf("var(");
  while (at !== -1) {
    let depth = 0;
    let end = at;
    for (; end < value.length; end++) {
      if (value[end] === "(") depth++;
      else if (value[end] === ")" && --depth === 0) {
        end++;
        break;
      }
    }
    const body = value.slice(at + 4, end - 1);
    let inner = 0;
    let comma = -1;
    for (let k = 0; k < body.length; k++) {
      if (body[k] === "(") inner++;
      else if (body[k] === ")") inner--;
      else if (body[k] === "," && inner === 0) {
        comma = k;
        break;
      }
    }
    calls.push({
      name: (comma === -1 ? body : body.slice(0, comma)).trim(),
      fallback: comma === -1 ? null : body.slice(comma + 1).trim(),
    });
    at = value.indexOf("var(", end);
  }
  return calls;
}

/**
 * Every size a value can resolve to, as `{px, unresolved}`. A `var()` is resolved from the file's own
 * declarations — all scopes — or from the pinned scale; failing both, its fallback is followed; failing
 * that too, the size is UNRESOLVED and reported, never quietly passed. A floor check that cannot see a
 * size is the defect this file exists to prevent, so the instrument never answers "fine" to a question it
 * could not read (voicebox-beads-94of).
 */
function resolveValue(value, props, depth = 0) {
  const out = { sizes: [], unresolved: [] };
  if (depth > 5) {
    out.unresolved.push(value.trim());
    return out;
  }
  const trimmed = value.trim();
  if (NOT_A_SIZE.test(trimmed)) return out;
  for (const [, number, unit] of trimmed.matchAll(LENGTH)) {
    if (unit === "rem" || unit === "px") {
      out.sizes.push({ px: unit === "rem" ? parseFloat(number) * 16 : parseFloat(number), via: null });
    } else {
      out.unresolved.push(`${number}${unit}`);
    }
  }
  for (const { name, fallback } of varCalls(trimmed)) {
    const declared = props.get(name) ?? [];
    const candidates = declared.length > 0 ? declared : fallback === null ? [] : [{ value: fallback, line: 0 }];
    if (candidates.length === 0) {
      out.unresolved.push(`var(${name})`);
      continue;
    }
    for (const candidate of candidates) {
      const resolved = resolveValue(candidate.value, props, depth + 1);
      for (const size of resolved.sizes) {
        // A size that came out of a custom property is attributed to the DECLARATION that set it, so a
        // refusal names the cause rather than every use site of that token (voicebox-beads-94of).
        out.sizes.push({ px: size.px, via: size.via ?? { name, value: candidate.value, line: candidate.line } });
      }
      out.unresolved.push(...resolved.unresolved);
    }
  }
  return out;
}

/**
 * The size slot of a `font:` shorthand: the first length or `var()`, after any style/variant/weight/stretch
 * (`font: 600 11px/1.4 …`, `font: var(--text-xs)/1.45 …`). `null` when the value declares no size at all —
 * `font: inherit`, or a system font such as `font: menu` — which is not a floor question.
 */
function shorthandSize(value) {
  const SIZE = /^-?\d*\.?\d+(px|rem|em|%|pt|pc|q|mm|cm|in|ch|ex|cap|ic|lh|rlh|vw|vh|vmin|vmax)$/;
  let at = 0;
  while (at < value.length) {
    while (at < value.length && /\s/.test(value[at])) at++;
    if (at >= value.length) return null;
    let token;
    if (value.startsWith("var(", at)) {
      let depth = 0;
      let end = at;
      for (; end < value.length; end++) {
        if (value[end] === "(") depth++;
        else if (value[end] === ")" && --depth === 0) {
          end++;
          break;
        }
      }
      token = value.slice(at, end);
      at = end;
    } else {
      let end = at;
      while (end < value.length && !/\s/.test(value[end])) end++;
      token = value.slice(at, end);
      at = end;
    }
    const head = token.split("/")[0];
    if (head.startsWith("var(") || SIZE.test(head)) return head;
  }
  return null;
}

/**
 * Every size a stylesheet declares, as `{line, decl, px, via, why}` — one entry per size it resolves to, plus
 * one entry per size it could not resolve (`px: null`, with the reason in `why`). Reads `font-size: <value>`
 * and the size slot of the `font:` shorthand; values carried by a custom property are resolved, so a sub-12px
 * size cannot travel through a token, a scoped override, or a nested fallback unseen.
 *
 * The text is read as DECLARATION text, not one line at a time, and property names are case-folded: the two
 * valid CSS spellings a line-at-a-time, case-sensitive scan is blind to are a value that starts on the next
 * line (`font-size:` then `0.6rem;`) and an upper-cased property name (`FONT-SIZE:`) — both shipped sub-floor
 * text past the gate while it reported green (voicebox-beads-jlfq). The source offset is kept so a refusal
 * still names the real line of the file.
 */
function declaredSizes(text) {
  const clean = withoutComments(text);
  const props = customProperties(clean);
  const out = [];
  for (const match of clean.matchAll(/(?:^|[\s;{"'])(font-size|font)\s*:\s*([^;}"']+)/gi)) {
    const prop = match[1].toLowerCase();
    const value = tidy(match[2]);
    const line = lineAt(clean, match.index + match[0].indexOf(match[1]));
    const size = prop === "font" ? shorthandSize(value) : value;
    if (size === null) continue;
    const { sizes, unresolved } = resolveValue(size, props);
    const decl = `${prop}: ${value}`;
    for (const { px, via } of sizes) out.push({ line, decl, px, via, why: null });
    for (const unknown of unresolved) {
      out.push({ line, decl, px: null, via: null, why: `cannot be resolved: ${unknown}` });
    }
  }
  return out;
}

/** Every declaration the floor refuses: a size below it, or a size this check could not resolve at all. */
const belowFloor = (text) => declaredSizes(text).filter((d) => d.px === null || d.px < FLOOR_PX);

/**
 * A refusal a person can act on, one line per CAUSE. A size that arrived through a custom property is
 * reported at the declaration that set it, with the first use site, and the rest of the file's uses of that
 * same token collapse into one line instead of one per site.
 */
function floorReport(label, text) {
  const causes = new Map();
  for (const d of belowFloor(text)) {
    const key = d.via ? `${label}:${d.via.line}:${d.via.name}` : `${label}:${d.line}:${d.decl}`;
    causes.set(key, [...(causes.get(key) ?? []), d]);
  }
  return [...causes.values()].map((uses) => {
    // Prefer the use site on the declaration's own line (a one-liner override); otherwise the first one.
    const d = uses.find((u) => u.via && u.line === u.via.line) ?? uses[0];
    if (d.px === null) return `${label}:${d.line} ${d.decl} — ${d.why}`;
    if (!d.via) return `${label}:${d.line} ${d.decl} = ${d.px}px`;
    const sites = new Set(uses.map((u) => u.line)).size;
    const more = sites > 1 ? ` (and ${sites - 1} more site${sites > 2 ? "s" : ""} using ${d.via.name})` : "";
    return `${label}:${d.via.line} ${d.via.name}: ${d.via.value} = ${d.px}px — used by \`${d.decl}\` at line ${d.line}${more}`;
  });
}

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
    const report = floorReport(label, readFileSync(file, "utf8"));
    assert.deepEqual(
      report,
      [],
      `${label} must declare no size below ${FLOOR_PX}px and no size this check cannot resolve (express it in rem or px, or via a --text-* token) — voicebox-beads-3674; above is the full list`,
    );
  }
});

test("the floor scanner refuses a sub-12px size carried by a custom property (voicebox-beads-94of)", () => {
  // The mutant the reviewer filed: the size never appears as a literal in the declaration, so a
  // literal-only scan passes it while the browser renders 9.6px on a shipped page.
  assert.equal(belowFloor(`.foot-fact { --text-xs: 0.6rem; font-size: var(--text-xs); }`).length, 1,
    "a scoped override of a pinned token that goes below the floor must be refused");
  assert.equal(belowFloor(`:root { --text-2xs: 0.65rem; } .x { font-size: var(--text-2xs); }`).length, 1,
    "a brand-new token that goes below the floor must be refused");
  assert.equal(belowFloor(`.x { font-size: var(--mystery); }`).length, 1,
    "a size the scanner cannot resolve must be refused, not silently passed");
  assert.equal(belowFloor(`.x { font-size: 1.2em; }`).length, 1,
    "a size in a unit the floor cannot be computed in must be refused, not silently passed");
  assert.equal(belowFloor(`.x { font: var(--tiny)/1.4 monospace; }`).length, 1,
    "the same must hold for the size slot of the font: shorthand");

  // The honest shapes stay green: the refusal must not be a check that always fails.
  assert.deepEqual(belowFloor(`:root { --text-2xs: 0.75rem; } .x { font-size: var(--text-2xs); }`), [],
    "a new token AT the floor is fine");
  assert.deepEqual(belowFloor(`.x { font-size: var(--text-xs); }`), [], "the pinned token is fine");
  assert.deepEqual(belowFloor(`.x { font-size: var(--nope, var(--text-xs)); }`), [],
    "an unknown token with a fallback to the pinned scale is fine — public/style.css carries this shape");
  assert.deepEqual(belowFloor(`.x { font-size: var(--text-xs, 0.75rem); }`), [], "a literal fallback is fine");
  assert.deepEqual(belowFloor(`.x { font: 13px/1.4 var(--mono, monospace); }`), [],
    "a var in the shorthand's FAMILY is not the size slot");
  assert.deepEqual(belowFloor(`.x { font: inherit; }`), [], "a CSS-wide keyword declares no size");
});

test("the floor scanner reads a declaration as declaration text, not one line at a time (voicebox-beads-jlfq)", () => {
  // Two valid CSS spellings a line-at-a-time, case-sensitive scan is blind to. Both are non-equivalent
  // mutants, measured in a real Chromium against a 12px control: the appended `.rev-wrapped` computed to
  // 9.6px and `.rev-case` to 11px on a shipped page while the scanner reported the floor green.
  const wrapped = belowFloor(`.rev-wrapped {\n  font-size:\n  0.6rem;\n}`);
  assert.equal(wrapped.length, 1, "a value that starts on the next line must still be read");
  assert.equal(wrapped[0].line, 2, "the refusal must name the property's own line, not the value's");
  assert.equal(belowFloor(`.rev-case { FONT-SIZE: 11px; }`).length, 1, "an upper-cased property name must still be read");
  assert.equal(belowFloor(`.x { FONT: 600 11px/1.4 monospace; }`).length, 1, "the font: shorthand is case-folded too");
  assert.equal(belowFloor(`.x { Font-Size: var(--mystery); }`).length, 1, "an unreadable size is refused in any casing");
  assert.equal(belowFloor(`.x {\n  --text-2xs:\n  0.65rem;\n  font-size: var(--text-2xs);\n}`).length, 1,
    "a custom property whose value starts on the next line must still be resolved and floored");

  // …and the honest spellings stay green: the refusal must not be a check that always fails.
  assert.deepEqual(belowFloor(`.x { FONT-SIZE: 0.75rem; }`), [], "an upper-cased size AT the floor is fine");
  assert.deepEqual(belowFloor(`.x {\n  font-size:\n  var(--text-xs);\n}`), [], "a line-split pinned token is fine");
  assert.deepEqual(belowFloor(`.x {\n  --text-2xs:\n  0.75rem;\n  font-size: var(--text-2xs);\n}`), [],
    "a line-split new token AT the floor is fine");
  assert.deepEqual(belowFloor(`.x { FONT: inherit; }`), [], "a case-folded CSS-wide keyword still declares no size");
});

test("the room's .sr-only clips instead of scrolling (voicebox-beads-dche)", () => {
  const css = withoutComments(readFileSync(path.join(PUBLIC, "style.css"), "utf8"));
  const rule = /\.sr-only\s*\{([^}]*)\}/.exec(css);
  assert.ok(rule, "public/style.css must declare a .sr-only rule");
  assert.match(rule[1], /overflow:\s*clip/, "public/style.css .sr-only must clip without creating a scroll container");
  assert.doesNotMatch(rule[1], /overflow:\s*(?:hidden|auto|scroll)/, "public/style.css .sr-only must not create a scroll container");
});
