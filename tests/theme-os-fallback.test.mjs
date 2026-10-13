// tests/theme-os-fallback.test.mjs — the colour scheme a person gets when NO theme script can run,
// and the scheme they get for each stored choice when one can. (voicebox-beads-7xse)
//
// WHY THIS FILE EXISTS. Before this change `public/index.html` and `public/help.html` hardcoded
// `data-theme="light"` and style.css pinned `color-scheme: light`, with no `prefers-color-scheme`
// fallback anywhere. So a browser with JavaScript disabled painted light forever, whatever the
// operating system said, and there was no CSS-only way out: the attribute selector outranked any
// media query. This file is the check that the OS now decides when nothing else has.
//
// THE NO-JS CASES CANNOT USE page.evaluate, AND THAT IS THE POINT. With scripting disabled the
// evaluation context throws ("2 is not a function"), measured while scoping this bead, so those cases
// read computed styles through the CDP CSS domain instead (DOM.getDocument + DOM.querySelector +
// CSS.getComputedStyleForNode). A test that reached for evaluate here would fail for the wrong reason.
//
// NON-VACUOUS BY CONSTRUCTION: the no-JS dark case asserts the painted background is the DARK token.
// Against the old tree that assertion fails, because the document was always light — verified by
// restoring the forced attribute and watching this file go red.
//
//   node --test tests/theme-os-fallback.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startServer } from "./lib/server.mjs";
import { launch } from "./lib/cdp.mjs";

// The two grounds, quoted from the palette rather than derived, so a token change has to be deliberate.
const LIGHT_GROUND = "rgb(251, 251, 249)";
const DARK_GROUND = "rgb(11, 15, 25)";

test("theme: the OS decides when no script can, and an explicit choice still wins (voicebox-beads-7xse)", { timeout: 180000 }, async (t) => {
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "vb-7xse-")));
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

  const rootRes = await fetch(`${server.base}/api/root`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-voicebox-host-token": server.hostToken },
    body: JSON.stringify({ project: "7xse", root: { kind: "machine", path: workspace } }),
  });
  assert.equal(rootRes.ok, true, "declared workspace root");

  const page = await launch({ width: 1100, height: 800 });
  t.after(() => page.close());
  await page.send("DOM.enable");
  await page.send("CSS.enable");
  await page.send("Network.enable");

  const emulatedOs = (value) =>
    page.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value }] });
  const scripting = (value) => page.send("Emulation.setScriptExecutionDisabled", { value });

  /** Read the painted scheme without running any page script — for the JavaScript-disabled cases. */
  const readWithoutScripts = async () => {
    const doc = await page.send("DOM.getDocument", { depth: -1 });
    const computed = async (selector) => {
      const node = await page.send("DOM.querySelector", { nodeId: doc.root.nodeId, selector });
      const css = await page.send("CSS.getComputedStyleForNode", { nodeId: node.nodeId });
      return (name) => (css.computedStyle.find((p) => p.name === name) || {}).value;
    };
    const html = await computed("html");
    const body = await computed("body");
    const settings = await computed("#settings");
    return { colorScheme: html("color-scheme"), ground: body("background-color"), shadow: settings("box-shadow") };
  };

  /** Read the same three things with scripts running, plus the attributes the JS path writes. */
  const readWithScripts = () =>
    page.evaluate(() => ({
      colorScheme: getComputedStyle(document.documentElement).colorScheme,
      ground: getComputedStyle(document.body).backgroundColor,
      shadow: getComputedStyle(document.getElementById("settings")).boxShadow,
      theme: document.documentElement.dataset.theme ?? null,
      mode: document.documentElement.dataset.themeMode ?? null,
    }));

  const seedStored = async (value) => {
    const source = value === null
      ? `try{localStorage.removeItem("voicebox:theme")}catch(e){}`
      : `try{localStorage.setItem("voicebox:theme", ${JSON.stringify(value)})}catch(e){}`;
    const { identifier } = await page.send("Page.addScriptToEvaluateOnNewDocument", { source });
    return () => page.send("Page.removeScriptToEvaluateOnNewDocument", { identifier });
  };

  // ── 1. NO JAVASCRIPT AT ALL. This is the bug: the OS has to decide. ─────────────────────────
  for (const [os, expectedGround, label] of [
    ["dark", DARK_GROUND, "dark"],
    ["light", LIGHT_GROUND, "light"],
  ]) {
    await scripting(true);
    await emulatedOs(os);
    await page.goto(`${server.base}/`);
    const seen = await readWithoutScripts();
    assert.equal(
      seen.ground,
      expectedGround,
      `with JavaScript disabled on a ${label} OS the page must PAINT ${label} — this is the whole point of the bead. Without the fix it is always rgb(251, 251, 249)`,
    );
    assert.match(
      String(seen.colorScheme),
      new RegExp(label),
      `color-scheme must let the browser-drawn surfaces follow the ${label} OS too`,
    );
    // A box-shadow wrapped in light-dark() is INVALID (light-dark() resolves to a <color>), which makes
    // the computed value `none` with no error anywhere. This assertion is what stops that regression.
    assert.notEqual(seen.shadow, "none", "the card shadow must still resolve with JavaScript disabled");
  }

  // ── 2. WITH JAVASCRIPT. An explicit choice outranks the OS; nothing stored stays light. ─────
  await scripting(false);
  for (const [stored, os, expectedGround, expectedTheme, note] of [
    [null, "dark", LIGHT_GROUND, "light", "nothing stored keeps the LIGHT default the JS path has always had, by decision — it does NOT follow the OS"],
    ["dark", "light", DARK_GROUND, "dark", "an explicit dark choice beats a light OS"],
    ["light", "dark", LIGHT_GROUND, "light", "an explicit light choice beats a dark OS"],
    ["system", "dark", DARK_GROUND, "dark", "system follows a dark OS"],
    ["system", "light", LIGHT_GROUND, "light", "system follows a light OS"],
  ]) {
    const unseed = await seedStored(stored);
    await emulatedOs(os);
    await page.goto(`${server.base}/`);
    const seen = await readWithScripts();
    assert.equal(seen.theme, expectedTheme, `${note} (ground ${seen.ground})`);
    assert.equal(seen.ground, expectedGround, `${note} — the painted ground must match`);
    assert.notEqual(seen.shadow, "none", "the card shadow must resolve with scripts running");
    await unseed();
  }

  // ── 3. GUARD FAILURE. theme-boot.js blocked, scripts fine: theme.mjs must still honour storage. ──
  await page.send("Network.setBlockedURLs", { urls: ["*theme-boot.js*"] });
  const unseed = await seedStored("dark");
  await emulatedOs("light");
  await page.goto(`${server.base}/`);
  const withoutGuard = await readWithScripts();
  assert.equal(
    withoutGuard.theme,
    "dark",
    "with the pre-paint guard blocked but scripts running, the stored choice must still be applied by theme.mjs",
  );
  await unseed();
  await page.send("Network.setBlockedURLs", { urls: [] });
});
