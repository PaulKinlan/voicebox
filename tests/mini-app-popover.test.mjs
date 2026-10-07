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

  // 4b. Test full-screen expand (#mini-app-expand, voicebox-beads-3kqm) and drag handle (#mini-app-drag-handle, voicebox-beads-k7fq)
  const beforeExpand = await page.evaluate(() => {
    const c = document.querySelector("#mini-app-container");
    const h = document.querySelector("#mini-app-drag-handle");
    const rect = c.getBoundingClientRect();
    return {
      resize: getComputedStyle(c).resize,
      handleCursor: h ? getComputedStyle(h).cursor : null,
      width: rect.width,
      height: rect.height,
      left: rect.left,
      top: rect.top,
    };
  });
  assert.equal(beforeExpand.resize, "both", "mini-app container supports CSS resize: both");
  assert.equal(beforeExpand.handleCursor, "grab", "#mini-app-drag-handle shows grab cursor");

  // Drag #mini-app-drag-handle by (-120, -80)
  const afterDrag = await page.evaluate(() => {
    const c = document.querySelector("#mini-app-container");
    const h = document.querySelector("#mini-app-drag-handle");
    const r0 = c.getBoundingClientRect();
    const startX = r0.left + 40;
    const startY = r0.top + 16;
    h.dispatchEvent(new PointerEvent("pointerdown", { clientX: startX, clientY: startY, button: 0, pointerId: 1, bubbles: true }));
    window.dispatchEvent(new PointerEvent("pointermove", { clientX: startX - 120, clientY: startY - 80, pointerId: 1, bubbles: true }));
    window.dispatchEvent(new PointerEvent("pointerup", { clientX: startX - 120, clientY: startY - 80, pointerId: 1, bubbles: true }));
    const r1 = c.getBoundingClientRect();
    // voicebox-beads-p4ae: the drag CLAMPS to the viewport (left/top >= 8, and a max by the
    // bubble's width and 48px bottom margin — the product's own constants from the drag handler),
    // so the expected shift is the clamped one, derived from the bubble's actual start position.
    // A drag that starts near the left edge legitimately moves less than the full pointer delta —
    // measured as a gate flake: dx -115 against a hard-coded -120 ± 2 when startLeft was ~123.
    const maxLeft = Math.max(8, window.innerWidth - Math.min(r0.width || 320, 160));
    const maxTop = Math.max(8, window.innerHeight - 48);
    return {
      dx: Math.round(r1.left - r0.left),
      dy: Math.round(r1.top - r0.top),
      expectedDx: Math.round(Math.max(8, Math.min(maxLeft, r0.left - 120)) - r0.left),
      expectedDy: Math.round(Math.max(8, Math.min(maxTop, r0.top - 80)) - r0.top),
      draggingAttr: c.dataset.dragging,
    };
  });
  assert.ok(Math.abs(afterDrag.dx - afterDrag.expectedDx) <= 2, `dragging header shifts left by the clamped ~-120px (got ${afterDrag.dx}, expected ${afterDrag.expectedDx})`);
  assert.ok(Math.abs(afterDrag.dy - afterDrag.expectedDy) <= 2, `dragging header shifts top by the clamped ~-80px (got ${afterDrag.dy}, expected ${afterDrag.expectedDy})`);
  assert.equal(afterDrag.draggingAttr, undefined, "data-dragging attribute cleared on pointerup");

  // Expand to full width and full height (#mini-app-expand)
  await page.evaluate(() => {
    document.querySelector("#mini-app-expand")?.click();
  });
  const expandedMetrics = await page.evaluate(() => {
    const c = document.querySelector("#mini-app-container");
    const rect = c.getBoundingClientRect();
    return {
      expanded: c.dataset.expanded,
      widthRatio: rect.width / window.innerWidth,
      heightRatio: rect.height / window.innerHeight,
    };
  });
  assert.equal(expandedMetrics.expanded, "true", "clicking #mini-app-expand sets data-expanded='true'");
  assert.ok(expandedMetrics.widthRatio >= 0.9, `expanded width covers >=90% of viewport width (got ${expandedMetrics.widthRatio})`);
  assert.ok(expandedMetrics.heightRatio >= 0.85, `expanded height covers >=85% of viewport height (got ${expandedMetrics.heightRatio})`);

  // Restore standard size before mobile check and clear inline drag styles so mobile CSS applies cleanly
  await page.evaluate(() => {
    document.querySelector("#mini-app-expand")?.click();
    const c = document.querySelector("#mini-app-container");
    c.style.left = "";
    c.style.top = "";
    c.style.right = "";
    c.style.bottom = "";
    c.style.transform = "";
  });

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

  // 8. In-place updates, #mini-app-edit, and #mini-app-delete (voicebox-beads-lkdd)
  await page.send("Emulation.setDeviceMetricsOverride", {
    width: 1280,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await sleep(100);

  await page.evaluate(() => {
    window.__voiceboxMiniApp.mount({
      appId: "app_timer",
      title: "Focus Timer",
      fileName: "focus-timer.html",
      html: "<!DOCTYPE html><html><body><h1 id='v'>v1 timer</h1></body></html>",
      source: "workspace",
      tools: [],
    });
    window.__voiceboxMiniApp.mount({
      appId: "app_timer_v2",
      title: "Focus Timer",
      fileName: "focus-timer.html",
      html: "<!DOCTYPE html><html><body><h1 id='v'>v2 timer</h1></body></html>",
      source: "shelf",
      tools: [],
    });
  });

  await page.waitFor(() => {
    const outer = document.querySelector("#mini-app-outer-frame");
    const inner = outer?.contentDocument?.querySelector("#inner-app");
    return Boolean(inner?.srcdoc?.includes("v2 timer"));
  }, { label: "mini-app bridge inner iframe updated to v2 timer" });

  const dedupedState = await page.evaluate(() => {
    const c = document.querySelector("#mini-app-container");
    const badge = document.querySelector("#mini-app-source-badge");
    const outer = document.querySelector("#mini-app-outer-frame");
    const inner = outer?.contentDocument?.querySelector("#inner-app");
    const chips = [...document.querySelectorAll("#sqeh-actions .sqeh-miniapp-bubble")];
    const timerChips = chips.filter((el) => el.textContent.toLowerCase().includes("focus timer"));
    return {
      hidden: c?.hidden,
      badgeHidden: badge?.hidden,
      badgeText: badge?.textContent?.trim(),
      srcdoc: inner?.srcdoc ?? "",
      timerChipCount: timerChips.length,
    };
  });

  assert.equal(dedupedState.hidden, false, "mini-app container is visible after mounting Focus Timer");
  assert.equal(dedupedState.timerChipCount, 1, "mounting updated mini-app with same title updates in place in #sqeh-actions (1 bubble, not 2)");
  assert.ok(dedupedState.srcdoc.includes("v2 timer"), "live iframe content updates to v2 HTML");
  assert.equal(dedupedState.badgeHidden, false, "mini-app source badge is visible");
  assert.equal(dedupedState.badgeText, "Saved app", "mini-app source badge reflects updated source");

  // Click #mini-app-edit -> opens mini-app HTML in #reader's #file-editor
  await page.evaluate(() => {
    document.querySelector("#mini-app-edit")?.click();
  });
  await sleep(150);

  const editState = await page.evaluate(() => {
    const reader = document.querySelector("#reader");
    const editor = document.querySelector("#file-editor");
    return {
      readerEditing: reader?.dataset.editing,
      editorHidden: editor?.hidden,
      editorValue: editor?.value ?? "",
    };
  });
  assert.equal(editState.readerEditing, "true", "clicking #mini-app-edit puts #reader into editing mode");
  assert.equal(editState.editorHidden, false, "#file-editor is visible when editing mini-app source");
  assert.ok(editState.editorValue.includes("v2 timer"), "#file-editor contains the active mini-app HTML source");

  // Click #mini-app-delete -> removes mini-app and closes #mini-app-container
  await page.evaluate(() => {
    document.querySelector("#mini-app-delete")?.click();
  });
  await sleep(250);

  const afterDelete = await page.evaluate(() => {
    const c = document.querySelector("#mini-app-container");
    const chips = [...document.querySelectorAll("#sqeh-actions .sqeh-miniapp-bubble")];
    const timerChips = chips.filter((el) => el.textContent.toLowerCase().includes("focus timer"));
    return {
      containerHidden: c?.hidden,
      timerChipCount: timerChips.length,
    };
  });
  assert.equal(afterDelete.containerHidden, true, "#mini-app-container closes after clicking #mini-app-delete");
  assert.equal(afterDelete.timerChipCount, 0, "deleted mini-app is removed from #sqeh-actions");
});

