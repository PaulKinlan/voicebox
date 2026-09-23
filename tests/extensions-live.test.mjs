// Real host + provider wire; local vendor fixture, no paid sessions or external fetches.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { startServer } from "./lib/server.mjs";
import { upgrade } from "../lib/ws-server.mjs";

async function until(check, label) {
  for (let i = 0; i < 250; i++) { const value = check(); if (value) return value; await sleep(20); }
  assert.fail(`No ${label} within 5 seconds`);
}

for (const provider of ["gemini", "openai"]) {
  test(`${provider}: discover, approve mid-session, invoke extension, preserve refusals`, { timeout: 20000 }, async () => {
    const scratch = mkdtempSync(path.join(os.tmpdir(), "vb-ext-live-"));
    const workspace = path.join(scratch, "workspace");
    mkdirSync(workspace);
    const messages = [], requests = [], sockets = [];
    let server, live, peer, terminal = "";
    const vendor = createServer((req, res) => {
      requests.push(req.url);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ answer: "Saturn has rings", query: new URL(req.url, "http://local").searchParams.get("q") }));
    });
    vendor.on("upgrade", (req, raw) => {
      sockets.push(raw);
      peer = upgrade(req, raw);
      peer.on("message", data => {
        const message = JSON.parse(String(data));
        messages.push(message);
        if (message.setup || message.type === "session.update") {
          peer.send(JSON.stringify(provider === "gemini" ? { setupComplete: {} } : { type: "session.updated" }));
        }
      });
    });
    try {
      await new Promise(resolve => vendor.listen(0, "127.0.0.1", resolve));
      const origin = `http://127.0.0.1:${vendor.address().port}`;
      server = await startServer({ env: {
        VOICEBOX_WORKSPACE: workspace, VOICEBOX_EXTENSIONS_DIR: path.join(scratch, "host"),
        GEMINI_API_KEY: "synthetic-fixture-only", OPENAI_API_KEY: "synthetic-fixture-only",
        NODE_OPTIONS: `--import=${fileURLToPath(new URL("./fixtures/live-vendor-redirect.mjs", import.meta.url))}`,
        FIXTURE_VENDOR: origin.replace("http:", "ws:"),
      } });
      server.child.stdout.on("data", chunk => { terminal += chunk; });
      const post = async (route, body) => (await fetch(server.base + route, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      })).json();
      await fetch(server.base + "/api/agent-settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider }) });
      live = new WebSocket(server.base.replace("http:", "ws:") + "/live", { headers: { origin: server.base } });
      const frames = [];
      live.onmessage = event => { if (typeof event.data === "string") frames.push(JSON.parse(event.data)); };
      await until(() => frames.some(f => f.state === "ready"), "ready live session");
      const setup = messages.find(m => m.setup || m.type === "session.update");
      const declarations = setup.setup?.tools[0].functionDeclarations ?? setup.session.tools;
      for (const name of ["list_extensions", "call_extension"]) assert(declarations.some(d => d.name === name), `${name} not declared to ${provider}`);
      let sequence = 0;
      async function call(name, args = {}) {
        const id = `ext-${++sequence}`;
        peer.send(JSON.stringify(provider === "gemini"
          ? { toolCall: { functionCalls: [{ id, name, args }] } }
          : { type: "response.function_call_arguments.done", call_id: id, name, arguments: JSON.stringify(args) }));
        return until(() => {
          if (provider === "gemini") return messages.flatMap(m => m.toolResponse?.functionResponses ?? []).find(r => r.id === id)?.response.result;
          const answer = messages.find(m => m.item?.call_id === id);
          return answer && JSON.parse(answer.item.output).result;
        }, `correlated ${name} result`);
      }
      assert.deepEqual((await call("list_extensions")).extensions, []);
      const descriptor = { id: "search", name: "Search", runsIn: "host", capabilities: ["network"], bounds: { hosts: ["127.0.0.1"], maxRequests: 1 }, tools: [
        { name: "search_fixture", description: "Search for a planet", primitive: "http-get", params: { url: `${origin}/?privateDefault=not-for-discovery` } },
      ] };
      assert.equal((await post("/api/extensions/proposals", { descriptor })).state, "pending");
      const pending = await call("list_extensions");
      assert.equal(pending.extensions.length, 0);
      assert.equal(pending.proposals[0]?.state, "pending", "discovery must report the pending proposal");
      assert.equal((await call("call_extension", { name: "search_fixture" })).refused, "not-admitted");
      assert.equal(requests.length, 0);
      const approval = await post("/api/extensions/approval-request", { id: "search" });
      const code = await until(() => terminal.match(/approve "search": (\d{8}) /)?.[1], "host console code");
      assert.equal((await post("/api/extensions/approve", { id: "search", requestId: approval.requestId, code })).decision, "admitted");
      const listed = await call("list_extensions");
      assert.equal(listed.extensions[0]?.id, "search", "discovery must refresh after admission");
      assert.deepEqual(listed.extensions[0].tools, ["search_fixture"]);
      assert.deepEqual(listed.extensions[0].toolDetails, [{ name: "search_fixture", description: "Search for a planet", primitive: "http-get", arguments: ["url"] }]);
      assert(!JSON.stringify(listed).includes("not-for-discovery"), "descriptor defaults leaked");
      assert(!JSON.stringify(listed).includes(server.hostToken), "host token leaked");
      assert.equal((await call("call_extension", { name: "search_fixture", url: "https://example.invalid/" })).refused, "host-not-allowed");
      const result = await call("call_extension", { name: "search_fixture", url: `${origin}/?q=Saturn` });
      assert.equal(result.ok, true);
      assert.match(result.body, /Saturn has rings/);
      assert.deepEqual(requests, ["/?q=Saturn"]);
      assert.equal((await call("call_extension", { name: "search_fixture" })).refused, "budget-exhausted");
      assert.equal((await call("call_extension", { name: "unknown" })).refused, "unknown-tool");
      assert.equal((await call("call_extension", { name: "search_fixture", url: {} })).refused, "invalid-argument");
      assert.equal((await call("call_extension", {})).refused, "missing-argument");
      assert.equal((await call("approve_extension", { name: "search" })).refused, "unknown-command");
      assert.equal(requests.length, 1, "refused calls performed no network requests");
      const inventory = await fetch(server.base + "/api/extensions").then(r => r.json());
      assert.deepEqual(listed.extensions, inventory.extensions, "model and app inventory agree");
      const typed = await post("/api/turn", { transcript: "list extensions" });
      assert.deepEqual(typed.result.extensions, inventory.extensions);
      const audit = readFileSync(path.join(workspace, "audit.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
      assert(audit.some(row => row.act?.tool === "search_fixture" && row.result === "ok"), "extension invocation audited");
    } finally {
      live?.close();
      await server?.stop();
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => vendor.close(resolve));
      rmSync(scratch, { recursive: true, force: true });
    }
  });
}
