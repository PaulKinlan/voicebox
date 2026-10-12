// tests/help-theme-first-paint.test.mjs — the Help page's theme: right at the FIRST paint, and still
// following the system scheme long after it. (voicebox-beads-uj16, voicebox-beads-ftqe)
//
// WHY THIS FILE EXISTS. public/help.html used to carry its own copy of the theme decision, inline, as the
// LAST thing in <body>. That copy read the same localStorage key and applied the same attribute, so every
// "does the theme persist" check passed, while it quietly disagreed with the owner on `system`, on
// data-theme-mode, and on the listener.
//
// WHAT WAS ACTUALLY WRONG, MEASURED RATHER THAN ASSUMED. The obvious story — "a script at the end of the
// body runs after the first paint, so the page flashed" — is FALSE here. This file's first version asserted
// exactly that, and it failed. The copy was an inline CLASSIC script, so it ran during parsing: on the exact
// pre-uj16 markup it set the attribute at 1ms with the first frame at 13ms already dark. The xpwt flash came
// from a DEFERRED MODULE, which is a different timing. So the defect was DIVERGENCE — and once the shared
// guard replaced the copy, the guard's one-shot system resolution introduced a real regression that a
// reviewer caught (voicebox-beads-ftqe): with "system" stored, an operating-system switch while the page was
// open left it light while the room followed. public/help-theme.mjs imports the shared module for that.
//
// WHY THE ASSERTIONS ARE AT THE FIRST rAF: every version of a late-apply bug ends up correct once the page
// settles, so a test that samples late passes on the broken implementation AND the fixed one.
// requestAnimationFrame callbacks run in the frame's rendering steps BEFORE that frame is painted, so what
// is read inside the first rAF is what the first painted frame had.
//
// THE CONTROLS ARE FAITHFUL ON PURPOSE. An earlier control removed the guard and showed the page was then
// wrong — which proves the guard is load-bearing, but not that the OLD page flashed, because the old page
// had a body-end copy that the control never restored. A reviewer rejected that as insufficient (correctly).
// Section 4 rebuilds the pre-uj16 arrangement from the CURRENT file, measures ITS first frame, and asserts
// what is actually true.
//
//   node --test tests/help-theme-first-paint.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "./lib/server.mjs";
import { launch } from "./lib/cdp.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const LIGHT_GROUND = "rgb(251, 251, 249)";
const DARK_GROUND = "rgb(11, 15, 25)";

// Registered at document-start, before any page script: what the first frame looked like, and when the
// dark scheme first appeared (so "it applied the theme late" is measured, not inferred from the end state).
const SAMPLER = `
  window.__rec = { t0: performance.now(), firstRaf: null, firstDarkAt: null };
  const noteDark = () => {
    if (window.__rec.firstDarkAt === null && document.documentElement.dataset.theme === "dark") {
      window.__rec.firstDarkAt = Math.round(performance.now() - window.__rec.t0);
    }
  };
  requestAnimationFrame(() => {
    window.__rec.firstRaf = {
      t: Math.round(performance.now() - window.__rec.t0),
      theme: document.documentElement.dataset.theme ?? null,
      mode: document.documentElement.dataset.themeMode ?? null,
      bg: getComputedStyle(document.body || document.documentElement).backgroundColor,
      colorScheme: getComputedStyle(document.documentElement).colorScheme ?? null,
    };
    noteDark();
  });
  new MutationObserver(noteDark).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
`;
const seed = (value) =>
  value === null
    ? "try { localStorage.removeItem('voicebox:theme'); } catch (e) {}"
    : `try { localStorage.setItem('voicebox:theme', ${JSON.stringify(value)}); } catch (e) {}`;

/** The pre-uj16 arrangement, rebuilt from the CURRENT page so it cannot silently drift out of date. */
const OLD_BODY_END_COPY = [
  "      try {",
  '        const savedTheme = localStorage.getItem("voicebox:theme");',
  '        if (savedTheme === "dark" || savedTheme === "light") {',
  "          document.documentElement.dataset.theme = savedTheme;",
  "        }",
  "      } catch {}",
].join("\n");

function preUj16Markup(currentSource, samplerSource) {
  let out = currentSource;
  // (1) That page had no guard and no module: the decision was applied by the copy in (2).
  const withTags = out;
  out = out.replace(/\s*<script src="\/theme-boot\.js"><\/script>/, "");
  out = out.replace(/\s*<script type="module" src="\/help-theme\.mjs"><\/script>/, "");
  assert.notEqual(out, withTags, "the guard and module tags must have been present for the control to remove");
  // (2) The copy goes back at the END of <body>, which is where it was and why it ran after the paint.
  const anchor = "    (() => {\n";
  assert.ok(out.includes(anchor), "the body-end script must still begin with the IIFE the copy lived in");
  out = out.replace(anchor, `${anchor}${OLD_BODY_END_COPY}\n`);
  // (3) The measuring instrument. The old page had no head script; this one does, and that is the only
  // addition — without it there is nothing to read the first frame with.
  out = out.replace("<head>", `<head>\n  <script>${samplerSource}</script>`);
  return out;
}

test("help.html applies the stored theme at the FIRST paint and keeps following the system (voicebox-beads-uj16 + ftqe)", { timeout: 180000 }, async (t) => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "vb-help-paint-"));
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
  await page.send("DOM.enable");
  await page.send("CSS.enable");
  await page.send("Network.enable");
  const emulatedOs = (value) =>
    page.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value }] });
  const settle = () => new Promise((r) => setTimeout(r, 300));
  const helpSource = fs.readFileSync(path.join(here, "..", "public", "help.html"), "utf8");

  // ── 1. WITH SCRIPTING: the stored choice must already be applied in the first frame. ─────────────
  for (const [stored, os, expectedTheme, expectedGround, note] of [
    ["dark", "light", "dark", DARK_GROUND, "a stored dark choice beats a light OS"],
    ["light", "dark", "light", LIGHT_GROUND, "a stored light choice beats a dark OS"],
    ["system", "dark", "dark", DARK_GROUND, "system follows a dark OS"],
    [null, "dark", "light", LIGHT_GROUND, "nothing stored stays light with scripting — the same default index.html keeps"],
  ]) {
    const { identifier: seedId } = await page.send("Page.addScriptToEvaluateOnNewDocument", { source: seed(stored) });
    const { identifier: samplerId } = await page.send("Page.addScriptToEvaluateOnNewDocument", { source: SAMPLER });
    await emulatedOs(os);
    await page.goto(`${server.base}/help.html`);
    const rec = await page.evaluate(() => window.__rec);
    await page.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: seedId });
    await page.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: samplerId });

    assert.ok(rec.firstRaf, "the first requestAnimationFrame must have been sampled");
    assert.equal(
      rec.firstRaf.theme,
      expectedTheme,
      `${note} — the theme must be right AT THE FIRST PAINT, not after it. First frame was "${rec.firstRaf.theme}" at ${rec.firstRaf.t}ms (bg ${rec.firstRaf.bg}), dark arriving at ${rec.firstDarkAt}ms`,
    );
    assert.equal(rec.firstRaf.bg, expectedGround, `${note} — the first painted ground must match`);
    assert.match(String(rec.firstRaf.colorScheme), new RegExp(expectedTheme), "the browser-drawn surfaces must follow the same scheme");
  }

  // ── 2. THE GUARD IS SHARED, AND THE LISTENER COMES FROM THE SHARED MODULE (ftqe). ────────────────
  assert.match(helpSource, /<script src="\/theme-boot\.js"><\/script>/, "help.html must load the shared guard");
  assert.match(helpSource, /<script type="module" src="\/help-theme\.mjs"><\/script>/, "help.html must import the module that owns the system listener");
  assert.doesNotMatch(helpSource, /data-theme\s*=/, "help.html must not apply data-theme itself — that is the duplicate this bead removed");
  assert.doesNotMatch(
    helpSource,
    /localStorage[\s\S]{0,120}voicebox:theme/,
    "help.html must not read the storage key itself — that decision belongs to theme.mjs",
  );
  const guardTag = /<script[^>]*src="\/theme-boot\.js"[^>]*>/.exec(helpSource)[0];
  assert.doesNotMatch(guardTag, /type=|defer|async/, "the guard must stay a CLASSIC script, or it runs after the paint again");
  assert.ok(
    helpSource.indexOf("/theme-boot.js") < helpSource.indexOf('<link rel="stylesheet"'),
    "the guard must sit in <head> BEFORE the stylesheet, mirroring index.html",
  );

  // ── 3. THE SYSTEM SCHEME CHANGING WHILE THE PAGE IS OPEN (voicebox-beads-ftqe). ──────────────────
  // The guard resolves the system scheme once; the shared module's listener is what keeps up. With the
  // module blocked this section is the reviewer's blocker, so it is the RED control too.
  for (const blocked of [false, true]) {
    await page.send("Network.setBlockedURLs", { urls: blocked ? ["*help-theme.mjs*"] : [] });
    const { identifier: seedId } = await page.send("Page.addScriptToEvaluateOnNewDocument", { source: seed("system") });
    await emulatedOs("light");
    await page.goto(`${server.base}/help.html`);
    const atLight = await page.evaluate(() => document.documentElement.dataset.theme);
    await emulatedOs("dark");
    await settle();
    const afterDark = await page.evaluate(() => ({
      theme: document.documentElement.dataset.theme,
      bg: getComputedStyle(document.body).backgroundColor,
    }));
    await emulatedOs("light");
    await settle();
    const backToLight = await page.evaluate(() => document.documentElement.dataset.theme);
    await page.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: seedId });

    if (blocked) {
      assert.equal(
        afterDark.theme,
        "light",
        "CONTROL: with help-theme.mjs blocked, a stored `system` choice must stay light when the OS turns dark — this is voicebox-beads-ftqe, and it is what the shared module fixes",
      );
    } else {
      assert.equal(atLight, "light", "system on a light OS starts light");
      assert.equal(
        afterDark.theme,
        "dark",
        "a stored `system` choice must FOLLOW the OS turning dark while the page is open — the guard alone resolves once and cannot do this (voicebox-beads-ftqe)",
      );
      assert.equal(afterDark.bg, DARK_GROUND, "and the page must repaint, not just carry the attribute");
      assert.equal(backToLight, "light", "and it must follow the OS back to light");
    }
  }
  await page.send("Network.setBlockedURLs", { urls: [] });

  // An EXPLICIT choice must not move when the OS moves.
  {
    const { identifier: seedId } = await page.send("Page.addScriptToEvaluateOnNewDocument", { source: seed("dark") });
    await emulatedOs("light");
    await page.goto(`${server.base}/help.html`);
    await emulatedOs("dark");
    await settle();
    const still = await page.evaluate(() => document.documentElement.dataset.theme);
    await page.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: seedId });
    assert.equal(still, "dark", "an explicit dark choice must survive the OS switching, in both directions");
  }

  // ── 4. CONTROLS, MEASURED — INCLUDING ONE THAT REFUTES THIS BEAD'S ORIGINAL PREMISE. ───────────
  const frameId = (await page.send("Page.getFrameTree")).frameTree.frame.id;
  {
    // (a) The faithful pre-uj16 markup: guard and module removed, the body-end copy restored.
    const { identifier: seedId } = await page.send("Page.addScriptToEvaluateOnNewDocument", { source: seed("dark") });
    await emulatedOs("light");
    await page.goto(`${server.base}/help.html`);
    await page.send("Page.setDocumentContent", { frameId, html: preUj16Markup(helpSource, SAMPLER) });
    await settle();
    const rec = await page.evaluate(() => window.__rec);
    await page.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: seedId });

    assert.ok(rec.firstRaf, "the old arrangement must have been sampled at its first frame");
    assert.equal(
      rec.firstRaf.theme,
      "dark",
      `CONTROL: the PRE-uj16 page applied a stored dark choice BEFORE the first frame (dark at ${rec.firstDarkAt}ms, first frame at ${rec.firstRaf.t}ms) — it did NOT flash. Its copy was an inline classic script, which runs during parsing; the xpwt flash came from a deferred module. This assertion is the CORRECTION of this bead's original premise, and it is deliberately written to fail if that premise is ever silently restored`,
    );
    assert.equal(rec.firstRaf.bg, DARK_GROUND, "CONTROL: and it painted the dark ground in that first frame");
  }
  // (b) The ordering guarantee is STRUCTURAL, and it is asserted rather than raced. Whether a deferred
  // module happens to beat the first paint depends on the network and the CPU: measured in this file's own
  // runs, the module applied BEFORE the first frame when it was cached and AFTER it under load, so a control
  // asserting either outcome is flaky — which is exactly what an earlier version of this section was. What
  // is determinate is the shape: the guard is a classic script with no defer/async, while the module carries
  // type="module" and is therefore deferred by definition, so the guard is the only one of the two that CAN
  // run before the paint.
  const moduleTag = /<script[^>]*src="\/help-theme\.mjs"[^>]*>/.exec(helpSource)[0];
  assert.match(
    moduleTag,
    /type="module"/,
    "the module must stay a module — that deferral is precisely why the guard is needed for the first frame",
  );

  // ── 5. WITH NO SCRIPTING: 7xse's CSS must still carry the OS fallback on this page too. ─────────
  await page.send("Emulation.setScriptExecutionDisabled", { value: true });
  for (const [os, expectedGround] of [["dark", DARK_GROUND], ["light", LIGHT_GROUND]]) {
    await emulatedOs(os);
    await page.goto(`${server.base}/help.html`);
    const doc = await page.send("DOM.getDocument", { depth: -1 });
    const node = await page.send("DOM.querySelector", { nodeId: doc.root.nodeId, selector: "body" });
    const css = await page.send("CSS.getComputedStyleForNode", { nodeId: node.nodeId });
    const ground = (css.computedStyle.find((p) => p.name === "background-color") || {}).value;
    assert.equal(
      ground,
      expectedGround,
      `with scripting disabled on a ${os} OS, help.html must still paint ${os} from the stylesheet alone`,
    );
  }
  await page.send("Emulation.setScriptExecutionDisabled", { value: false });
});
