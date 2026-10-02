// tests/ux-bubble-stage.test.mjs — UX Overhaul: Light Mode Default, Centered Hero Mic, Files Bubble Popover, Real Mini-App Bubbles & Scroll Fix (voicebox-beads-3rcy)

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startServer } from "./lib/server.mjs";
import { launch } from "./lib/cdp.mjs";

test("ux-bubble-stage: light mode default, centered hero mic, files bubble popover, real mini-app bubbles, and standards-mode inner scroll", { timeout: 45000 }, async (t) => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "vb-ux-bubble-stage-"));
  const workspace = path.join(scratch, "project");
  fs.mkdirSync(workspace, { recursive: true });

  // Seed a regular file and an interactive HTML mini-app file in the workspace
  fs.writeFileSync(path.join(workspace, "notes.md"), "# Notes\nHello world\n", "utf8");
  fs.writeFileSync(
    path.join(workspace, "counter.html"),
    `<!doctype html>
<html>
<head><title>Counter Mini-App</title></head>
<body>
  <h1>Counter App</h1>
  <div id="tall-block" style="height: 2000px">tall content</div>
  <script>
    window.webMcp.registerTool({
      name: "probe_scroll",
      description: "Verify standards mode and vertical scrolling inside #inner-app",
      parameters: { type: "object", properties: {} },
      execute: async () => {
        window.scrollTo(0, 300);
        const scrollY = window.scrollY || document.scrollingElement?.scrollTop || 0;
        return {
          compatMode: document.compatMode,
          scrollY,
          clientHeight: document.documentElement.clientHeight,
          scrollHeight: document.documentElement.scrollHeight,
        };
      },
    });
    window.webMcp.ready();
  </script>
</body>
</html>`,
    "utf8",
  );

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

  // Declare workspace root so /api/files returns the seeded files
  const rootRes = await fetch(`${server.base}/api/root`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-voicebox-host-token": server.hostToken,
    },
    body: JSON.stringify({
      project: "ux-stage-test",
      root: { kind: "machine", path: workspace },
    }),
  });
  assert.equal(rootRes.ok, true, "declared workspace root");

  const page = await launch({ width: 1280, height: 800 });
  t.after(() => page.close());

  await page.goto(`${server.base}/`);
  await page.waitFor(
    () =>
      window.__voiceboxMiniApp !== undefined &&
      document.querySelectorAll("#files .file-open").length === 2,
    { label: "page and workspace files loaded" },
  );

  // ── 1. Light Mode Default & Theme Toggle ─────────────────────────────────
  const initialThemeState = await page.evaluate(() => {
    return {
      dataTheme: document.documentElement.dataset.theme,
      bodyBg: getComputedStyle(document.body).backgroundColor,
      togglePresent: Boolean(document.getElementById("theme-toggle")),
    };
  });
  assert.equal(initialThemeState.dataTheme, "light", "defaults to data-theme='light'");
  assert.equal(initialThemeState.togglePresent, true, "#theme-toggle button exists in header");
  assert.ok(
    initialThemeState.bodyBg === "rgb(251, 251, 249)" || initialThemeState.bodyBg === "rgb(248, 250, 252)",
    `expected light body background, got ${initialThemeState.bodyBg}`,
  );

  // Click #theme-toggle to switch to dark mode
  await page.evaluate(() => {
    document.getElementById("theme-toggle")?.click();
  });
  const darkThemeState = await page.evaluate(() => ({
    dataTheme: document.documentElement.dataset.theme,
    stored: localStorage.getItem("voicebox:theme"),
    bodyBg: getComputedStyle(document.body).backgroundColor,
  }));
  assert.equal(darkThemeState.dataTheme, "dark", "clicking #theme-toggle switches to dark");
  assert.equal(darkThemeState.stored, "dark", "persists 'dark' in localStorage");
  assert.notEqual(darkThemeState.bodyBg, initialThemeState.bodyBg, "background color updates in dark mode");

  // Switch back to light mode for remaining checks
  await page.evaluate(() => {
    document.getElementById("theme-toggle")?.click();
  });
  const restoredLight = await page.evaluate(() => ({
    dataTheme: document.documentElement.dataset.theme,
    stored: localStorage.getItem("voicebox:theme"),
  }));
  assert.equal(restoredLight.dataTheme, "light", "clicking #theme-toggle again restores light mode");
  assert.equal(restoredLight.stored, "light", "persists 'light' in localStorage");

  // ── 2. Centered Hero Mic & Compact Stage ─────────────────────────────────
  const heroGeometry = await page.evaluate(() => {
    const mic = document.getElementById("mic");
    const deck = document.getElementById("sqeh-deck");
    const made = document.getElementById("made-list");
    const micRect = mic.getBoundingClientRect();
    const deckRect = deck.getBoundingClientRect();
    const madeRect = made.getBoundingClientRect();
    return {
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      micCenter: micRect.left + micRect.width / 2,
      micTop: micRect.top,
      deckTop: deckRect.top,
      deckBottom: deckRect.bottom,
      madeTop: madeRect.top,
      sqehState: document.body.dataset.sqehState,
    };
  });
  assert.equal(heroGeometry.sqehState, "deck", "starts in deck state");
  assert.ok(
    Math.abs(heroGeometry.micCenter - heroGeometry.viewportWidth / 2) < 40,
    `expected #mic horizontally centered (center=${heroGeometry.micCenter}, viewportWidth/2=${heroGeometry.viewportWidth / 2})`,
  );
  assert.ok(
    heroGeometry.micTop > 0 && heroGeometry.micTop < heroGeometry.viewportHeight * 0.55,
    `expected #mic in upper-middle hero area (micTop=${heroGeometry.micTop}, limit=${heroGeometry.viewportHeight * 0.55})`,
  );
  assert.ok(
    heroGeometry.deckTop < heroGeometry.viewportHeight,
    `expected #sqeh-deck visible without scrolling (deckTop=${heroGeometry.deckTop}, viewportHeight=${heroGeometry.viewportHeight})`,
  );
  assert.ok(
    heroGeometry.madeTop > heroGeometry.micTop,
    `#made-list must not occupy vertical stage flow above #mic (madeTop=${heroGeometry.madeTop}, micTop=${heroGeometry.micTop})`,
  );

  // ── 3. Files Bubble Popover ──────────────────────────────────────────────
  const filesBubbleInfo = await page.evaluate(() => {
    const bubble = document.getElementById("sqeh-files-bubble");
    const badge = document.getElementById("sqeh-files-badge");
    const pills = [...document.querySelectorAll("#sqeh-quick-files .sqeh-file-tile")].map((el) => el.dataset.file);
    return {
      bubblePresent: Boolean(bubble),
      badgeText: badge?.textContent?.trim(),
      ariaExpanded: bubble?.getAttribute("aria-expanded"),
      pills,
    };
  });
  assert.equal(filesBubbleInfo.bubblePresent, true, "#sqeh-files-bubble exists");
  assert.equal(filesBubbleInfo.badgeText, "2", "#sqeh-files-badge shows count of workspace files");
  assert.equal(filesBubbleInfo.ariaExpanded, "false", "files bubble starts collapsed");
  assert.deepEqual(filesBubbleInfo.pills.sort(), ["counter.html", "notes.md"], "quick files pills list workspace files");

  // Click #sqeh-files-bubble to open the floating #made-list popover
  await page.evaluate(() => {
    document.getElementById("sqeh-files-bubble")?.click();
  });
  const openedPopover = await page.evaluate(() => {
    const made = document.getElementById("made-list");
    const style = getComputedStyle(made);
    const rect = made.getBoundingClientRect();
    return {
      sqehState: document.body.dataset.sqehState,
      ariaExpanded: document.getElementById("sqeh-files-bubble")?.getAttribute("aria-expanded"),
      position: style.position,
      zIndex: Number(style.zIndex),
      visibleInViewport: rect.width > 0 && rect.height > 0 && rect.top >= 0 && rect.top < window.innerHeight,
    };
  });
  assert.equal(openedPopover.sqehState, "files", "clicking files bubble enters 'files' state");
  assert.equal(openedPopover.ariaExpanded, "true", "files bubble sets aria-expanded='true'");
  assert.equal(openedPopover.position, "fixed", "#made-list becomes a fixed popover card in 'files' state");
  assert.ok(openedPopover.zIndex >= 70, "#made-list popover sits above stage");
  assert.equal(openedPopover.visibleInViewport, true, "#made-list popover is visible in viewport");

  // Click #sqeh-files-bubble again to toggle it closed
  await page.evaluate(() => {
    document.getElementById("sqeh-files-bubble")?.click();
  });
  const closedPopover = await page.evaluate(() => ({
    sqehState: document.body.dataset.sqehState,
    ariaExpanded: document.getElementById("sqeh-files-bubble")?.getAttribute("aria-expanded"),
  }));
  assert.equal(closedPopover.sqehState, "deck", "clicking files bubble again returns to 'deck' state");
  assert.equal(closedPopover.ariaExpanded, "false", "files bubble sets aria-expanded='false'");

  // ── 4. Real Mini-App Bubbles & Inner Iframe Scrolling ────────────────────
  const miniAppBubbles = await page.evaluate(() => {
    const actions = document.getElementById("sqeh-actions");
    const labels = [...(actions?.querySelectorAll("button") ?? [])].map((b) => b.textContent?.trim() ?? "");
    const htmlBubbles = [...(actions?.querySelectorAll(".sqeh-miniapp-bubble") ?? [])].map((b) => ({
      file: b.dataset.miniAppFile,
      id: b.dataset.miniAppId,
      text: b.textContent?.trim(),
    }));
    return { labels, htmlBubbles };
  });

  for (const fakeLabel of ["Mute Mic", "Volume +", "Explorer", "Spotify"]) {
    assert.ok(
      !miniAppBubbles.labels.some((l) => l.includes(fakeLabel)),
      `#sqeh-actions must not contain fake placeholder button '${fakeLabel}'`,
    );
  }
  assert.equal(miniAppBubbles.htmlBubbles.length, 1, "workspace counter.html appears as a real Mini-App bubble in #sqeh-actions");
  assert.equal(miniAppBubbles.htmlBubbles[0].file, "counter.html", "bubble targets counter.html");

  // Click the counter.html Mini-App bubble in #sqeh-actions and verify it mounts #mini-app-container
  await page.evaluate(() => {
    document.querySelector("#sqeh-actions .sqeh-miniapp-bubble")?.click();
  });

  await page.waitFor(() => {
    const c = document.getElementById("mini-app-container");
    const tools = window.__voiceboxMiniApp?.getTools?.() ?? [];
    return Boolean(c && !c.hidden && c.dataset.collapsed === "false" && tools.some((t) => t.name === "probe_scroll"));
  }, { label: "counter.html mini-app mounted and Web MCP tool registered inside inner iframe" });

  // Verify inner iframe is in Standards Mode (CSS1Compat) and scrolls properly
  const probeResp = await page.evaluate(async () => {
    return await window.__voiceboxMiniApp.callTool("probe_scroll", {});
  });

  assert.equal(probeResp?.ok, true, "probe_scroll tool executed inside sandboxed #inner-app");
  const scrollResult = probeResp.result;
  assert.equal(scrollResult.compatMode, "CSS1Compat", "inner #inner-app iframe renders in Standards Mode (CSS1Compat)");
  assert.ok(
    scrollResult.scrollY > 0,
    `expected inner iframe to scroll (scrollY=${scrollResult.scrollY}, clientHeight=${scrollResult.clientHeight}, scrollHeight=${scrollResult.scrollHeight})`,
  );
});
