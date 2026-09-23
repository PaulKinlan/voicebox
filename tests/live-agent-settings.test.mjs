// tests/live-agent-settings.test.mjs — the settings handoff, DRIVEN: a person picks
// a voice and a personality; the NEXT live session must start with both, and the
// vendor must accept them (a voice name the vendor rejects kills the setup — so a
// working turn IS the evidence the choice landed).
//
//   GEMINI_API_KEY=... node --test tests/live-agent-settings.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { startServer } from "./lib/server.mjs";

const HAVE_KEY = Boolean(process.env.GEMINI_API_KEY);
const SCRATCH = mkdtempSync(path.join(os.tmpdir(), "voicebox-settings-"));
const WORKSPACE = path.join(SCRATCH, "workspace");
mkdirSync(WORKSPACE, { recursive: true });

test("a chosen voice and personality are CARRIED into the live session that starts next", { skip: !HAVE_KEY && "GEMINI_API_KEY not set", timeout: 120000 }, async () => {
  const server = await startServer({ env: { VOICEBOX_WORKSPACE: WORKSPACE, VOICEBOX_PROVIDER: "script" } });
  try {
    // Choose: Kore, dry. The payload must report them APPLIED (not pending) BEFORE any session runs.
    const put = await fetch(`${server.base}/api/agent-settings`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ voice: "Kore", personality: "dry" }),
    }).then((r) => r.json());
    assert.equal(put.applied.voice, "Kore", `the payload does not report the voice as carried: ${JSON.stringify(put.applied)}`);
    assert.equal(put.applied.instruction, "dry");
    assert.equal(put.pending.voice, null, "a pending reason survived the handoff");

    // The session that starts next: a working turn proves the vendor accepted the setup
    // (a rejected voice name or a malformed instruction field fails the handshake).
    const ws = new WebSocket(`${server.base.replace("http", "ws")}/live`, { headers: { origin: server.base } });
    const states = [];
    const tools = [];
    ws.onmessage = (e) => {
      if (typeof e.data !== "string") return;
      const m = JSON.parse(e.data);
      if (m.type === "state") states.push(m);
      if (m.type === "tool") tools.push(m);
    };
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    for (let i = 0; i < 100 && !states.some((s) => s.state === "ready"); i++) await sleep(200);
    assert(states.some((s) => s.state === "ready"), "the session never became ready — the vendor rejected the carried settings");

    ws.send(JSON.stringify({ type: "text", text: "Please create a file called settings-proof.txt with the exact content: chosen and carried" }));
    for (let i = 0; i < 300 && !tools.some((t) => t.calls.some((c) => c.name === "write_file" && c.ok)); i++) await sleep(200);
    assert(tools.some((t) => t.calls.some((c) => c.name === "write_file" && c.ok)), "the turn did not land — the session with carried settings could not act");

    // The byte-for-byte check, on disk:
    assert.equal(readFileSync(path.join(WORKSPACE, "settings-proof.txt"), "utf8"), "chosen and carried");

    // And the payload's running session says what it is using:
    const view = await fetch(`${server.base}/api/agent-settings`).then((r) => r.json());
    assert.equal(view.runningSession?.provider, "gemini", JSON.stringify(view.runningSession));
    ws.close();
  } finally {
    await server.stop();
    rmSync(SCRATCH, { recursive: true, force: true });
  }
});
