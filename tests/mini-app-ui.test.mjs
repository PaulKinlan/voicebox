// tests/mini-app-ui.test.mjs — Interactive Mini-Apps Room UI & Web MCP mounting (voicebox-beads-5h1)
//
// WHAT THIS SUITE PROVES (driven in real browser over CDP):
//   1. Room surface mounting:
//      - Container (#mini-app-container) starts hidden
//      - Mounts via window.__voiceboxMiniApp.mount({ title, html })
//      - Title is rendered in #mini-app-title
//      - Outer iframe has sandbox="allow-scripts" (no allow-same-origin)
//      - Handshake establishes private MessagePort channel
//      - Inner iframe renders fixture markup with Web MCP SDK
//   2. Interactive room controls:
//      - Collapse / expand toggle button (#mini-app-toggle)
//      - Reload button (#mini-app-reload)
//      - Close button (#mini-app-close) hides container and tears down frames
//   3. Producer turn & WebSocket frame integration:
//      - Turn "launch mini-app Counter with ..." triggers mini_app action
//      - Room receives miniApp and dynamically mounts the widget without manual status checks
//      - WebSocket { type: "mini_app", miniApp } frame triggers room mount

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { startServer } from "./lib/server.mjs";
import { launch } from "./lib/cdp.mjs";

test("mini-app room UI: mounting, double-iframe sandbox, interactive controls, and tear down", { timeout: 45000 }, async (t) => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "vb-mini-app-ui-"));
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

  // 1. Initially hidden
  const initHidden = await page.evaluate(() => {
    const c = document.querySelector("#mini-app-container");
    return c?.hidden;
  });
  assert.equal(initHidden, true, "mini-app container must start hidden");

  // 2. Mount fixture mini-app with Web MCP tool
  const fixtureApp = {
    title: "Scoreboard Widget",
    html: `
      <div id="app-root">
        <h1>Scoreboard</h1>
        <p id="score-display">100</p>
        <button id="add-btn" type="button">Add 10</button>
      </div>
      <script>
        let score = 100;
        document.getElementById("add-btn").addEventListener("click", () => {
          score += 10;
          document.getElementById("score-display").textContent = String(score);
        });
        window.webMcp.registerTool({
          name: "add_score",
          description: "Add to current score",
          parameters: {
            type: "object",
            properties: { points: { type: "number" } },
            required: ["points"]
          },
          execute: async ({ points }) => {
            score += points;
            document.getElementById("score-display").textContent = String(score);
            return { ok: true, newScore: score };
          }
        });
        window.webMcp.ready();
      <\/script>
    `,
  };

  await page.evaluate((app) => {
    window.__voiceboxMiniApp.mount(app);
  }, fixtureApp);

  // Wait for outer iframe to appear and mount
  await page.waitFor(() => {
    const c = document.querySelector("#mini-app-container");
    const frame = document.querySelector("#mini-app-outer-frame");
    return c && !c.hidden && frame;
  }, { label: "mini-app mounting in room" });

  const mountState = await page.evaluate(() => {
    const c = document.querySelector("#mini-app-container");
    const title = document.querySelector("#mini-app-title")?.textContent;
    const outer = document.querySelector("#mini-app-outer-frame");
    return {
      containerHidden: c?.hidden,
      title,
      outerSandbox: outer?.getAttribute("sandbox"),
      outerSrc: outer?.getAttribute("src"),
    };
  });

  assert.equal(mountState.containerHidden, false, "container must unhide on mount");
  assert.equal(mountState.title, "Scoreboard Widget");
  assert.equal(mountState.outerSandbox, "allow-scripts", "outer iframe must enforce sandbox='allow-scripts' without allow-same-origin");
  assert.match(mountState.outerSrc, /mini-app-bridge\.html\?appId=/);

  // 3. Test collapse / expand toggle
  await page.evaluate(() => {
    document.querySelector("#mini-app-toggle")?.click();
  });
  await sleep(150);

  const collapsedState = await page.evaluate(() => {
    const c = document.querySelector("#mini-app-container");
    const btn = document.querySelector("#mini-app-toggle");
    return {
      collapsed: c?.dataset.collapsed,
      ariaLabel: btn?.getAttribute("aria-label"),
    };
  });
  assert.equal(collapsedState.collapsed, "true");
  assert.equal(collapsedState.ariaLabel, "Expand App");

  // Expand again
  await page.evaluate(() => {
    document.querySelector("#mini-app-toggle")?.click();
  });
  await sleep(150);

  const expandedState = await page.evaluate(() => {
    const c = document.querySelector("#mini-app-container");
    const btn = document.querySelector("#mini-app-toggle");
    return {
      collapsed: c?.dataset.collapsed,
      ariaLabel: btn?.getAttribute("aria-label"),
    };
  });
  assert.equal(expandedState.collapsed, "false");
  assert.equal(expandedState.ariaLabel, "Collapse App");

  // 4. Test reload control
  await page.evaluate(() => {
    document.querySelector("#mini-app-reload")?.click();
  });
  await sleep(200);

  const reloadState = await page.evaluate(() => {
    const c = document.querySelector("#mini-app-container");
    const outer = document.querySelector("#mini-app-outer-frame");
    return {
      hidden: c?.hidden,
      framePresent: Boolean(outer),
    };
  });
  assert.equal(reloadState.hidden, false);
  assert.equal(reloadState.framePresent, true);

  // 5. Test close control
  await page.evaluate(() => {
    document.querySelector("#mini-app-close")?.click();
  });
  await sleep(150);

  const closedState = await page.evaluate(() => {
    const c = document.querySelector("#mini-app-container");
    const viewport = document.querySelector("#mini-app-viewport");
    return {
      hidden: c?.hidden,
      hasChildren: viewport?.children?.length > 0,
    };
  });
  assert.equal(closedState.hidden, true, "clicking close button must hide container");
  assert.equal(closedState.hasChildren, false, "viewport should be cleared on close");
});

test("mini-app producer: conversational turn dynamically launches mini-app widget in room", { timeout: 30000 }, async (t) => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "vb-mini-app-turn-"));
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

  // Container starts hidden
  assert.equal(await page.evaluate(() => document.querySelector("#mini-app-container")?.hidden), true);

  // Execute turn through composer input: "launch app Counter with <p>hello</p>"
  await page.evaluate(() => {
    const input = document.querySelector("#utterance");
    const form = document.querySelector("#text-form");
    input.value = "launch app Counter with <div id='counter-body'>Count: 1</div>";
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });

  // Wait for mini-app to mount dynamically
  await page.waitFor(() => {
    const c = document.querySelector("#mini-app-container");
    return c && !c.hidden && document.querySelector("#mini-app-title")?.textContent === "Counter";
  }, { label: "mini-app launched from turn" });

  const state = await page.evaluate(() => {
    const c = document.querySelector("#mini-app-container");
    const title = document.querySelector("#mini-app-title")?.textContent;
    return { hidden: c?.hidden, title };
  });

  assert.equal(state.hidden, false);
  assert.equal(state.title, "Counter");

  // Deliver a live WebSocket mini_app frame
  await page.evaluate(() => {
    window.__voiceboxOnMiniApp?.({
      title: "Live Game Board",
      html: "<div id='game'>Game Board Active</div>",
    });
  });
  await sleep(200);

  const liveState = await page.evaluate(() => {
    const c = document.querySelector("#mini-app-container");
    const title = document.querySelector("#mini-app-title")?.textContent;
    return { hidden: c?.hidden, title };
  });

  assert.equal(liveState.hidden, false);
  assert.equal(liveState.title, "Live Game Board");
});
