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

  // ── 1. Light Mode Default & Settings Theme Select (voicebox-beads-zc28) ──
  const initialThemeState = await page.evaluate(() => {
    const toggle = document.getElementById("theme-toggle");
    const select = document.getElementById("theme-select");
    return {
      dataTheme: document.documentElement.dataset.theme,
      bodyBg: getComputedStyle(document.body).backgroundColor,
      togglePresent: Boolean(toggle),
      toggleHidden: Boolean(toggle?.hidden || (toggle && getComputedStyle(toggle).display === "none")),
      selectPresent: Boolean(select),
      selectOptions: select ? [...select.options].map((o) => o.value) : [],
    };
  });
  assert.equal(initialThemeState.dataTheme, "light", "defaults to data-theme='light'");
  assert.equal(initialThemeState.togglePresent, true, "#theme-toggle button remains in DOM");
  assert.equal(initialThemeState.toggleHidden, true, "#theme-toggle is hidden in the top header");
  assert.equal(initialThemeState.selectPresent, true, "#theme-select exists inside #settings");
  assert.deepEqual(initialThemeState.selectOptions, ["system", "light", "dark"], "#theme-select offers system, light, and dark options");
  assert.ok(
    initialThemeState.bodyBg === "rgb(251, 251, 249)" || initialThemeState.bodyBg === "rgb(248, 250, 252)",
    `expected light body background, got ${initialThemeState.bodyBg}`,
  );

  // Switch #theme-select in #settings to dark mode
  await page.evaluate(() => {
    const select = document.getElementById("theme-select");
    if (select) {
      select.value = "dark";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    }
  });
  const darkThemeState = await page.evaluate(() => ({
    dataTheme: document.documentElement.dataset.theme,
    themeMode: document.documentElement.dataset.themeMode,
    stored: localStorage.getItem("voicebox:theme"),
    bodyBg: getComputedStyle(document.body).backgroundColor,
    stateText: document.getElementById("theme-select-state")?.textContent?.trim(),
  }));
  assert.equal(darkThemeState.dataTheme, "dark", "selecting 'dark' in #theme-select switches to dark");
  assert.equal(darkThemeState.themeMode, "dark", "sets data-theme-mode='dark'");
  assert.equal(darkThemeState.stored, "dark", "persists 'dark' in localStorage");
  assert.equal(darkThemeState.stateText, "Dark mode", "#theme-select-state reflects Dark mode");
  assert.notEqual(darkThemeState.bodyBg, initialThemeState.bodyBg, "background color updates in dark mode");

  // Switch to system mode and then back to light mode for remaining checks
  await page.evaluate(() => {
    const select = document.getElementById("theme-select");
    if (select) {
      select.value = "system";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    }
  });
  const systemThemeState = await page.evaluate(() => ({
    themeMode: document.documentElement.dataset.themeMode,
    stored: localStorage.getItem("voicebox:theme"),
  }));
  assert.equal(systemThemeState.themeMode, "system", "selecting 'system' sets data-theme-mode='system'");
  assert.equal(systemThemeState.stored, "system", "persists 'system' in localStorage");

  await page.evaluate(() => {
    const select = document.getElementById("theme-select");
    if (select) {
      select.value = "light";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    }
  });
  const restoredLight = await page.evaluate(() => ({
    dataTheme: document.documentElement.dataset.theme,
    stored: localStorage.getItem("voicebox:theme"),
  }));
  assert.equal(restoredLight.dataTheme, "light", "selecting 'light' in #theme-select restores light mode");
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
  assert.ok(
    miniAppBubbles.htmlBubbles.some((b) => b.file === "counter.html"),
    "workspace counter.html appears as a real Mini-App bubble in #sqeh-actions",
  );
  assert.ok(
    miniAppBubbles.htmlBubbles.some((b) => b.id === "agent-progress-tracker"),
    "built-in Agent Progress bubble appears in #sqeh-actions",
  );
  assert.equal(miniAppBubbles.htmlBubbles[0].file, "counter.html", "first bubble targets counter.html");

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

  // ── 7. UI Polish & Popover Extensions (69ij, a6jb, 5drl, t6rk, 46rd, hq0v, okgg, tlec, je4i) ──
  const uiPolishState = await page.evaluate(() => {
    const dockSettings = document.getElementById("sqeh-dock-settings");
    const iconBtn = document.getElementById("settings-open");
    const iconPadding = iconBtn ? getComputedStyle(iconBtn).paddingTop : null;
    const harnessForm = document.getElementById("harness-add-agent");
    const harnessSave = document.getElementById("harness-config-save");
    const apiKeysFieldset = document.getElementById("settings-api-keys");
    const apiKeysSave = document.getElementById("api-keys-save");
    const gearPaths = [...document.querySelectorAll("#i-gear path")].map((p) => p.getAttribute("d") || "");
    const textForm = document.getElementById("text-form");
    const utterance = document.getElementById("utterance");
    const sendBtn = document.getElementById("send");
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
      gearHasCogTeeth: gearPaths.some((d) => d.includes("M19.4 15")),
      textFormHidden: Boolean(textForm?.hidden && getComputedStyle(textForm).display === "none"),
      composerDomIntact: Boolean(textForm && utterance && sendBtn),
    };
  });
  assert.equal(uiPolishState.dockSettingsHidden, true, "duplicate #sqeh-dock-settings in bottom dock is hidden");
  assert.equal(uiPolishState.iconPadding, "0px", ".icon-button has 0px padding so icons are not clipped");
  assert.equal(uiPolishState.harnessFormPresent, true, "#harnesses-dialog includes #harness-add-agent setup controls");
  assert.equal(uiPolishState.apiKeysPresent, true, "#settings includes #settings-api-keys inputs and save button");
  assert.equal(uiPolishState.gearHasCogTeeth, true, "#i-gear uses toothed cogwheel SVG path (t6rk)");
  assert.equal(uiPolishState.textFormHidden, true, "#text-form is hidden on the main stage (46rd)");
  assert.equal(uiPolishState.composerDomIntact, true, "#text-form, #utterance, and #send remain in the DOM (46rd)");

  // Verify .env-label inside #exts does not squash into 1-char vertical columns when .env-state has long text (hq0v)
  await page.evaluate(() => {
    document.getElementById("exts-open")?.click();
  });
  await page.waitFor(
    () => document.querySelectorAll("#exts .env-item .env-label").length > 0,
    { label: "#exts rows rendered" },
  );
  const envLabelGeometry = await page.evaluate(() => {
    const exts = document.getElementById("exts");
    const row = document.querySelector("#exts .env-item:not(.env-empty)");
    const labelEl = row?.querySelector(".env-label");
    const stateEl = row?.querySelector(".env-state");
    if (stateEl) {
      stateEl.textContent = "unavailable — docker daemon is not running or socket was refused by host policy";
    }
    const rect = labelEl?.getBoundingClientRect();
    exts?.close?.();
    return {
      labelWidth: rect?.width ?? 0,
      labelHeight: rect?.height ?? 0,
    };
  });
  assert.ok(
    envLabelGeometry.labelWidth >= 100,
    `expected .env-label to maintain horizontal width >= 100px even with long .env-state text, got ${envLabelGeometry.labelWidth}px (hq0v)`,
  );

  // Verify Work activity popover (#sqeh-toggle-activity & #activity-log-panel, okgg)
  await page.evaluate(() => {
    window.__voiceboxAppendActivity?.({
      kind: "command",
      label: "Command",
      summary: "Ran: ls -la",
      detail: "notes.md\ncounter.html",
    });
    document.getElementById("sqeh-toggle-activity")?.click();
  });
  const activityPopoverState = await page.evaluate(() => {
    const panel = document.getElementById("activity-log-panel");
    const items = [...document.querySelectorAll("#activity-log-list .activity-item")];
    const pStyle = getComputedStyle(panel);
    return {
      sqehState: document.body.dataset.sqehState,
      panelHidden: Boolean(panel?.hidden),
      panelPosition: pStyle.position,
      panelDisplay: pStyle.display,
      itemCount: items.length,
      summaries: items.map((el) => el.querySelector(".activity-summary")?.textContent?.trim() ?? ""),
      details: items.map((el) => el.querySelector(".activity-detail")?.textContent?.trim() ?? "").filter(Boolean),
    };
  });
  assert.equal(activityPopoverState.sqehState, "activity", "clicking #sqeh-toggle-activity enters 'activity' state (okgg)");
  assert.equal(activityPopoverState.panelHidden, false, "#activity-log-panel unhides in 'activity' state (okgg)");
  assert.equal(activityPopoverState.panelPosition, "fixed", "#activity-log-panel is a floating fixed popover card (okgg)");
  assert.equal(activityPopoverState.panelDisplay, "flex", "#activity-log-panel renders as flex container (okgg)");
  assert.ok(activityPopoverState.itemCount >= 2, "activity log records tool calls and command entries (okgg)");
  assert.ok(
    activityPopoverState.summaries.some((s) => s.includes("Ran: ls -la")),
    "activity log displays command summary (okgg)",
  );
  assert.ok(
    activityPopoverState.details.some((d) => d.includes("notes.md")),
    "activity log displays command detail output (okgg)",
  );

  await page.evaluate(() => {
    document.getElementById("activity-log-close")?.click();
  });
  assert.equal(
    await page.evaluate(() => document.getElementById("activity-log-panel")?.hidden),
    true,
    "#activity-log-close hides #activity-log-panel",
  );

  // Verify Project Change Flash (tlec)
  const flashState = await page.evaluate(() => {
    window.__voiceboxFlashProjectChange?.("switched-root");
    const whereEl = document.querySelector(".where");
    return {
      bodyFlash: document.body.dataset.projectFlash,
      whereFlash: document.getElementById("help-open")?.dataset.flash,
      flashReason: document.body.dataset.projectFlashReason,
    };
  });
  assert.equal(flashState.bodyFlash, "true", "project change sets body[data-project-flash='true'] (tlec)");
  assert.equal(flashState.whereFlash, "true", "project change flashes the info icon (voicebox-beads-zhg1: the cue moved with the facts into the help dialog)");
  assert.equal(flashState.flashReason, "switched-root", "records project flash reason (tlec)");

  // Verify Descriptive Changelog Commit Cards (je4i)
  await page.evaluate(() => {
    document.getElementById("changelog-open")?.click();
  });
  await page.waitFor(
    () => document.querySelectorAll("#changelog-commits .commit-card").length > 0,
    { label: "changelog commits loaded" },
  );
  const changelogCardsState = await page.evaluate(() => {
    const firstCard = document.querySelector("#changelog-commits .commit-card");
    const badge = firstCard?.querySelector(".commit-badge")?.textContent?.trim();
    const subject = firstCard?.querySelector(".commit-subject")?.textContent?.trim();
    const description = firstCard?.querySelector(".commit-description")?.textContent?.trim();
    const sha = firstCard?.querySelector(".commit-sha")?.textContent?.trim();
    document.getElementById("changelog-close")?.click();
    return {
      hasCard: Boolean(firstCard),
      badge,
      subject,
      description,
      sha,
    };
  });
  assert.equal(changelogCardsState.hasCard, true, "#changelog-commits renders .commit-card items (je4i)");
  assert.ok(Boolean(changelogCardsState.badge), "commit card includes descriptive .commit-badge (je4i)");
  assert.ok(Boolean(changelogCardsState.subject), "commit card includes .commit-subject (je4i)");
  assert.ok(
    Boolean(changelogCardsState.description && changelogCardsState.description.length > 10),
    `commit card includes plain-language .commit-description, got '${changelogCardsState.description}' (je4i)`,
  );
  assert.ok(Boolean(changelogCardsState.sha), "commit card preserves .commit-sha link (je4i)");

  // ── 8. Mic Dock Styling/Spacing, Harnesses Dialog, PWA Hooks & Clipboard Commands ──
  const micDockComparison = await page.evaluate(() => {
    const mic = document.getElementById("mic");
    const dock = document.getElementById("mic-dock");
    if (!mic || !dock) return null;
    const prevHidden = dock.hidden;
    dock.hidden = false;
    const micStyle = getComputedStyle(mic);
    const dockStyle = getComputedStyle(dock);
    const dockRect = dock.getBoundingClientRect();
    const bottomGap = window.innerHeight - dockRect.bottom;
    dock.hidden = prevHidden;
    return {
      micBg: micStyle.backgroundColor,
      dockBg: dockStyle.backgroundColor,
      dockBgImage: dockStyle.backgroundImage,
      micColor: micStyle.color,
      dockColor: dockStyle.color,
      bottomGap,
    };
  });
  assert.ok(micDockComparison, "#mic and #mic-dock exist");
  assert.equal(
    micDockComparison.dockBg,
    micDockComparison.micBg,
    ".mic-dock uses the same var(--card) background color as .mic",
  );
  assert.equal(
    micDockComparison.dockBgImage,
    "none",
    ".mic-dock does not use a dark #000 radial-gradient override",
  );
  assert.equal(
    micDockComparison.dockColor,
    micDockComparison.micColor,
    ".mic-dock uses the same accent icon color as .mic",
  );
  assert.ok(
    micDockComparison.bottomGap >= 28,
    `expected .mic-dock at least 28px from bottom edge, got ${micDockComparison.bottomGap}px`,
  );

  // Verify Harnesses Dialog: no Gemini CLI, includes Antigravity, state legend, Connect/Disconnect buttons, and Agent Progress Tracker
  await page.evaluate(() => {
    document.getElementById("harnesses-open")?.click();
  });
  await page.waitFor(
    () => document.querySelectorAll("#harnesses-list .harness-article").length > 0,
    { label: "harnesses list populated" },
  );
  const harnessesAudit = await page.evaluate(() => {
    const select = document.getElementById("harness-agent-select");
    const options = select ? [...select.options].map((o) => ({ value: o.value, text: o.textContent?.trim() })) : [];
    const legend = document.getElementById("harnesses-state-legend");
    const trackerBtn = document.getElementById("harnesses-open-tracker");
    const rows = [...document.querySelectorAll("#harnesses-list .harness-article")].map((a) => ({
      id: a.dataset.harness,
      title: a.querySelector("h3")?.textContent?.trim(),
      status: a.querySelector(".harness-badge")?.dataset.status,
      badgeText: a.querySelector(".harness-badge")?.textContent?.trim(),
      actionText: a.querySelector(".harness-activate-btn")?.textContent?.trim(),
    }));
    document.getElementById("harnesses-close")?.click();
    return {
      options,
      hasLegend: Boolean(legend && legend.querySelectorAll(".harness-legend-item").length >= 3),
      hasTrackerBtn: Boolean(trackerBtn),
      rows,
    };
  });
  assert.ok(
    !harnessesAudit.options.some((o) => o.value === "gemini" || /gemini cli/i.test(o.text ?? "")),
    "#harness-agent-select must not include Gemini CLI",
  );
  assert.ok(
    harnessesAudit.options.some((o) => o.value === "antigravity" && o.text === "Antigravity"),
    "#harness-agent-select includes Antigravity",
  );
  assert.equal(harnessesAudit.hasLegend, true, "#harnesses-state-legend explains Active, Ready, and Setup needed states");
  assert.equal(harnessesAudit.hasTrackerBtn, true, "#harnesses-open-tracker button exists inside #harnesses-dialog");
  assert.ok(
    !harnessesAudit.rows.some((r) => r.id === "gemini"),
    "#harnesses-list must not render a gemini row",
  );
  assert.ok(
    harnessesAudit.rows.some((r) => r.id === "antigravity" && /Antigravity/i.test(r.title ?? "")),
    "#harnesses-list renders Antigravity row",
  );
  assert.ok(
    harnessesAudit.rows.some((r) => r.actionText === "Connect" || r.actionText === "Disconnect"),
    "#harnesses-list rows provide Connect / Disconnect buttons",
  );

  // Verify PWA manifest link and Service Worker registration hook
  const pwaCheck = await page.evaluate(async () => {
    const manifestLink = document.querySelector('link[rel="manifest"]');
    const themeMeta = document.querySelector('meta[name="theme-color"]');
    const fusedRes = await fetch("/fused.js");
    const fusedSrc = await fusedRes.text();
    return {
      manifestHref: manifestLink?.getAttribute("href"),
      themeColor: themeMeta?.getAttribute("content"),
      hasSwRegister: fusedSrc.includes('serviceWorker.register("/sw.js")'),
    };
  });
  assert.equal(pwaCheck.manifestHref, "manifest.webmanifest", "index.html includes <link rel='manifest' href='manifest.webmanifest'>");
  assert.equal(pwaCheck.themeColor, "#1f3fd0", "index.html includes <meta name='theme-color' content='#1f3fd0'>");
  assert.equal(pwaCheck.hasSwRegister, true, "fused.js registers /sw.js via navigator.serviceWorker.register");

  // Verify executeBrowserSystemCommand handles copy and paste
  const clipboardResult = await page.evaluate(async () => {
    let writtenText = null;
    const origClipboard = navigator.clipboard;
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (t) => { writtenText = t; },
        readText: async () => "pasted from clipboard",
      },
    });
    try {
      const utterance = document.getElementById("utterance");
      if (utterance) utterance.value = "";
      const copyRes = await window.executeBrowserSystemCommand({ command: "copy", text: "copied hello" });
      const pasteRes = await window.executeBrowserSystemCommand({ command: "paste" });
      return {
        copyOk: copyRes?.ok,
        writtenText,
        pasteOk: pasteRes?.ok,
        utteranceValue: utterance?.value,
      };
    } finally {
      if (origClipboard !== undefined) {
        Object.defineProperty(navigator, "clipboard", { configurable: true, value: origClipboard });
      }
    }
  });
  assert.equal(clipboardResult.copyOk, true, "executeBrowserSystemCommand('copy') succeeds");
  assert.equal(clipboardResult.writtenText, "copied hello", "executeBrowserSystemCommand('copy') writes text to clipboard");
  assert.equal(clipboardResult.pasteOk, true, "executeBrowserSystemCommand('paste') succeeds");
  assert.equal(clipboardResult.utteranceValue, "pasted from clipboard", "executeBrowserSystemCommand('paste') populates #utterance");

  // ── 9. Menu Bar Redesign (2eur), Microphone Outside Rings (c17u) & Sync Toast (rwtc) ──
  const menuBarAndRings = await page.evaluate(() => {
    const wordmarkDot = document.querySelector(".head .wordmark .wordmark-dot");
    const whereEl = document.getElementById("help-open");
    const whereStyle = whereEl ? getComputedStyle(whereEl) : null;
    const settingsBtn = document.getElementById("settings-open");
    const settingsBtnStyle = settingsBtn ? getComputedStyle(settingsBtn) : null;
    const ring1 = document.querySelector("#sqeh-arcs i:nth-child(1)");
    const ring2 = document.querySelector("#sqeh-arcs i:nth-child(2)");
    const ring3 = document.querySelector("#sqeh-arcs i:nth-child(3)");
    const r1Style = ring1 ? getComputedStyle(ring1) : null;
    const r2Style = ring2 ? getComputedStyle(ring2) : null;
    const r3Style = ring3 ? getComputedStyle(ring3) : null;
    return {
      hasWordmarkDot: Boolean(wordmarkDot),
      whereRadius: whereStyle?.borderRadius,
      whereBorderWidth: whereStyle?.borderTopWidth,
      iconBtnRadius: settingsBtnStyle?.borderRadius,
      iconBtnBorderWidth: settingsBtnStyle?.borderTopWidth,
      ring1Width: r1Style?.width,
      ring1Opacity: Number(r1Style?.opacity ?? 0),
      ring1BorderStyle: r1Style?.borderTopStyle,
      ring2Width: r2Style?.width,
      ring2Opacity: Number(r2Style?.opacity ?? 0),
      ring2BorderStyle: r2Style?.borderTopStyle,
      ring3OpacityAtRest: Number(r3Style?.opacity ?? 1),
    };
  });
  assert.equal(menuBarAndRings.hasWordmarkDot, true, ".wordmark includes .wordmark-dot status dot (2eur)");
  assert.equal(menuBarAndRings.whereRadius, "999px", ".where is styled as a rounded pill tag (2eur)");
  assert.equal(menuBarAndRings.whereBorderWidth, "1px", ".where has a 1px pill border (2eur)");
  assert.equal(menuBarAndRings.iconBtnRadius, "999px", ".head > .icon-button is a rounded circle button (2eur)");
  assert.equal(menuBarAndRings.iconBtnBorderWidth, "1px", ".head > .icon-button has a 1px card border (2eur)");
  assert.equal(menuBarAndRings.ring1Width, "148px", ".sqeh-arcs i:nth-child(1) is a 148px outside ring (c17u)");
  assert.ok(menuBarAndRings.ring1Opacity > 0.5, `.sqeh-arcs i:nth-child(1) is visible at rest (opacity=${menuBarAndRings.ring1Opacity}) (c17u)`);
  assert.equal(menuBarAndRings.ring1BorderStyle, "solid", ".sqeh-arcs i:nth-child(1) has a solid border (c17u)");
  assert.equal(menuBarAndRings.ring2Width, "178px", ".sqeh-arcs i:nth-child(2) is a 178px outer ring (c17u)");
  assert.ok(menuBarAndRings.ring2Opacity > 0.5, `.sqeh-arcs i:nth-child(2) is visible at rest (opacity=${menuBarAndRings.ring2Opacity}) (c17u)`);
  assert.equal(menuBarAndRings.ring2BorderStyle, "dashed", ".sqeh-arcs i:nth-child(2) has a dashed border (c17u)");
  assert.equal(menuBarAndRings.ring3OpacityAtRest, 0, ".sqeh-arcs i:nth-child(3) pulse ring is hidden at rest (c17u)");

  // Verify Top-Level Out-of-Sync Toast Notification (#sync-toast, rwtc)
  const syncToastCheck = await page.evaluate(() => {
    const toast = document.getElementById("sync-toast");
    const msg = document.getElementById("sync-toast-message");
    const dismiss = document.getElementById("sync-toast-dismiss");
    if (!toast || !msg || !dismiss) return null;
    const initiallyHidden = toast.hidden;
    window.__voiceboxSyncToast?.update({
      outOfSync: true,
      reason: "UI and server are on different revisions. Reload the page or restart the server.",
      key: "rev:aaa->bbb",
    });
    const shownWhenOutOfSync = !toast.hidden && getComputedStyle(toast).display !== "none";
    const shownText = msg.textContent?.trim();
    dismiss.click();
    const hiddenAfterDismiss = toast.hidden;
    // Same key stays dismissed
    window.__voiceboxSyncToast?.update({
      outOfSync: true,
      reason: "UI and server are on different revisions. Reload the page or restart the server.",
      key: "rev:aaa->bbb",
    });
    const staysHiddenForSameKey = toast.hidden;
    // Reset back in sync
    window.__voiceboxSyncToast?.update({ outOfSync: false });
    return {
      initiallyHidden,
      shownWhenOutOfSync,
      shownText,
      hiddenAfterDismiss,
      staysHiddenForSameKey,
    };
  });
  assert.ok(syncToastCheck, "#sync-toast, #sync-toast-message, and #sync-toast-dismiss exist (rwtc)");
  assert.equal(syncToastCheck.initiallyHidden, true, "#sync-toast is hidden when UI and server are in sync (rwtc)");
  assert.equal(syncToastCheck.shownWhenOutOfSync, true, "#sync-toast becomes visible when UI and server are out of sync (rwtc)");
  assert.match(syncToastCheck.shownText ?? "", /different revisions/, "#sync-toast-message explains the revision mismatch (rwtc)");
  assert.equal(syncToastCheck.hiddenAfterDismiss, true, "clicking #sync-toast-dismiss hides #sync-toast (rwtc)");
  assert.equal(syncToastCheck.staysHiddenForSameKey, true, "#sync-toast stays hidden for the dismissed revision key (rwtc)");
});
