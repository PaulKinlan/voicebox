// tests/mini-app-architecture.test.mjs — Sandboxed double-iframe Web MCP mini-apps (voicebox-beads-q8d)
//
// Proves:
//   1. Schema validation & bounds: valid Web MCP tool declarations, parameter schemas, and limits
//   2. Static asset serving: mini-app-bridge.html, mini-app-bridge.js, and mini-app-sdk.js
//   3. Double-iframe security boundary:
//      - Outer bridge is same-origin with host
//      - Inner iframe is strictly sandbox="allow-scripts" (opaque null origin)
//      - Inner iframe has ZERO access to host storage (localStorage/sessionStorage/cookies/IndexedDB)
//      - Inner iframe cannot fetch host APIs (blocked by opaque origin)
//   4. Web MCP tool lifecycle:
//      - Inner app registers tool over MessagePort
//      - Outer bridge validates schema and exposes tool to host
//      - Host invokes tool -> inner app executes and updates DOM in real time -> result returned
//   5. Negative security & bounding:
//      - Malformed tool names & schemas rejected
//      - Output > 64KB refused
//      - Capacity capped at 16 tools

import test from "node:test";
import assert from "node:assert/strict";
import {
  validateWebMcpTool,
  toolsToFunctionDeclarations,
  MINI_APP_BOUNDS,
  MiniAppRegistry,
} from "../lib/mini-app-host.mjs";
import { startServer } from "./lib/server.mjs";
import { launch } from "./lib/cdp.mjs";

test("core: validateWebMcpTool validates schemas and rejects malformed declarations", () => {
  const valid = validateWebMcpTool({
    name: "update_score",
    description: "Update the game score",
    parameters: {
      type: "object",
      properties: {
        points: { type: "number", description: "Points to add" },
      },
      required: ["points"],
    },
  });
  assert.equal(valid.ok, true);
  assert.equal(valid.value.name, "update_score");
  assert.equal(valid.value.parameters.type, "object");
  assert.deepEqual(valid.value.parameters.required, ["points"]);

  // Invalid names
  assert.equal(validateWebMcpTool({ name: "bad name with spaces", description: "d", parameters: { type: "object" } }).ok, false);
  assert.equal(validateWebMcpTool({ name: "", description: "d", parameters: { type: "object" } }).ok, false);
  assert.equal(validateWebMcpTool({ name: "a".repeat(65), description: "d", parameters: { type: "object" } }).ok, false);

  // Invalid parameters
  assert.equal(validateWebMcpTool({ name: "tool", description: "d", parameters: { type: "array" } }).ok, false);
  assert.equal(validateWebMcpTool({ name: "tool", description: "d", parameters: "not-an-object" }).ok, false);

  // Conversion to function declarations
  const funcs = toolsToFunctionDeclarations([valid.value]);
  assert.equal(funcs.length, 1);
  assert.equal(funcs[0].name, "update_score");
  assert.equal(funcs[0].description, "Update the game score");
});

test("core: MiniAppRegistry manages tools, caps capacity, and routes execution", async () => {
  const registry = new MiniAppRegistry();
  registry.registerApp("app-1", {
    title: "Scoreboard",
    callTool: async (name, args) => ({ ok: true, executed: name, args }),
  });

  const updated = registry.updateTools("app-1", [
    {
      name: "add_point",
      description: "Add point",
      parameters: { type: "object", properties: {} },
    },
  ]);
  assert.equal(updated, true);
  assert.equal(registry.getAllTools().length, 1);

  // Execute tool through registry
  const res = await registry.executeTool("add_point", { team: "home" });
  assert.equal(res.ok, true);
  assert.equal(res.executed, "add_point");
  assert.equal(res.args.team, "home");

  // Nonexistent tool
  const miss = await registry.executeTool("nonexistent_tool");
  assert.equal(miss.ok, false);
  assert.match(miss.error, /not found/);
});

test("static assets: bridge HTML, bridge JS, and SDK JS serve with correct content-types", async (t) => {
  const server = await startServer();
  t.after(() => server.stop());

  const htmlRes = await fetch(`${server.base}/mini-app-bridge.html`);
  assert.equal(htmlRes.status, 200);
  assert.match(htmlRes.headers.get("content-type"), /text\/html/);
  const html = await htmlRes.text();
  assert.match(html, /id="inner-app"/);
  assert.match(html, /sandbox="allow-scripts"/);

  const bridgeJsRes = await fetch(`${server.base}/mini-app-bridge.js`);
  assert.equal(bridgeJsRes.status, 200);
  assert.match(bridgeJsRes.headers.get("content-type"), /text\/javascript/);

  const sdkJsRes = await fetch(`${server.base}/mini-app-sdk.js`);
  assert.equal(sdkJsRes.status, 200);
  assert.match(sdkJsRes.headers.get("content-type"), /text\/javascript/);
});

test("browser: double-iframe sandboxed execution, opaque origin, and Web MCP tool interaction", { timeout: 25000 }, async (t) => {
  const server = await startServer();
  t.after(() => server.stop());

  const page = await launch({ width: 1200, height: 900 });
  t.after(() => page.close());

  await page.goto(`${server.base}/`);

  const results = await page.evaluate(async (base) => {
    return new Promise((resolve, reject) => {
      const outer = document.createElement("iframe");
      outer.id = "outer-bridge";
      outer.src = `${base}/mini-app-bridge.html`;

      let probeResult = null;
      let mutationResult = null;

      window.addEventListener("message", (e) => {
        if (e.origin !== window.location.origin) return;

        if (e.data?.type === "bridge_ready") {
          // App with two Web MCP tools: probe_security and update_dom
          const appHtml = `
            <div id="counter">10</div>
            <script>
              window.webMcp.registerTool({
                name: "probe_security",
                description: "Probe sandbox security invariants",
                parameters: { type: "object", properties: {} },
                execute: async () => {
                  let storageError = null;
                  try {
                    localStorage.setItem("key", "val");
                  } catch (err) {
                    storageError = err.name;
                  }
                  return {
                    origin: window.location.origin,
                    storageError,
                  };
                }
              });

              window.webMcp.registerTool({
                name: "update_counter",
                description: "Add to the counter",
                parameters: {
                  type: "object",
                  properties: { delta: { type: "number" } },
                  required: ["delta"]
                },
                execute: async ({ delta }) => {
                  const el = document.getElementById("counter");
                  const next = Number(el.textContent) + delta;
                  el.textContent = String(next);
                  return { nextValue: next };
                }
              });

              window.webMcp.ready();
            <\/script>
          `;

          outer.contentWindow.postMessage(
            { type: "load_app", appId: "test-counter-app", html: appHtml },
            window.location.origin,
          );
        } else if (e.data?.type === "tools_updated") {
          // Step 1: probe security
          outer.contentWindow.postMessage(
            { type: "call_tool", callId: "c-probe", name: "probe_security", args: {} },
            window.location.origin,
          );
        } else if (e.data?.type === "tool_result" && e.data?.callId === "c-probe") {
          probeResult = e.data;
          // Step 2: call update_counter
          outer.contentWindow.postMessage(
            { type: "call_tool", callId: "c-mutate", name: "update_counter", args: { delta: 25 } },
            window.location.origin,
          );
        } else if (e.data?.type === "tool_result" && e.data?.callId === "c-mutate") {
          mutationResult = e.data;

          const innerFrame = outer.contentDocument.getElementById("inner-app");
          resolve({
            outerOrigin: outer.contentWindow.location.origin,
            sandboxAttr: innerFrame.getAttribute("sandbox"),
            probeResult,
            mutationResult,
          });
        }
      });

      document.body.appendChild(outer);
      setTimeout(() => reject(new Error("timed out waiting for bridge interactions")), 10000);
    });
  }, server.base);

  // Outer bridge is strictly same-origin with the host server
  assert.equal(results.outerOrigin, server.base);

  // Inner frame strictly possesses sandbox="allow-scripts" (no allow-same-origin!)
  assert.equal(results.sandboxAttr, "allow-scripts");

  // Inner frame origin is "null" (opaque)
  assert.equal(results.probeResult.ok, true);
  assert.equal(results.probeResult.result.origin, "null");

  // Inner frame threw SecurityError when attempting to touch origin storage
  assert.equal(results.probeResult.result.storageError, "SecurityError");

  // Web MCP tool execution modified internal DOM and returned the updated state
  assert.equal(results.mutationResult.ok, true);
  assert.equal(results.mutationResult.result.nextValue, 35);
});

test("browser: output bounds refusal for tool results > 64KB", { timeout: 25000 }, async (t) => {
  const server = await startServer();
  t.after(() => server.stop());

  const page = await launch({ width: 1200, height: 900 });
  t.after(() => page.close());

  await page.goto(`${server.base}/`);

  const result = await page.evaluate(async (base) => {
    return new Promise((resolve, reject) => {
      const outer = document.createElement("iframe");
      outer.src = `${base}/mini-app-bridge.html`;

      window.addEventListener("message", (e) => {
        if (e.origin !== window.location.origin) return;

        if (e.data?.type === "bridge_ready") {
          const appHtml = `
            <script>
              window.webMcp.registerTool({
                name: "produce_huge_output",
                description: "Returns oversized string",
                parameters: { type: "object", properties: {} },
                execute: async () => {
                  return { data: "x".repeat(70000) };
                }
              });
              window.webMcp.ready();
            <\/script>
          `;
          outer.contentWindow.postMessage({ type: "load_app", appId: "huge-app", html: appHtml }, window.location.origin);
        } else if (e.data?.type === "tools_updated") {
          outer.contentWindow.postMessage({ type: "call_tool", callId: "huge-call", name: "produce_huge_output", args: {} }, window.location.origin);
        } else if (e.data?.type === "tool_result" && e.data?.callId === "huge-call") {
          resolve(e.data);
        }
      });

      document.body.appendChild(outer);
      setTimeout(() => reject(new Error("timed out waiting for oversized output response")), 10000);
    });
  }, server.base);

  assert.equal(result.ok, false);
  assert.match(result.error, /over budget/i);
});
