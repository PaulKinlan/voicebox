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

  // ── 2. Centered Hero Mic, Compact Stage & Deduplicated File Lists ────────
  const heroGeometry = await page.evaluate(() => {
    const mic = document.getElementById("mic");
    const deck = document.getElementById("sqeh-deck");
    const made = document.getElementById("made-list");
    const reader = document.getElementById("reader");
    const quickFiles = document.getElementById("sqeh-quick-files");
    const readerBubble = document.getElementById("sqeh-reader-bubble");
    const micRect = mic.getBoundingClientRect();
    const deckRect = deck.getBoundingClientRect();
    return {
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      micCenter: micRect.left + micRect.width / 2,
      micTop: micRect.top,
      deckTop: deckRect.top,
      deckBottom: deckRect.bottom,
      madeDisplay: getComputedStyle(made).display,
      readerDisplay: getComputedStyle(reader).display,
      quickFilesHidden: Boolean(quickFiles?.hidden || getComputedStyle(quickFiles).display === "none"),
      readerBubbleHidden: Boolean(readerBubble?.hidden),
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
  assert.equal(heroGeometry.madeDisplay, "none", "#made-list is hidden in 'deck' state (not rendered inline)");
  assert.equal(heroGeometry.readerDisplay, "none", "#reader is hidden when empty");
  assert.equal(heroGeometry.quickFilesHidden, true, "#sqeh-quick-files duplicate grid is hidden");
  assert.equal(heroGeometry.readerBubbleHidden, true, "#sqeh-reader-bubble starts hidden when no file is open");

  // ── 3. Files Bubble Popover & Reader Bubble Popover ──────────────────────
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
  assert.deepEqual(filesBubbleInfo.pills.sort(), ["counter.html", "notes.md"], "quick files pills stay synced in DOM");

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
      display: style.display,
      position: style.position,
      zIndex: Number(style.zIndex),
      visibleInViewport: rect.width > 0 && rect.height > 0 && rect.top >= 0 && rect.top < window.innerHeight,
    };
  });
  assert.equal(openedPopover.sqehState, "files", "clicking files bubble enters 'files' state");
  assert.equal(openedPopover.ariaExpanded, "true", "files bubble sets aria-expanded='true'");
  assert.equal(openedPopover.display, "flex", "#made-list is displayed when in 'files' state");
  assert.equal(openedPopover.position, "fixed", "#made-list becomes a fixed popover card in 'files' state");
  assert.ok(openedPopover.zIndex >= 70, "#made-list popover sits above stage");
  assert.equal(openedPopover.visibleInViewport, true, "#made-list popover is visible in viewport");

  // Click a file card (notes.md) inside #made-list: #reader opens as a fixed popover, #made-list hides, and #sqeh-reader-bubble appears
  await page.evaluate(() => {
    document.querySelector('#files .file-open[data-file="notes.md"]')?.click();
  });
  await page.waitFor(
    () => document.getElementById("reader")?.dataset.state === "ready",
    { label: "#reader opened notes.md" },
  );
  const readerOpenState = await page.evaluate(() => {
    const reader = document.getElementById("reader");
    const made = document.getElementById("made-list");
    const readerBubble = document.getElementById("sqeh-reader-bubble");
    const readerBubbleName = document.getElementById("sqeh-reader-bubble-name");
    const rStyle = getComputedStyle(reader);
    const rRect = reader.getBoundingClientRect();
    return {
      readerDisplay: rStyle.display,
      readerPosition: rStyle.position,
      readerVisible: rRect.width > 0 && rRect.height > 0,
      madeDisplay: getComputedStyle(made).display,
      bubbleHidden: Boolean(readerBubble?.hidden),
      bubbleExpanded: readerBubble?.getAttribute("aria-expanded"),
      bubbleName: readerBubbleName?.textContent?.trim(),
    };
  });
  assert.equal(readerOpenState.readerDisplay, "flex", "#reader is visible when open");
  assert.equal(readerOpenState.readerPosition, "fixed", "#reader is a fixed popover card");
  assert.equal(readerOpenState.readerVisible, true, "#reader has positive dimensions");
  assert.equal(readerOpenState.madeDisplay, "none", "#made-list hides while #reader popover is open so only one popover shows at once");
  assert.equal(readerOpenState.bubbleHidden, false, "#sqeh-reader-bubble is visible while a file is open");
  assert.equal(readerOpenState.bubbleExpanded, "true", "#sqeh-reader-bubble is aria-expanded='true' while #reader is expanded");
  assert.equal(readerOpenState.bubbleName, "notes.md", "#sqeh-reader-bubble shows active file name");

  // Click #reader-back-files ("Files" button in reader header) -> collapses #reader to bubble and shows #made-list
  await page.evaluate(() => {
    document.getElementById("reader-back-files")?.click();
  });
  const backToFilesState = await page.evaluate(() => ({
    sqehState: document.body.dataset.sqehState,
    readerCollapsed: document.getElementById("reader")?.dataset.collapsed,
    readerDisplay: getComputedStyle(document.getElementById("reader")).display,
    madeDisplay: getComputedStyle(document.getElementById("made-list")).display,
    bubbleHidden: Boolean(document.getElementById("sqeh-reader-bubble")?.hidden),
    bubbleExpanded: document.getElementById("sqeh-reader-bubble")?.getAttribute("aria-expanded"),
  }));
  assert.equal(backToFilesState.sqehState, "files", "#reader-back-files keeps/sets 'files' state");
  assert.equal(backToFilesState.readerCollapsed, "true", "#reader is collapsed");
  assert.equal(backToFilesState.readerDisplay, "none", "collapsed #reader is hidden");
  assert.equal(backToFilesState.madeDisplay, "flex", "#made-list popover is visible again");
  assert.equal(backToFilesState.bubbleHidden, false, "#sqeh-reader-bubble remains visible when #reader is minimized");
  assert.equal(backToFilesState.bubbleExpanded, "false", "#sqeh-reader-bubble has aria-expanded='false' when minimized");

  // Click #sqeh-reader-bubble to re-expand #reader, then click #reader-minimize to collapse to deck
  await page.evaluate(() => {
    document.getElementById("sqeh-reader-bubble")?.click();
  });
  const reExpandedReader = await page.evaluate(() => ({
    readerDisplay: getComputedStyle(document.getElementById("reader")).display,
    bubbleExpanded: document.getElementById("sqeh-reader-bubble")?.getAttribute("aria-expanded"),
  }));
  assert.equal(reExpandedReader.readerDisplay, "flex", "clicking #sqeh-reader-bubble re-opens #reader popover");
  assert.equal(reExpandedReader.bubbleExpanded, "true", "#sqeh-reader-bubble has aria-expanded='true'");

  await page.evaluate(() => {
    document.getElementById("reader-minimize")?.click();
  });
  const minimizedToDeck = await page.evaluate(() => ({
    sqehState: document.body.dataset.sqehState,
    readerDisplay: getComputedStyle(document.getElementById("reader")).display,
    madeDisplay: getComputedStyle(document.getElementById("made-list")).display,
    bubbleHidden: Boolean(document.getElementById("sqeh-reader-bubble")?.hidden),
  }));
  assert.equal(minimizedToDeck.sqehState, "deck", "minimizing #reader returns to 'deck' state");
  assert.equal(minimizedToDeck.readerDisplay, "none", "#reader is hidden when minimized");
  assert.equal(minimizedToDeck.madeDisplay, "none", "#made-list is hidden in 'deck' state");
  assert.equal(minimizedToDeck.bubbleHidden, false, "#sqeh-reader-bubble stays visible in top bar");

  // Re-open #reader via bubble and close it via #reader-close
  await page.evaluate(() => {
    document.getElementById("sqeh-reader-bubble")?.click();
    document.getElementById("reader-close")?.click();
  });
  const closedReader = await page.evaluate(() => ({
    readerState: document.getElementById("reader")?.dataset.state,
    readerDisplay: getComputedStyle(document.getElementById("reader")).display,
    bubbleHidden: Boolean(document.getElementById("sqeh-reader-bubble")?.hidden),
  }));
  assert.equal(closedReader.readerState, "empty", "#reader-close resets data-state='empty'");
  assert.equal(closedReader.readerDisplay, "none", "#reader is hidden after close");
  assert.equal(closedReader.bubbleHidden, true, "#sqeh-reader-bubble hides after #reader-close");

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

  // Close mini-app before testing history popover and live tool calls
  await page.evaluate(() => {
    document.getElementById("mini-app-close")?.click();
  });

  // ── 5. History Popover (#sqeh-toggle-history, #session) & No Dimming (hr9h, fuo6) ──
  await page.evaluate(() => {
    document.getElementById("sqeh-toggle-history")?.click();
  });
  const historyPopoverState = await page.evaluate(() => {
    const session = document.getElementById("session");
    const voice = document.querySelector(".voice");
    const deck = document.getElementById("sqeh-deck");
    const sStyle = getComputedStyle(session);
    const sRect = session.getBoundingClientRect();
    return {
      sqehState: document.body.dataset.sqehState,
      sessionHidden: session.hidden,
      sessionPosition: sStyle.position,
      sessionDisplay: sStyle.display,
      sessionWidth: sRect.width,
      voiceOpacity: getComputedStyle(voice).opacity,
      deckOpacity: getComputedStyle(deck).opacity,
      closePresent: Boolean(document.getElementById("session-close")),
      emptyPresent: Boolean(document.getElementById("session-empty")),
    };
  });
  assert.equal(historyPopoverState.sqehState, "history", "clicking #sqeh-toggle-history enters 'history' state");
  assert.equal(historyPopoverState.sessionHidden, false, "#session unhides when history is toggled");
  assert.equal(historyPopoverState.sessionPosition, "fixed", "#session is a floating fixed popover bubble");
  assert.equal(historyPopoverState.sessionDisplay, "flex", "#session renders as flex card");
  assert.ok(historyPopoverState.sessionWidth > 0 && historyPopoverState.sessionWidth <= 500, `expected compact #session popover width, got ${historyPopoverState.sessionWidth}`);
  assert.equal(historyPopoverState.voiceOpacity, "1", ".voice stays at full opacity when history popover is open (no graying out)");
  assert.equal(historyPopoverState.deckOpacity, "1", "#sqeh-deck stays at full opacity when history popover is open");
  assert.equal(historyPopoverState.closePresent, true, "#session-close button exists");
  assert.equal(historyPopoverState.emptyPresent, true, "#session-empty placeholder exists");

  // Close #session via #session-close
  await page.evaluate(() => {
    document.getElementById("session-close")?.click();
  });
  assert.equal(
    await page.evaluate(() => document.getElementById("session")?.hidden),
    true,
    "#session-close hides #session popover",
  );

  // ── 6. Rich Artifact Chip Preview (np3f) & Auto-Open on read_file (8ga5) ──
  await page.evaluate(() => {
    window.__voiceboxOnToolCalls?.(
      [
        {
          ok: true,
          name: "write_file",
          file: "notes.md",
          bytes: 28,
          args: { name: "notes.md", content: "# Notes\nUpdated line 1\nLine 2" },
        },
        {
          ok: true,
          name: "read_file",
          file: "notes.md",
          content: "# Notes\nUpdated line 1\nLine 2",
          args: { name: "notes.md" },
        },
      ],
      { calls: [] },
    );
  });

  await page.waitFor(
    () => document.getElementById("reader")?.dataset.state === "ready",
    { label: "#reader auto-opened on read_file tool call" },
  );

  await page.evaluate(() => {
    window.__voiceboxOnLiveText?.("hello voicebox", "user");
    window.__voiceboxOnLiveText?.("Hi there!", "model");
  });

  const toolEffects = await page.evaluate(() => {
    const chip = document.querySelector("#session-log .sqeh-artifact-chip");
    const badge = chip?.querySelector(".sqeh-artifact-badge")?.textContent?.trim();
    const size = chip?.querySelector(".sqeh-artifact-size")?.textContent?.trim();
    const preview = chip?.querySelector(".sqeh-artifact-preview code")?.textContent ?? "";
    const readerState = document.getElementById("reader")?.dataset.state;
    const readerName = document.getElementById("sqeh-reader-bubble-name")?.textContent?.trim();
    const sessionHiddenAfterSpeechAndTools = document.getElementById("session")?.hidden;
    const logItemCount = document.querySelectorAll("#session-log li").length;
    return {
      chipPresent: Boolean(chip),
      badge,
      size,
      preview,
      readerState,
      readerName,
      sessionHiddenAfterSpeechAndTools,
      logItemCount,
    };
  });
  assert.equal(toolEffects.sessionHiddenAfterSpeechAndTools, true, "#session stays closed when speaking, getting replies, or running tools until Recent turns is clicked");
  assert.ok(toolEffects.logItemCount >= 3, "turns are still recorded in #session-log while #session is closed");
  assert.equal(toolEffects.chipPresent, true, "write_file creates .sqeh-artifact-chip in #session-log");
  assert.equal(toolEffects.badge, "Wrote", "artifact chip displays action badge");
  assert.equal(toolEffects.size, "28 bytes", "artifact chip displays byte size");
  assert.match(toolEffects.preview, /Updated line 1/, "artifact chip renders code preview snippet");
  assert.equal(toolEffects.readerState, "ready", "read_file tool call auto-opens #reader");
  assert.equal(toolEffects.readerName, "notes.md", "#reader displays read file name");

  // ── 7. Dock Deduplication & Icon Padding (69ij), Harness Setup UI (a6jb), API Keys UI (5drl) ──
  const uiPolishState = await page.evaluate(() => {
    const dockSettings = document.getElementById("sqeh-dock-settings");
    const iconBtn = document.getElementById("settings-open");
    const iconPadding = iconBtn ? getComputedStyle(iconBtn).paddingTop : null;
    const harnessForm = document.getElementById("harness-add-agent");
    const harnessSave = document.getElementById("harness-config-save");
    const apiKeysFieldset = document.getElementById("settings-api-keys");
    const apiKeysSave = document.getElementById("api-keys-save");
    return {
      dockSettingsHidden: Boolean(dockSettings?.hidden || (dockSettings && getComputedStyle(dockSettings).display === "none")),
      iconPadding,
      harnessFormPresent: Boolean(harnessForm && harnessSave),
      apiKeysPresent: Boolean(
        apiKeysFieldset &&
        apiKeysSave &&
        document.getElementById("api-key-gemini") &&
        document.getElementById("api-key-openai") &&
        document.getElementById("api-key-anthropic"),
      ),
    };
  });
  assert.equal(uiPolishState.dockSettingsHidden, true, "duplicate #sqeh-dock-settings in bottom dock is hidden");
  assert.equal(uiPolishState.iconPadding, "0px", ".icon-button has 0px padding so icons are not clipped");
  assert.equal(uiPolishState.harnessFormPresent, true, "#harnesses-dialog includes #harness-add-agent setup controls");
  assert.equal(uiPolishState.apiKeysPresent, true, "#settings includes #settings-api-keys inputs and save button");
});

