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
