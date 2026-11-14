// A key-free /live provider emits real tool calls. Its prompt is test-controlled; the host executor is not mocked.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startServer } from "./lib/server.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function fixture(t, loopbackAuth) {
  const scratch = mkdtempSync(path.join(os.tmpdir(), "voicebox-live-exec-auth-"));
  const workspace = path.join(scratch, "workspace");
  mkdirSync(workspace);
  // Node's --import preloads this fake provider into the real server process. Production code,
  // provider selection, /live dispatch and the machine executor are otherwise unchanged.
  const preload = path.join(scratch, "provider.mjs");
  const liveSessionUrl = pathToFileURL(path.join(root, "lib/live-session.mjs")).href;
  writeFileSync(preload, `import { registerLiveProvider } from ${JSON.stringify(liveSessionUrl)};
registerLiveProvider("gemini", ({ emit }) => ({
  start() { emit({ type: "transport-open" }); emit({ type: "ready" }); },
  sendText(text) {
    if (text.startsWith("recover:")) {
      emit({ type: "output-text", kind: "input-transcript", text: text.slice(8) });
      emit({ type: "output-text", kind: "model", text: "A system error occurred." });
      emit({ type: "turn-complete", interactionStatus: "IDLE" });
      return;
    }
    const name = text === "list" ? "list_files" : "run_command";
    emit({ type: "tool-call", calls: [{ id: String(Date.now()), name,
      args: name === "run_command" ? { command: text } : { dir: "." } }] });
  },
  sendToolResponse() { return true; },
  close() { emit({ type: "closed", code: 1000, reason: "test provider closed" }); },
}), { inputRate: 16000 });
`);
  let server;
  t.after(async () => {
    if (server) await server.stop();
    rmSync(scratch, { recursive: true, force: true });
  });
  server = await startServer({ cwd: scratch, env: {
    VOICEBOX_WORKSPACE: workspace,
    VOICEBOX_LOOPBACK_AUTH: loopbackAuth ? "1" : "0",
    NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
  } });
  return { server, workspace };
}

async function socketFor(t, base, headers) {
  const socket = new WebSocket(`${base.replace(/^http/, "ws")}/live`, { headers });
  t.after(() => socket.close());
  const frames = [];
  const waiting = new Set();
  socket.onmessage = (event) => {
    let frame;
    try { frame = JSON.parse(event.data); } catch { return; }
    frames.push(frame);
    for (const waiter of waiting) if (waiter.predicate(frame)) waiter.resolve(frame);
  };
  const opened = new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let openTimer;
  try {
    await Promise.race([opened, new Promise((_, reject) => {
      openTimer = setTimeout(() => reject(new Error("/live upgrade timeout")), 4000);
    })]);
  } finally { clearTimeout(openTimer); }
  const frame = (predicate, after = 0) => {
    const prior = frames.slice(after).find(predicate);
    if (prior) return Promise.resolve(prior);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve(value) { clearTimeout(timer); waiting.delete(waiter); resolve(value); } };
      const timer = setTimeout(() => { waiting.delete(waiter); reject(new Error(`missing /live frame: ${JSON.stringify(frames)}`)); }, 4000);
      waiting.add(waiter);
    });
  };
  return { socket, frame, frames };
}

async function runTool(peer, command) {
  const result = peer.frame((f) => f.type === "tool" && f.calls?.some((c) => c.name === (command === "list" ? "list_files" : "run_command")), peer.frames.length);
  peer.socket.send(JSON.stringify({ type: "text", text: command }));
  return (await result).calls[0];
}

test("gate-off Origin-only /live cannot execute; explicit room token and paired bearer can", async (t) => {
  const { server, workspace } = await fixture(t, false);
  const room = /<meta name="voicebox-session-token" content="([0-9a-f]+)"/.exec(await fetch(server.base).then((r) => r.text()))?.[1];
  assert.ok(room);
  const attacker = await socketFor(t, server.base, { origin: server.base });
  await attacker.frame((f) => f.type === "state" && f.state === "ready");
  const marker = path.join(workspace, "must-not-exist.txt");
  const forbidden = await runTool(attacker, "touch must-not-exist.txt");
  assert.equal(forbidden.ok, false);
  assert.equal(forbidden.refused, "room-session-required");
  assert.equal(existsSync(marker), false, "Origin-only claim cannot run a host command");
  const recovery = await socketFor(t, server.base, { origin: server.base });
  await recovery.frame((f) => f.type === "state" && f.state === "ready");
  const recovered = recovery.frame((f) => f.type === "tool" && f.recovered);
  recovery.socket.send(JSON.stringify({ type: "text", text: "recover:run command touch recovered-without-auth.txt" }));
  assert.equal((await recovered).calls[0].ok, false, "the fallback must not bypass the live exec gate");
  assert.equal(existsSync(path.join(workspace, "recovered-without-auth.txt")), false);
  const benign = await runTool(attacker, "list");
  assert.equal(benign.ok, true, "non-shell live tools still work");

  attacker.socket.send(JSON.stringify({ type: "session_auth", sessionToken: "wrong" }));
  assert.deepEqual(await attacker.frame((f) => f.type === "session_auth"), { type: "session_auth", ok: false });
  const stillForbidden = await runTool(attacker, "touch must-not-exist.txt");
  assert.equal(stillForbidden.refused, "room-session-required");
  assert.equal(existsSync(marker), false);

  attacker.socket.send(JSON.stringify({ type: "session_auth", sessionToken: room }));
  assert.deepEqual(await attacker.frame((f) => f.type === "session_auth" && f.ok), { type: "session_auth", ok: true });
  const authorized = await runTool(attacker, "touch room-authorized.txt");
  assert.equal(authorized.ok, true);
  assert.equal(existsSync(path.join(workspace, "room-authorized.txt")), true);

  const pair = await fetch(`${server.base}/api/pair`, {
    method: "POST", headers: { "content-type": "application/json", "x-voicebox-host-token": server.hostToken },
    body: JSON.stringify({ envKey: "test-peer" }),
  }).then((r) => r.json());
  assert.ok(pair.bearer);
  const paired = await socketFor(t, server.base, {});
  paired.socket.send(JSON.stringify({ type: "hello", bearer: pair.bearer }));
  await paired.frame((f) => f.type === "state" && f.state === "ready");
  const pairedResult = await runTool(paired, "touch paired-authorized.txt");
  assert.equal(pairedResult.ok, true);
  assert.equal(existsSync(path.join(workspace, "paired-authorized.txt")), true);
});

test("bootstrap-cookie /live session can run a command without a room-token frame", async (t) => {
  const { server, workspace } = await fixture(t, true);
  const ticket = await fetch(`${server.base}/api/bootstrap`, {
    method: "POST", headers: { "x-voicebox-host-token": server.hostToken },
  }).then((r) => r.json());
  assert.match(ticket.url, /\?bootstrap=[0-9a-f]{64}$/);
  const redemption = await fetch(ticket.url, { redirect: "manual" });
  assert.equal(redemption.status, 303);
  const cookie = redemption.headers.get("set-cookie")?.split(";")[0];
  assert.ok(cookie);
  const peer = await socketFor(t, server.base, { origin: server.base, cookie });
  await peer.frame((f) => f.type === "state" && f.state === "ready");
  const result = await runTool(peer, "touch cookie-authorized.txt");
  assert.equal(result.ok, true);
  assert.equal(existsSync(path.join(workspace, "cookie-authorized.txt")), true);
});
