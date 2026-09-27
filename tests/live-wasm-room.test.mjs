// tests/live-wasm-room.test.mjs — THE ROOM-LOOP PROOF for voicebox-beads-ri4k:
// a real Gemini live session whose tool catalogue carries the shelf's declarations,
// asked to use the hash tool BY NAME. Green means: the shelf tool is discoverable in
// the room loop, the model calls it, and the digest-pinned result comes back —
// through the same shared executor, refusal names and audit as every other tool.
//
//   GEMINI_API_KEY=... node --test tests/live-wasm-room.test.mjs
//
// Skipped when there is no key or no isocan shelf — a skip is not a pass; the
// green run is the driven evidence (recorded on the bead).
import { spawn } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import net from "node:net";

const ROOT = new URL("..", import.meta.url).pathname;
const HAVE_KEY = Boolean(process.env.GEMINI_API_KEY);
const REAL_SHELF = path.join(os.homedir(), ".isocan", "modules", "wasm-tools");
const SHA256_ABC = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = new (require("node:net").Server)();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => { const p = probe.address().port; probe.close(() => resolve(p)); });
  });
}

test("live wasm room: the model calls the shelf hash tool by name and speaks the digest", { skip: (!HAVE_KEY || !existsSync(REAL_SHELF)) && "needs GEMINI_API_KEY and the isocan shelf", timeout: 180000 }, async () => {
  const port = await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => { const p = probe.address().port; probe.close(() => resolve(p)); });
  });
  const SCRATCH = mkdtempSync(path.join(os.tmpdir(), "voicebox-live-wasm-"));
  const WORKSPACE = path.join(SCRATCH, "workspace");
  mkdirSync(WORKSPACE, { recursive: true });

  const server = spawn("node", ["server.mjs"], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), VOICEBOX_RESOLVER: "script", VOICEBOX_WORKSPACE: WORKSPACE, VOICEBOX_WASM_SHELF_DIR: REAL_SHELF },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  server.stderr.on("data", (d) => { stderr += String(d); });
  try {
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("server did not start")), 10000);
      server.stdout.on("data", (d) => { if (String(d).includes("voicebox on")) { clearTimeout(t); resolve(); } });
    });

    const ws = new WebSocket(`ws://127.0.0.1:${port}/live`, { headers: { origin: `http://127.0.0.1:${port}` } });
    const states = [], texts = [], tools = [];
    ws.onmessage = (e) => {
      if (typeof e.data !== "string") return;
      const m = JSON.parse(e.data);
      if (m.type === "state") states.push(m);
      if (m.type === "text") texts.push(m);
      if (m.type === "tool") tools.push(m);
    };
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    for (let i = 0; i < 100; i++) {
      if (states.some((s) => s.state === "ready")) break;
      await sleep(200);
      if (i === 99) throw new Error("the live session never became ready");
    }

    ws.send(JSON.stringify({ type: "text", text: "Use the hash tool to compute the hash of the text abc. Tell me the hash." }));
    const hashCalled = () => tools.some((t) => t.calls?.some((c) => c.name === "hash" && c.ok));
    for (let i = 0; i < 300 && !hashCalled(); i++) await sleep(200);
    assert(hashCalled(), `the model did not call the shelf hash tool — tools: ${JSON.stringify(tools.flatMap((t) => t.calls ?? []))}`);

    let said = "";
    for (let i = 0; i < 150; i++) {
      await sleep(200);
      said = texts.map((t) => t.text).join(" ").replace(/\s+/g, " ");
      if (said.toLowerCase().includes("ba7816bf")) break;
    }
    assert.match(said.toLowerCase(), /ba7816bf/, `the digest did not come back spoken — heard: ${said.slice(0, 200)}`);
    ws.close();
  } finally {
    server.kill("SIGKILL");
    if (stderr) console.error(stderr.slice(0, 800));
  }
});
