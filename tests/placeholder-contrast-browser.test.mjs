// tests/placeholder-contrast-browser.test.mjs — the room and Help pages must not draw placeholder text
// from the user agent's grey (voicebox-beads-0q5c).
//
// The floor is 4.5:1, applied to placeholder text the same way `tests/ui-ux-accessibility.test.mjs`
// applies it to the Environment page. Before voicebox-beads-0q5c the room and Help fields measured
// 4.45:1 light / 4.16:1 dark, and the two transcript fields 4.19:1 / 3.17:1 on their darker ground.
//
// Two things this test deliberately does NOT assert, because asserting them would be false:
//   1. That EVERY placeholder is governed by this rule. `#utterance` in the composer is deliberately NOT:
//      it is a translucent mix of `--muted` kept quieter than typed text, so it has its own declaration and
//      its own assertions at the end of this file, which hold it to the same floor while requiring that it
//      stay translucent. It was 62% (2.68:1 light / 3.46:1 dark) until voicebox-beads-8wm8 raised it to 90%.
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

// Composer-specific measurement, in pixels. The placeholder colour here is a color-mix() that resolves to a
// syntax this file's other helper would have to parse; painting it over the field's real ground and reading
// bytes avoids assuming any format, and alpha comes from a black/white pixel pair.
const CANONICAL = () => {
  const el = document.querySelector("#utterance");
  if (!el) return { found: false };
  const cv = document.createElement("canvas"); cv.width = 1; cv.height = 1;
  const ctx = cv.getContext("2d", { willReadFrequently: true });
  const paint = (bg, fg) => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = bg; ctx.fillRect(0, 0, 1, 1);
    if (fg) { ctx.fillStyle = fg; ctx.fillRect(0, 0, 1, 1); } const d = ctx.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2]]; };
  let ground = [255, 255, 255];
  for (let node = el; node; node = node.parentElement) {
    const c = getComputedStyle(node).backgroundColor;
    if (c && c !== "rgba(0, 0, 0, 0)" && c !== "transparent") { ground = paint("rgb(255,255,255)", c); break; }
  }
  const ph = getComputedStyle(el, "::placeholder");
  const raw = ph.color;
  // The pseudo-element's own opacity is applied ON TOP of the colour's alpha. A rule setting opacity: .5
  // fades the rendered text while leaving this colour's alpha untouched, which is why the canvas ratio alone
  // was blind to it (voicebox-beads-1g1h). Visible = the composited colour blended over the ground again by
  // that opacity, which is what a reader's eye receives.
  const phOpacity = Math.min(1, Math.max(0, parseFloat(ph.opacity)));
  const composited = paint(`rgb(${ground.join(",")})`, raw);
  const ob = paint("rgb(0,0,0)", raw), ow = paint("rgb(255,255,255)", raw);
  const alpha = Math.min(1, Math.max(0, 1 - (ow[1] - ob[1]) / 255));
  const lum = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return +((Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)).toFixed(2); };
  const seen = composited.map((v, i) => v * phOpacity + ground[i] * (1 - phOpacity));
  return { found: true, alpha: +alpha.toFixed(3), ratio: ratio(composited, ground),
    opacity: phOpacity, seenRatio: ratio(seen, ground),
    inkRatio: ratio(paint("rgb(255,255,255)", getComputedStyle(el).color), ground) };
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

  // The composer keeps its own declaration, deliberately translucent and deliberately quieter than typed
  // text. Pinned by shape so a silent reduction back under the floor fails here as well as on the computed
  // ratio below. 90% is the percentage this change pins, chosen for HEADROOM: 88% is the bare clearing candidate,
  // at 4.54:1 light and 5.61:1 dark, only 0.04 above the floor in light, which is inside rendering variance
  // (voicebox-beads-8wm8). This test asserts the chosen percentage, not that it is the minimum.
  assert.match(
    styleRules,
    /\.composer input::placeholder\s*\{\s*color:\s*color-mix\(in srgb,\s*var\(--muted\)\s*90%,\s*transparent\);\s*\}/,
    "the composer must keep its own translucent 90% mix; a weaker percentage drops it back under the floor",
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

        // The composer is its own rule with its own bar (voicebox-beads-8wm8): it must clear the same floor
        // while staying VISIBLY quieter than typed text, i.e. translucent and clearly below it. Measured with
        // canvas pixels rather than by parsing a colour string, so an oklch()/color() value cannot fool it.
        const composer = rows.find((r) => r.id === "utterance");
        if (pagePath === "/") {
          assert.ok(composer, `${where}: #utterance must be enumerated; the composer guard would be vacuous`);
          const c = await page.evaluate(CANONICAL);
          assert.ok(c.found, `${where}: #utterance must exist in the live UI`);
          // The pseudo-element's own opacity must not fade the text. 0q5c asserted exactly this and this
          // bead's rewrite dropped it, which left the suite green against a rule that visibly halved the
          // placeholder's contrast (voicebox-beads-1g1h). Both assertions run in each stored theme because
          // this block sits inside the theme loop.
          assert.equal(
            composer.opacity, "1",
            `${where}: #utterance ::placeholder computed opacity is ${composer.opacity}, expected 1 - ` +
            "an opacity below 1 fades the rendered text even when the colour's own alpha is unchanged",
          );
          assert.equal(
            c.opacity, 1,
            `${where}: #utterance ::placeholder opacity measured ${c.opacity} in the pixel probe, expected 1`,
          );
          assert.ok(
            c.ratio >= FLOOR,
            `${where}: composer placeholder composites to ${c.ratio}:1 over its own ground ` +
            `(alpha ${c.alpha}), below the ${FLOOR}:1 floor`,
          );
          // The ratio a reader actually sees, with the pseudo-element's opacity applied. This is the
          // assertion that stays RED for an injected opacity: .5 while every colour-based check passes.
          assert.ok(
            c.seenRatio >= FLOOR,
            `${where}: composer placeholder renders at ${c.seenRatio}:1 once the pseudo-element's own ` +
            `opacity (${c.opacity}) is applied, below the ${FLOOR}:1 floor even though its colour is fine`,
          );
          assert.ok(
            c.alpha < 1,
            `${where}: composer placeholder alpha measured ${c.alpha}; it must stay translucent rather than ` +
            "be flattened to the opaque --muted token",
          );
          assert.ok(
            c.inkRatio > c.ratio + 1,
            `${where}: the composer placeholder (${c.ratio}:1) must stay clearly quieter than typed text ` +
            `(${c.inkRatio}:1); the de-emphasis is the point of the mix`,
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
