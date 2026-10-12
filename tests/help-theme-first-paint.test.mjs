// tests/help-theme-first-paint.test.mjs — help.html must apply the stored theme AT THE FIRST PAINT,
// from the shared guard. (voicebox-beads-uj16)
//
// WHY THIS FILE EXISTS. public/help.html used to carry its own copy of the theme decision, inline, as the
// LAST thing in <body>. That copy read the same localStorage key and applied the same attribute, so every
// "does the theme persist" check passed — and the page still painted the wrong scheme first for anyone who
// had chosen light or dark, because the apply happened after the first paint. The defect is the TIMING,
// not the duplication: the duplication is only why nobody noticed. The fix loads the same
// public/theme-boot.js that index.html loads, in <head>, and deletes the body-end copy.
//
// WHY THE ASSERTION IS AT THE FIRST rAF, AND WHY "eventually dark" WOULD BE WORTHLESS: every version of
// this bug ends up dark. Sampling after the page settles passes on the broken implementation AND on the
// fixed one. requestAnimationFrame callbacks run in the frame's rendering steps BEFORE that frame is
// painted, so what is read inside the first rAF is what the first painted frame had. tests/theme-first-
// paint.test.mjs measures the same thing on index.html, and the two files exist because the pages are
// separate documents with separate script loads.
//
// THE NEGATIVE CONTROL IS NOT DECORATION. This file must FAIL, on the stored-dark case, when
// public/help.html does not load the guard in <head> — verified that way (RED before, GREEN after) before
// hand-off, by restoring the old body-end copy.
//
//   node --test tests/help-theme-first-paint.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startServer } from "./lib/server.mjs";
import { launch } from "./lib/cdp.mjs";

const LIGHT_GROUND = "rgb(251, 251, 249)";
const DARK_GROUND = "rgb(11, 15, 25)";

// Registered at document-start, before any page script: what the first frame looked like.
const SAMPLER = `
  window.__rec = { t0: performance.now(), firstRaf: null };
  requestAnimationFrame(() => {
    window.__rec.firstRaf = {
      t: Math.round(performance.now() - window.__rec.t0),
      theme: document.documentElement.dataset.theme ?? null,
      mode: document.documentElement.dataset.themeMode ?? null,
      bg: getComputedStyle(document.body || document.documentElement).backgroundColor,
      colorScheme: getComputedStyle(document.documentElement).colorScheme ?? null,
    };
  });
`;
const seed = (value) =>
  value === null
    ? "try { localStorage.removeItem('voicebox:theme'); } catch (e) {}"
    : `try { localStorage.setItem('voicebox:theme', ${JSON.stringify(value)}); } catch (e) {}`;

test("help.html applies a stored preference at the FIRST paint, from the shared guard (voicebox-beads-uj16)", { timeout: 180000 }, async (t) => {
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
  const emulatedOs = (value) =>
    page.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value }] });

  // ── 1. WITH SCRIPTING: the stored choice must already be applied in the first frame. ──────────
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
    const rec = await page.evaluate(() => window.__rec.firstRaf);
    await page.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: seedId });
    await page.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: samplerId });

    assert.ok(rec, "the first requestAnimationFrame must have been sampled");
    assert.equal(
      rec.theme,
      expectedTheme,
      `${note} — the theme must be right AT THE FIRST PAINT, not after it. The old body-end copy in help.html left this null (or the previous scheme) in the first frame. First frame was "${rec.theme}" at ${rec.t}ms (bg ${rec.bg})`,
    );
    assert.equal(rec.bg, expectedGround, `${note} — the first painted ground must match`);
    assert.match(String(rec.colorScheme), new RegExp(expectedTheme), "the browser-drawn surfaces must follow the same scheme");
  }

  // ── 2. THE GUARD MUST BE SHARED, NOT COPIED. The whole bead is that help.html stopped carrying its own. ──
  const helpSource = fs.readFileSync(new URL("../public/help.html", import.meta.url), "utf8");
  assert.match(
    helpSource,
    /<script src="\/theme-boot\.js"><\/script>/,
    "help.html must load the shared public/theme-boot.js",
  );
  assert.doesNotMatch(
    helpSource,
    /data-theme\s*=/,
    "help.html must not apply data-theme itself any more — that is the duplicate this bead removed",
  );
  const guardTag = /<script[^>]*src="\/theme-boot\.js"[^>]*>/.exec(helpSource)[0];
  assert.doesNotMatch(guardTag, /type=|defer|async/, "the guard must stay a CLASSIC script — deferred or module means it runs after the paint again");
  assert.ok(
    helpSource.indexOf("/theme-boot.js") < helpSource.indexOf("<link rel=\"stylesheet\""),
    "the guard must sit in <head> BEFORE the stylesheet, mirroring index.html",
  );

  // ── 3. WITH NO SCRIPTING: 7xse's CSS must still carry the OS fallback on this page too. ──────
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
