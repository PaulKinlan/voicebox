// Real page/server/provider and native WebSockets; only vendor destinations are redirected.
// Synthetic keys/media, owned roots and ephemeral ports. No authenticated model/audio claim.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { startServer } from "./lib/server.mjs";
import { launch } from "./lib/cdp.mjs";
import { upgrade } from "../lib/ws-server.mjs";
import { functionDeclarations, liveSystemInstruction } from "../lib/commands.mjs";

async function until(check, label) {
  const deadline = performance.now() + 5000;
  while (performance.now() < deadline) { const result = check(); if (result) return result; await sleep(20); }
  assert.fail(`No ${label} within 5000ms`);
}

async function fixture(t, envProvider = "openai", selectedProvider = "openai") {
  const scratch = mkdtempSync(path.join(os.tmpdir(), "vb-openai-browser-"));
  const workspace = path.join(scratch, "workspace"), host = path.join(scratch, "host");
  mkdirSync(workspace); mkdirSync(host);
  const rows = [], observations = [];
  let server, page;
  const vendor = createServer();
  vendor.on("upgrade", (req, raw) => {
    const peer = upgrade(req, raw);
    const row = { raw, peer, provider: new URL(req.url, "http://localhost").pathname.split("/").at(-1), messages: [], frames: 0 };
    rows.push(row);
    peer.on("message", data => {
      const msg = JSON.parse(String(data));
      if (msg.type === "input_audio_buffer.append" || msg.realtimeInput?.audio) row.frames++;
      else row.messages.push(msg);
    });
  });
  const read = () => page.evaluate(() => ({ state: window.__voiceboxLiveClient.snapshot(), controls: window.liveControls }));
  async function record(label) {
    const observation = { label, browser: await read(), wire: rows.map(({ provider, messages, frames }) => ({ provider, messages, frames })) };
    observations.push(observation);
    if (process.env.VOICEBOX_LIVE_FIX_EVIDENCE) {
      const dir = path.join(process.env.VOICEBOX_LIVE_FIX_EVIDENCE, t.name.replace(/[^a-z0-9]+/gi, "-"));
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, "receipt.json"), JSON.stringify({ envProvider, selectedProvider, observations }, null, 2) + "\n");
      await page.screenshot(path.join(dir, `${label}.png`));
    }
    return observation.browser;
  }
  t.after(async () => {
    try {
      if (page) { try { await page.evaluate(() => window.__voiceboxLiveClient.stopCapture()); } finally { await page.close(); } }
    } finally {
      for (const row of rows) row.raw.destroy();
      if (server?.child.exitCode === null && server.child.signalCode === null) {
        const exited = once(server.child, "exit"); await server.stop(); await exited;
      }
      await new Promise(resolve => vendor.close(resolve));
      rmSync(scratch, { recursive: true, force: true });
    }
  });
  await new Promise(resolve => vendor.listen(0, "127.0.0.1", resolve));
  server = await startServer({ env: {
    VOICEBOX_WORKSPACE: workspace, VOICEBOX_EXTENSIONS_DIR: host, LIVE_PROVIDER: envProvider,
    GEMINI_API_KEY: "synthetic-fixture-only", OPENAI_API_KEY: "synthetic-fixture-only",
    NODE_OPTIONS: `--import=${fileURLToPath(new URL("./fixtures/live-vendor-redirect.mjs", import.meta.url))}`,
    FIXTURE_VENDOR: `ws://127.0.0.1:${vendor.address().port}`,
  } });
  const select = async provider => {
    const res = await fetch(server.base + "/api/agent-settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider }) });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).requested.provider, provider);
  };
  await select(selectedProvider);
  page = await launch({ fakeMedia: true, width: 1100, height: 1000 });
  await page.send("Page.addScriptToEvaluateOnNewDocument", { source: `
    window.liveControls = [];
    const NativeSocket = window.WebSocket;
    window.WebSocket = new Proxy(NativeSocket, { construct(target, args) {
      const socket = Reflect.construct(target, args);
      socket.addEventListener('message', e => { if (typeof e.data === 'string') window.liveControls.push(JSON.parse(e.data)); });
      return socket;
    } });` });
  await page.goto(server.base + "/");
  await page.waitFor(() => window.__voiceboxLiveClient);
  await page.click("#mic");
  const row = await until(() => rows[0]?.messages.length && rows[0], "vendor setup");
  row.peer.send(JSON.stringify(row.provider === "openai" ? { type: "session.updated" } : { setupComplete: {} }));
  await page.waitFor(() => window.__voiceboxLiveClient.snapshot().ready && window.__voiceboxLiveClient.snapshot().capture);
  await until(() => row.frames > 0, "native PCM at vendor");
  await record("ready");
  return { row, workspace, page, server, select, read, record,
    send: msg => row.peer.send(JSON.stringify(msg)),
    answer: id => row.messages.find(msg => msg.item?.type === "function_call_output" && msg.item.call_id === id),
  };
}

test("OpenAI browser: real function call writes and answers; invalid calls refuse", { timeout: 20000 }, async t => {
  const f = await fixture(t);
  const setup = f.row.messages.find(msg => msg.type === "session.update").session;
  assert.deepEqual(setup.tools, functionDeclarations().map(tool => ({ type: "function", ...tool })));
  assert.equal(setup.instructions, liveSystemInstruction());
  f.send({ type: "response.created" });
  const content = "owned live-tool marker — café\n";
  f.send({ type: "response.function_call_arguments.done", call_id: "write-1", name: "write_file", arguments: JSON.stringify({ name: "live.txt", content }) });
  const answer = await until(() => f.answer("write-1"), "correlated write result");
  assert.equal(JSON.parse(answer.item.output).result.ok, true);
  assert.equal(readFileSync(path.join(f.workspace, "live.txt"), "utf8"), content);
  const audit = readdirSync(path.join(f.workspace, ".audit")).filter(n => n.endsWith(".jsonl")).flatMap(n => readFileSync(path.join(f.workspace, ".audit", n), "utf8").trim().split("\n").map(JSON.parse));
  assert.ok(audit.some(entry => entry.turn === "live" && entry.act?.target === "live.txt"));
  assert.equal(f.row.messages.some(msg => msg.type === "response.create"), false, "generation is still active");
  f.send({ type: "response.done" });
  await until(() => f.row.messages.some(msg => msg.type === "response.create"), "continuation after tool result");
  for (const [id, name, args, refused] of [
    ["unknown", "not_a_command", "{}", "unknown-command"],
    ["missing", "write_file", '{"name":"missing.txt"}', "missing-argument"],
    ["malformed", "write_file", "{", "invalid-tool-call"],
  ]) {
    f.send({ type: "response.function_call_arguments.done", call_id: id, name, arguments: args });
    const reply = await until(() => f.answer(id), `named refusal for ${id}`);
    assert.equal(JSON.parse(reply.item.output).result.refused, refused);
  }
  f.send({ type: "response.output_audio_transcript.delta", delta: "after tool results" });
  await f.page.waitFor(() => window.liveControls.some(c => c.text === "after tool results"));
  const observed = await f.record("write-and-refusals");
  assert.equal(observed.state.ready, true);
  assert.ok(observed.controls.some(c => c.type === "tool" && c.calls.some(call => call.name === "write_file" && call.ok)));
});

for (const [environment, selected, rate, model] of [
  ["gemini", "openai", 24000, "gpt-realtime"],
  ["openai", "gemini", 16000, "models/gemini-3.8-live"],
]) test(`Selected ${selected}: declaration and native capture agree despite ${environment} environment`, { timeout: 15000 }, async t => {
  const f = await fixture(t, environment, selected);
  const first = await f.read();
  assert.equal(f.row.provider, selected, "actual vendor destination");
  assert.deepEqual(first.controls[0], { type: "rate", inputRate: rate, provider: selected });
  assert.equal(first.state.captureRate, rate, "native running AudioContext rate, not only a declaration");
  assert.equal(first.state.provider, selected);
  assert.equal(first.state.rateContradiction, null);
  // Settings affect the next session, not state frames emitted by this running one.
  await f.select(environment);
  f.send(selected === "openai" ? { type: "response.done" } : { serverContent: { turnComplete: true } });
  await f.page.waitFor(() => window.liveControls.some(c => c.state === "turn-complete"));
  const after = await f.record("selected-rate-and-session-snapshot");
  const state = after.controls.find(c => c.state === "turn-complete");
  assert.equal(state.detail.provider, selected);
  assert.equal(state.model, model);
});
