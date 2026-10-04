// tests/mic-rings-removed.test.mjs — remove decorative rings/halos around microphone (voicebox-beads-yf33)
//
// Paul (2026-10-04): "Remove the rings around the microphone"
//
// What each check proves, driven in a real browser over CDP:
//   1. Decorative outside rings (#sqeh-arcs) are completely removed from the DOM.
//   2. The microphone button (#mic) has NO outer halo box-shadow at rest, listening, or speaking.
//   3. Single-mic focusable accessibility: exactly ONE focusable mic in the tab order.
//   4. Dock stand-in behavior:
//      - While in view, #mic is focusable (tabIndex 0) and #mic-dock is hidden.
//      - When scrolled out of view, #mic-dock stands in and #mic steps out (tabIndex -1, aria-hidden=true).
//      - Clicking #mic-dock delegates click directly to #mic.
//      - Scrolling back restores #mic and hides the dock.

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "./lib/server.mjs";
import { launch } from "./lib/cdp.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let server;
let BASE;
let page;

test.before(async () => {
  server = await startServer({
    cwd: ROOT,
    env: { VOICEBOX_INSTANCE: "mic-rings-removed-test" },
  });
  BASE = server.base;
  page = await launch();
  await page.goto(`${BASE}/`);
  await page.waitFor(() => document.getElementById("mic") !== null, { label: "the mic button" });
});

test.after(async () => {
  await page?.close();
  await server?.stop();
});

test("decorative outside rings (#sqeh-arcs) are removed from the DOM", async () => {
  const result = await page.evaluate(() => {
    const sqehArcs = document.getElementById("sqeh-arcs");
    const arcElements = document.querySelectorAll(".sqeh-arcs, .mic-stage > i");
    return {
      hasSqehArcs: Boolean(sqehArcs),
      arcElementsCount: arcElements.length,
    };
  });

  assert.equal(result.hasSqehArcs, false, "#sqeh-arcs element must not exist in DOM");
  assert.equal(result.arcElementsCount, 0, "no decorative arc/ring elements inside .mic-stage");
});

test("microphone (#mic) has no outer halo box-shadow at rest, listening, or speaking", async () => {
  const states = await page.evaluate(() => {
    const mic = document.getElementById("mic");
    const stage = document.getElementById("voice-ring-wrap");
    if (!mic || !stage) return null;

    // Helper to check for spread-radius halo (e.g. 0 0 0 10px ...)
    const hasHalo = (boxShadowStr) => {
      // Halo rings use 0 0 0 <spread>px or similar outer ring patterns
      return /0px\s+0px\s+0px\s+\d+px/i.test(boxShadowStr);
    };

    // 1. At rest
    stage.dataset.voice = "off";
    const restShadow = getComputedStyle(mic).boxShadow;

    // 2. Listening
    stage.dataset.voice = "listening";
    const listeningShadow = getComputedStyle(mic).boxShadow;

    // 3. Speaking
    stage.dataset.voice = "speaking";
    const speakingShadow = getComputedStyle(mic).boxShadow;

    // Reset back to off
    stage.dataset.voice = "off";

    return {
      restShadow,
      listeningShadow,
      speakingShadow,
      restHasHalo: hasHalo(restShadow),
      listeningHasHalo: hasHalo(listeningShadow),
      speakingHasHalo: hasHalo(speakingShadow),
    };
  });

  assert.ok(states, "mic and stage elements must exist");
  assert.equal(states.restHasHalo, false, `mic at rest must have no halo ring (got: ${states.restShadow})`);
  assert.equal(states.listeningHasHalo, false, `mic when listening must have no halo ring (got: ${states.listeningShadow})`);
  assert.equal(states.speakingHasHalo, false, `mic when speaking must have no halo ring (got: ${states.speakingShadow})`);
});

test("single-mic focusable accessibility: exactly one focusable mic on page", async () => {
  const a11y = await page.evaluate(() => {
    const mic = document.getElementById("mic");
    const dock = document.getElementById("mic-dock");
    if (!mic || !dock) return null;

    const allMics = [mic, dock];
    const focusable = allMics.filter((el) => !el.hidden && el.tabIndex >= 0 && el.getAttribute("aria-hidden") !== "true");

    return {
      micPresent: Boolean(mic),
      micTagName: mic.tagName.toLowerCase(),
      micTabIndex: mic.tabIndex,
      micAriaHidden: mic.getAttribute("aria-hidden"),
      micAriaPressed: mic.getAttribute("aria-pressed"),
      micAriaLabel: mic.getAttribute("aria-label"),
      micAriaKeyShortcuts: mic.getAttribute("aria-keyshortcuts"),
      dockHidden: dock.hidden,
      focusableMicsCount: focusable.length,
    };
  });

  assert.ok(a11y, "mic elements must be found");
  assert.equal(a11y.micTagName, "button", "#mic must be an accessible HTML button");
  assert.equal(a11y.micTabIndex, 0, "#mic must be in normal tab order (tabIndex 0)");
  assert.equal(a11y.micAriaHidden, null, "#mic must not be aria-hidden when in viewport");
  assert.equal(a11y.micAriaPressed, "false", "#mic aria-pressed defaults to false");
  assert.match(a11y.micAriaLabel ?? "", /listening|speak/i, "#mic must have an explicit aria-label");
  assert.equal(a11y.micAriaKeyShortcuts, "M", "#mic must declare hotkey shortcut M");
  assert.equal(a11y.dockHidden, true, "#mic-dock must be hidden while #mic is in view");
  assert.equal(a11y.focusableMicsCount, 1, "exactly ONE focusable mic in accessibility tree");
});

test("dock stand-in behavior: handoff, click delegation, and return", async () => {
  const standInResult = await page.evaluate(async () => {
    const mic = document.getElementById("mic");
    const dock = document.getElementById("mic-dock");
    if (!mic || !dock) return null;

    const wait = (ms) => new Promise((r) => setTimeout(r, ms));

    // Append spacer to ensure room for scrolling #mic out of view
    const spacer = document.createElement("div");
    spacer.style.height = "200vh";
    document.querySelector("main")?.appendChild(spacer);

    const ringIntoView = async () => {
      mic.scrollIntoView({ block: "center", behavior: "instant" });
      await wait(250);
    };

    // 1. Initial state: #mic in viewport
    await ringIntoView();
    const initial = {
      dockHidden: dock.hidden,
      micTabIndex: mic.tabIndex,
      micAriaHidden: mic.getAttribute("aria-hidden"),
    };

    // Track clicks on #mic
    let micClicks = 0;
    const counter = () => { micClicks++; };
    mic.addEventListener("click", counter);

    // 2. Scroll far away so #mic is off screen
    window.scrollTo({ top: 999999, behavior: "instant" });
    await wait(250);

    const scrolledAway = {
      dockHidden: dock.hidden,
      micTabIndex: mic.tabIndex,
      micAriaHidden: mic.getAttribute("aria-hidden"),
    };

    // 3. Click dock stand-in
    dock.click();
    await wait(50);
    mic.removeEventListener("click", counter);

    // 4. Scroll back into view
    await ringIntoView();
    const restored = {
      dockHidden: dock.hidden,
      micTabIndex: mic.tabIndex,
      micAriaHidden: mic.getAttribute("aria-hidden"),
      micClicks,
    };

    spacer.remove();
    window.scrollTo({ top: 0, behavior: "instant" });
    return { initial, scrolledAway, restored };
  });

  assert.ok(standInResult, "stand-in test executed");
  assert.equal(standInResult.initial.dockHidden, true, "initially dock is hidden");
  assert.equal(standInResult.initial.micTabIndex, 0, "initially mic tabIndex is 0");

  assert.equal(standInResult.scrolledAway.dockHidden, false, "dock appears when mic scrolled away");
  assert.equal(standInResult.scrolledAway.micTabIndex, -1, "mic steps out of tab order (tabIndex -1)");
  assert.equal(standInResult.scrolledAway.micAriaHidden, "true", "mic steps out of a11y tree (aria-hidden='true')");

  assert.equal(standInResult.restored.micClicks, 1, "clicking #mic-dock delegated click to #mic");
  assert.equal(standInResult.restored.dockHidden, true, "dock hidden when mic scrolls back into view");
  assert.equal(standInResult.restored.micTabIndex, 0, "mic tabIndex restored to 0");
  assert.equal(standInResult.restored.micAriaHidden, null, "mic aria-hidden removed when restored");
});
