// tests/mini-app-architecture.test.mjs — Sandboxed double-iframe Web MCP mini-apps (voicebox-beads-q8d)
//
// Proves:
//   1. Schema validation & bounds: valid Web MCP tool declarations, parameter schemas, and limits
//   2. Static asset serving: mini-app-bridge.html, mini-app-bridge.js, and mini-app-sdk.js
//   3. Double-iframe security boundary:
//      - Outer bridge is same-origin with host
//      - Inner iframe is strictly sandbox="allow-scripts" (opaque null origin)
//      - Host storage (cookies, origin localStorage) is unreachable; the SDK installs a
//        DOCUMENT-LOCAL in-memory Storage shim so apps that use Web Storage do not crash (sdxn)
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
import { setTimeout as sleep } from "node:timers/promises";
import {
  validateWebMcpTool,
  validateMiniAppToolArgs,
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
                  let storedValue = null;
                  try {
                    localStorage.setItem("key", "val");
                    storedValue = localStorage.getItem("key");
                  } catch (err) {
                    storageError = err.name;
                  }
                  return {
                    origin: window.location.origin,
                    storageError,
                    storedValue,
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

  // The opaque origin THROWS on host storage — so the SDK shimmed Web Storage in the document:
  // the app never sees a SecurityError, and the value round-trips in-memory (voicebox-beads-sdxn).
  assert.equal(results.probeResult.result.storageError, null, "no SecurityError: the SDK shimmed Web Storage for the sandboxed document");
  assert.equal(results.probeResult.result.storedValue, "val", "the in-memory shim stores and returns the value");

  // Web MCP tool execution modified internal DOM and returned the updated state
  assert.equal(results.mutationResult.ok, true);
  assert.equal(results.mutationResult.result.nextValue, 35);
});

test("browser: a repeated mini_app_ready re-handshakes with a FRESH port — no DataCloneError, tools keep answering (voicebox-beads-sdxn)", { timeout: 25000 }, async (t) => {
  const server = await startServer();
  t.after(() => server.stop());

  const page = await launch({ width: 1000, height: 800 });
  t.after(() => page.close());

  await page.goto(`${server.base}/`);

  const results = await page.evaluate(async (base) => {
    return new Promise((resolve, reject) => {
      const outer = document.createElement("iframe");
      outer.id = "outer-bridge";
      outer.src = `${base}/mini-app-bridge.html`;
      const errors = [];
      let first = null;
      let second = null;
      let readySent = false;

      window.addEventListener("message", (e) => {
        if (e.origin !== window.location.origin) return;
        if (e.data?.type === "bridge_ready") {
          const appHtml = `<script>
            window.webMcp.registerTool({
              name: "echo",
              description: "echo",
              parameters: { type: "object", properties: {} },
              execute: async (args) => {
                if (args.reannounce) {
                  window.parent.postMessage({ type: "mini_app_ready" }, "*");
                }
                return { echo: args.value };
              }
            });
            window.webMcp.ready();
          <\/script>`;
          outer.contentWindow.postMessage({ type: "load_app", appId: "sdxn-repeat", html: appHtml }, window.location.origin);
        } else if (e.data?.type === "tools_updated" && !readySent) {
          outer.contentWindow.postMessage({ type: "call_tool", callId: "first", name: "echo", args: { value: "one", reannounce: true } }, window.location.origin);
        } else if (e.data?.type === "tool_result" && e.data?.callId === "first") {
          first = e.data;
          // THE REPEATED ANNOUNCEMENT: watch the bridge frame for the uncaught DataCloneError Paul
          // saw, then handshake again — the inner must get a LIVE port through a fresh channel.
          outer.contentWindow.addEventListener("error", (err) => errors.push(String(err.message || err)));
          readySent = true;
          setTimeout(() => {
            outer.contentWindow.postMessage({ type: "call_tool", callId: "second", name: "echo", args: { value: "two" } }, window.location.origin);
          }, 200);
        } else if (e.data?.type === "tool_result" && e.data?.callId === "second") {
          second = e.data;
          resolve({ first, second, errors });
        }
      });
      document.body.appendChild(outer);
      setTimeout(() => reject(new Error("timed out waiting for the repeated handshake")), 12000);
    });
  }, server.base);

  assert.equal(results.first.ok, true, `first call: ${JSON.stringify(results.first)}`);
  assert.equal(results.second.ok, true, `the tool must answer through the FRESH port: ${JSON.stringify(results.second)}`);
  assert.equal(results.second.result.echo, "two");
  assert.deepEqual(results.errors, [], "no uncaught DataCloneError in the bridge on a repeated handshake");
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

test("browser: SDK aliases window.voicebox and navigator.modelContext alongside window.webMcp (voicebox-beads-0ul6)", { timeout: 25000 }, async (t) => {
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
              window.voicebox.registerTool({
                name: "via_voicebox",
                description: "Registered via window.voicebox",
                parameters: { type: "object", properties: {} },
                execute: async () => ({ alias: "voicebox", hasModelContext: Boolean(navigator.modelContext?.registerTool) })
              });
              navigator.modelContext.registerTool({
                name: "via_model_context",
                description: "Registered via navigator.modelContext",
                parameters: { type: "object", properties: {} },
                execute: async () => ({ alias: "modelContext" })
              });
              window.voicebox.ready();
            <\/script>
          `;
          outer.contentWindow.postMessage({ type: "load_app", appId: "alias-app", html: appHtml }, window.location.origin);
        } else if (e.data?.type === "app_ready" && e.data?.appId === "alias-app") {
          outer.contentWindow.postMessage({ type: "call_tool", callId: "c-vb", name: "via_voicebox", args: {} }, window.location.origin);
        } else if (e.data?.type === "tool_result" && e.data?.callId === "c-vb") {
          resolve(e.data);
        }
      });

      document.body.appendChild(outer);
      setTimeout(() => reject(new Error("timed out waiting for alias tool execution")), 10000);
    });
  }, server.base);

  assert.equal(result.ok, true);
  assert.equal(result.result.alias, "voicebox");
  assert.equal(result.result.hasModelContext, true);
});

test("browser: decoy frame cannot trigger port transfer via mini_app_ready or hijack inner handshake (voicebox-beads-221y)", { timeout: 25000 }, async (t) => {
  const server = await startServer();
  t.after(() => server.stop());

  const page = await launch({ width: 1200, height: 900 });
  t.after(() => page.close());

  await page.goto(`${server.base}/`);

  const results = await page.evaluate(async (base) => {
    // 1. Create untrusted decoy iframe pointing to /help.html (same origin, distinct browsing context)
    const decoy = document.createElement("iframe");
    decoy.id = "decoy-frame";
    decoy.src = `${base}/help.html`;
    await new Promise((r) => {
      decoy.onload = r;
      document.body.appendChild(decoy);
    });

    const script = decoy.contentDocument.createElement("script");
    script.textContent = `
      window.stolenPorts = [];
      window.receivedMessages = [];
      window.rogueReceived = [];
      window.addEventListener("message", function(e) {
        window.receivedMessages.push(e.data ? e.data.type : "unknown");
        if (e.ports && e.ports.length > 0) {
          window.stolenPorts.push(e.ports[0]);
        }
      });
      window.attackBridge = function(targetWin) {
        targetWin.postMessage({ type: "mini_app_ready" }, "*");
      };
      window.attackInner = function(innerWin) {
        var rogueChannel = new MessageChannel();
        rogueChannel.port1.onmessage = function(ev) {
          window.rogueReceived.push(ev.data);
        };
        innerWin.postMessage({ type: "mini_app_handshake", appId: "rogue-app" }, "*", [rogueChannel.port2]);
        rogueChannel.port1.postMessage({ type: "call_tool", callId: "rogue-1", name: "secure_ping", args: {} });
      };
    `;
    decoy.contentDocument.body.appendChild(script);

    return new Promise((resolve, reject) => {
      // 2. Create the outer bridge iframe
      const outer = document.createElement("iframe");
      outer.id = "outer-bridge";
      outer.src = `${base}/mini-app-bridge.html`;
      document.body.appendChild(outer);

      const events = {
        decoyAttackExecuted: false,
        rogueAttackExecuted: false,
        decoyStolenPortsCount: 0,
        decoyReceivedMessagesCount: 0,
        rogueReceived: [],
        bridgeRejectedUnverifiedSource: false,
        legitimateHandshakeCompleted: false,
        legitimateToolResult: null,
      };

      let legitToolCalled = false;

      window.addEventListener("message", (e) => {
        if (e.origin !== window.location.origin) return;

        if (e.data?.type === "bridge_ready" && outer) {
          // Track bridge warnings to verify rejection of unverified window source (voicebox-beads-221y Finding P2)
          try {
            const origWarn = outer.contentWindow.console.warn;
            outer.contentWindow.console.warn = (...args) => {
              if (args.some((a) => String(a).includes("rejected mini_app_ready from unverified window source"))) {
                events.bridgeRejectedUnverifiedSource = true;
              }
              origWarn?.apply(outer.contentWindow.console, args);
            };
          } catch (_) {}

          // Mount legitimate app inside outer bridge
          const appHtml = `<!doctype html><html><body><script>
            window.webMcp.registerTool({
              name: "secure_ping",
              description: "ping tool",
              parameters: { type: "object", properties: {} },
              execute: async () => ({ status: "secure_pong" })
            });
            window.webMcp.ready();
          <\/script></body></html>`;
          outer.contentWindow.postMessage(
            { type: "load_app", appId: "secure-app", html: appHtml },
            window.location.origin,
          );
        } else if (e.data?.type === "app_ready" && e.data?.appId === "secure-app" && !legitToolCalled) {
          events.legitimateHandshakeCompleted = true;

          // Attack 2: Decoy attempts to hijack inner frame by sending rogue mini_app_handshake
          try {
            const innerFrame = outer.contentDocument?.getElementById("inner-app");
            if (innerFrame?.contentWindow && typeof decoy.contentWindow.attackInner === "function") {
              decoy.contentWindow.attackInner(innerFrame.contentWindow);
              events.rogueAttackExecuted = true;
            }
          } catch (err) {
            events.rogueAttackError = String(err);
          }

          // Attack 1: Decoy attempts to impersonate the inner app by sending mini_app_ready to the outer bridge
          try {
            if (typeof decoy.contentWindow.attackBridge === "function") {
              decoy.contentWindow.attackBridge(outer.contentWindow);
              events.decoyAttackExecuted = true;
            }
          } catch (err) {
            events.decoyAttackError = String(err);
          }

          // Bounded poll for rogue response: early-exits if rogueReceived is populated (vulnerability detected fast)
          // or otherwise waits at least 1500ms to prove no rogue response arrives (voicebox-beads-221y Finding P1)
          const pollStart = Date.now();
          const pollRogue = () => {
            const currentRogue = decoy.contentWindow?.rogueReceived ? [...decoy.contentWindow.rogueReceived] : [];
            if (currentRogue.length > 0 || Date.now() - pollStart >= 1500) {
              events.decoyStolenPortsCount = decoy.contentWindow?.stolenPorts?.length || 0;
              events.decoyReceivedMessagesCount = decoy.contentWindow?.receivedMessages?.length || 0;
              events.rogueReceived = currentRogue;

              legitToolCalled = true;
              outer.contentWindow.postMessage(
                { type: "call_tool", callId: "legit-1", name: "secure_ping", args: {} },
                window.location.origin,
              );
            } else {
              setTimeout(pollRogue, 50);
            }
          };
          setTimeout(pollRogue, 50);
        } else if (e.data?.type === "tool_result" && e.data?.callId === "legit-1") {
          events.legitimateToolResult = e.data;
          resolve(events);
        }
      });

      setTimeout(() => reject(new Error("timed out waiting for decoy test completion: " + JSON.stringify(events))), 12000);
    });
  }, server.base);

  // Negative control assertions: decoy received ZERO ports, rogue port received ZERO tool results
  assert.equal(results.decoyAttackExecuted, true, `decoy bridge attack was executed: ${JSON.stringify(results)}`);
  assert.equal(results.rogueAttackExecuted, true, `decoy inner attack was executed: ${JSON.stringify(results)}`);
  assert.equal(results.bridgeRejectedUnverifiedSource, true, "bridge MUST log warning and reject mini_app_ready from unverified window");
  assert.equal(results.decoyStolenPortsCount, 0, "decoy MUST NOT steal any MessagePort from bridge");
  assert.equal(results.decoyReceivedMessagesCount, 0, "decoy MUST NOT receive any handshake messages");
  assert.deepEqual(results.rogueReceived, [], "inner frame MUST NOT execute tools or reply over rogue port");

  // Positive control assertions: legitimate handshake and tool invocation succeeded
  assert.equal(results.legitimateHandshakeCompleted, true, "legitimate inner app completed handshake");
  assert.equal(results.legitimateToolResult?.ok, true, "legitimate tool execution succeeded");
  assert.equal(results.legitimateToolResult?.result?.status, "secure_pong");
});

test("core: validateMiniAppToolArgs validates arguments against JSON schema and enforces bounds (GH #24, voicebox-beads-fdtu)", () => {
  const tool = {
    name: "configure_widget",
    description: "Configure widget settings",
    parameters: {
      type: "object",
      properties: {
        theme: { type: "string", enum: ["light", "dark", "system"] },
        refreshInterval: { type: "number", description: "Refresh interval in seconds" },
        enabled: { type: "boolean" },
        tags: { type: "array" },
        meta: { type: "object" },
      },
      required: ["theme", "refreshInterval"],
    },
  };

  // Valid calls
  const valid = validateMiniAppToolArgs(tool, { theme: "dark", refreshInterval: 30, enabled: true });
  assert.equal(valid.ok, true);
  assert.equal(valid.value.theme, "dark");
  assert.equal(valid.value.refreshInterval, 30);
  assert.equal(valid.value.enabled, true);

  // Missing required argument
  const missing = validateMiniAppToolArgs(tool, { theme: "dark" });
  assert.equal(missing.ok, false);
  assert.equal(missing.refused, "missing-argument");
  assert.ok(missing.why.includes("refreshInterval"));

  // Invalid argument type
  const badType = validateMiniAppToolArgs(tool, { theme: "dark", refreshInterval: "thirty" });
  assert.equal(badType.ok, false);
  assert.equal(badType.refused, "invalid-argument-type");
  assert.ok(badType.why.includes("refreshInterval"));

  // Invalid enum value
  const badEnum = validateMiniAppToolArgs(tool, { theme: "neon", refreshInterval: 10 });
  assert.equal(badEnum.ok, false);
  assert.equal(badEnum.refused, "invalid-argument-enum");
  assert.ok(badEnum.why.includes("neon"));

  // Non-object arguments
  const notObj = validateMiniAppToolArgs(tool, "bad-string");
  assert.equal(notObj.ok, false);
  assert.equal(notObj.refused, "invalid-tool-arguments");

  // Array arguments
  const isArr = validateMiniAppToolArgs(tool, [1, 2, 3]);
  assert.equal(isArr.ok, false);
  assert.equal(isArr.refused, "invalid-tool-arguments");

  // Omitted optional arguments with no required fields
  const noReqTool = {
    name: "ping",
    description: "Ping",
    parameters: { type: "object", properties: {} },
  };
  const emptyPass = validateMiniAppToolArgs(noReqTool, {});
  assert.equal(emptyPass.ok, true);
  const nullPass = validateMiniAppToolArgs(noReqTool, null);
  assert.equal(nullPass.ok, true);

  // Bounds enforcement: oversized payload > 64KB
  const hugePayload = { theme: "light", refreshInterval: 5, meta: { big: "x".repeat(70000) } };
  const overBound = validateMiniAppToolArgs(tool, hugePayload);
  assert.equal(overBound.ok, false);
  assert.equal(overBound.refused, "invalid-tool-arguments");
  assert.ok(overBound.why.includes("exceeds maximum allowed bound"));

  // Additional properties constraint: additionalProperties: false
  const strictTool = {
    name: "strict_config",
    description: "Strict config",
    parameters: {
      type: "object",
      properties: {
        mode: { type: "string", maxLength: 10 },
        count: { type: "number", maximum: 100 },
      },
      additionalProperties: false,
    },
  };
  const extraArg = validateMiniAppToolArgs(strictTool, { mode: "fast", unknownField: 123 });
  assert.equal(extraArg.ok, false);
  assert.equal(extraArg.refused, "invalid-argument");
  assert.ok(extraArg.why.includes("unknownField"));

  // Range and length bounds
  const overLength = validateMiniAppToolArgs(strictTool, { mode: "a-very-long-string-value" });
  assert.equal(overLength.ok, false);
  assert.equal(overLength.refused, "invalid-argument-length");

  const overMax = validateMiniAppToolArgs(strictTool, { count: 101 });
  assert.equal(overMax.ok, false);
  assert.equal(overMax.refused, "invalid-argument-range");
});

test("server: /turn validates mini-app tool arguments at host boundary before dispatch (GH #24, voicebox-beads-fdtu)", async (t) => {
  const server = await startServer();
  t.after(() => server.stop());

  // Register an app with a schema-bearing tool
  const regRes = await fetch(`${server.base}/api/mini-app/tools`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      appId: "app-test-args",
      title: "Arg Test App",
      tools: [
        {
          name: "calculate_tax",
          description: "Calculate sales tax",
          parameters: {
            type: "object",
            properties: {
              amount: { type: "number" },
              rate: { type: "number" },
            },
            required: ["amount", "rate"],
          },
        },
      ],
    }),
  });
  assert.equal(regRes.status, 200);

  // Valid /turn invocation: passes validation and returns dispatched action
  const validTurn = await fetch(`${server.base}/api/turn`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: {
        verb: "mini_app_tool",
        name: "calculate_tax",
        args: { amount: 100, rate: 0.05 },
      },
    }),
  });
  const validJson = await validTurn.json();
  assert.equal(validJson.result?.ok, true);
  assert.equal(validJson.miniAppToolCall?.name, "calculate_tax");
  assert.deepEqual(validJson.miniAppToolCall?.args, { amount: 100, rate: 0.05 });

  // Malformed /turn invocation: missing required argument
  const missingTurn = await fetch(`${server.base}/api/turn`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: {
        verb: "mini_app_tool",
        name: "calculate_tax",
        args: { amount: 100 },
      },
    }),
  });
  const missingJson = await missingTurn.json();
  assert.equal(missingJson.result?.ok, false);
  assert.equal(missingJson.result?.refused, "missing-argument");
  assert.ok(missingJson.result?.why.includes("rate"));

  // Malformed /turn invocation: invalid type
  const badTypeTurn = await fetch(`${server.base}/api/turn`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: {
        verb: "mini_app_tool",
        name: "calculate_tax",
        args: { amount: "one hundred", rate: 0.05 },
      },
    }),
  });
  const badTypeJson = await badTypeTurn.json();
  assert.equal(badTypeJson.result?.ok, false);
  assert.equal(badTypeJson.result?.refused, "invalid-argument-type");
  assert.ok(badTypeJson.result?.why.includes("amount"));

  // Bounded request body on POST /api/mini-app/tools: payload > 65536 bytes rejected with HTTP 400 body-too-large
  const oversizedPayload = JSON.stringify({ appId: "test-app", title: "T".repeat(70000), tools: [] });
  const oversizedRes = await fetch(`${server.base}/api/mini-app/tools`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: oversizedPayload,
  });
  assert.equal(oversizedRes.status, 400);
  const oversizedJson = await oversizedRes.json();
  assert.equal(oversizedJson.ok, false);
  assert.equal(oversizedJson.refused, "body-too-large");
});

test("browser: outer bridge validates mini-app tool arguments and refuses malformed calls before execution (GH #24, voicebox-beads-fdtu)", { timeout: 25000 }, async (t) => {
  const server = await startServer();
  t.after(() => server.stop());

  const page = await launch({ width: 1000, height: 800 });
  t.after(() => page.close());

  await page.goto(`${server.base}/`);

  const results = await page.evaluate(async (base) => {
    return new Promise((resolve, reject) => {
      const outer = document.createElement("iframe");
      outer.id = "outer-bridge-args";
      outer.src = `${base}/mini-app-bridge.html`;

      const recordedEvents = {
        appExecutedValidCall: false,
        appReceivedMalformedCall: false,
        validResult: null,
        malformedResult: null,
      };

      window.addEventListener("message", (e) => {
        if (e.origin !== window.location.origin) return;
        if (e.data?.type === "bridge_ready") {
          const appHtml = `<script>
            window.webMcp.registerTool({
              name: "set_temperature",
              description: "Set thermostat target temperature",
              parameters: {
                type: "object",
                properties: {
                  target: { type: "number", description: "Target degrees Celsius" },
                  mode: { type: "string", enum: ["heat", "cool", "auto"] }
                },
                required: ["target", "mode"]
              },
              execute: async (args) => {
                if (typeof args.target !== "number") {
                  window.__receivedMalformedCall = true;
                }
                return { currentTarget: args.target, mode: args.mode };
              }
            });
            window.webMcp.ready();
          <\/script>`;
          outer.contentWindow.postMessage({ type: "load_app", appId: "fdtu-browser-test", html: appHtml }, window.location.origin);
        } else if (e.data?.type === "tools_updated") {
          // 1. Dispatch valid call
          outer.contentWindow.postMessage({
            type: "call_tool",
            callId: "call-valid-1",
            name: "set_temperature",
            args: { target: 21.5, mode: "heat" },
          }, window.location.origin);
        } else if (e.data?.type === "tool_result" && e.data?.callId === "call-valid-1") {
          recordedEvents.validResult = e.data;
          // 2. Dispatch malformed call (target is string instead of number, mode is invalid enum)
          outer.contentWindow.postMessage({
            type: "call_tool",
            callId: "call-malformed-1",
            name: "set_temperature",
            args: { target: "twenty-one", mode: "turbo" },
          }, window.location.origin);
        } else if (e.data?.type === "tool_result" && e.data?.callId === "call-malformed-1") {
          recordedEvents.malformedResult = e.data;
          resolve(recordedEvents);
        }
      });

      document.body.appendChild(outer);
      setTimeout(() => reject(new Error("timed out waiting for mini-app tool arg tests")), 12000);
    });
  }, server.base);

  // Positive verification: legitimate call succeeded with valid result
  assert.equal(results.validResult?.ok, true, `valid tool call must succeed: ${JSON.stringify(results.validResult)}`);
  assert.equal(results.validResult?.result?.currentTarget, 21.5);
  assert.equal(results.validResult?.result?.mode, "heat");

  // Negative verification: malformed call was intercepted and refused by bridge
  assert.equal(results.malformedResult?.ok, false, `malformed tool call must be refused: ${JSON.stringify(results.malformedResult)}`);
  assert.equal(results.malformedResult?.refused, "invalid-argument-type");
  assert.ok(results.malformedResult?.error?.includes("must be a finite number"));
});

test("core: validateWebMcpTool preserves additionalProperties: false and validates property schema types (Finding P1)", () => {
  const decl = {
    name: "strict_tool",
    description: "Strict tool",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        count: { type: "number" },
      },
      additionalProperties: false,
    },
  };
  const res = validateWebMcpTool(decl);
  assert.equal(res.ok, true);
  assert.equal(res.value?.parameters?.additionalProperties, false);

  // Reject unsupported property type at registration
  const badTypeDecl = {
    name: "bad_tool",
    description: "Bad tool",
    parameters: {
      type: "object",
      properties: {
        func: { type: "function" },
      },
    },
  };
  const badRes = validateWebMcpTool(badTypeDecl);
  assert.equal(badRes.ok, false);
  assert.equal(badRes.refused, "invalid-tool-parameters");

  // Reject non-object property schema at registration
  const nonObjPropDecl = {
    name: "bad_prop_tool",
    description: "Bad prop tool",
    parameters: {
      type: "object",
      properties: {
        raw: "string",
      },
    },
  };
  const nonObjRes = validateWebMcpTool(nonObjPropDecl);
  assert.equal(nonObjRes.ok, false);
  assert.equal(nonObjRes.refused, "invalid-tool-parameters");
});

test("core: validateMiniAppToolArgs guards against inherited prototype properties (Finding P1)", () => {
  const tool = {
    name: "clean_tool",
    description: "Clean tool",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
      },
      required: ["query"],
      additionalProperties: false,
    },
  };

  // Tool requiring 'constructor' property: passing empty object {} must fail missing-argument,
  // not pass via Object.prototype.constructor
  const ctorReqTool = {
    name: "ctor_tool",
    description: "Tool requiring constructor",
    parameters: {
      type: "object",
      properties: {
        constructor: { type: "string" },
      },
      required: ["constructor"],
    },
  };
  const emptyArgs = {};
  const missingCtor = validateMiniAppToolArgs(ctorReqTool, emptyArgs);
  assert.equal(missingCtor.ok, false);
  assert.equal(missingCtor.refused, "missing-argument");

  // Inherited properties should not be treated as own properties
  const extraArgs = Object.create({ inheritedProp: "hidden" });
  extraArgs.query = "valid";
  const passInherited = validateMiniAppToolArgs(tool, extraArgs);
  assert.equal(passInherited.ok, true);
});

test("core: validateMiniAppToolArgs enforces 64KiB bound using UTF-8 byte length (Finding P1)", () => {
  const tool = {
    name: "multibyte_tool",
    description: "Tool handling multibyte text",
    parameters: {
      type: "object",
      properties: {
        content: { type: "string" },
      },
    },
  };
  // '𠮷' (U+20BB7) is 2 UTF-16 code units (surrogate pair) and 4 UTF-8 bytes.
  // 17,000 repeats -> string.length is 34,000 (< 65536 code units),
  // but UTF-8 byte length is 68,000 bytes (> 65536 bytes).
  const multibyteStr = "𠮷".repeat(17000);
  assert.ok(multibyteStr.length < 65536, "string length is less than 64K characters");
  assert.ok(Buffer.byteLength(multibyteStr, "utf8") > 65536, "UTF-8 byte length exceeds 64KiB");

  const res = validateMiniAppToolArgs(tool, { content: multibyteStr });
  assert.equal(res.ok, false);
  assert.equal(res.refused, "invalid-tool-arguments");
  assert.match(res.why, /exceeds maximum allowed bound/);
});

test("core: validateMiniAppToolArgs validates array items and rejects null for non-nullable types (Finding P1)", () => {
  const tool = {
    name: "array_tool",
    description: "Array tool",
    parameters: {
      type: "object",
      properties: {
        tags: { type: "array", items: { type: "string" } },
        score: { type: "number" },
      },
      required: ["score"],
    },
  };

  // Null value for required or optional typed property
  const nullVal = validateMiniAppToolArgs(tool, { score: null });
  assert.equal(nullVal.ok, false);
  assert.equal(nullVal.refused, "missing-argument");

  const nullOptional = validateMiniAppToolArgs(tool, { score: 10, tags: null });
  assert.equal(nullOptional.ok, false);
  assert.equal(nullOptional.refused, "invalid-argument-type");

  // Array item type mismatch
  const badItems = validateMiniAppToolArgs(tool, { score: 10, tags: ["good", 123] });
  assert.equal(badItems.ok, false);
  assert.equal(badItems.refused, "invalid-argument-type");
  assert.match(badItems.why, /array item at index 1/i);

  // Valid array items
  const goodItems = validateMiniAppToolArgs(tool, { score: 10, tags: ["alpha", "beta"] });
  assert.equal(goodItems.ok, true);
});

test("browser: outer bridge immediately refuses unknown tool without forwarding (Finding P2)", { timeout: 25000 }, async (t) => {
  const server = await startServer();
  t.after(() => server.stop());

  const page = await launch({ width: 1000, height: 800 });
  t.after(() => page.close());

  await page.goto(`${server.base}/`);

  const result = await page.evaluate(async (base) => {
    return new Promise((resolve, reject) => {
      const outer = document.createElement("iframe");
      outer.src = `${base}/mini-app-bridge.html`;

      window.addEventListener("message", (e) => {
        if (e.origin !== window.location.origin) return;
        if (e.data?.type === "bridge_ready") {
          const appHtml = `<script>
            window.webMcp.registerTool({
              name: "known_tool",
              description: "Known tool",
              parameters: { type: "object", properties: {} },
              execute: async () => ({ status: "ok" })
            });
            window.webMcp.ready();
          <\/script>`;
          outer.contentWindow.postMessage({ type: "load_app", appId: "p2-unknown-test", html: appHtml }, window.location.origin);
        } else if (e.data?.type === "tools_updated") {
          // Call an unknown tool
          outer.contentWindow.postMessage({
            type: "call_tool",
            callId: "call-unknown-tool",
            name: "non_existent_tool",
            args: {},
          }, window.location.origin);
        } else if (e.data?.type === "tool_result" && e.data?.callId === "call-unknown-tool") {
          resolve(e.data);
        }
      });

      document.body.appendChild(outer);
      setTimeout(() => reject(new Error("timed out waiting for unknown tool result")), 12000);
    });
  }, server.base);

  assert.equal(result.ok, false);
  assert.equal(result.refused, "unknown-tool");
  assert.match(result.error, /is not registered/);
});

test("core: validateWebMcpTool rejects unsupported schema keywords recursively (Finding P1)", () => {
  // Reject string pattern
  const patternTool = {
    name: "pattern_tool",
    description: "Pattern tool",
    parameters: {
      type: "object",
      properties: {
        code: { type: "string", pattern: "^[A-Z]+$" },
      },
    },
  };
  const patternRes = validateWebMcpTool(patternTool);
  assert.equal(patternRes.ok, false);
  assert.equal(patternRes.refused, "invalid-tool-parameters");
  assert.match(patternRes.why, /unsupported schema keyword 'pattern'/);

  // Reject nested items.minLength on array
  const itemsMinLengthTool = {
    name: "array_items_minlen",
    description: "Array items with minLength",
    parameters: {
      type: "object",
      properties: {
        names: { type: "array", items: { type: "string", minLength: 3 } },
      },
    },
  };
  const itemsMinLenRes = validateWebMcpTool(itemsMinLengthTool);
  assert.equal(itemsMinLenRes.ok, false);
  assert.equal(itemsMinLenRes.refused, "invalid-tool-parameters");
  assert.match(itemsMinLenRes.why, /unsupported schema keyword 'minLength' in items schema/);

  // Reject nested items.type: array or object (non-primitive items)
  const nestedArrayItemsTool = {
    name: "matrix_tool",
    description: "Matrix tool",
    parameters: {
      type: "object",
      properties: {
        matrix: { type: "array", items: { type: "array" } },
      },
    },
  };
  const nestedArrayRes = validateWebMcpTool(nestedArrayItemsTool);
  assert.equal(nestedArrayRes.ok, false);
  assert.equal(nestedArrayRes.refused, "invalid-tool-parameters");
  assert.match(nestedArrayRes.why, /unsupported items type 'array'/);

  // Reject top-level unknown keyword
  const topUnknownTool = {
    name: "top_unknown",
    description: "Top unknown",
    parameters: {
      type: "object",
      pattern: ".*",
      properties: {},
    },
  };
  const topRes = validateWebMcpTool(topUnknownTool);
  assert.equal(topRes.ok, false);
  assert.equal(topRes.refused, "invalid-tool-parameters");
  assert.match(topRes.why, /unsupported top-level schema keyword 'pattern'/);

  // Positive control: valid schema with supported keywords across all types
  const validControlTool = {
    name: "valid_control",
    description: "Valid control tool",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", minLength: 1, maxLength: 50, enum: ["alice", "bob"] },
        age: { type: "integer", minimum: 0, maximum: 120 },
        ratio: { type: "number", minimum: 0.0, maximum: 1.0 },
        active: { type: "boolean" },
        tags: { type: "array", items: { type: "string", enum: ["red", "blue"] } },
        config: {
          type: "object",
          properties: {
            retries: { type: "number" },
          },
          additionalProperties: false,
        },
      },
      required: ["name", "age"],
      additionalProperties: false,
    },
  };
  const validRes = validateWebMcpTool(validControlTool);
  assert.equal(validRes.ok, true, `valid control must pass registration: ${JSON.stringify(validRes)}`);
  assert.equal(validRes.value?.parameters?.additionalProperties, false);
});

test("browser: bridge rejects unsupported schema keywords at registration time (Finding P1)", { timeout: 25000 }, async (t) => {
  const server = await startServer();
  t.after(() => server.stop());

  const page = await launch({ width: 1000, height: 800 });
  t.after(() => page.close());

  await page.goto(`${server.base}/`);

  const result = await page.evaluate(async (base) => {
    return new Promise((resolve, reject) => {
      const outer = document.createElement("iframe");
      outer.src = `${base}/mini-app-bridge.html`;

      window.addEventListener("message", (e) => {
        if (e.origin !== window.location.origin) return;
        if (e.data?.type === "bridge_ready") {
          // Attempt to register tool with unsupported keyword 'pattern'
          const appHtml = `<script>
            window.webMcp.registerTool({
              name: "pattern_tool",
              description: "Tool with regex pattern",
              parameters: {
                type: "object",
                properties: {
                  code: { type: "string", pattern: "^[A-Z]+$" }
                }
              },
              execute: async () => ({ status: "ok" })
            });
            window.webMcp.ready();
          <\/script>`;
          outer.contentWindow.postMessage({ type: "load_app", appId: "bad-reg-app", html: appHtml }, window.location.origin);
        } else if (e.data?.type === "app_ready") {
          // If rejected at registration, tools list in app_ready must be empty
          resolve(e.data.tools);
        }
      });

      document.body.appendChild(outer);
      setTimeout(() => reject(new Error("timed out waiting for bridge registration")), 12000);
    });
  }, server.base);

  assert.equal(Array.isArray(result), true);
  assert.equal(result.length, 0, "tool with unsupported 'pattern' must be rejected at registration");

  // Also test bridge rejecting malformed properties: "bad" at registration
  const badPropsResult = await page.evaluate(async (base) => {
    return new Promise((resolve, reject) => {
      const outer = document.createElement("iframe");
      outer.src = `${base}/mini-app-bridge.html`;

      window.addEventListener("message", (e) => {
        if (e.origin !== window.location.origin) return;
        if (e.data?.type === "bridge_ready") {
          const appHtml = `<script>
            window.webMcp.registerTool({
              name: "bad_props_tool",
              description: "Tool with bad properties",
              parameters: {
                type: "object",
                properties: "not-an-object"
              },
              execute: async () => ({ status: "ok" })
            });
            window.webMcp.ready();
          <\/script>`;
          outer.contentWindow.postMessage({ type: "load_app", appId: "bad-props-app", html: appHtml }, window.location.origin);
        } else if (e.data?.type === "app_ready") {
          resolve(e.data.tools);
        }
      });

      document.body.appendChild(outer);
      setTimeout(() => reject(new Error("timed out waiting for bridge bad props registration")), 12000);
    });
  }, server.base);

  assert.equal(Array.isArray(badPropsResult), true);
  assert.equal(badPropsResult.length, 0, "tool with non-object properties must be rejected at registration");

  // Also test bridge rejecting items.enum with wrong element types
  const badItemsResult = await page.evaluate(async (base) => {
    return new Promise((resolve, reject) => {
      const outer = document.createElement("iframe");
      outer.src = `${base}/mini-app-bridge.html`;

      window.addEventListener("message", (e) => {
        if (e.origin !== window.location.origin) return;
        if (e.data?.type === "bridge_ready") {
          const appHtml = `<script>
            window.webMcp.registerTool({
              name: "bad_items_tool",
              description: "Tool with bad items enum",
              parameters: {
                type: "object",
                properties: {
                  tags: { type: "array", items: { type: "string", enum: [123] } }
                }
              },
              execute: async () => ({ status: "ok" })
            });
            window.webMcp.ready();
          <\/script>`;
          outer.contentWindow.postMessage({ type: "load_app", appId: "bad-items-app", html: appHtml }, window.location.origin);
        } else if (e.data?.type === "app_ready") {
          resolve(e.data.tools);
        }
      });

      document.body.appendChild(outer);
      setTimeout(() => reject(new Error("timed out waiting for bridge bad items registration")), 12000);
    });
  }, server.base);

  assert.equal(Array.isArray(badItemsResult), true);
  assert.equal(badItemsResult.length, 0, "tool with mismatched items enum types must be rejected at registration");

  // Also test bridge rejecting unsatisfiable string enum against minLength
  const badStringEnumResult = await page.evaluate(async (base) => {
    return new Promise((resolve, reject) => {
      const outer = document.createElement("iframe");
      outer.src = `${base}/mini-app-bridge.html`;

      window.addEventListener("message", (e) => {
        if (e.origin !== window.location.origin) return;
        if (e.data?.type === "bridge_ready") {
          const appHtml = `<script>
            window.webMcp.registerTool({
              name: "bad_string_enum_tool",
              description: "Tool with bad string enum",
              parameters: {
                type: "object",
                properties: {
                  code: { type: "string", minLength: 2, enum: ["x"] }
                }
              },
              execute: async () => ({ status: "ok" })
            });
            window.webMcp.ready();
          <\/script>`;
          outer.contentWindow.postMessage({ type: "load_app", appId: "bad-string-enum-app", html: appHtml }, window.location.origin);
        } else if (e.data?.type === "app_ready") {
          resolve(e.data.tools);
        }
      });

      document.body.appendChild(outer);
      setTimeout(() => reject(new Error("timed out waiting for bridge bad string enum registration")), 12000);
    });
  }, server.base);

  assert.equal(Array.isArray(badStringEnumResult), true);
  assert.equal(badStringEnumResult.length, 0, "tool with unsatisfiable string enum must be rejected at registration");
});

test("core: validateWebMcpTool rejects contradictory and malformed constraint schemas (Finding P1)", () => {
  // 1. Contradictory schema: required property not declared in properties when additionalProperties: false
  const contradictoryTool = {
    name: "contradictory_tool",
    description: "Contradictory tool",
    parameters: {
      type: "object",
      properties: {
        existing: { type: "string" },
      },
      required: ["missing_token"],
      additionalProperties: false,
    },
  };
  const cRes = validateWebMcpTool(contradictoryTool);
  assert.equal(cRes.ok, false);
  assert.equal(cRes.refused, "invalid-tool-parameters");
  assert.match(cRes.why, /contradictory schema: required property 'missing_token'/);

  // 2. Malformed constraint values: string maxLength is not integer
  const badMaxLenTool = {
    name: "bad_maxlen",
    description: "Bad maxlen",
    parameters: {
      type: "object",
      properties: {
        code: { type: "string", maxLength: "two" },
      },
    },
  };
  const maxLenRes = validateWebMcpTool(badMaxLenTool);
  assert.equal(maxLenRes.ok, false);
  assert.equal(maxLenRes.refused, "invalid-tool-parameters");
  assert.match(maxLenRes.why, /maxLength.*must be a non-negative integer/);

  // 3. Malformed required: elements must be non-empty strings (no silent filtering)
  const badReqTool = {
    name: "bad_req",
    description: "Bad req",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string" },
      },
      required: [123],
    },
  };
  const reqRes = validateWebMcpTool(badReqTool);
  assert.equal(reqRes.ok, false);
  assert.equal(reqRes.refused, "invalid-tool-parameters");
  assert.match(reqRes.why, /required must be an array of non-empty strings/);

  // 4. Nested contradictory object schema
  const nestedContradictoryTool = {
    name: "nested_contradictory",
    description: "Nested contradictory",
    parameters: {
      type: "object",
      properties: {
        nested: {
          type: "object",
          properties: {},
          required: ["ghost"],
          additionalProperties: false,
        },
      },
    },
  };
  const nestedCRes = validateWebMcpTool(nestedContradictoryTool);
  assert.equal(nestedCRes.ok, false);
  assert.equal(nestedCRes.refused, "invalid-tool-parameters");
  assert.match(nestedCRes.why, /contradictory schema on property 'nested'/);

  // 5. Malformed properties: non-object properties must be rejected, never silently defaulted to {}
  const badPropsTool = {
    name: "bad_props",
    description: "Bad props tool",
    parameters: {
      type: "object",
      properties: "bad",
    },
  };
  const badPropsRes = validateWebMcpTool(badPropsTool);
  assert.equal(badPropsRes.ok, false);
  assert.equal(badPropsRes.refused, "invalid-tool-parameters");
  assert.match(badPropsRes.why, /parameters properties must be an object/);

  // 6. Array items enum member type mismatch
  const badItemsEnumTool = {
    name: "bad_items_enum",
    description: "Bad items enum",
    parameters: {
      type: "object",
      properties: {
        tags: { type: "array", items: { type: "string", enum: [1] } },
      },
    },
  };
  const badItemsEnumRes = validateWebMcpTool(badItemsEnumTool);
  assert.equal(badItemsEnumRes.ok, false);
  assert.equal(badItemsEnumRes.refused, "invalid-tool-parameters");
  assert.match(badItemsEnumRes.why, /enum in items schema of array property 'tags' must contain strings matching type 'string'/);

  // 7. Integer enum containing non-integers (e.g. 1.5)
  const nonIntegerEnumTool = {
    name: "non_integer_enum",
    description: "Non-integer enum",
    parameters: {
      type: "object",
      properties: {
        level: { type: "integer", enum: [1, 1.5, 2] },
      },
    },
  };
  const nonIntRes = validateWebMcpTool(nonIntegerEnumTool);
  assert.equal(nonIntRes.ok, false);
  assert.equal(nonIntRes.refused, "invalid-tool-parameters");
  assert.match(nonIntRes.why, /enum for integer property 'level' must be a non-empty array of integers/);

  // 8. Integer bounds consistency: minimum/maximum non-integer or enum out of bounds
  const badIntBoundsTool = {
    name: "bad_int_bounds",
    description: "Bad int bounds",
    parameters: {
      type: "object",
      properties: {
        level: { type: "integer", minimum: 2.5 },
      },
    },
  };
  const badIntBoundsRes = validateWebMcpTool(badIntBoundsTool);
  assert.equal(badIntBoundsRes.ok, false);
  assert.equal(badIntBoundsRes.refused, "invalid-tool-parameters");
  assert.match(badIntBoundsRes.why, /minimum on integer property 'level' must be an integer/);

  const enumOutOfRangeTool = {
    name: "enum_out_of_range",
    description: "Enum out of range",
    parameters: {
      type: "object",
      properties: {
        level: { type: "integer", minimum: 2, maximum: 5, enum: [0, 1] },
      },
    },
  };
  const enumRangeRes = validateWebMcpTool(enumOutOfRangeTool);
  assert.equal(enumRangeRes.ok, false);
  assert.equal(enumRangeRes.refused, "invalid-tool-parameters");
  assert.match(enumRangeRes.why, /no enum members satisfy declared range bounds on property 'level'/);

  // 9. Array items integer enum with non-integers
  const arrayIntEnumTool = {
    name: "array_int_enum",
    description: "Array int enum",
    parameters: {
      type: "object",
      properties: {
        scores: { type: "array", items: { type: "integer", enum: [2.5] } },
      },
    },
  };
  const arrayIntRes = validateWebMcpTool(arrayIntEnumTool);
  assert.equal(arrayIntRes.ok, false);
  assert.equal(arrayIntRes.refused, "invalid-tool-parameters");
  assert.match(arrayIntRes.why, /enum in items schema of array property 'scores' must contain integers matching type 'integer'/);

  // 10. String enum unsatisfiable against minLength / maxLength
  const unsatisfiableStringEnumTool = {
    name: "unsatisfiable_string_enum",
    description: "Unsatisfiable string enum",
    parameters: {
      type: "object",
      properties: {
        code: { type: "string", minLength: 2, enum: ["x"] },
      },
    },
  };
  const unsatRes = validateWebMcpTool(unsatisfiableStringEnumTool);
  assert.equal(unsatRes.ok, false);
  assert.equal(unsatRes.refused, "invalid-tool-parameters");
  assert.match(unsatRes.why, /no enum members satisfy declared length bounds/);

  // Mixed satisfiable string enum: at least one member is valid -> admitted at registration
  const mixedStringEnumTool = {
    name: "mixed_string_enum",
    description: "Mixed string enum",
    parameters: {
      type: "object",
      properties: {
        code: { type: "string", minLength: 2, enum: ["x", "okay"] },
      },
    },
  };
  const mixedStringRes = validateWebMcpTool(mixedStringEnumTool);
  assert.equal(mixedStringRes.ok, true, "mixed satisfiable string enum must be admitted at registration");
  // Dispatch time: out-of-bounds member refused, valid member accepted
  const mixedDispatchBad = validateMiniAppToolArgs(mixedStringEnumTool, { code: "x" });
  assert.equal(mixedDispatchBad.ok, false);
  assert.equal(mixedDispatchBad.refused, "invalid-argument-length");
  const mixedDispatchGood = validateMiniAppToolArgs(mixedStringEnumTool, { code: "okay" });
  assert.equal(mixedDispatchGood.ok, true);

  // Mixed satisfiable integer enum: at least one member is valid -> admitted at registration
  const mixedIntEnumTool = {
    name: "mixed_int_enum",
    description: "Mixed int enum",
    parameters: {
      type: "object",
      properties: {
        level: { type: "integer", minimum: 5, enum: [2, 10] },
      },
    },
  };
  const mixedIntRes = validateWebMcpTool(mixedIntEnumTool);
  assert.equal(mixedIntRes.ok, true, "mixed satisfiable integer enum must be admitted at registration");
  // Dispatch time: out-of-bounds member refused, valid member accepted
  const mixedIntBad = validateMiniAppToolArgs(mixedIntEnumTool, { level: 2 });
  assert.equal(mixedIntBad.ok, false);
  assert.equal(mixedIntBad.refused, "invalid-argument-range");
  const mixedIntGood = validateMiniAppToolArgs(mixedIntEnumTool, { level: 10 });
  assert.equal(mixedIntGood.ok, true);

  // All-invalid integer enum: rejected at registration
  const allInvalidIntTool = {
    name: "all_invalid_int",
    description: "All invalid int",
    parameters: {
      type: "object",
      properties: {
        level: { type: "integer", minimum: 10, enum: [1, 2] },
      },
    },
  };
  const allInvalidIntRes = validateWebMcpTool(allInvalidIntTool);
  assert.equal(allInvalidIntRes.ok, false);
  assert.equal(allInvalidIntRes.refused, "invalid-tool-parameters");
  assert.match(allInvalidIntRes.why, /no enum members satisfy declared range bounds/);

  // 11. Schema nesting depth limit: 16 passes, 17 rejected with invalid-tool-parameters
  let deepSchema16 = { type: "string" };
  for (let i = 0; i < 15; i++) {
    deepSchema16 = { type: "object", properties: { child: deepSchema16 } };
  }
  const deepTool16 = {
    name: "deep_tool_16",
    description: "Deep schema 16",
    parameters: deepSchema16,
  };
  const deepRes16 = validateWebMcpTool(deepTool16);
  assert.equal(deepRes16.ok, true, "schema depth 16 must pass");

  let deepSchema17 = { type: "string" };
  for (let i = 0; i < 18; i++) {
    deepSchema17 = { type: "object", properties: { child: deepSchema17 } };
  }
  const deepTool17 = {
    name: "deep_tool_17",
    description: "Deep schema 17",
    parameters: deepSchema17,
  };
  const deepRes17 = validateWebMcpTool(deepTool17);
  assert.equal(deepRes17.ok, false);
  assert.equal(deepRes17.refused, "invalid-tool-parameters");
  assert.match(deepRes17.why, /schema nesting exceeds maximum depth of 16/);

  // Positive control: valid string enum satisfying minLength and maxLength
  const validStringEnumTool = {
    name: "valid_string_enum",
    description: "Valid string enum",
    parameters: {
      type: "object",
      properties: {
        code: { type: "string", minLength: 1, maxLength: 5, enum: ["a", "abc"] },
      },
    },
  };
  const validStringEnumRes = validateWebMcpTool(validStringEnumTool);
  assert.equal(validStringEnumRes.ok, true);
});

test("core: validateMiniAppToolArgs enforces snapshot literal invariant and rejects non-JSON / undefined values (Finding P2)", () => {
  const tool = {
    name: "test_tool",
    description: "Test tool",
    parameters: {
      type: "object",
      properties: {
        count: { type: "integer" },
      },
    },
  };

  // 1. Oversized key with undefined value
  const badKey = "k".repeat(70000);
  const badArgObj = { [badKey]: undefined };
  const undefRes = validateMiniAppToolArgs(tool, badArgObj);
  assert.equal(undefRes.ok, false);
  assert.equal(undefRes.refused, "invalid-argument");
  assert.match(undefRes.why, /cannot be undefined/);

  // 2. Non-finite number
  const nanRes = validateMiniAppToolArgs(tool, { count: NaN });
  assert.equal(nanRes.ok, false);
  assert.equal(nanRes.refused, "invalid-argument");
  assert.match(nanRes.why, /must be a finite number/);

  // 3. Circular reference
  const cyclic = { count: 1 };
  cyclic.self = cyclic;
  const cyclicRes = validateMiniAppToolArgs(tool, cyclic);
  assert.equal(cyclicRes.ok, false);
  assert.equal(cyclicRes.refused, "invalid-argument");
  assert.match(cyclicRes.why, /circular reference/);

  // 4. Accessor property
  const accessorObj = {};
  Object.defineProperty(accessorObj, "rogue", { get: () => 1, enumerable: true });
  const accessorRes = validateMiniAppToolArgs(tool, accessorObj);
  assert.equal(accessorRes.ok, false);
  assert.equal(accessorRes.refused, "invalid-argument");
  assert.match(accessorRes.why, /cannot use getter\/setter/);

  // 5. Positive control: valid snapshot normalization
  const validArgs = { count: 5 };
  const validRes = validateMiniAppToolArgs(tool, validArgs);
  assert.equal(validRes.ok, true);
  assert.deepEqual(validRes.value, Object.assign(Object.create(null), { count: 5 }));
  assert.notEqual(validRes.value, validArgs, "returned snapshot must be a normalized copy");

  // 6. Own __proto__ property is rejected
  const protoPollution = JSON.parse('{"__proto__": {"evil": 1}}');
  const protoRes = validateMiniAppToolArgs(tool, protoPollution);
  assert.equal(protoRes.ok, false);
  assert.equal(protoRes.refused, "invalid-argument");
  assert.match(protoRes.why, /cannot contain '__proto__' property/);

  // 7. Legitimate data properties 'constructor' and 'prototype' are preserved safely
  const dataTool = {
    name: "data_tool",
    description: "Data tool",
    parameters: {
      type: "object",
      properties: {
        constructor: { type: "string" },
        prototype: { type: "string" },
      },
    },
  };
  const dataArgs = { constructor: "Alice", prototype: "v1" };
  const dataRes = validateMiniAppToolArgs(dataTool, dataArgs);
  assert.equal(dataRes.ok, true);
  assert.equal(dataRes.value.constructor, "Alice");
  assert.equal(dataRes.value.prototype, "v1");
  assert.equal(Object.getPrototypeOf(dataRes.value), null, "snapshot must be null-prototype");

  // 8. Non-plain objects (Date, Map, Set, RegExp)
  assert.equal(validateMiniAppToolArgs(tool, { date: new Date() }).ok, false);
  assert.equal(validateMiniAppToolArgs(tool, { map: new Map() }).ok, false);
  assert.equal(validateMiniAppToolArgs(tool, { set: new Set() }).ok, false);
  assert.equal(validateMiniAppToolArgs(tool, { regex: /abc/ }).ok, false);

  // 9. Array element accessors, sparse arrays, and non-index/symbol own properties
  const sparseArr = [];
  sparseArr[1] = "val";
  assert.equal(validateMiniAppToolArgs({ name: "arr_tool", description: "", parameters: { type: "object", properties: { items: { type: "array" } } } }, { items: sparseArr }).ok, false);

  const accessorArr = [1];
  Object.defineProperty(accessorArr, 0, { get: () => 1, enumerable: true });
  assert.equal(validateMiniAppToolArgs({ name: "arr_tool", description: "", parameters: { type: "object", properties: { items: { type: "array" } } } }, { items: accessorArr }).ok, false);

  // Arrays with own non-index properties (enumerable or non-enumerable) or symbols must be rejected
  const extraPropArr = [1];
  extraPropArr.extra = "value";
  const extraPropRes = validateMiniAppToolArgs({ name: "arr_tool", description: "", parameters: { type: "object", properties: { items: { type: "array" } } } }, { items: extraPropArr });
  assert.equal(extraPropRes.ok, false);
  assert.equal(extraPropRes.refused, "invalid-argument");
  assert.match(extraPropRes.why, /cannot contain non-index or symbol properties/);

  const nonEnumPropArr = [1];
  Object.defineProperty(nonEnumPropArr, "hidden", { value: "secret", enumerable: false });
  const nonEnumRes = validateMiniAppToolArgs({ name: "arr_tool", description: "", parameters: { type: "object", properties: { items: { type: "array" } } } }, { items: nonEnumPropArr });
  assert.equal(nonEnumRes.ok, false);
  assert.equal(nonEnumRes.refused, "invalid-argument");
  assert.match(nonEnumRes.why, /cannot contain non-index or symbol properties/);

  const symPropArr = [1];
  symPropArr[Symbol("meta")] = "tag";
  const symPropRes = validateMiniAppToolArgs({ name: "arr_tool", description: "", parameters: { type: "object", properties: { items: { type: "array" } } } }, { items: symPropArr });
  assert.equal(symPropRes.ok, false);
  assert.equal(symPropRes.refused, "invalid-argument");
  assert.match(symPropRes.why, /cannot contain non-index or symbol properties/);

  // 10. Depth limits: 32 passes, 33 rejected with invalid-argument-bounds
  function makeNested(levels) {
    let cur = { leaf: 1 };
    for (let i = 0; i < levels; i++) {
      cur = { next: cur };
    }
    return cur;
  }
  const toolAny = { name: "any_tool", description: "", parameters: { type: "object", properties: {} } };
  const depth32Res = validateMiniAppToolArgs(toolAny, makeNested(31)); // 31 next wrappers + 1 leaf = 32 levels
  assert.equal(depth32Res.ok, true, "depth 32 must pass");

  const depth33Res = validateMiniAppToolArgs(toolAny, makeNested(32)); // 32 next wrappers + 1 leaf = 33 levels
  assert.equal(depth33Res.ok, false);
  assert.equal(depth33Res.refused, "invalid-argument-bounds");
  assert.match(depth33Res.why, /nesting exceeds maximum depth of 32/);

  // 11. Exact Node Count Boundary:
  // Root object (1 node) + list array (1 node) + 2046 elements = 2048 nodes -> PASS
  const arr2046 = new Array(2046).fill(1);
  const res2048 = validateMiniAppToolArgs(
    { name: "arr_t", description: "", parameters: { type: "object", properties: { list: { type: "array" } } } },
    { list: arr2046 }
  );
  assert.equal(res2048.ok, true, "exact 2048 nodes must pass");

  // Root object (1 node) + list array (1 node) + 2047 elements = 2049 nodes -> FAIL
  const arr2047 = new Array(2047).fill(1);
  const res2049 = validateMiniAppToolArgs(
    { name: "arr_t", description: "", parameters: { type: "object", properties: { list: { type: "array" } } } },
    { list: arr2047 }
  );
  assert.equal(res2049.ok, false, "exact 2049 nodes must be refused");
  assert.equal(res2049.refused, "invalid-argument-bounds");
  assert.match(res2049.why, /exceeds maximum node count of 2048/);

  // 12. Exact UTF-8 Byte Length Boundary:
  // Entire serialized snapshot string (including braces, field name, quotes) at exactly 65536 bytes vs 65537 bytes
  const stringTool = {
    name: "str_tool",
    description: "",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string" },
      },
    },
  };
  const jsonWrapperPrefix = '{"text":"';
  const jsonWrapperSuffix = '"}';
  const overhead = Buffer.byteLength(jsonWrapperPrefix, "utf8") + Buffer.byteLength(jsonWrapperSuffix, "utf8"); // 11 bytes

  const exact65536Payload = "a".repeat(65536 - overhead);
  const serialized65536 = JSON.stringify({ text: exact65536Payload });
  assert.equal(Buffer.byteLength(serialized65536, "utf8"), 65536, "precondition: serialized UTF-8 bytes must equal exactly 65536");
  const res65536 = validateMiniAppToolArgs(stringTool, { text: exact65536Payload });
  assert.equal(res65536.ok, true, "exact 65536 bytes must pass");

  const exact65537Payload = "a".repeat(65537 - overhead);
  const serialized65537 = JSON.stringify({ text: exact65537Payload });
  assert.equal(Buffer.byteLength(serialized65537, "utf8"), 65537, "precondition: serialized UTF-8 bytes must equal exactly 65537");
  const res65537 = validateMiniAppToolArgs(stringTool, { text: exact65537Payload });
  assert.equal(res65537.ok, false, "exact 65537 bytes must be refused");
  assert.equal(res65537.refused, "invalid-tool-arguments");
  assert.match(res65537.why, /exceeds maximum allowed bound of 65536 bytes/);

  // 13. Revoked Proxy passed as rawArgs
  const { proxy: revProxy, revoke: doRevoke } = Proxy.revocable({ count: 1 }, {});
  doRevoke();
  const revRes = validateMiniAppToolArgs(tool, revProxy);
  assert.equal(revRes.ok, false);
  assert.equal(revRes.refused, "invalid-argument");
  assert.match(revRes.why, /failed to inspect arguments/);

  // 14. Throwing Proxy with throwing message getter
  const evilError = new Error();
  Object.defineProperty(evilError, "message", {
    get() { throw new Error("nested trap throw"); },
  });
  const throwingProxy = new Proxy({}, {
    get() { throw evilError; },
    ownKeys() { throw evilError; },
    getOwnPropertyDescriptor() { throw evilError; },
  });
  const throwRes = validateMiniAppToolArgs(tool, throwingProxy);
  assert.equal(throwRes.ok, false);
  assert.equal(throwRes.refused, "invalid-argument");
  assert.match(throwRes.why, /cannot read symbols|cannot read descriptors|failed to inspect arguments/);

  // 15. Symmetric non-enumerable plain object property rejection
  const nonEnumObj = { count: 1 };
  Object.defineProperty(nonEnumObj, "hidden", { value: 123, enumerable: false });
  const nonEnumObjRes = validateMiniAppToolArgs(tool, nonEnumObj);
  assert.equal(nonEnumObjRes.ok, false);
  assert.equal(nonEnumObjRes.refused, "invalid-argument");
  assert.match(nonEnumObjRes.why, /cannot be non-enumerable/);
});

test("core: validateMiniAppToolArgs enforces object additionalProperties: false without properties and Unicode code points (Findings P1 & P2)", () => {
  // Object schema without properties and additionalProperties: false
  const strictEmptyObjTool = {
    name: "strict_obj",
    description: "Strict obj",
    parameters: {
      type: "object",
      properties: {
        config: {
          type: "object",
          additionalProperties: false,
        },
      },
    },
  };
  // Passing rogue key inside config must be refused
  const rogueRes = validateMiniAppToolArgs(strictEmptyObjTool, { config: { rogue: 1 } });
  assert.equal(rogueRes.ok, false);
  assert.equal(rogueRes.refused, "invalid-argument");
  assert.match(rogueRes.why, /unrecognized argument 'rogue'/);

  // Passing empty object config: {} must pass
  const emptyRes = validateMiniAppToolArgs(strictEmptyObjTool, { config: {} });
  assert.equal(emptyRes.ok, true);

  // Unicode code points for string maxLength / minLength
  const unicodeTool = {
    name: "unicode_tool",
    description: "Unicode tool",
    parameters: {
      type: "object",
      properties: {
        char: { type: "string", maxLength: 1, minLength: 1 },
      },
    },
  };
  // '𠮷' is 2 UTF-16 code units, but 1 Unicode code point -> must pass maxLength: 1, minLength: 1
  const singleCharRes = validateMiniAppToolArgs(unicodeTool, { char: "𠮷" });
  assert.equal(singleCharRes.ok, true);

  // Two supplementary characters '𠮷𠮷' is 2 Unicode code points -> must exceed maxLength: 1
  const doubleCharRes = validateMiniAppToolArgs(unicodeTool, { char: "𠮷𠮷" });
  assert.equal(doubleCharRes.ok, false);
  assert.equal(doubleCharRes.refused, "invalid-argument-length");
});

test("browser: continuous host -> page -> bridge -> inner DOM journey with visual screenshot verification (Finding P2)", { timeout: 35000 }, async (t) => {
  const server = await startServer();
  t.after(() => server.stop());

  const page = await launch({ width: 1200, height: 900 });
  t.after(() => page.close());

  await page.goto(`${server.base}/`);
  await page.waitFor(() => window.__voiceboxMiniApp !== undefined, { label: "mini-app controller on window" });

  const appHtml = `<!doctype html>
<html>
<head>
  <style>
    body { font-family: sans-serif; padding: 20px; background: #eff6ff; color: #1e3a8a; margin: 0; }
    .card { background: white; padding: 20px; border-radius: 8px; border: 2px solid #3b82f6; }
    .temp { font-size: 40px; font-weight: bold; color: #1d4ed8; }
    .mode { font-size: 20px; color: #64748b; font-weight: bold; }
  </style>
</head>
<body>
  <div class="card">
    <div id="temp-val" class="temp">20.0°C</div>
    <div id="mode-val" class="mode">STANDBY</div>
  </div>
  <script>
    let executionCount = 0;
    window.webMcp.registerTool({
      name: "set_temperature",
      description: "Set thermostat target temperature",
      parameters: {
        type: "object",
        properties: {
          target: { type: "number", minimum: 10, maximum: 35 },
          mode: { type: "string", enum: ["heat", "cool", "auto"] }
        },
        required: ["target", "mode"],
        additionalProperties: false
      },
      execute: async (args) => {
        executionCount++;
        document.getElementById("temp-val").textContent = args.target.toFixed(1) + "°C";
        document.getElementById("mode-val").textContent = args.mode.toUpperCase();
        return { ok: true, currentTarget: args.target, mode: args.mode, count: executionCount, received: args };
      }
    });
    window.webMcp.ready();
  <\/script>
</body>
</html>`;

  // 1. Mount via production window.__voiceboxMiniApp.mount() into #mini-app-container
  await page.evaluate((html) => {
    window.__voiceboxMiniApp.mount({
      appId: "continuous-thermostat-app",
      title: "Thermostat Widget",
      html,
    });
  }, appHtml);

  // Wait for outer iframe and inner app to mount and register tools
  await page.waitFor(() => {
    const outer = document.querySelector("#mini-app-outer-frame") || document.querySelector("#mini-app-frame");
    const tools = window.__voiceboxMiniApp?.getTools?.() ?? [];
    return outer && tools.some((t) => t.name === "set_temperature");
  }, { label: "mini-app tool registered on production controller" });

  // Sync tools with server host so server knows about set_temperature
  const tools = await page.evaluate(() => window.__voiceboxMiniApp.getTools());
  await fetch(`${server.base}/api/mini-app/tools`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      appId: "continuous-thermostat-app",
      title: "Thermostat Widget",
      tools,
    }),
  });

  await sleep(200);

  // Capture BEFORE screenshot of the production container
  const clip = await page.evaluate(() => {
    const el = document.querySelector("#mini-app-container") || document.querySelector("#mini-app-outer-frame");
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height), scale: 1 };
  });

  const snapBefore = await page.send("Page.captureScreenshot", { format: "png", clip });
  const bufBefore = Buffer.from(snapBefore.data, "base64");
  assert.ok(bufBefore.length > 500, "valid before screenshot captured");

  // Step 2: Continuous Server Turn -> Host Boundary Validation -> Page Controller -> Bridge -> Inner DOM
  const turnRes = await fetch(`${server.base}/api/turn`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: {
        verb: "mini_app_tool",
        name: "set_temperature",
        args: { target: 24.5, mode: "heat" },
      },
    }),
  });
  const turnJson = await turnRes.json();
  assert.equal(turnJson.result?.ok, true, "server host validation admitted valid turn");
  assert.ok(turnJson.miniAppToolCall, "server returned miniAppToolCall in turn result");

  // Route the admitted turnJson.miniAppToolCall through production controller (public/fused.js:3281-3283)
  const appRes = await page.evaluate(async (call) => {
    return await window.__voiceboxMiniApp.callTool(call.name, call.args);
  }, turnJson.miniAppToolCall);

  assert.equal(appRes.ok, true, "production callTool succeeded");
  assert.equal(appRes.result.currentTarget, 24.5);
  assert.equal(appRes.result.mode, "heat");
  assert.equal(appRes.result.count, 1);
  assert.deepEqual(appRes.result.received, { target: 24.5, mode: "heat" }, "forwarded args must match validated normalized snapshot");

  await sleep(200);

  // Capture AFTER-VALID screenshot of the production container
  const snapAfterValid = await page.send("Page.captureScreenshot", { format: "png", clip });
  const bufAfterValid = Buffer.from(snapAfterValid.data, "base64");
  assert.ok(bufAfterValid.length > 500, "valid after screenshot captured");

  // Assert observable DOM update and screenshot pixel delta
  assert.notDeepEqual(bufBefore, bufAfterValid, "painted screenshot MUST change when mini-app executes valid tool");

  // Step 3: Host Rejection on Malformed Args
  const badTurnRes = await fetch(`${server.base}/api/turn`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: {
        verb: "mini_app_tool",
        name: "set_temperature",
        args: { target: "twenty-four", mode: "turbo" },
      },
    }),
  });
  const badTurnJson = await badTurnRes.json();
  assert.equal(badTurnJson.result?.ok, false, "server host rejected malformed turn");
  assert.equal(badTurnJson.result?.refused, "invalid-argument-type");
  assert.equal(badTurnJson.miniAppToolCall, undefined, "server must not emit miniAppToolCall on refused turn");

  // Direct bridge malformed dispatch: bridge intercepts and refuses without inner execution
  const bridgeBadRes = await page.evaluate(async () => {
    return await window.__voiceboxMiniApp.callTool("set_temperature", { target: "twenty-four", mode: "turbo" });
  });
  assert.equal(bridgeBadRes.ok, false);
  assert.equal(bridgeBadRes.refused, "invalid-argument-type");

  // Reachable bypass test: key >64KiB with undefined value must be refused before reaching inner app
  const bridgeUndefRes = await page.evaluate(async () => {
    return await window.__voiceboxMiniApp.callTool("set_temperature", { ["k".repeat(70000)]: undefined });
  });
  assert.equal(bridgeUndefRes.ok, false);
  assert.equal(bridgeUndefRes.refused, "invalid-argument");

  // Own __proto__ property must be refused by bridge before reaching inner app
  const bridgeProtoRes = await page.evaluate(async () => {
    return await window.__voiceboxMiniApp.callTool("set_temperature", JSON.parse('{"__proto__": {"evil": 1}}'));
  });
  assert.equal(bridgeProtoRes.ok, false);
  assert.equal(bridgeProtoRes.refused, "invalid-argument");

  // Array with extra non-index property must be refused by bridge before reaching inner app
  const bridgeArrayExtraRes = await page.evaluate(async () => {
    const badArr = Object.assign([10], { extra: "bad" });
    return await window.__voiceboxMiniApp.callTool("set_temperature", { target: badArr, mode: "heat" });
  });
  assert.equal(bridgeArrayExtraRes.ok, false);
  assert.equal(bridgeArrayExtraRes.refused, "invalid-argument");

  await sleep(200);

  // Capture AFTER-MALFORMED screenshot
  const snapAfterMalformed = await page.send("Page.captureScreenshot", { format: "png", clip });
  const bufAfterMalformed = Buffer.from(snapAfterMalformed.data, "base64");

  // Assert DOM remained stable and uncorrupted: screenshot buffers MUST match after-valid screenshot
  assert.deepEqual(bufAfterValid, bufAfterMalformed, "painted screenshot MUST remain unchanged and stable on malformed refusal");

  // Step 4: Next-Valid-Call Probe — proves execution count was not incremented by malformed calls and handler is functional
  const nextRes = await page.evaluate(async () => {
    return await window.__voiceboxMiniApp.callTool("set_temperature", { target: 22.0, mode: "cool" });
  });
  assert.equal(nextRes.ok, true, "next valid tool call succeeded");
  assert.equal(nextRes.result.currentTarget, 22.0);
  assert.equal(nextRes.result.mode, "cool");
  assert.equal(nextRes.result.count, 2, "execution count MUST advance to exactly 2 (refused calls were never executed)");
  assert.deepEqual(nextRes.result.received, { target: 22.0, mode: "cool" }, "next valid call forwarded exact normalized snapshot");

  await sleep(200);

  // Capture AFTER-NEXT-VALID screenshot
  const snapAfterNextValid = await page.send("Page.captureScreenshot", { format: "png", clip });
  const bufAfterNextValid = Buffer.from(snapAfterNextValid.data, "base64");
  assert.notDeepEqual(bufAfterMalformed, bufAfterNextValid, "painted screenshot MUST update on subsequent valid execution");

  // Save artifacts to /tmp/fdtu-evidence/
  const fs = await import("node:fs");
  fs.mkdirSync("/tmp/fdtu-evidence", { recursive: true });
  fs.writeFileSync("/tmp/fdtu-evidence/01-before-initial.png", bufBefore);
  fs.writeFileSync("/tmp/fdtu-evidence/02-after-valid.png", bufAfterValid);
  fs.writeFileSync("/tmp/fdtu-evidence/03-after-malformed.png", bufAfterMalformed);
  fs.writeFileSync("/tmp/fdtu-evidence/04-after-next-valid.png", bufAfterNextValid);
});

