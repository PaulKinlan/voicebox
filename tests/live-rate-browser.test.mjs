// Regression for the native press and reconnect missed by pre-declared-rate unit fixtures.
// Before d48bc8c, the first press refused immediately and reattach reused the previous rate.
// Real Chromium AudioContext/worklet + native clicks + owned loopback WebSockets; fake media,
// never a real microphone/vendor. No credentials, fixed ports, timers mocked or product code replaced.
// Run: node --test tests/live-rate-browser.test.mjs
// Optional screenshots/receipts: VOICEBOX_RATE_EVIDENCE=/absolute/new/directory
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { upgrade } from "../lib/ws-server.mjs";
import { launch } from "./lib/cdp.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));

// Serialized into the fixture page: parsed as JS here, not an unchecked script inside a string.
async function installFixture() {
  const trace = { mediaCalls: 0, contexts: [], attempts: [], attachments: 0 };
  const sockets = [];
  const NativeContext = window.AudioContext;
  window.AudioContext = new Proxy(NativeContext, {
    construct(target, args) {
      const context = new target(...args);
      trace.contexts.push({ requested: args[0]?.sampleRate, actual: context.sampleRate });
      return context;
    },
  });
  const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = (options) => {
    trace.mediaCalls++;
    return getUserMedia(options);
  };
  const NativeSocket = window.WebSocket;
  window.WebSocket = new Proxy(NativeSocket, {
    construct(target, args) {
      const socket = new target(...args);
      sockets.push(socket);
      return socket;
    },
  });
  await import("/live-voice.js"); // the actual #mic handler, including open -> startCapture
  const client = window.__voiceboxLiveClient;
  const start = client.startCapture;
  client.startCapture = (...args) => {
    const attempt = { started: performance.now(), settled: false };
    trace.attempts.push(attempt);
    return start(...args).finally(() => {
      attempt.elapsed = performance.now() - attempt.started;
      attempt.settled = true;
    });
  };
  // Separate native controls let reconnect's warm-up work on the old implementation too.
  // Only the warm-up pre-declares. The second start happens BEFORE its own rate arrives.
  document.querySelector("#attach-client").onclick = async () => {
    await client.stopCapture();
    const previous = sockets.at(-1);
    if (previous && previous.readyState !== WebSocket.CLOSED) {
      await new Promise((resolve) => {
        previous.addEventListener("close", resolve, { once: true });
        previous.close();
      });
    }
    const socket = new WebSocket(`ws://${location.host}/live`);
    await new Promise((resolve) => socket.addEventListener("open", resolve, { once: true }));
    client.attachSocket(socket);
    trace.attachments++;
  };
  document.querySelector("#start-client").onclick = () => client.startCapture();
  window.readRateTest = () => ({ ...trace, state: client.snapshot(), label: document.querySelector("#voice-state").textContent });
  setInterval(() => {
    document.querySelector("#receipt").textContent = JSON.stringify(window.readRateTest(), null, 2);
  }, 100);
}

async function until(check, label) {
  const deadline = performance.now() + 3500;
  while (performance.now() < deadline) {
    if (check()) return;
    await sleep(20);
  }
  assert.fail(`No ${label} within 3500ms`);
}

async function fixture(t, name) {
  const rows = [];
  const observations = [];
  let page;
  const html = `<!doctype html><meta charset="utf-8"><title>Live rate regression</title>
    <style>body{font:16px system-ui;margin:24px}button{font:inherit;padding:14px}pre{white-space:pre-wrap}</style>
    <h1>Live rate regression</h1><p>Actual client/worklet; synthetic browser media; owned loopback.</p>
    <button id="mic">Microphone — production handler</button><span id="voice-state"></span>
    <div id="voice-ring-wrap"></div><button id="interrupt">Stop reply</button>
    <p>Adapter lifecycle controls:</p><button id="attach-client">Attach a new socket</button>
    <button id="start-client">Start capture on this socket</button><pre id="receipt"></pre>
    <script type="module">await (${installFixture})();</script>`;
  const server = createServer((req, res) => {
    res.setHeader("Cache-Control", "no-store");
    if (req.url === "/") {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.end(html);
    }
    if (["/audio-client.js", "/live-voice.js", "/pcm.js", "/pcm-worklet.js"].includes(req.url)) {
      res.setHeader("Content-Type", "application/javascript");
      return res.end(readFileSync(path.join(root, "public", req.url)));
    }
    res.writeHead(404).end();
  });
  server.on("upgrade", (req, socket) => {
    if (req.url !== "/live") return socket.destroy();
    const peer = upgrade(req, socket);
    const row = { peer, frames: 0, bytes: 0, declared: [] };
    rows.push(row);
    peer.on("message", (data) => {
      assert.ok(Buffer.isBuffer(data) && data.length > 0 && data.length % 2 === 0, "receiver must get actual PCM16 frames");
      row.frames++;
      row.bytes += data.length;
    });
    // Deliberately NO format here: release is controlled by the test AFTER capture was invoked.
  });
  const read = () => page.evaluate(() => window.readRateTest());
  async function record(stage) {
    const browser = await read();
    const wire = rows.map(({ frames, bytes, declared }) => ({ frames, bytes, declared: [...declared] }));
    observations.push({ stage, browser, wire });
    return browser;
  }
  t.after(async () => {
    try {
      if (page) {
        await record("exit");
        if (process.env.VOICEBOX_RATE_EVIDENCE) {
          const directory = path.join(process.env.VOICEBOX_RATE_EVIDENCE, name);
          mkdirSync(directory, { recursive: true });
          writeFileSync(path.join(directory, "receipt.json"), JSON.stringify({ root, observations }, null, 2) + "\n");
          await page.screenshot(path.join(directory, "state.png"), { fullPage: true });
        }
      }
    } finally {
      if (page) {
        try { await page.evaluate(() => window.__voiceboxLiveClient?.stopCapture()); } finally { await page.close(); }
      }
      for (const row of rows) row.peer.close();
      await new Promise((resolve) => server.close(resolve));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  page = await launch({ fakeMedia: true, width: 1050, height: 1000 });
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitFor(() => typeof window.readRateTest === "function", { timeout: 3500, label: "fixture installed" });
  const declare = (row, inputRate) => {
    row.declared.push(inputRate);
    row.peer.send(JSON.stringify({ type: "rate", inputRate, provider: `fixture-${inputRate}` }));
  };
  const ready = (row) => row.peer.send(JSON.stringify({ type: "state", state: "ready" }));
  async function warmUp() {
    await page.click("#attach-client");
    await page.waitFor(() => window.readRateTest().attachments === 1, { timeout: 3500 });
    declare(rows[0], 16000);
    ready(rows[0]);
    await page.waitFor(() => window.readRateTest().state.inputRate === 16000, { timeout: 3500 });
    await page.click("#start-client");
    await page.waitFor(() => window.readRateTest().state.capture, { timeout: 3500 });
    await until(() => rows[0].frames > 0, "warm-up PCM receipt");
    assert.equal((await record("warm-up-16k")).contexts.at(-1).actual, 16000);
  }
  return { page, rows, read, record, declare, ready, warmUp };
}

const options = { timeout: 15000 };

test("rate browser: a first native mic press waits for its rate, without a retry", options, async (t) => {
  const f = await fixture(t, "first-press");
  assert.equal((await f.read()).mediaCalls, 0, "loading a page is not permission to capture");
  await f.page.click("#mic");
  await f.page.waitFor(() => window.readRateTest().attempts.length === 1, { timeout: 3500 });
  const waiting = await f.record("pressed-before-rate");
  assert.equal(waiting.state.phase, "starting", "the open continuation must wait, not immediately refuse");
  assert.equal(waiting.attempts[0].settled, false);
  assert.equal(waiting.mediaCalls, 0);
  assert.equal(f.rows[0].frames, 0);
  f.declare(f.rows[0], 24000);
  f.ready(f.rows[0]);
  await f.page.waitFor(() => window.readRateTest().state.capture, { timeout: 3500 });
  await until(() => f.rows[0].frames > 0, "first-press PCM receipt");
  const captured = await f.record("first-press-captures");
  assert.equal(captured.attempts.length, 1, "no retry may provide a leftover rate");
  assert.equal(captured.contexts.at(-1).actual, 24000);
  assert.equal(captured.state.captureRate, captured.contexts.at(-1).actual);
});

test("rate browser: the same client on a new socket cannot capture using the old rate", options, async (t) => {
  const f = await fixture(t, "reattach");
  await f.warmUp();
  await f.page.click("#attach-client");
  await f.page.waitFor(() => window.readRateTest().attachments === 2, { timeout: 3500 });
  const attached = await f.record("new-socket-before-declaration");
  assert.equal(attached.state.inputRate, null, "the new socket must not inherit 16000");
  assert.equal(attached.state.captureRate, null, "the stopped old context is not this session's capture");
  await f.page.click("#start-client");
  await f.page.waitFor(() => window.readRateTest().attempts.length === 2, { timeout: 3500 });
  const waiting = await f.record("reattached-start-waits");
  assert.equal(waiting.attempts[1].settled, false);
  assert.equal(waiting.mediaCalls, 1, "the only media request is the completed warm-up");
  assert.equal(waiting.state.capture, false);
  assert.equal(f.rows[1].frames, 0);
  assert.deepEqual(f.rows[1].declared, []);
  f.declare(f.rows[1], 24000);
  f.ready(f.rows[1]);
  await f.page.waitFor(() => window.readRateTest().state.capture, { timeout: 3500 });
  await until(() => f.rows[1].frames > 0, "new socket PCM receipt");
  const captured = await f.record("new-socket-24k");
  assert.equal(captured.contexts.at(-1).actual, 24000);
  assert.equal(captured.state.captureRate, 24000);
  assert.equal(captured.state.rateContradiction, null);
});

test("rate browser: a late conflicting declaration names both declared and running rates", options, async (t) => {
  const f = await fixture(t, "conflicting-rate");
  await f.warmUp();
  f.declare(f.rows[0], 24000);
  await f.page.waitFor(() => window.readRateTest().state.inputRate === 24000, { timeout: 3500 });
  const conflicting = await f.record("24k-declared-16k-running");
  assert.equal(conflicting.contexts.at(-1).actual, 16000, "the actual context did not change when a message arrived");
  assert.deepEqual(conflicting.state.rateContradiction, { declared: 24000, running: 16000 }, "accepted rate messages must not erase the running-context fact");
  assert.equal(conflicting.state.captureRate, conflicting.contexts.at(-1).actual);
});

test("rate browser: no declaration produces a named refusal after the real five-second wait", options, async (t) => {
  const f = await fixture(t, "missing-rate");
  await f.page.click("#mic");
  await f.page.waitFor(() => window.readRateTest().attempts.length === 1, { timeout: 3500 });
  assert.equal((await f.record("missing-rate-waiting")).attempts[0].settled, false, "absence starts a bounded wait, not an immediate refusal");
  await f.page.waitFor(() => window.readRateTest().attempts[0].settled, { timeout: 7500, label: "five-second declaration wait to return" });
  const refused = await f.record("missing-rate-refused");
  assert.ok(refused.attempts[0].elapsed >= 4900 && refused.attempts[0].elapsed < 7500, `expected the real 5s wait, observed ${refused.attempts[0].elapsed}ms`);
  assert.equal(refused.state.captureErrorReason, "rate-not-declared");
  assert.match(refused.label, /server has not said what audio rate/i, "the person must see the reason");
  assert.equal(refused.state.capture, false);
  assert.equal(refused.mediaCalls, 0);
  assert.equal(refused.contexts.length, 0);
  assert.equal(f.rows[0].frames, 0);
  // A late declaration after refusal must not resurrect the expired user action.
  f.declare(f.rows[0], 24000);
  await f.page.waitFor(() => window.readRateTest().state.inputRate === 24000, { timeout: 3500 });
  const late = await f.record("late-rate-after-refusal");
  assert.equal(late.state.capture, false);
  assert.equal(late.mediaCalls, 0);
});
