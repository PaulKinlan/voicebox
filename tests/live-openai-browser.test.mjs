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

async function fixture(t, envProvider = "openai", selectedProvider = "openai", debug = false) {
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
  await page.goto(server.base + (debug ? "/?debug=1" : "/"));
  await page.waitFor(() => window.__voiceboxLiveClient);
  assert.equal(await page.evaluate(() => document.querySelector("#debug-panel").hidden), !debug);
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
  assert.equal((await f.read()).controls.some(c => c.type === "debug"), false, "normal sessions do not transmit debug payloads");
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

for (const provider of ["gemini", "openai"]) test(`Debug transcript: ${provider} failing tool → clipboard, with redaction and error navigation`, { timeout: 30000 }, async t => {
  const f = await fixture(t, provider, provider, true);
  const callId = "debug-failure";
  const secret = "AIzaSyntheticSecretForExportOnly123456789";
  const args = { name: "debug-missing.txt", cookie: "synthetic-cookie", note: `key in prose ${secret}` };
  f.send(provider === "gemini"
    ? { toolCall: { functionCalls: [{ id: callId, name: "read_file", args }] } }
    : { type: "response.function_call_arguments.done", call_id: callId, name: "read_file", arguments: JSON.stringify(args) });
  await f.page.waitFor(() => document.querySelector("#debug-events").textContent.includes("tool.delivery"));
  const raw = await f.page.evaluate(() => document.querySelector("#debug-events").textContent);
  assert(raw.includes(secret), "positive witness: unredacted model arguments arrived at the actual page");
  assert(raw.includes("synthetic-cookie"));
  assert(raw.includes("tool.result"));
  const upstream = await until(() => provider === "gemini"
    ? f.row.messages.find(m => m.toolResponse)?.toolResponse.functionResponses.find(r => r.id === callId)
    : f.answer(callId), "actual result at the fixture provider");
  const result = provider === "gemini" ? upstream.response.result : JSON.parse(upstream.item.output).result;
  assert.equal(result.ok, false, "real executor must fail on missing file");
  assert(result.error || result.refused);
  const setup = f.row.messages.find(m => m.setup || m.type === "session.update");
  assert.equal(provider === "gemini" ? setup.setup.inputAudioTranscription : setup.session.audio.input.transcription, undefined,
    "debug must not enable transcription or change the provider's setup");

  await f.page.click("#debug-next-error");
  assert.equal(await f.page.evaluate(() => document.activeElement.closest('[data-error="true"]') !== null), true);
  await f.page.send("Browser.grantPermissions", { origin: f.server.base, permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"] });
  await f.page.click("#debug-copy");
  await f.page.waitFor(() => document.querySelector("#debug-copy-status").textContent.startsWith("Copied"));
  const text = await f.page.evaluate(() => navigator.clipboard.readText());
  assert(!text.includes(secret), "opaque API key must not leave the page");
  assert(!text.includes("synthetic-cookie"), "cookie value must not leave the page");
  const events = text.trim().split("\n").map(JSON.parse);
  assert.equal(events.length, await f.page.evaluate(() => document.querySelectorAll("#debug-events > li").length), "one copy captures the entire timeline");
  assert(events.every(e => Number.isFinite(Date.parse(e.timestamp))));
  assert(events.some(e => e.type === "debug.start" && e.inputTranscript.includes("does not enable transcription")));
  const stages = events.filter(e => e.callId === callId);
  for (const type of ["tool.request", "tool.route", "tool.result", "tool.delivery"]) assert(stages.some(e => e.type === type), type);
  const routed = stages.find(e => e.type === "tool.route");
  assert.equal(routed.route, "shared-executor");
  const failed = stages.find(e => e.type === "tool.result");
  assert.equal(failed.result.ok, false);
  assert(failed.durationMs >= 0);
  assert.equal(stages.find(e => e.type === "tool.delivery").delivery, "transport-accepted");
  assert.equal(stages.find(e => e.type === "tool.delivery").modelReceipt, "unknown");

  // Real typed turns are also captured, beyond the eight visible recent turns.
  for (let i = 0; i < 9; i++) {
    await f.page.type("#utterance", `read debug-missing-${i}.txt`);
    await f.page.click("#send");
    await f.page.waitFor(() => document.querySelector("#send").textContent === "Send");
  }
  await f.page.click("#debug-copy");
  await f.page.waitFor(() => document.querySelector("#debug-export").value.includes("debug-missing-8.txt"));
  const typed = (await f.page.evaluate(() => document.querySelector("#debug-export").value)).trim().split("\n").map(JSON.parse);
  assert.equal(typed.filter(e => e.type === "turn.request").length, 9);
  assert.equal(typed.filter(e => e.type === "turn.result").length, 9);
  assert.equal(typed.filter(e => e.type === "turn.presented").length, 9);
  for (const width of [1280, 390]) {
    await f.page.emulateViewport({ width, height: 850, mobile: width === 390 });
    const fits = await f.page.evaluate(() => {
      const panel = document.querySelector("#debug-panel").getBoundingClientRect();
      return panel.left >= 0 && panel.right <= innerWidth && document.documentElement.scrollWidth <= innerWidth;
    });
    assert(fits, `debug panel fits ${width}px viewport`);
  }
  // A refused clipboard still exposes ONLY the redacted fallback, with a remedy.
  await f.page.evaluate(() => Object.defineProperty(navigator, "clipboard", { value: { writeText: () => Promise.reject(new Error("fixture denial")) }, configurable: true }));
  await f.page.click("#debug-copy");
  await f.page.waitFor(() => document.querySelector("#debug-copy-status").textContent.includes("Clipboard unavailable"));
  assert.equal(await f.page.evaluate(() => {
    const out = document.querySelector("#debug-export");
    return !out.hidden && out.selectionEnd === out.value.length && out.selectionStart === 0;
  }), true);
});
