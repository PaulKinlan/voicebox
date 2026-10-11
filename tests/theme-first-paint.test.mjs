// tests/theme-first-paint.test.mjs — the theme must be right AT THE FIRST PAINT, not shortly after.
//
// voicebox-beads-xpwt. Before public/theme-boot.js existed, the theme was applied by public/theme.mjs,
// which fused.js imports — and module scripts are always deferred, so the apply happened after the first
// paint. Measured then: with dark stored, FCP 76ms and dark applied 78ms. A person who chose dark saw
// light first, on every load.
//
// WHY THE ASSERTION IS AT THE FIRST rAF, and why an "eventually dark" test would be worthless here: every
// version of this bug ends up dark. Sampling after the page settles passes on the broken implementation
// AND on the fixed one, which is why the defect survived a browser test that already drove theme
// persistence (tests/theme-browser.test.mjs). requestAnimationFrame callbacks run in the frame's
// rendering steps BEFORE that frame is painted, so the value read inside the first rAF is the value the
// first painted frame had.
//
// The negative control is not decoration: this file must FAIL, on the dark case, with public/theme-boot.js
// removed from public/index.html. Verified that way (RED before, GREEN after) before hand-off.
//
//   node --test tests/theme-first-paint.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startServer } from "./lib/server.mjs";
import { launch } from "./lib/cdp.mjs";

// Registered at document-start, before any page script: what the first frame looked like.
const SAMPLER = `
  window.__rec = { t0: performance.now(), firstRaf: null, darkAt: null };
  requestAnimationFrame(() => {
    const cs = getComputedStyle(document.documentElement);
    window.__rec.firstRaf = {
      t: Math.round(performance.now() - window.__rec.t0),
      theme: document.documentElement.dataset.theme ?? null,
      mode: document.documentElement.dataset.themeMode ?? null,
      bg: getComputedStyle(document.body || document.documentElement).backgroundColor,
      // The craft-floor "browser surfaces" check: the parts nobody drew - scrollbars, the caret, text
      // selection, form controls - are themed by color-scheme, which style.css sets from data-theme. So a
      // guard that only rewrote the color-scheme META would leave these on the old scheme at first paint.
      colorScheme: cs.colorScheme ?? null,
    };
  });
  const tick = () => {
    if (document.documentElement.dataset.theme === "dark" && window.__rec.darkAt === null) {
      window.__rec.darkAt = Math.round(performance.now() - window.__rec.t0);
    }
  };
  new MutationObserver(tick).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  tick();
`;

const seed = (value) =>
  value === null
    ? "try { localStorage.removeItem('voicebox:theme'); } catch (e) {}"
    : `try { localStorage.setItem('voicebox:theme', ${JSON.stringify(value)}); } catch (e) {}`;

test("theme is applied by the first paint, from a stored preference (voicebox-beads-xpwt)", { timeout: 180000 }, async (t) => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "vb-first-paint-"));
  const workspace = path.join(scratch, "project");
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, "notes.md"), "# Notes\n", "utf8");

  const server = await startServer({
    env: {
      VOICEBOX_WORKSPACE: workspace,
      VOICEBOX_RESOLVER: "script",
      VOICEBOX_SANDBOX_HOMES: path.join(scratch, "sandbox-homes"),
    },
  });
  t.after(async () => {
    await server.stop();
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  const page = await launch({ width: 1180, height: 820 });
  t.after(() => page.close());

  const { identifier: samplerId } = await page.send("Page.addScriptToEvaluateOnNewDocument", { source: SAMPLER });
  // NOTE: no t.after() to remove the sampler. `after` hooks run in registration order, so a
  // remove-on-close hook would call page.send() on a socket that page.close() had already shut, and that
  // promise never settles — it hung this test at teardown while every assertion had already passed. The
  // sampler dies with the browser, which this test closes, and the OS-scheme emulation is per-page too.

  const shotDir = "/tmp/xpwt-screens";

  /**
   * Navigate with a stored preference and an OS scheme already in place, then read what the FIRST frame
   * looked like. Both the seed and the sampler are registered before any page script runs.
   */
  const firstPaint = async ({ stored, osDark, name }) => {
    const { identifier } = await page.send("Page.addScriptToEvaluateOnNewDocument", { source: seed(stored) });
    await page.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-color-scheme", value: osDark ? "dark" : "light" }],
    });
    try {
      await page.goto(`${server.base}/`);
      await page.waitFor(() => window.__rec && window.__rec.firstRaf !== null, { label: `first rAF for ${name}` });
      const rec = await page.evaluate(() => ({
        firstRaf: window.__rec.firstRaf,
        darkAt: window.__rec.darkAt,
        paint: performance.getEntriesByType("paint").map((e) => ({ name: e.name, at: Math.round(e.startTime) })),
        bootApplied: document.documentElement.dataset.themeMode ?? null,
        settled: document.documentElement.dataset.theme,
      }));
      fs.mkdirSync(shotDir, { recursive: true });
      await page.screenshot(path.join(shotDir, `${name}.png`));
      return rec;
    } finally {
      await page.send("Page.removeScriptToEvaluateOnNewDocument", { identifier });
    }
  };

  // ── The defect: an explicit dark preference must be dark in the first frame ────────────────────
  const dark = await firstPaint({ stored: "dark", osDark: false, name: "1-dark-stored" });
  assert.equal(
    dark.firstRaf.theme,
    "dark",
    `a stored dark preference must be dark AT THE FIRST PAINT, not after it. First frame was ${JSON.stringify(dark.firstRaf.theme)} at ${dark.firstRaf.t}ms (bg ${dark.firstRaf.bg}); paints: ${JSON.stringify(dark.paint)}`,
  );
  assert.equal(dark.firstRaf.mode, "dark", "the preference is recorded in the first frame too, not only the scheme");
  assert.match(
    String(dark.firstRaf.colorScheme),
    /dark/,
    `color-scheme must already be dark in the first frame, so the browser-drawn surfaces (scrollbars, caret, text selection, form controls) are not left on the light scheme. Got ${JSON.stringify(dark.firstRaf.colorScheme)}`,
  );

  // ── An explicit light preference must stay light even on a dark OS ─────────────────────────────
  const light = await firstPaint({ stored: "light", osDark: true, name: "2-light-stored-dark-os" });
  assert.equal(light.firstRaf.theme, "light", "an explicit light choice must be light in the first frame even when the OS is dark");
  assert.match(String(light.firstRaf.colorScheme), /light/, "an explicit light choice keeps the browser-drawn surfaces light too");

  // ── system resolves against the OS before paint ───────────────────────────────────────────────
  const systemDark = await firstPaint({ stored: "system", osDark: true, name: "3-system-stored-dark-os" });
  assert.equal(systemDark.firstRaf.theme, "dark", "system on a dark OS must be dark in the first frame");
  assert.equal(systemDark.firstRaf.mode, "system", "the preference stays 'system' — only the effective scheme is resolved");
  assert.match(String(systemDark.firstRaf.colorScheme), /dark/, "color-scheme follows the resolved system scheme before the first paint too");

  // ── Nothing stored: still light, and it must NOT start following the OS by itself ──────────────
  const none = await firstPaint({ stored: null, osDark: true, name: "4-nothing-stored" });
  assert.equal(none.firstRaf.theme, "light", "nothing stored stays light — this guard must not silently adopt the OS scheme");

  // ── The guard must not be doing this work late: it is in the head, so it beat the first frame ──
  for (const [rec, want] of [[dark, "dark"], [light, "light"], [systemDark, "dark"], [none, "light"]]) {
    assert.equal(rec.settled, want, "the settled theme agrees with the first frame");
  }
});
