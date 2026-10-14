// tests/type-scale.test.mjs — the type scale's BROWSER contract (voicebox-beads-3674, voicebox-beads-dche).
//
// Everything here launches a real Chromium over CDP, so this file is LIVE tier and is covered by the full
// gate (and by the room's acceptance harness). The static half of the same contract — the tokens, the
// 12px floor, the `.sr-only` declaration — needs no browser and lives in tests/type-scale-tokens.test.mjs,
// which is UNIT tier and therefore runs in the fast gate.
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "./lib/server.mjs";
import { launch } from "./lib/cdp.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The room rules this bead lifted off sub-12px literal sizes, with the markup each one needs to apply.
 * Read as computed sizes so a rule that stops resolving (`var(--text-xs)` renamed, a rule deleted, the
 * token shadowed) fails here instead of on somebody's screen. [label, selector, markup]
 */
const LIFTED_ROOM_RULES = [
  ["presence floor badge", ".presence-floor-badge", `<span class="presence-floor-badge">1</span>`],
  ["doctor check status", ".doctor-check-status", `<span class="doctor-check-status">ok</span>`],
  ["doctor check detail", ".doctor-check-detail", `<span class="doctor-check-detail">3 checks ran</span>`],
  ["waiting-branches badge", ".badge", `<button class="quiet branches-open-btn"><span class="badge" aria-hidden="true">2</span></button>`],
  ["branch commit sha", ".branch-commit-sha", `<span class="branch-commit-sha">a26fb12</span>`],
  ["branch meta info", ".branch-meta-info", `<span class="branch-meta-info">2 files changed</span>`],
  ["branch merge badge", ".branch-merge-badge", `<span class="branch-merge-badge">ready</span>`],
  ["branch file status", ".file-status", `<div class="branch-file-item"><span class="file-status status-a">A</span></div>`],
  ["branch file stats", ".file-stats", `<div class="branch-file-item"><span class="file-stats">+2 −1</span></div>`],
];

const FLOOR_PX = 12;

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
  assert.ok(roomMetrics.micPx !== null && roomMetrics.micPx >= FLOOR_PX, `desktop mic badge font-size must be >= ${FLOOR_PX}px, got ${roomMetrics.micPx}`);
  assert.ok(roomMetrics.dockPx !== null && roomMetrics.dockPx >= FLOOR_PX, `sqeh-dock-label font-size must be >= ${FLOOR_PX}px, got ${roomMetrics.dockPx}`);

  // 1b. Every rule this bead lifted, measured off its own markup on the live page
  const lifted = await page.evaluate((rules) => {
    const host = document.createElement("div");
    host.style.cssText = "position:fixed;top:-9999px;left:-9999px;";
    document.body.append(host);
    const measured = rules.map(([label, selector, markup]) => {
      host.innerHTML = markup;
      const el = host.querySelector(selector);
      if (!el) return { label, selector, px: null };
      return { label, selector, px: parseFloat(getComputedStyle(el).fontSize) };
    });
    host.remove();
    return measured;
  }, LIFTED_ROOM_RULES);
  for (const rule of lifted) {
    assert.ok(
      rule.px !== null && rule.px >= FLOOR_PX,
      `${rule.label} (${rule.selector}) must compute to >= ${FLOOR_PX}px, got ${rule.px}`,
    );
  }

  // 2. Room mobile viewport
  await page.emulateViewport({ width: 375, height: 667, mobile: true, scale: 2 });
  const mobileMicPx = await page.evaluate(() => {
    const mic = document.getElementById("mic-hotkey-badge");
    return mic ? parseFloat(window.getComputedStyle(mic).fontSize) : null;
  });
  assert.ok(mobileMicPx !== null && mobileMicPx >= FLOOR_PX, `mobile mic badge font-size must be >= ${FLOOR_PX}px, got ${mobileMicPx}`);
  await page.clearViewport();

  // 3. Agent monitor
  await page.goto(`${server.base}/apps/agent-monitor.html`);
  await page.waitFor(() => document.body !== null);
  const agentPillPx = await page.evaluate(() => {
    const pill = document.querySelector(".pill-toggle-btn");
    return pill ? parseFloat(window.getComputedStyle(pill).fontSize) : null;
  });
  assert.ok(agentPillPx !== null && agentPillPx >= FLOOR_PX, `agent-monitor pill-toggle-btn font-size must be >= ${FLOOR_PX}px, got ${agentPillPx}`);

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
  assert.ok(landingMetrics.commitPx !== null && landingMetrics.commitPx >= FLOOR_PX, `branch-commit font-size must be >= ${FLOOR_PX}px, got ${landingMetrics.commitPx}`);
  assert.ok(landingMetrics.metaPx !== null && landingMetrics.metaPx >= FLOOR_PX, `branch-meta font-size must be >= ${FLOOR_PX}px, got ${landingMetrics.metaPx}`);
  assert.ok(landingMetrics.tagPx !== null && landingMetrics.tagPx >= FLOOR_PX, `file-status-tag font-size must be >= ${FLOOR_PX}px, got ${landingMetrics.tagPx}`);

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
  assert.ok(protoMetrics.kbdPx !== null && protoMetrics.kbdPx >= FLOOR_PX, `prototype mic-kbd font-size must be >= ${FLOOR_PX}px, got ${protoMetrics.kbdPx}`);
  assert.ok(protoMetrics.trayPx !== null && protoMetrics.trayPx >= FLOOR_PX, `prototype bubble-tray-label font-size must be >= ${FLOOR_PX}px, got ${protoMetrics.trayPx}`);
  assert.ok(protoMetrics.badgePx !== null && protoMetrics.badgePx >= FLOOR_PX, `prototype bubble-badge font-size must be >= ${FLOOR_PX}px, got ${protoMetrics.badgePx}`);
});

test("browser: the lifted sizes are rem, so they follow the root font size (voicebox-beads-3674)", { timeout: 60000 }, async (t) => {
  const server = await startServer({
    cwd: ROOT,
    env: { VOICEBOX_WORKSPACE: undefined },
  });
  t.after(() => server.stop());

  const page = await launch();
  t.after(() => page.close());

  await page.goto(`${server.base}/`);
  await page.waitFor(() => document.body !== null);

  // 2x root font size is the user-preference / text-scale case: a px literal would not move at all,
  // a rem token doubles. This is the behaviour the bead adopted instead of hardcoded px (voicebox-beads-3674).
  const scaled = await page.evaluate((rules) => {
    const host = document.createElement("div");
    host.style.cssText = "position:fixed;top:-9999px;left:-9999px;";
    document.body.append(host);
    const before = document.documentElement.style.fontSize;
    document.documentElement.style.fontSize = "32px";
    const measured = rules.map(([label, selector, markup]) => {
      host.innerHTML = markup;
      const el = host.querySelector(selector);
      return { label, selector, px: el ? parseFloat(getComputedStyle(el).fontSize) : null };
    });
    host.remove();
    document.documentElement.style.fontSize = before;
    return measured;
  }, LIFTED_ROOM_RULES);

  for (const rule of scaled) {
    // 0.75rem at a 32px root is 24px; >= 24 asserts it grew with the user's text scale at all.
    assert.ok(
      rule.px !== null && rule.px >= 24,
      `${rule.label} (${rule.selector}) must scale with a 32px root font size (>= 24px), got ${rule.px}`,
    );
  }
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

  const liveCheck = await page.evaluate(() => {
    // The control arm is what makes this test honest: it proves the probe CAN see a scroll container,
    // so a room of zero is a measurement rather than a broken detector.
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

  // The COUNT is deliberately not pinned: 18 became 19 the moment main added a toolbar button
  // (voicebox-beads-dche), and a count is machine state the next lane would have to update. The
  // invariant is the one this bead owns — every .sr-only node that exists clips without scrolling.
  assert.ok(liveCheck.total > 0, "the room must render at least one .sr-only element for this check to mean anything");
  assert.equal(liveCheck.controlHidden, true, "control arm: overflow:hidden 1px box MUST be scrollable (detecting the defect)");
  assert.equal(liveCheck.controlClip, false, "control arm: overflow:clip 1px box must have nothing to scroll");
  assert.equal(liveCheck.scrollableCount, 0, `all ${liveCheck.total} live .sr-only boxes must have 0 scroll containers (6 of 18 measured before the fix), got ${liveCheck.scrollableCount}`);

  // Accessibility tree read: .sr-only text must still name the button
  await page.send("Accessibility.enable");
  const axTree = await page.send("Accessibility.getFullAXTree");
  const harnessesBtn = axTree.nodes.find((n) => n.role?.value === "button" && n.name?.value === "Harnesses");
  assert.ok(harnessesBtn, "the .sr-only text 'Harnesses' must still name its button in the full accessibility tree");
});
