// tests/live-tools.test.mjs — THE ACCEPTANCE PAUL RUNS, automated:
// ask the live voice to write a file, then read that file from disk and
// compare byte for byte; then ask it to read the file back, and hear the
// content spoken (via the output transcription).
//
// Real Gemini Live, real executor, real filesystem. No stubs. Skipped only
// when there is no key — a green run here IS the driven evidence.
//
//   GEMINI_API_KEY=... node --test tests/live-tools.test.mjs
import { spawn } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { setTimeout as sleep } from "node:timers/promises";

const ROOT = new URL("..", import.meta.url).pathname;
const HAVE_KEY = Boolean(process.env.GEMINI_API_KEY);

// A FREE PORT PER SERVER, the fleet rule (2026-09-20: fixed ports collide with
// other lanes' runs, and a suite that reports on its environment is not a
// gate). Bind 0, read the number, release, hand it over — the same pattern
// scripts/docs-check.mjs uses, with the same TOCTOU caveat.
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const p = probe.address().port;
      probe.close(() => resolve(p));
    });
  });
}

const SCRATCH = mkdtempSync(path.join(os.tmpdir(), "voicebox-live-tools-"));
// The workspace must EXIST: VOICEBOX_WORKSPACE is a declaration, and declaring
// a missing directory is refused at boot ("no root is declared"), which turns
// this acceptance into the refusal test's shape by accident.
const WORKSPACE = path.join(SCRATCH, "workspace");
mkdirSync(WORKSPACE, { recursive: true });

function startServer(port, env = {}) {
  const proc = spawn("node", ["server.mjs"], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), VOICEBOX_PROVIDER: "script", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return proc;
}

function waitForServer(proc, ms = 10000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("server did not start")), ms);
    proc.stdout.on("data", (d) => {
      if (String(d).includes("voicebox on")) { clearTimeout(t); resolve(); }
    });
  });
}

async function liveSocket(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/live`, { headers: { origin: `http://127.0.0.1:${port}` } });
  const states = [];
  const texts = [];
  const tools = [];
  let audioBytes = 0;
  ws.binaryType = "arraybuffer";
  ws.onmessage = (e) => {
    if (typeof e.data === "string") {
      const m = JSON.parse(e.data);
      if (m.type === "state") states.push(m);
      if (m.type === "text") texts.push(m);
      if (m.type === "tool") tools.push(m);
    } else {
      audioBytes += e.data.byteLength;
    }
  };
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  // Wait for the readiness gate to open.
  for (let i = 0; i < 100; i++) {
    if (states.some((s) => s.state === "ready")) break;
    await sleep(200);
    if (i === 99) throw new Error("the live session never became ready");
  }
  return { ws, states, texts, tools, audio: () => audioBytes };
}

test("live tools: the model writes a file we read byte-for-byte, then reads it back aloud", { skip: !HAVE_KEY && "GEMINI_API_KEY not set", timeout: 120000 }, async () => {
  const port = await freePort();
  const server = startServer(port, { VOICEBOX_WORKSPACE: WORKSPACE });
  try {
    await waitForServer(server);
    const { ws, texts, tools, audio } = await liveSocket(port);

    // 1. WRITE — the model must choose write_file and the file must land.
    ws.send(JSON.stringify({ type: "text", text: "Please create a file called live-note.txt with the exact content: the live path wrote this" }));
    const target = path.join(WORKSPACE, "live-note.txt");
    // The file can land before its websocket event. Wait for BOTH within the
    // same 60s budget, including the specific successful write we assert below.
    const writeReported = () => tools.some((t) => t.calls.some((c) => c.name === "write_file" && c.ok));
    for (let i = 0; i < 300 && (!existsSync(target) || !writeReported()); i++) await sleep(200);
    assert(existsSync(target), "the live turn produced no file — the tool was not called");
    const onDisk = readFileSync(target, "utf8");
    assert.equal(onDisk, "the live path wrote this", `byte-for-byte compare failed: ${JSON.stringify(onDisk)}`);
    assert(writeReported(), "the page-visible tool event did not report the write");

    // 2. READ — the model must call read_file and SPEAK the content.
    const spokenBefore = texts.length;
    ws.send(JSON.stringify({ type: "text", text: "Read live-note.txt back to me." }));
    let said = "";
    for (let i = 0; i < 150; i++) {
      await sleep(200);
      said = texts.slice(spokenBefore).map((t) => t.text).join(" ").replace(/\s+/g, " ");
      if (/live path wrote this/i.test(said)) break;
    }
    assert(tools.some((t) => t.calls.some((c) => c.name === "read_file" && c.ok)), "the model did not call read_file");
    assert.match(said, /live path wrote this/i, `the model did not speak the file's content — heard: ${said.slice(0, 160)}`);
    assert(audio() > 0, "no audio came back — the answer was not spoken");

    ws.close();
  } finally {
    server.kill("SIGKILL");
  }
});

test("live tools: with no root declared the refusal is SPOKEN, not swallowed", { skip: !HAVE_KEY && "GEMINI_API_KEY not set", timeout: 120000 }, async () => {
  // No VOICEBOX_WORKSPACE and no POST /api/root: the executor refuses by name.
  const port = await freePort();
  const server = startServer(port);
  try {
    await waitForServer(server);
    const { ws, texts, tools } = await liveSocket(port);

    ws.send(JSON.stringify({ type: "text", text: "Create a file called anything.txt with hello" }));
    let said = "";
    for (let i = 0; i < 150; i++) {
      await sleep(200);
      said = texts.map((t) => t.text).join(" ");
      if (tools.length && /root|declared|can't|cannot|unable/i.test(said)) break;
    }
    const writeCall = tools.flatMap((t) => t.calls).find((c) => c.name === "write_file");
    assert(writeCall, "the model did not attempt the write");
    assert.equal(writeCall.ok, false, "with no root declared the write must be refused");
    assert.match(said, /root|declared|can't|cannot|unable/i, `the refusal was not spoken — heard: ${said.slice(0, 160)}`);

    ws.close();
  } finally {
    server.kill("SIGKILL");
  }
});

test.after(() => rmSync(SCRATCH, { recursive: true, force: true }));
