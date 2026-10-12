// tests/placeholder-contrast-browser.test.mjs — the room and Help pages must not draw placeholder text
// from the user agent's grey (voicebox-beads-0q5c).
//
// The floor is 4.5:1, applied to placeholder text the same way `tests/ui-ux-accessibility.test.mjs`
// applies it to the Environment page. Before voicebox-beads-0q5c the room and Help fields measured
// 4.45:1 light / 4.16:1 dark, and the two transcript fields 4.19:1 / 3.17:1 on their darker ground.
//
// Two things this test deliberately does NOT assert, because asserting them would be false:
//   1. That EVERY placeholder passes. `#utterance` in the composer still does not, by design: it is a
//      62%-alpha composite that voicebox-beads-8wm8 owns, and it depends on this change landing first.
//   2. That the fix works because of a selector's specificity. It does not; see the assertion on the
//      rule's shape below. `.room input::placeholder` and `.composer input::placeholder` are at EQUAL
//      specificity, so source order decides and a plain container rule would flatten the composer.
//
// The theme is driven through the application's own preference (localStorage["voicebox:theme"]) and a
// reload, not by setting data-theme by hand and not through prefers-color-scheme alone: with nothing
// stored the app resolves the system preference, and on this machine that is light, so a test that only
// drove the media feature would assert light twice and report dark as clean without ever seeing it.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { startServer } from "./lib/server.mjs";
import { launch } from "./lib/cdp.mjs";

const FLOOR = 4.5;

// Every page here loads public/style.css. help.html is the second page the fix covers; the Environment
// page has its own stylesheet and its own test.
const PAGES = [
  { path: "/", minOpaque: 20 },
  { path: "/help.html", minOpaque: 1 },
];

const THEMES = ["light", "dark"];

// Read every placeholder element's composited colour against its own background. Self-contained: a
// page-evaluated function is serialised and cannot close over this file's scope.
const MEASURE = () => {
  const rgba = (c) => {
    const m = c.match(/color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\)/);
    if (m) return [+m[1] * 255, +m[2] * 255, +m[3] * 255, m[4] === undefined ? 1 : +m[4]];
    const n = (c.match(/[\d.]+/g) || []).map(Number);
    return [n[0] ?? 0, n[1] ?? 0, n[2] ?? 0, n[3] === undefined ? 1 : n[3]];
  };
  const over = ([r, g, b, a], [br, bg, bb]) => [r * a + br * (1 - a), g * a + bg * (1 - a), b * a + bb * (1 - a)];
  const lum = ([r, g, b]) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const probe = document.createElement("span");
  probe.style.color = "var(--muted)";
  document.body.append(probe);
  const mutedResolved = getComputedStyle(probe).color;
  probe.remove();
  return {
    mutedResolved,
    rows: [...document.querySelectorAll("[placeholder]")].map((el) => {
      const st = getComputedStyle(el, "::placeholder");
      const fg = rgba(st.color);
      let bg = null;
      for (let node = el; node; node = node.parentElement) {
        const [r, g, b, a] = rgba(getComputedStyle(node).backgroundColor);
        if (a > 0) { bg = [r, g, b]; break; }
      }
      return {
        id: el.id || el.tagName.toLowerCase(),
        color: st.color,
        opacity: st.opacity,
        ratio: bg ? +ratio(over(fg, bg), bg).toFixed(2) : null,
        zone: el.closest(".composer") ? "composer"
          : el.closest(".list-tools") ? "list-tools"
          : el.closest(".room") ? "room"
          : el.closest(".settings-form") ? "settings-form"
          : el.closest(".help-page") ? "help-page" : "other",
      };
    }),
  };
};

test("browser: room and Help placeholder text clears 4.5:1 in both stored themes", async () => {
  // The rule must be present and must be the zero-specificity form. If someone rewrites it without
  // :where(), the composer silently flattens - that was measured, not theorised - so the shape is
  // pinned here rather than left to a reviewer to notice.
  const styleCss = fs.readFileSync(path.join(process.cwd(), "public/style.css"), "utf8");
  // Assert against the stylesheet with comments stripped: the provenance comment above the rule quotes
  // the very selectors this test is checking for, and a future edit to that prose must not be able to
  // make these assertions pass or fail on its wording.
  const styleRules = styleCss.replace(/\/\*[\s\S]*?\*\//g, "");
  assert.match(
    styleRules,
    /:where\(\.room,\s*\.settings-form,\s*\.help-page\)\s*:is\(input,\s*textarea\)::placeholder\s*\{\s*color:\s*var\(--muted\);\s*opacity:\s*1;\s*\}/,
    "style.css must carry the zero-specificity :where() placeholder rule (voicebox-beads-0q5c)",
  );
  assert.doesNotMatch(
    styleRules,
    /^\s*\.room input::placeholder/m,
    "a plain .room placeholder rule would tie with .composer's and win on source order, flattening the composer",
  );

  // The composer's own declaration must survive untouched. voicebox-beads-8wm8 owns changing it.
  assert.match(
    styleRules,
    /\.composer input::placeholder\s*\{\s*color:\s*color-mix\(in srgb,\s*var\(--muted\)\s*62%,\s*transparent\);\s*\}/,
    "the composer's deliberate 62% alpha must not be replaced by this change",
  );

  const server = await startServer();
  let browser;
  try {
    browser = await launch();
    const page = browser.page ?? (await browser.newPage?.()) ?? browser;
    await page.goto(`${server.base}/`);

    for (const theme of THEMES) {
      // Drive the application's own preference, then reload so theme.mjs boots into it.
      await page.evaluate((t) => localStorage.setItem("voicebox:theme", t), theme);

      for (const { path: pagePath, minOpaque } of PAGES) {
        await page.goto(`${server.base}${pagePath}`);
        const applied = await page.evaluate(() => ({
          theme: document.documentElement.dataset.theme,
          mode: document.documentElement.dataset.themeMode ?? null,
        }));
        assert.equal(
          applied.theme, theme,
          `${pagePath}: stored preference "${theme}" must resolve to data-theme="${theme}" (got "${applied.theme}"); ` +
          "if this fails the theme was not actually exercised and every colour below is the other theme's",
        );

        const { mutedResolved, rows } = await page.evaluate(MEASURE);
        const opaque = rows.filter((r) => r.zone !== "composer" && r.zone !== "list-tools");
        const where = `${pagePath} in ${theme}`;

        // Guard against a vacuous pass: a selector that matches nothing must fail, not succeed.
        assert.ok(
          opaque.length >= minOpaque,
          `${where}: expected at least ${minOpaque} opaque placeholder fields, enumerated ${opaque.length} - ` +
          "the enumeration itself would be vacuous",
        );
        assert.equal(mutedResolved, mutedResolved.trim(), "sanity: the token must resolve to a colour");
        assert.notEqual(mutedResolved, "", `${where}: --muted must resolve to a colour`);

        for (const row of opaque) {
          assert.ok(
            row.ratio !== null && row.ratio >= FLOOR,
            `${where}: #${row.id} placeholder is ${row.ratio}:1 (${row.color}), below the ${FLOOR}:1 floor - ` +
            "it is still inheriting the user agent's grey instead of the page's own --muted",
          );
        }

        // The rule must actually be the thing producing the colour: at least one covered field has to
        // resolve to --muted's own value rather than merely happening to clear the floor.
        const fromToken = opaque.filter((r) => r.color === mutedResolved);
        assert.ok(
          fromToken.length >= Math.ceil(opaque.length / 2),
          `${where}: only ${fromToken.length} of ${opaque.length} opaque placeholders resolve to --muted ` +
          `(${mutedResolved}); the rule is not covering the fields it should`,
        );

        // The placeholder opacity is stated explicitly, matching the .list-tools rule. It is inert in this
        // browser - measured, opacity was already 1 on every element before the rule existed - but stated
        // rather than left to the user agent, which is the hardening that rule already carries.
        for (const row of opaque) {
          assert.equal(
            row.opacity, "1",
            `${where}: #${row.id} placeholder opacity computed to ${row.opacity}, expected 1`,
          );
        }

        // Protected elements: unchanged by this bead, whatever they measure. #utterance stays a 62%
        // alpha composite (voicebox-beads-8wm8) and #file-filter keeps its two-class rule.
        const composer = rows.find((r) => r.id === "utterance");
        if (composer) {
          assert.equal(
            composer.opacity, "1",
            `${where}: #utterance placeholder opacity computed to ${composer.opacity}, expected 1`,
          );
          assert.match(
            composer.color, /\/\s*0\.62\s*\)|62%/,
            `${where}: #utterance must keep its 62% alpha composite, but its colour is ${composer.color} - ` +
            "this change flattened the composer, which is voicebox-beads-8wm8's decision to make, not this bead's",
          );
        }
        const listTools = rows.find((r) => r.id === "file-filter");
        if (listTools) {
          assert.equal(
            listTools.color, mutedResolved,
            `${where}: #file-filter must keep drawing from --muted (${mutedResolved}), but computed ${listTools.color}`,
          );
        }
      }
    }
  } finally {
    await browser?.close();
    await server.stop();
  }
});
