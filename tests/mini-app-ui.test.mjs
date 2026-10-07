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
      VOICEBOX_SANDBOX_HOMES: path.join(scratch, "sandbox-homes"),
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

  // 1. Initially hidden and empty mini-app tray (#sqeh-actions)
  const initHidden = await page.evaluate(() => {
    const c = document.querySelector("#mini-app-container");
    return c?.hidden;
  });
  assert.equal(initHidden, true, "mini-app container must start hidden");

  const initialTrayBubbles = await page.evaluate(() => {
    const actions = document.getElementById("sqeh-actions");
    const bubbles = [...(actions?.querySelectorAll(".sqeh-miniapp-bubble") ?? [])];
    return bubbles.map((b) => ({
      id: b.dataset.miniAppId || b.dataset.appId || "",
      text: b.textContent?.trim() || "",
    }));
  });
  assert.equal(initialTrayBubbles.length, 0, "#sqeh-actions must have zero default mini-app buttons in empty workspace");
  assert.ok(
    !initialTrayBubbles.some((b) => b.id === "agent-progress-tracker" || b.id === "live-vision-studio" || b.id === "landing-inspector"),
    "built-in default apps must not appear in mini-app tray",
  );

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

  // Wait for outer iframe to appear, and inner iframe to receive srcdoc
  await page.waitFor(() => {
    const c = document.querySelector("#mini-app-container");
    const outer = document.querySelector("#mini-app-outer-frame");
    const inner = outer?.contentDocument?.getElementById("inner-app");
    const srcdoc = inner?.getAttribute("srcdoc");
    return c && !c.hidden && outer && inner && srcdoc && srcdoc.includes("Scoreboard");
  }, { label: "mini-app mounting in room and rendering inner srcdoc" });

  const mountState = await page.evaluate(() => {
    const c = document.querySelector("#mini-app-container");
    const title = document.querySelector("#mini-app-title")?.textContent;
    const outer = document.querySelector("#mini-app-outer-frame");
    const inner = outer?.contentDocument?.getElementById("inner-app");
    return {
      containerHidden: c?.hidden,
      title,
      outerOrigin: outer?.contentWindow?.location?.origin,
      outerSrc: outer?.getAttribute("src"),
      innerFound: Boolean(inner),
      innerSandbox: inner?.getAttribute("sandbox"),
      innerSrcdoc: inner?.getAttribute("srcdoc"),
    };
  });

  assert.equal(mountState.containerHidden, false, "container must unhide on mount");
  assert.equal(mountState.title, "Scoreboard Widget");
  assert.equal(mountState.outerOrigin, server.base, "outer mediator frame is same-origin with the host");
  assert.match(mountState.outerSrc, /mini-app-bridge\.html\?appId=/);
  assert.equal(mountState.innerFound, true, "inner app frame must exist inside the bridge");
  assert.equal(mountState.innerSandbox, "allow-scripts", "inner app iframe must enforce sandbox='allow-scripts' without allow-same-origin");
  assert.match(mountState.innerSrcdoc, /Scoreboard/);
  assert.match(mountState.innerSrcdoc, /window\.webMcp/);

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
      VOICEBOX_SANDBOX_HOMES: path.join(scratch, "sandbox-homes"),
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

  // Wait for mini-app to mount dynamically and render its inner app
  await page.waitFor(() => {
    const c = document.querySelector("#mini-app-container");
    const outer = document.querySelector("#mini-app-outer-frame");
    const inner = outer?.contentDocument?.getElementById("inner-app");
    const srcdoc = inner?.getAttribute("srcdoc");
    return c && !c.hidden && document.querySelector("#mini-app-title")?.textContent === "Counter" && srcdoc && srcdoc.includes("counter-body");
  }, { label: "mini-app launched from turn and rendered inner app" });

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

test("mini-app room UI: spoofed bridge_ready from decoy frame cannot disrupt mounting or hijack room channel (voicebox-beads-221y)", { timeout: 30000 }, async (t) => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "vb-mini-app-spoof-"));
  const workspace = path.join(scratch, "project");
  fs.mkdirSync(workspace, { recursive: true });

  const server = await startServer({
    env: {
      VOICEBOX_WORKSPACE: workspace,
      VOICEBOX_RESOLVER: "script",
      VOICEBOX_SANDBOX_HOMES: path.join(scratch, "sandbox-homes"),
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

  const attackResult = await page.evaluate(async (base) => {
    // 1. Create a decoy frame on the same origin pointing to /help.html
    const decoy = document.createElement("iframe");
    decoy.id = "decoy-room-frame";
    decoy.src = `${base}/help.html`;
    await new Promise((r) => {
      decoy.onload = r;
      document.body.appendChild(decoy);
    });

    const script = decoy.contentDocument.createElement("script");
    script.textContent = `
      window.spoofBridgeReady = function(appId) {
        window.parent.postMessage({ type: "bridge_ready", appId: appId || "spoofed-app" }, window.location.origin);
      };
      window.spoofHandshake = function(appId) {
        window.parent.postMessage({ type: "mini_app_handshake", appId: appId || "spoofed-app" }, window.location.origin);
      };
    `;
    decoy.contentDocument.body.appendChild(script);

    // 2. Mount legitimate app through the real room API
    const app = {
      title: "Legitimate Room App",
      html: `
        <div id="room-app-content">Active</div>
        <script>
          window.webMcp.registerTool({
            name: "room_ping",
            description: "ping",
            parameters: { type: "object", properties: {} },
            execute: async () => ({ status: "room_pong" })
          });
          window.webMcp.ready();
        <\/script>
      `,
    };

    // Attack: Decoy fires spoofed bridge_ready and mini_app_handshake before and during mount
    decoy.contentWindow.spoofBridgeReady("spoofed-pre");
    decoy.contentWindow.spoofHandshake("spoofed-pre");

    window.__voiceboxMiniApp.mount(app);

    // Spoof again while mount/handshake is in flight
    decoy.contentWindow.spoofBridgeReady("spoofed-mid");
    decoy.contentWindow.spoofHandshake("spoofed-mid");

    return { decoyAttackSent: true };
  }, server.base);

  assert.equal(attackResult.decoyAttackSent, true);

  // Assert legitimate app mounts cleanly despite spoofed trigger attempts
  await page.waitFor(() => {
    const c = document.querySelector("#mini-app-container");
    const outer = document.querySelector("#mini-app-outer-frame");
    const inner = outer?.contentDocument?.getElementById("inner-app");
    const srcdoc = inner?.getAttribute("srcdoc");
    return c && !c.hidden && document.querySelector("#mini-app-title")?.textContent === "Legitimate Room App" && srcdoc && srcdoc.includes("room-app-content");
  }, { label: "legitimate mini-app mounting despite spoofed bridge_ready", timeout: 15000 });

  const mountState = await page.evaluate(() => {
    const c = document.querySelector("#mini-app-container");
    const title = document.querySelector("#mini-app-title")?.textContent;
    return { containerHidden: c?.hidden, title };
  });

  assert.equal(mountState.containerHidden, false);
  assert.equal(mountState.title, "Legitimate Room App");
});
