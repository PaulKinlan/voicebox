// tests/ui-ux-accessibility.test.mjs — Verify UI/UX accessibility, readability floor, focus-visible rings, and token consistency (GH #27, voicebox-beads-sodf).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { readComposedCss } from "./lib/css-bundle.mjs";
import path from "node:path";
import { startServer } from "./lib/server.mjs";
import { launch } from "./lib/cdp.mjs";

test("unit: secondary UI surfaces declare explicit focus rings, 12px readability floor, and responsive viewports", () => {
  const root = process.cwd();

  // 1. mini-app-bridge.html declares responsive viewport
  const bridgeHtml = fs.readFileSync(path.join(root, "public/mini-app-bridge.html"), "utf8");
  assert.match(bridgeHtml, /<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">/);

  // 2. style.css task-badge, mini-app-badge, mini-app-source-badge enforce readability floor (0.75rem / 12px)
  const styleCss = readComposedCss(path.join(root, "public/style.css"));
  assert.match(styleCss, /\.task-badge\s*\{[^}]*font-size:\s*0\.75rem;/);
  assert.match(styleCss, /\.mini-app-badge\s*\{[^}]*font-size:\s*0\.75rem;/);
  assert.match(styleCss, /\.mini-app-source-badge\s*\{[^}]*font-size:\s*0\.75rem;/);

  // 3. environment.css declares :focus-visible and the 0.75rem readability floor for .tag.
  //    voicebox-beads-xggy.3 moved this block out of environment.html into a same-origin stylesheet for CSP
  //    readiness, so these assertions follow the rules to the file that now serves them. The invariants are
  //    NOT relaxed: a real focus ring and a 12px floor on the status tag, exactly as before. Relaxing them is
  //    what a failure like this invites, and the whole point of the assertion is that the page keeps them.
  const envCss = fs.readFileSync(path.join(root, "public/environment.css"), "utf8");
  assert.match(envCss, /\.back-nav a:hover,\s*\.back-nav a:focus-visible/);
  assert.match(envCss, /:focus-visible\s*\{[^}]*outline:\s*2px solid/);
  assert.match(envCss, /\.tag\s*\{[^}]*font-size:\s*0\.75rem;/);

  // 4. secondary app pages declare :focus-visible for buttons
  const agentMonitorHtml = fs.readFileSync(path.join(root, "public/apps/agent-monitor.html"), "utf8");
  assert.match(agentMonitorHtml, /\.btn:focus-visible\s*\{/);
  assert.match(agentMonitorHtml, /:focus-visible\s*\{[^}]*outline:\s*2px solid/);
  assert.match(agentMonitorHtml, /id="task-prompt-input"[^>]*aria-label="Multi-harness task prompt"/);

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

  // 9. `.sr-only` in public/environment.css CLIPS; it does not become a scroll container
  //    (voicebox-beads-y5dr). Under `overflow: hidden` the 1px box is still a scroll container, so the
  //    label text inside it has scrollable overflow a script can scroll to — measured on the room's copy
  //    of this rule, where 6 of 18 boxes were real scroll containers: a 65x20 scroll area inside a 1x1
  //    client box, with `scrollLeft = 999` moving it to 64. `overflow: clip` clips the same pixels and
  //    creates nothing to scroll. The live room's copy in public/style.css was fixed in
  //    voicebox-beads-dche (tests/type-scale.test.mjs) and public/environment.css carries the
  //    Environment page's copy (voicebox-beads-y5dr). The browser arm below proves the behaviour,
  //    since a text match cannot see a `clip` that some later rule overrides back to `hidden`.
  const srOnlyRule = /\.sr-only\s*\{([^}]*)\}/.exec(envCss);
  assert.ok(srOnlyRule, "public/environment.css must declare a .sr-only rule");
  assert.match(srOnlyRule[1], /overflow:\s*clip/, "public/environment.css .sr-only must clip without a scroll container");
  assert.doesNotMatch(srOnlyRule[1], /overflow:\s*(?:hidden|auto|scroll)/, "public/environment.css .sr-only must not create a scroll container");
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

  // 4. Environment: back-nav focus, status tag >= 12px, and the placeholder contrast floor. The floor
  // is voicebox-beads-sv2n: the user agent's placeholder grey resolves to #757575 in BOTH schemes, in
  // which it measured 4.34:1 light and 3.87:1 dark against a 4.5:1 requirement, so a light-only
  // assertion would have missed half of it. --muted replaced it (5.76:1 / 6.45:1).
  // The assertion enumerates EVERY element that renders placeholder text rather than naming one input:
  // the first fix covered only #asset-name and left five others failing identically, which review filed
  // as voicebox-beads-yd08. The ratio has to be computed in the page: the colour belongs to a
  // pseudo-element, and only getComputedStyle reads it.
  const readEnvMetrics = () => {
    const backNav = document.querySelector(".back-nav a");
    backNav.focus();
    const backStyle = window.getComputedStyle(backNav);

    const tag = document.querySelector(".tag");
    const tagStyle = window.getComputedStyle(tag);

    const luminance = (rgb) => {
      const channels = rgb.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number).map((value) => {
        const c = value / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
    };
    const contrast = (a, b) => {
      const la = luminance(a);
      const lb = luminance(b);
      return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
    };

    // Every placeholder on the page, so a future element cannot quietly reintroduce the user agent grey.
    const placeholders = [...document.querySelectorAll("[placeholder]")].map((element) => {
      const placeholderStyle = window.getComputedStyle(element, "::placeholder");
      return {
        id: element.id || element.tagName.toLowerCase(),
        color: placeholderStyle.color,
        ratio: Number(contrast(placeholderStyle.color, window.getComputedStyle(element).backgroundColor).toFixed(2)),
      };
    });

    return {
      backOutlineStyle: backStyle.outlineStyle,
      backOutlineWidth: backStyle.outlineWidth,
      backOutlineOffset: backStyle.outlineOffset,
      backOutlineColor: backStyle.outlineColor,
      tagFontSizePx: parseFloat(tagStyle.fontSize),
      placeholders,
    };
  };

  await page.goto(`${server.base}/environment.html`);
  const envMetrics = await page.evaluate(readEnvMetrics);
  // Pin the page's OWN ring rather than the presence of one (voicebox-beads-oiod). `!== "none"` was
  // vacuous: with public/environment.css not reaching the page the user agent still supplies its own
  // focus ring — measured as `auto` / 1px / 1px / rgb(16, 16, 16) — so the assertion stayed green with
  // the page's rule absent. With the rule present these resolve to solid / 2px / 2px / var(--accent),
  // and that last value is the light arm, which is what this test launches in.
  assert.equal(envMetrics.backOutlineStyle, "solid", `back-nav focus ring must be the page's own, got ${envMetrics.backOutlineStyle}`);
  assert.equal(envMetrics.backOutlineWidth, "2px", `back-nav focus ring width must be 2px, got ${envMetrics.backOutlineWidth}`);
  assert.equal(envMetrics.backOutlineOffset, "2px", `back-nav focus ring offset must be 2px, got ${envMetrics.backOutlineOffset}`);
  assert.equal(envMetrics.backOutlineColor, "rgb(31, 63, 208)", `back-nav focus ring must use --accent, got ${envMetrics.backOutlineColor}`);
  assert.ok(envMetrics.tagFontSizePx >= 12, `tag font size must be >= 12px, got ${envMetrics.tagFontSizePx}px`);
  // A non-empty enumeration is itself asserted: an earlier version of this test named one input and would
  // have stayed green while five others failed, so a selector that silently matches nothing must fail.
  assert.ok(envMetrics.placeholders.length >= 6, `expected at least the page's six placeholder elements to be measured, got ${envMetrics.placeholders.length}`);
  const belowFloor = envMetrics.placeholders.filter((p) => p.ratio < 4.5);
  assert.equal(belowFloor.length, 0, `${belowFloor.length} of ${envMetrics.placeholders.length} placeholders are below 4.5:1: ${belowFloor.map((p) => `${p.id} ${p.ratio}:1 at ${p.color}`).join(", ")}`);

  await page.screenshot(path.join(evidenceDir, "04-environment-focus-and-tag.png"));

  // The same floor in the dark arm. The user agent supplied the same grey in both schemes, so the
  // shortfall was a two-scheme bug rather than a light one, and the fix is asserted the same way.
  await page.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
  try {
    await page.goto(`${server.base}/environment.html`);
    const envMetricsDark = await page.evaluate(readEnvMetrics);
    assert.ok(envMetricsDark.placeholders.length >= 6, `expected at least the page's six placeholder elements in dark too, got ${envMetricsDark.placeholders.length}`);
    const belowFloorDark = envMetricsDark.placeholders.filter((p) => p.ratio < 4.5);
    assert.equal(belowFloorDark.length, 0, `dark: ${belowFloorDark.length} of ${envMetricsDark.placeholders.length} placeholders are below 4.5:1: ${belowFloorDark.map((p) => `${p.id} ${p.ratio}:1 at ${p.color}`).join(", ")}`);
    await page.screenshot(path.join(evidenceDir, "04b-environment-placeholder-dark.png"));
  } finally {
    await page.send("Emulation.setEmulatedMedia", { features: [] });
  }

  // 4c. `.sr-only` CLIPS rather than scrolls, and it still NAMES a control for assistive technology
  // (voicebox-beads-y5dr). environment.html uses the class nowhere, so the elements under test are
  // created here — but the rule they exercise is the SERVED stylesheet's, and the computed-`overflow`
  // assertion is what proves the page's own CSS answered rather than a user-agent default. Four arms,
  // because none of them alone is enough: the probe must be un-scrollable; an identical box with
  // `overflow: hidden` must still REPORT ITSELF SCROLLABLE, or the measurement cannot see the defect it
  // exists for; an identical box with `clip` must not, so a page where the declaration never arrives
  // cannot pass on a user-agent default; and the accessibility tree must carry the hidden text as its
  // button's name while a `display:none` sibling's text names nothing at all, so the read can tell a
  // hidden label from an absent one (voicebox-beads-y5dr's dispatch asked for exactly that control).
  // A navigation of its own: this section must not depend on which page-load arm 4 left behind.
  await page.goto(`${server.base}/environment.html`);
  const srProbe = await page.evaluate(() => {
    const arm = (overflow) => {
      const box = document.createElement("span");
      box.textContent = "Harnesses Controls";
      box.style.cssText = `position:absolute;width:1px;height:1px;clip-path:inset(50%);white-space:nowrap;overflow:${overflow};`;
      document.body.append(box);
      box.scrollLeft = 999;
      box.scrollTop = 999;
      const scrolled = box.scrollLeft !== 0 || box.scrollTop !== 0;
      box.remove();
      return scrolled;
    };

    const host = document.createElement("div");
    host.id = "sr-only-probe-host";
    host.innerHTML =
      '<button id="sr-only-probe"><span class="sr-only">sr-only names this button</span></button>' +
      '<button id="sr-only-visible"><span>visible text names this button</span></button>' +
      '<button id="sr-only-display-none"><span style="display:none">display:none text names nothing</span></button>';
    document.body.append(host);

    const probe = host.querySelector(".sr-only");
    const style = window.getComputedStyle(probe);
    const rect = probe.getBoundingClientRect();
    probe.scrollLeft = 999;
    probe.scrollTop = 999;
    return {
      overflow: `${style.overflowX}/${style.overflowY}`,
      clipPath: style.clipPath,
      display: style.display,
      visibility: style.visibility,
      box: `${rect.width}x${rect.height}`,
      scrolled: probe.scrollLeft !== 0 || probe.scrollTop !== 0,
      controlHidden: arm("hidden"),
      controlClip: arm("clip"),
    };
  });

  assert.equal(srProbe.overflow, "clip/clip", `the served environment.css must answer for .sr-only, got ${srProbe.overflow}`);
  assert.match(srProbe.clipPath, /inset\(50%\)/, `the shrinking clip-path must survive, got ${srProbe.clipPath}`);
  assert.notEqual(srProbe.display, "none", `.sr-only must stay in the render tree, got display: ${srProbe.display}`);
  assert.notEqual(srProbe.visibility, "hidden", `.sr-only must stay visible-but-clipped, got visibility: ${srProbe.visibility}`);
  assert.equal(srProbe.box, "1x1", `.sr-only must still collapse to its 1x1 box, got ${srProbe.box}`);
  assert.equal(srProbe.controlHidden, true, "control arm: an `overflow: hidden` 1px box MUST report itself scrollable, or this check cannot detect the defect it exists for");
  assert.equal(srProbe.controlClip, false, "control arm: an `overflow: clip` 1px box must have nothing to scroll");
  assert.equal(srProbe.scrolled, false, `.sr-only must not be a scroll container (${srProbe.box} box)`);

  // The hidden text must still BE the button's name, read from the real accessibility tree rather than
  // from `textContent` — `textContent` cannot tell a clipped label from one that left the tree, which is
  // the regression this arm exists to catch. The visible and `display:none` buttons are its controls.
  await page.send("Accessibility.enable");
  const axTree = await page.send("Accessibility.getFullAXTree");
  const namedButtons = (want) => axTree.nodes.filter((node) => node.role?.value === "button" && node.name?.value === want).length;
  assert.equal(namedButtons("visible text names this button"), 1, "the accessibility tree read must see a plainly visible button's name, or it cannot be trusted for the hidden one");
  assert.equal(namedButtons("sr-only names this button"), 1, "the sr-only text must still name its button for assistive technology");
  assert.equal(namedButtons("display:none text names nothing"), 0, "control: `display:none` text must NOT name anything, so this read can tell a hidden label from an absent one");

  await page.screenshot(path.join(evidenceDir, "04c-sr-only-clipped-not-scrolled.png"));
  await page.evaluate(() => document.getElementById("sr-only-probe-host")?.remove());

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
