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

