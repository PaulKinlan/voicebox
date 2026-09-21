import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { stripTypeScriptTypes } from "node:module";
import { launch } from "./lib/cdp.mjs";

test("real browser: portable ACP fixture + IndexedDB control; D1 executor import remains blocked without bridge", { timeout: 30000 }, async (t) => {
  const requests = [];
  const files = new Map(["acp-client.mjs", "tasks.mjs", "task-interrupted.mjs"].map((name) => [`/lib/${name}`, new URL(`../lib/${name}`, import.meta.url)]));
  for (const name of ["audit.ts", "tasks.ts"]) files.set(`/core/${name}`, new URL(`../core/${name}`, import.meta.url));
  const server = http.createServer((req, res) => {
    requests.push(req.url);
    if (req.url === "/") {
      res.setHeader("content-type", "text/html");
      res.end('<!doctype html><title>ACP browser boundary check</title><h1>ACP browser boundary check</h1><pre id="result">Running…</pre>');
    } else if (files.has(req.url)) {
      res.setHeader("content-type", "text/javascript");
      const source = fs.readFileSync(files.get(req.url), "utf8");
      res.end(req.url.endsWith(".ts") ? stripTypeScriptTypes(source) : source);
    } else if (req.url === "/favicon.ico") { res.writeHead(204); res.end(); }
    else { res.writeHead(404); res.end("No API or bridge in this static test server"); }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => server.close(r)));
  const page = await launch(); t.after(() => page.close());
  await page.send("Log.enable");
  await page.send("Network.enable");
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const result = await page.evaluate(async () => {
    const { createAcpClient } = await import("/lib/acp-client.mjs");
    let receive;
    const client = createAcpClient({
      onMessage(fn) { receive = fn; }, onClose() {}, close() {},
      send(m) {
        queueMicrotask(() => {
          const r = m.method === "initialize" ? { protocolVersion: 1, agentInfo: { name: "pi-acp", version: "0.0.33" } }
            : m.method === "session/new" ? { sessionId: "browser-fixture" } : { stopReason: "end_turn" };
          if (m.method === "session/prompt") receive({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "browser-fixture", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "protocol fixture only" } } } });
          receive({ jsonrpc: "2.0", id: m.id, result: r });
        });
      },
    });
    await client.initialize(); await client.newSession("browser-fixture");
    const answer = await client.prompt("fixture"); client.close();
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open("acp-boundary-control", 1);
      req.onupgradeneeded = () => req.result.createObjectStore("results");
      req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
    });
    await new Promise((resolve, reject) => {
      const tx = db.transaction("results", "readwrite"); tx.objectStore("results").put(answer, "answer");
      tx.oncomplete = resolve; tx.onabort = () => reject(tx.error);
    });
    const persisted = await new Promise((resolve, reject) => {
      const req = db.transaction("results").objectStore("results").get("answer");
      req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
    });
    db.close();
    let blocked;
    try { await import("/lib/tasks.mjs"); blocked = "unexpectedly imported"; }
    catch (e) { blocked = e.message; }
    const result = { protocol: "fixture, not real harness/provider", persisted, blocked };
    document.querySelector("#result").textContent = JSON.stringify(result, null, 2);
    return result;
  });
  assert.equal(result.persisted, "protocol fixture only");
  assert.match(result.blocked, /Failed to fetch dynamically imported module|node:fs|node:path|node:crypto/);
  result.browserLog = page.events("Log.entryAdded").map((event) => event.entry.text);
  result.failedRequests = page.events("Network.requestWillBeSent").map((event) => event.request.url).filter((url) => url.startsWith("node:"));
  assert.ok(result.failedRequests.some((url) => url === "node:fs"), "browser actually attempted the unsupported Node dependency");
  assert.equal(requests.some((url) => url.startsWith("/api/") || url.startsWith("/live")), false);
  if (process.env.VOICEBOX_ACP_EVIDENCE) {
    const dir = process.env.VOICEBOX_ACP_EVIDENCE;
    fs.mkdirSync(dir, { recursive: true });
    await page.screenshot(path.join(dir, "browser-boundary.png"));
    fs.writeFileSync(path.join(dir, "browser-boundary.json"), JSON.stringify({ ...result, requests }, null, 2));
  }
});
