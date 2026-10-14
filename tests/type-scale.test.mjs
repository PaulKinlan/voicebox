// tests/type-scale.test.mjs — verify legible type scale tokens and sub-12px text lifting (voicebox-beads-3674)
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "./lib/server.mjs";
import { launch } from "./lib/cdp.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC = path.join(ROOT, "public");

test("static: public/style.css defines legible --text-* type scale tokens with 0.75rem floor", () => {
  const css = readFileSync(path.join(PUBLIC, "style.css"), "utf8");
  assert.match(css, /--text-xs:\s*0\.75rem;/, "style.css must declare --text-xs: 0.75rem");
  assert.match(css, /--text-sm:\s*0\.8125rem;/, "style.css must declare --text-sm: 0.8125rem");
  assert.match(css, /--text-base:\s*0\.875rem;/, "style.css must declare --text-base: 0.875rem");
  assert.match(css, /--text-md:\s*0\.9375rem;/, "style.css must declare --text-md: 0.9375rem");
  assert.match(css, /--text-lg:\s*1rem;/, "style.css must declare --text-lg: 1rem");
  assert.match(css, /--text-xl:\s*1\.125rem;/, "style.css must declare --text-xl: 1.125rem");
  assert.match(css, /--text-2xl:\s*1\.25rem;/, "style.css must declare --text-2xl: 1.25rem");
});

test("static: public/style.css contains zero sub-12px font-size declarations", () => {
  const css = readFileSync(path.join(PUBLIC, "style.css"), "utf8");
  const lines = css.split("\n");
  const sub12px = [];
  lines.forEach((line, idx) => {
    const matches = line.matchAll(/font-size:\s*([^;]+);/g);
    for (const match of matches) {
      const val = match[1].trim();
      let px = null;
      if (val.endsWith("rem")) {
        const num = parseFloat(val.replace("rem", ""));
        px = num * 16;
      } else if (val.endsWith("px")) {
        px = parseFloat(val.replace("px", ""));
      }
      if (px !== null && px < 12) {
        sub12px.push({ line: idx + 1, val, px, text: line.trim() });
      }
    }
  });
  assert.deepEqual(sub12px, [], "style.css must contain no sub-12px font-size declarations");
});

test("static: secondary app pages and prototype define type tokens and contain zero sub-12px font-size", () => {
  const files = [
    path.join(PUBLIC, "apps", "agent-monitor.html"),
    path.join(PUBLIC, "apps", "landing-inspector.html"),
    path.join(ROOT, "designs", "prototype.html"),
  ];

  for (const file of files) {
    const content = readFileSync(file, "utf8");
    assert.match(content, /--text-xs:\s*0\.75rem;/, `${path.basename(file)} must declare --text-xs`);

    const lines = content.split("\n");
    const sub12px = [];
    lines.forEach((line, idx) => {
      const matches = line.matchAll(/font-size:\s*([^;]+);/g);
      for (const match of matches) {
        const val = match[1].trim();
        let px = null;
        if (val.endsWith("rem")) {
          const num = parseFloat(val.replace("rem", ""));
          px = num * 16;
        } else if (val.endsWith("px")) {
          px = parseFloat(val.replace("px", ""));
        }
        if (px !== null && px < 12) {
          sub12px.push({ file: path.basename(file), line: idx + 1, val, px });
        }
      }
    });
    assert.deepEqual(sub12px, [], `${path.basename(file)} must contain no sub-12px font-size declarations`);
  }
});

test("browser: computed font sizes meet or exceed 12px across room, mobile, and secondary apps (voicebox-beads-3674)", { timeout: 60000 }, async (t) => {
  const server = await startServer({
    cwd: ROOT,
    env: { VOICEBOX_WORKSPACE: undefined },
  });
  t.after(() => server.stop());

  const page = await launch();
  t.after(() => page.close());

  // 1. Room desktop
  await page.goto(`${server.base}/`);
  await page.waitFor(() => document.body !== null);

  const roomMetrics = await page.evaluate(() => {
    const mic = document.getElementById("mic-hotkey-badge");
    const dock = document.querySelector(".sqeh-dock-label");
    return {
      micPx: mic ? parseFloat(window.getComputedStyle(mic).fontSize) : null,
      dockPx: dock ? parseFloat(window.getComputedStyle(dock).fontSize) : null,
    };
  });
  assert.ok(roomMetrics.micPx !== null && roomMetrics.micPx >= 12, `desktop mic badge font-size must be >= 12px, got ${roomMetrics.micPx}`);
  assert.ok(roomMetrics.dockPx !== null && roomMetrics.dockPx >= 12, `sqeh-dock-label font-size must be >= 12px, got ${roomMetrics.dockPx}`);

  // 2. Room mobile viewport
  await page.emulateViewport({ width: 375, height: 667, mobile: true, scale: 2 });
  const mobileMicPx = await page.evaluate(() => {
    const mic = document.getElementById("mic-hotkey-badge");
    return mic ? parseFloat(window.getComputedStyle(mic).fontSize) : null;
  });
  assert.ok(mobileMicPx !== null && mobileMicPx >= 12, `mobile mic badge font-size must be >= 12px, got ${mobileMicPx}`);
  await page.clearViewport();

  // 3. Agent monitor
  await page.goto(`${server.base}/apps/agent-monitor.html`);
  await page.waitFor(() => document.body !== null);
  const agentPillPx = await page.evaluate(() => {
    const pill = document.querySelector(".pill-toggle-btn");
    return pill ? parseFloat(window.getComputedStyle(pill).fontSize) : null;
  });
  assert.ok(agentPillPx !== null && agentPillPx >= 12, `agent-monitor pill-toggle-btn font-size must be >= 12px, got ${agentPillPx}`);

  // 4. Landing inspector
  await page.goto(`${server.base}/apps/landing-inspector.html`);
  await page.waitFor(() => document.body !== null);
  const landingMetrics = await page.evaluate(() => {
    const commit = document.querySelector(".branch-commit");
    const meta = document.querySelector(".branch-meta");
    const tag = document.querySelector(".file-status-tag");
    return {
      commitPx: commit ? parseFloat(window.getComputedStyle(commit).fontSize) : null,
      metaPx: meta ? parseFloat(window.getComputedStyle(meta).fontSize) : null,
      tagPx: tag ? parseFloat(window.getComputedStyle(tag).fontSize) : null,
    };
  });
  assert.ok(landingMetrics.commitPx !== null && landingMetrics.commitPx >= 12, `branch-commit font-size must be >= 12px, got ${landingMetrics.commitPx}`);
  assert.ok(landingMetrics.metaPx !== null && landingMetrics.metaPx >= 12, `branch-meta font-size must be >= 12px, got ${landingMetrics.metaPx}`);
  assert.ok(landingMetrics.tagPx !== null && landingMetrics.tagPx >= 12, `file-status-tag font-size must be >= 12px, got ${landingMetrics.tagPx}`);

  // 5. Prototype
  await page.goto(`file://${path.join(ROOT, "designs", "prototype.html")}`);
  await page.waitFor(() => document.body !== null);
  const protoMetrics = await page.evaluate(() => {
    const kbd = document.querySelector(".mic-kbd");
    const tray = document.querySelector(".bubble-tray-label");
    const badge = document.querySelector(".bubble-pill .bubble-badge");
    return {
      kbdPx: kbd ? parseFloat(window.getComputedStyle(kbd).fontSize) : null,
      trayPx: tray ? parseFloat(window.getComputedStyle(tray).fontSize) : null,
      badgePx: badge ? parseFloat(window.getComputedStyle(badge).fontSize) : null,
    };
  });
  assert.ok(protoMetrics.kbdPx !== null && protoMetrics.kbdPx >= 12, `prototype mic-kbd font-size must be >= 12px, got ${protoMetrics.kbdPx}`);
  assert.ok(protoMetrics.trayPx !== null && protoMetrics.trayPx >= 12, `prototype bubble-tray-label font-size must be >= 12px, got ${protoMetrics.trayPx}`);
  assert.ok(protoMetrics.badgePx !== null && protoMetrics.badgePx >= 12, `prototype bubble-badge font-size must be >= 12px, got ${protoMetrics.badgePx}`);
});

test("static: public/style.css .sr-only clips without creating a scroll container (voicebox-beads-dche)", () => {
  const css = readFileSync(path.join(PUBLIC, "style.css"), "utf8");
  const srOnlyRule = /\.sr-only\s*\{([^}]*)\}/.exec(css);
  assert.ok(srOnlyRule, "public/style.css must declare a .sr-only rule");
  assert.match(srOnlyRule[1], /overflow:\s*clip/, "public/style.css .sr-only must clip without a scroll container");
  assert.doesNotMatch(srOnlyRule[1], /overflow:\s*(?:hidden|auto|scroll)/, "public/style.css .sr-only must not create a scroll container");
});

test("browser: room .sr-only elements clip with zero scroll containers and preserve accessible button names (voicebox-beads-dche)", { timeout: 60000 }, async (t) => {
  const server = await startServer({
    cwd: ROOT,
    env: { VOICEBOX_WORKSPACE: undefined },
  });
  t.after(() => server.stop());

  const page = await launch();
  t.after(() => page.close());

  await page.goto(`${server.base}/`);
  await page.waitFor(() => document.body !== null);

  // Live room .sr-only nodes (all 18 nodes) have 0 scroll containers + control arms
  const liveCheck = await page.evaluate(() => {
    const arm = (overflow) => {
      const box = document.createElement("span");
      box.textContent = "Harnesses Controls Long Text Overflow";
      box.style.cssText = `position:absolute;width:1px;height:1px;clip-path:inset(50%);white-space:nowrap;overflow:${overflow};`;
      document.body.append(box);
      box.scrollLeft = 999;
      box.scrollTop = 999;
      const scrolled = box.scrollLeft !== 0 || box.scrollTop !== 0;
      box.remove();
      return scrolled;
    };

    const nodes = [...document.querySelectorAll(".sr-only")];
    const scrollable = [];
    nodes.forEach((node, i) => {
      node.scrollLeft = 999;
      node.scrollTop = 999;
      if (node.scrollLeft !== 0 || node.scrollTop !== 0) {
        scrollable.push({ index: i, text: node.textContent, scrollLeft: node.scrollLeft });
      }
    });

    return {
      total: nodes.length,
      scrollableCount: scrollable.length,
      scrollable,
      controlHidden: arm("hidden"),
      controlClip: arm("clip"),
    };
  });

  assert.equal(liveCheck.total, 18, "room must carry exactly 18 .sr-only elements");
  assert.equal(liveCheck.controlHidden, true, "control arm: overflow:hidden 1px box MUST be scrollable (detecting the defect)");
  assert.equal(liveCheck.controlClip, false, "control arm: overflow:clip 1px box must have nothing to scroll");
  assert.equal(liveCheck.scrollableCount, 0, `all 18 live .sr-only boxes must have 0 scroll containers (was 6 before fix), got ${liveCheck.scrollableCount}`);

  // Accessibility tree read: .sr-only text must still name the button
  await page.send("Accessibility.enable");
  const axTree = await page.send("Accessibility.getFullAXTree");
  const harnessesBtn = axTree.nodes.find((n) => n.role?.value === "button" && n.name?.value === "Harnesses");
  assert.ok(harnessesBtn, "the .sr-only text 'Harnesses' must still name its button in the full accessibility tree");
});
