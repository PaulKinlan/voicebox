// tests/live-rate-frame.test.mjs — step 2 of the rate work (journal-6g0).
//
// The page must be told what to capture at BEFORE it sends audio, and the number must come from the provider
// that will receive it. These two tests drive the real /live upgrade path of the real server — no key needed,
// because the rate frame is the FIRST frame on the socket, ahead of any provider connection: that ordering is
// the property (a rate that arrives after the audio has started is not a negotiation).
//
//   node --test tests/live-rate-frame.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";

async function serverWith(env) {
  const proc = spawn(process.execPath, ["server.mjs"], {
    env: { ...process.env, PORT: "0", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const line = await new Promise((res, rej) => {
    let buf = "";
    const t = setTimeout(() => rej(new Error(`server did not start: ${buf}`)), 15000);
    proc.stdout.on("data", (d) => {
      buf += d.toString();
      const m = buf.match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (m) { clearTimeout(t); res(m[1]); }
    });
    proc.stderr.on("data", (d) => { buf += d.toString(); });
  });
  return { proc, port: line };
}

async function firstFrame(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/live`, { headers: { origin: `http://127.0.0.1:${port}` } }); // local peer, declared
  const frames = [];
  ws.onmessage = (e) => frames.push(typeof e.data === "string" ? JSON.parse(e.data) : e.data);
  await once(ws, "open").catch(() => {});
  const started = Date.now();
  while (frames.length === 0 && Date.now() - started < 8000) await new Promise((r) => setTimeout(r, 50));
  const first = frames[0];
  ws.close();
  return { first, frames };
}

test("rate frame: the FIRST frame on /live is the input rate the resolved provider requires", async () => {
  const { proc, port } = await serverWith({ LIVE_PROVIDER: "gemini" });
  try {
    const { first, frames } = await firstFrame(port);
    assert.equal(first?.type, "rate", `the first frame must be the rate, got ${JSON.stringify(first)}`);
    assert.equal(first.inputRate, 16000, "gemini's protocol takes 16 kHz and the page must be told so");
    assert.equal(first.provider, "gemini", "and which provider is asking, so the page can say what it is talking to");
    assert.ok(!frames.some((f) => f?.type === "state" && f.state === "ready"), "no audio flowed before the rate was declared");
  } finally { proc.kill("SIGKILL"); }
});

test("rate frame: a provider that has not declared a rate is REFUSED before anything connects", async () => {
  const { proc, port } = await serverWith({ LIVE_PROVIDER: "no-such-provider" });
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/live`, { headers: { origin: `http://127.0.0.1:${port}` } }); // local peer, declared
    const frames = [];
    ws.onmessage = (e) => frames.push(typeof e.data === "string" ? JSON.parse(e.data) : e.data);
    await once(ws, "open").catch(() => {});
    const started = Date.now();
    while (frames.length === 0 && Date.now() - started < 8000) await new Promise((r) => setTimeout(r, 50));
    assert.ok(frames.length > 0, "an unknown provider must produce a refusal, not silence");
    assert.equal(frames[0]?.type, "error", `expected an error frame, got ${JSON.stringify(frames[0])}`);
  } finally { proc.kill("SIGKILL"); }
});
