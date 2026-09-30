// tests/mini-app-popover.test.mjs — Anchored Mini-App Floating Bubble & Popover UI (voicebox-beads-2twm)
//
// WHAT THIS SUITE PROVES (driven in real browser over CDP):
//   1. Floating bubble dock (#mini-app-dock):
//      - Starts hidden before any mini-app is mounted.
//      - Unhides on mount, with #mini-app-bubble carrying the title and aria-expanded="true".
//   2. Overlay popover presentation (#mini-app-container):
//      - Uses fixed overlay positioning so it does not shift in-flow elements or push the page off screen.
//   3. Quick dismissal & re-expansion:
//      - Clicking outside the popover (pointerdown on body/stage) collapses it to the anchored bubble (dataset.collapsed="true", aria-expanded="false").
//      - Clicking #mini-app-bubble re-expands the popover (dataset.collapsed="false", aria-expanded="true").
//      - Pressing Escape collapses the popover back to the bubble.
//   4. Mobile drawer / bottom-sheet responsiveness:
//      - In mobile viewport (390x844), #mini-app-container anchors to bottom of screen with #mini-app-sheet-handle.
//   5. Teardown:
//      - Clicking #mini-app-close hides both container and dock.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { startServer } from "./lib/server.mjs";
import { launch } from "./lib/cdp.mjs";

test("mini-app popover: anchored floating bubble, light-dismiss, and mobile drawer behavior", { timeout: 45000 }, async (t) => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "vb-mini-popover-"));
  const workspace = path.join(scratch, "project");
  fs.mkdirSync(workspace, { recursive: true });

  const server = await startServer({
    env: {
      VOICEBOX_WORKSPACE: workspace,
      VOICEBOX_RESOLVER: "script",
    },
  });
  t.after(async () => {
    await server.stop();
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  const page = await launch({ width: 1200, height: 900 });
  t.after(() => page.close());

  await page.goto(`${server.base}/`);
  await page.waitFor(() => window.__voiceboxMiniApp !== undefined, { label: "mini-app controller on window" });

  // 1. Initially hidden: both container and floating dock
  const initial = await page.evaluate(() => {
    const c = document.querySelector("#mini-app-container");
    const d = document.querySelector("#mini-app-dock");
    return {
      containerHidden: c?.hidden,
      dockHidden: d?.hidden,
    };
  });
  assert.equal(initial.containerHidden, true, "container starts hidden");
  assert.equal(initial.dockHidden, true, "floating dock starts hidden");

  // 2. Mount fixture app
  const fixtureApp = {
    title: "Spotify Player",
    html: `
      <div id="player">
        <h2>Now Playing</h2>
        <p id="track">Lo-Fi Beats</p>
      </div>
    `,
  };

  await page.evaluate((app) => {
    window.__voiceboxMiniApp.mount(app);
  }, fixtureApp);

  await page.waitFor(() => {
    const c = document.querySelector("#mini-app-container");
    const d = document.querySelector("#mini-app-dock");
    const b = document.querySelector("#mini-app-bubble-title");
    return c && !c.hidden && d && !d.hidden && b?.textContent?.includes("Spotify");
  }, { label: "popover container and dock unhiding with title" });

  const mounted = await page.evaluate(() => {
    const c = document.querySelector("#mini-app-container");
    const d = document.querySelector("#mini-app-dock");
    const b = document.querySelector("#mini-app-bubble");
    const style = getComputedStyle(c);
    return {
      containerHidden: c.hidden,
      dockHidden: d.hidden,
      collapsed: c.dataset.collapsed,
      bubbleAriaExpanded: b.getAttribute("aria-expanded"),
      position: style.position,
      zIndex: style.zIndex,
    };
  });

  assert.equal(mounted.containerHidden, false, "container is visible");
  assert.equal(mounted.dockHidden, false, "dock is visible");
  assert.equal(mounted.collapsed, "false", "initially not collapsed");
  assert.equal(mounted.bubbleAriaExpanded, "true", "bubble has aria-expanded='true'");
  assert.equal(mounted.position, "fixed", "popover container uses fixed overlay positioning (no in-flow shift)");
  assert.ok(Number(mounted.zIndex) >= 100, "popover sits on an elevated z-index");

  // 3. Quick light dismiss: clicking outside the popover card (e.g. on stage/header)
  await page.evaluate(() => {
    const stage = document.querySelector(".stage") || document.body;
    stage.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
  });
  await sleep(150);

  const afterOutsideClick = await page.evaluate(() => {
    const c = document.querySelector("#mini-app-container");
    const b = document.querySelector("#mini-app-bubble");
    const d = document.querySelector("#mini-app-dock");
    return {
      collapsed: c.dataset.collapsed,
      bubbleAriaExpanded: b.getAttribute("aria-expanded"),
      dockHidden: d.hidden,
    };
  });
  assert.equal(afterOutsideClick.collapsed, "true", "clicking outside collapses popover to bubble");
  assert.equal(afterOutsideClick.bubbleAriaExpanded, "false", "bubble has aria-expanded='false'");
  assert.equal(afterOutsideClick.dockHidden, false, "dock remains anchored on screen when collapsed");

  // 4. Re-expand via bubble click
  await page.evaluate(() => {
    document.querySelector("#mini-app-bubble")?.click();
  });
  await sleep(150);

  const afterBubbleClick = await page.evaluate(() => {
    const c = document.querySelector("#mini-app-container");
    const b = document.querySelector("#mini-app-bubble");
    return {
      collapsed: c.dataset.collapsed,
      bubbleAriaExpanded: b.getAttribute("aria-expanded"),
    };
  });
  assert.equal(afterBubbleClick.collapsed, "false", "clicking bubble re-expands popover");
  assert.equal(afterBubbleClick.bubbleAriaExpanded, "true", "bubble has aria-expanded='true'");

  // 5. Dismiss via Escape key
  await page.evaluate(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  });
  await sleep(150);

  const afterEsc = await page.evaluate(() => {
    return document.querySelector("#mini-app-container")?.dataset.collapsed;
  });
  assert.equal(afterEsc, "true", "pressing Escape collapses popover back to bubble");

  // 6. Test mobile sheet responsiveness
  await page.send("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 2,
    mobile: true,
  });
  await sleep(100);

  // Expand popover on mobile
  await page.evaluate(() => {
    document.querySelector("#mini-app-bubble")?.click();
  });
  await sleep(150);

  const mobileStyle = await page.evaluate(() => {
    const c = document.querySelector("#mini-app-container");
    const handle = document.querySelector("#mini-app-sheet-handle");
    const cStyle = getComputedStyle(c);
    const hStyle = getComputedStyle(handle);
    return {
      collapsed: c.dataset.collapsed,
      bottom: cStyle.bottom,
      left: cStyle.left,
      handleDisplay: hStyle.display,
      borderRadius: cStyle.borderTopLeftRadius,
    };
  });

  assert.equal(mobileStyle.collapsed, "false", "expanded on mobile");
  assert.equal(mobileStyle.bottom, "0px", "mobile popover anchors flush to bottom as drawer");
  assert.equal(mobileStyle.left, "0px", "mobile popover spans full inline width");
  assert.notEqual(mobileStyle.handleDisplay, "none", "mobile sheet grab handle is visible");
  assert.ok(parseInt(mobileStyle.borderRadius, 10) >= 16, "mobile drawer has rounded top corners");

  // 7. Close completely
  await page.evaluate(() => {
    document.querySelector("#mini-app-close")?.click();
  });
  await sleep(150);

  const closed = await page.evaluate(() => {
    const c = document.querySelector("#mini-app-container");
    const d = document.querySelector("#mini-app-dock");
    return {
      containerHidden: c.hidden,
      dockHidden: d.hidden,
    };
  });
  assert.equal(closed.containerHidden, true, "container hidden after close");
  assert.equal(closed.dockHidden, true, "dock hidden after close");
});
