// tests/mini-app-webmcp-surface.test.mjs — a Mini-App is a WebMCP page (voicebox-beads-cwx5.12).
//
// Driven in a real browser, mounted the room's way (bridge iframe, sandboxed opaque-origin inner frame), because
// the claim is about what app code can call inside that frame and what the ROOM then sees:
//
//   * document.modelContext.registerTool({ name, description, inputSchema, execute }) registers a tool the room
//     can call, and the promise it returns settles on the host's answer;
//   * a duplicate name, a missing description and a schema the host refuses are REJECTIONS the app can catch;
//   * aborting the signal given to registerTool unregisters the tool in the room;
//   * execute receives (input, { signal }) and that signal aborts when the host abandons the call;
//   * window.webMcp with `parameters` — the older Voicebox names — still works.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { startServer } from "./lib/server.mjs";
import { launch } from "./lib/cdp.mjs";

const APP = `<!doctype html><title>WebMCP probe</title><script>
(async () => {
  const mc = document.modelContext;
  const seen = { sameObject: navigator.modelContext === mc, outcomes: {}, cancelled: false, optionsSignal: null };
  const settle = (key, promise) => promise.then(() => { seen.outcomes[key] = "resolved"; }, (e) => { seen.outcomes[key] = (e && e.name) + ": " + (e && e.message); });

  await settle("first", mc.registerTool({
    name: "greet",
    description: "Greets a person by name.",
    inputSchema: { type: "object", properties: { who: { type: "string" } }, required: ["who"] },
    execute(input, options) {
      seen.optionsSignal = Object.prototype.toString.call(options && options.signal);
      return "hello " + input.who;
    },
  }));
  await settle("duplicate", mc.registerTool({ name: "greet", description: "Again.", execute() { return "x"; } }));
  await settle("noDescription", mc.registerTool({ name: "quiet", execute() { return "x"; } }));
  await settle("hostRefused", mc.registerTool({
    name: "odd_schema", description: "A schema keyword the host does not allow.",
    inputSchema: { type: "object", properties: {}, patternProperties: { ".*": { type: "string" } } },
    execute() { return "x"; },
  }));

  const temporary = new AbortController();
  await settle("temporary", mc.registerTool(
    { name: "temporary", description: "Unregistered when its signal aborts.", execute() { return "still here"; } },
    { signal: temporary.signal },
  ));
  await mc.registerTool({ name: "drop_temporary", description: "Aborts the temporary tool's signal.", execute() { temporary.abort(); return "dropped"; } });

  await mc.registerTool({
    name: "hang", description: "Never answers; records that the host cancelled it.",
    execute(input, { signal }) {
      return new Promise((resolve, reject) => signal.addEventListener("abort", () => { seen.cancelled = true; reject(signal.reason); }));
    },
  });
  await mc.registerTool({ name: "report", description: "What this page observed.", execute() { return seen; } });

  window.webMcp.registerTool({
    name: "legacy_add", description: "The older Voicebox registration, with parameters.",
    parameters: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] },
    execute: ({ a, b }) => ({ sum: a + b }),
  });
  window.webMcp.ready();
})();
<\/script>`;

test("a Mini-App registers, unregisters and is cancelled through the WebMCP surface", async (t) => {
  const scratch = mkdtempSync(path.join(os.tmpdir(), "voicebox-webmcp-surface-"));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const server = await startServer({ env: { VOICEBOX_WORKSPACE: path.join(scratch, "workspace") }, cwd: scratch });
  t.after(() => server.stop());
  const page = await launch();
  t.after(() => page.close());
  await page.goto(`${server.base}/`);
  await page.waitFor(
    () => typeof window.__voiceboxOnMiniApp === "function" && !!window.__voiceboxMiniAppRegistry,
    { label: "room booted", timeout: 30000 },
  );
  await page.evaluate((html) => {
    window.__voiceboxOnMiniApp({ appId: "webmcp-probe", title: "WebMCP probe", html });
  }, APP);

  const names = () => page.evaluate(() => window.__voiceboxMiniAppRegistry.getAllTools().map((tool) => tool.name).sort());
  const call = (name, args = {}) =>
    page.evaluate(([n, a]) => window.__voiceboxMiniAppRegistry.executeTool(n, a), [name, args]);

  await page.waitFor(
    () => window.__voiceboxMiniAppRegistry.getAllTools().some((tool) => tool.name === "legacy_add"),
    { label: "the probe's tools reached the room", timeout: 30000 },
  );
  assert.deepEqual(
    await names(),
    ["drop_temporary", "greet", "hang", "legacy_add", "report", "temporary"],
    "exactly the tools whose registration the host accepted are in the room",
  );

  const greeted = await call("greet", { who: "Ada" });
  assert.equal(greeted.ok, true, JSON.stringify(greeted));
  assert.equal(greeted.result, "hello Ada", "a string result crosses as a string");
  assert.equal((await call("greet", {})).ok, false, "inputSchema is enforced by the host exactly as parameters was");

  const added = await call("legacy_add", { a: 2, b: 3 });
  assert.deepEqual(added.result, { sum: 5 }, "window.webMcp with `parameters` still works");

  // The signal given to registerTool unregisters the tool IN THE ROOM.
  assert.equal((await call("temporary")).result, "still here");
  assert.equal((await call("drop_temporary")).result, "dropped");
  await page.waitFor(
    () => !window.__voiceboxMiniAppRegistry.getAllTools().some((tool) => tool.name === "temporary"),
    { label: "the aborted tool left the room's catalogue", timeout: 10000 },
  );

  // The host abandons a call that never answers, and the app's execute signal says so.
  const hung = await call("hang");
  assert.equal(hung.ok, false);
  assert.match(String(hung.error), /timed out/);

  const { result: seen } = await call("report");
  assert.equal(seen.sameObject, true, "navigator.modelContext is the same object as document.modelContext");
  assert.equal(seen.optionsSignal, "[object AbortSignal]", "execute receives (input, { signal })");
  assert.equal(seen.cancelled, true, "the abandoned call's signal aborted inside the app");
  assert.equal(seen.outcomes.first, "resolved");
  assert.equal(seen.outcomes.temporary, "resolved");
  assert.match(seen.outcomes.duplicate, /^InvalidStateError: .*already registered/);
  assert.match(seen.outcomes.noDescription, /^InvalidStateError: .*description/);
  assert.match(seen.outcomes.hostRefused, /^InvalidStateError: .*patternProperties/, "the host's refusal reaches the app as a rejection");
});
