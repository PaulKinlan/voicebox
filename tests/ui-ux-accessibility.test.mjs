// tests/ui-ux-accessibility.test.mjs — Verify UI/UX accessibility, readability floor, focus-visible rings, and token consistency (GH #27, voicebox-beads-sodf).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { startServer } from "./lib/server.mjs";
import { launch } from "./lib/cdp.mjs";

test("unit: secondary UI surfaces declare explicit focus rings, 12px readability floor, and responsive viewports", () => {
  const root = process.cwd();

  // 1. mini-app-bridge.html declares responsive viewport
  const bridgeHtml = fs.readFileSync(path.join(root, "public/mini-app-bridge.html"), "utf8");
  assert.match(bridgeHtml, /<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">/);

  // 2. style.css task-badge, mini-app-badge, mini-app-source-badge enforce readability floor (0.75rem / 12px)
  const styleCss = fs.readFileSync(path.join(root, "public/style.css"), "utf8");
  assert.match(styleCss, /\.task-badge\s*\{[^}]*font-size:\s*0\.75rem;/);
  assert.match(styleCss, /\.mini-app-badge\s*\{[^}]*font-size:\s*0\.75rem;/);
  assert.match(styleCss, /\.mini-app-source-badge\s*\{[^}]*font-size:\s*0\.75rem;/);

  // 3. environment.html declares :focus-visible and 0.75rem readability floor for .tag
  const envHtml = fs.readFileSync(path.join(root, "public/environment.html"), "utf8");
  assert.match(envHtml, /\.back-nav a:hover,\s*\.back-nav a:focus-visible/);
  assert.match(envHtml, /:focus-visible\s*\{[^}]*outline:\s*2px solid/);
  assert.match(envHtml, /\.tag\s*\{[^}]*font-size:\s*0\.75rem;/);

  // 4. secondary app pages declare :focus-visible for buttons
  const agentMonitorHtml = fs.readFileSync(path.join(root, "public/apps/agent-monitor.html"), "utf8");
  assert.match(agentMonitorHtml, /\.btn:focus-visible\s*\{/);
  assert.match(agentMonitorHtml, /:focus-visible\s*\{[^}]*outline:\s*2px solid/);

  const landingInspectorHtml = fs.readFileSync(path.join(root, "public/apps/landing-inspector.html"), "utf8");
  assert.match(landingInspectorHtml, /\.btn:focus-visible:not\(:disabled\)\s*\{/);
  assert.match(landingInspectorHtml, /:focus-visible\s*\{[^}]*outline:\s*2px solid/);

  const liveVisionHtml = fs.readFileSync(path.join(root, "public/apps/live-vision-studio.html"), "utf8");
  assert.match(liveVisionHtml, /\.btn:focus-visible:not\(:disabled\)\s*\{/);
  assert.match(liveVisionHtml, /:focus-visible\s*\{[^}]*outline:\s*2px solid/);

  // 5. prototype.html declares :focus-visible for pill buttons and search input
  const prototypeHtml = fs.readFileSync(path.join(root, "designs/prototype.html"), "utf8");
  assert.match(prototypeHtml, /\.pill-btn:focus-visible\s*\{/);
  assert.match(prototypeHtml, /\.files-search:focus-visible\s*\{/);

  // 6. changelog.css and harnesses.css declare semantic custom properties
  const changelogCss = fs.readFileSync(path.join(root, "public/changelog.css"), "utf8");
  assert.match(changelogCss, /--surface:\s*#101014;/);
  assert.match(changelogCss, /--accent:\s*#abc8ff;/);

  const harnessesCss = fs.readFileSync(path.join(root, "public/harnesses.css"), "utf8");
  assert.match(harnessesCss, /--surface:\s*#101014;/);
  assert.match(harnessesCss, /--accent:\s*#abc8ff;/);

  // 7. styles.css is valid CSS without stray </style> tag and declares tokens
  const stylesCss = fs.readFileSync(path.join(root, "public/styles.css"), "utf8");
  assert.equal(stylesCss.includes("</style>"), false, "public/styles.css must not contain a stray </style> tag");
  assert.match(stylesCss, /--danger:\s*light-dark/);

  // 8. evidence page declares color-scheme
  const evidenceHtml = fs.readFileSync(path.join(root, "docs/evidence/picked-dir-symlink/index.html"), "utf8");
  assert.match(evidenceHtml, /color-scheme:\s*light dark;/);
});

test("browser: secondary UI surfaces render visible focus rings, readable typography, and responsive mobile layouts", { timeout: 45000 }, async (t) => {
  const server = await startServer();
  t.after(() => server.stop());

  const page = await launch({ width: 1200, height: 900 });
  t.after(() => page.close());

  const evidenceDir = "/tmp/sodf-evidence";
  if (!fs.existsSync(evidenceDir)) fs.mkdirSync(evidenceDir, { recursive: true });

  // 1. Agent Monitor: button focus-visible
  await page.goto(`${server.base}/apps/agent-monitor.html`);
  const monitorFocus = await page.evaluate(() => {
    const btn = document.querySelector(".btn");
    btn.focus();
    const style = window.getComputedStyle(btn);
    return {
      tagName: btn.tagName,
      outlineStyle: style.outlineStyle,
      outlineWidth: style.outlineWidth,
      outlineColor: style.outlineColor,
      outlineOffset: style.outlineOffset,
    };
  });
  assert.notEqual(monitorFocus.outlineStyle, "none");
  assert.equal(monitorFocus.outlineWidth, "2px");
  assert.equal(monitorFocus.outlineOffset, "2px");

  await page.screenshot(path.join(evidenceDir, "01-agent-monitor-focus.png"));

  // 2. Landing Inspector: button focus-visible
  await page.goto(`${server.base}/apps/landing-inspector.html`);
  const inspectorFocus = await page.evaluate(() => {
    const btn = document.querySelector(".btn");
    btn.focus();
    const style = window.getComputedStyle(btn);
    return {
      tagName: btn.tagName,
      outlineStyle: style.outlineStyle,
      outlineWidth: style.outlineWidth,
      outlineOffset: style.outlineOffset,
    };
  });
  assert.notEqual(inspectorFocus.outlineStyle, "none");
  assert.equal(inspectorFocus.outlineWidth, "2px");
  assert.equal(inspectorFocus.outlineOffset, "2px");

  await page.screenshot(path.join(evidenceDir, "02-landing-inspector-focus.png"));

  // 3. Live Vision Studio: button focus-visible
  await page.goto(`${server.base}/apps/live-vision-studio.html`);
  const studioFocus = await page.evaluate(() => {
    const btn = document.querySelector(".btn");
    btn.focus();
    const style = window.getComputedStyle(btn);
    return {
      tagName: btn.tagName,
      outlineStyle: style.outlineStyle,
      outlineWidth: style.outlineWidth,
      outlineOffset: style.outlineOffset,
    };
  });
  assert.notEqual(studioFocus.outlineStyle, "none");
  assert.equal(studioFocus.outlineWidth, "2px");
  assert.equal(studioFocus.outlineOffset, "2px");

  await page.screenshot(path.join(evidenceDir, "03-live-vision-studio-focus.png"));

  // 4. Environment: back-nav focus & status tag >= 12px
  await page.goto(`${server.base}/environment.html`);
  const envMetrics = await page.evaluate(() => {
    const backNav = document.querySelector(".back-nav a");
    backNav.focus();
    const backStyle = window.getComputedStyle(backNav);

    const tag = document.querySelector(".tag");
    const tagStyle = window.getComputedStyle(tag);
    const parsedFontSize = parseFloat(tagStyle.fontSize);

    return {
      backOutlineStyle: backStyle.outlineStyle,
      tagFontSizePx: parsedFontSize,
    };
  });
  assert.notEqual(envMetrics.backOutlineStyle, "none");
  assert.ok(envMetrics.tagFontSizePx >= 12, `tag font size must be >= 12px, got ${envMetrics.tagFontSizePx}px`);

  await page.screenshot(path.join(evidenceDir, "04-environment-focus-and-tag.png"));

  // 5. Mini-App Bridge: mobile viewport sizing (375x667)
  // Close previous page before launching next browser instance per single-browser rule
  await page.close();

  const mobilePage = await launch({ width: 375, height: 667 });
  t.after(() => mobilePage.close());

  await mobilePage.send("Emulation.setDeviceMetricsOverride", {
    width: 375,
    height: 667,
    deviceScaleFactor: 2,
    mobile: true,
  });

  await mobilePage.goto(`${server.base}/mini-app-bridge.html`);
  const bridgeDimensions = await mobilePage.evaluate(() => {
    const body = document.body;
    const iframe = document.getElementById("inner-app");
    return {
      windowWidth: window.innerWidth,
      bodyWidth: body.clientWidth,
      iframeWidth: iframe.clientWidth,
      viewportMeta: document.querySelector('meta[name="viewport"]')?.getAttribute("content"),
    };
  });
  assert.equal(bridgeDimensions.windowWidth, 375);
  assert.equal(bridgeDimensions.bodyWidth, 375);
  assert.equal(bridgeDimensions.iframeWidth, 375);
  assert.match(bridgeDimensions.viewportMeta, /width=device-width/);

  await mobilePage.screenshot(path.join(evidenceDir, "05-mini-app-bridge-mobile.png"));

  // 6. Changelog: dark palette token rendering
  await mobilePage.goto(`${server.base}/changelog.html`);
  const changelogTokens = await mobilePage.evaluate(() => {
    const rootStyle = window.getComputedStyle(document.documentElement);
    return {
      surface: rootStyle.getPropertyValue("--surface").trim(),
      accent: rootStyle.getPropertyValue("--accent").trim(),
      line: rootStyle.getPropertyValue("--line").trim(),
      bgColor: rootStyle.backgroundColor,
    };
  });
  assert.equal(changelogTokens.surface, "#101014");
  assert.equal(changelogTokens.accent, "#abc8ff");
  assert.equal(changelogTokens.line, "#333344");

  await mobilePage.screenshot(path.join(evidenceDir, "06-changelog-dark-tokens.png"));

  // 7. Harnesses: dark palette token rendering
  await mobilePage.goto(`${server.base}/harnesses.html`);
  const harnessesTokens = await mobilePage.evaluate(() => {
    const rootStyle = window.getComputedStyle(document.documentElement);
    return {
      surface: rootStyle.getPropertyValue("--surface").trim(),
      accent: rootStyle.getPropertyValue("--accent").trim(),
      line: rootStyle.getPropertyValue("--line").trim(),
      bgColor: rootStyle.backgroundColor,
    };
  });
  assert.equal(harnessesTokens.surface, "#101014");
  assert.equal(harnessesTokens.accent, "#abc8ff");
  assert.equal(harnessesTokens.line, "#666666");

  await mobilePage.screenshot(path.join(evidenceDir, "07-harnesses-dark-tokens.png"));
});
