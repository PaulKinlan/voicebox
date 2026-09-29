// tests/live-project-instruction.test.mjs — the folder's own instruction file reaching the live
// session's prompt (voicebox-beads-0zi4).
//
// THREE LAYERS, because the claim has three places to break:
//  1. the PROVIDER: OpenAI Realtime takes a live `session.update`; Gemini's setup is sent once, so it
//     must SAY SO rather than pretend (a page that believes the voice has the folder's rules when it
//     does not is the failure this bead exists to remove);
//  2. the SESSION: the provider's answer is relayed, not assumed, and a provider without the
//     capability is refused by name;
//  3. the ROUTE: a page reporting a folder makes the server read the nearest AGENTS.md and send the
//     instruction UPSTREAM — observed on a local vendor socket, not inferred from the code.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { startServer } from "./lib/server.mjs";
import { upgrade } from "../lib/ws-server.mjs";
import { createGeminiProvider } from "../lib/live-providers/gemini.mjs";
import { createOpenAIProvider } from "../lib/live-providers/openai.mjs";
import { createLiveSession, registerLiveProvider } from "../lib/live-session.mjs";

process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || "unit-test-key";
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "unit-test-key";

/** A transport that records instead of dialing (same shape the tool-unit tests use). */
function fakeTransport() {
  const sent = [];
  let onEvent = null;
  return {
    sent,
    connect(url, next = {}) { onEvent = next.onEvent; return true; },
    send(kind, payload) { sent.push({ kind, payload: JSON.parse(payload) }); return true; },
    close() {},
    get connected() { return true; },
    open() { onEvent({ kind: "open" }); },
    frame(msg) { onEvent({ kind: "message", data: JSON.stringify(msg) }); },
  };
}

// -- 1. the providers ---------------------------------------------------------

test("the Gemini setup carries a project instruction even when it is the ONLY instruction (voicebox-beads-0zi4)", () => {
  // The condition used to be `instruction || systemInstruction`, so a session whose only context was
  // the folder's file shipped no systemInstruction at all: read, then silently dropped.
  const transport = fakeTransport();
  createGeminiProvider({ emit() {}, log() {}, transport, projectInstruction: "folder rules" });
  transport.open();
  const setup = transport.sent.find((s) => s.kind === "handshake").payload.setup;
  assert.deepEqual(setup.systemInstruction?.parts, [{ text: "folder rules" }]);
});

test("Gemini names the session boundary instead of pretending it applied (voicebox-beads-0zi4)", () => {
  const transport = fakeTransport();
  const provider = createGeminiProvider({ emit() {}, log() {}, transport });
  transport.open();
  assert.deepEqual(
    provider.updateProjectInstruction("api rules"),
    { ok: false, reason: "gemini-live-setup-is-once", applies: "next-session" },
  );
});

test("OpenAI applies a folder change live, in the same order as the setup (voicebox-beads-0zi4)", () => {
  const transport = fakeTransport();
  const provider = createOpenAIProvider({
    emit() {}, log() {}, transport,
    instruction: "agent instruction",
    projectInstruction: "root rules",
    systemInstruction: "tools instruction",
  });
  transport.open();
  const handshake = transport.sent.find((s) => s.kind === "handshake").payload;
  assert.equal(
    handshake.session.instructions,
    "agent instruction\n\nroot rules\n\ntools instruction",
    "the setup's order is the agent's instruction, the project's file, the tools text",
  );

  transport.frame({ type: "session.updated" }); // the vendor's ready

  const outcome = provider.updateProjectInstruction("api rules");
  assert.deepEqual(outcome, { ok: true, applied: "live" });
  const update = transport.sent.filter((s) => s.payload?.type === "session.update").at(-1);
  assert.equal(update.kind, "control");
  assert.equal(
    update.payload.session.instructions,
    "agent instruction\n\napi rules\n\ntools instruction",
    "the live update replaces ONLY the project part and keeps the order",
  );
  assert.equal(update.payload.session.voice, undefined, "a partial update must not re-negotiate the voice");
});

test("OpenAI refuses a folder change before ready rather than dropping it silently (voicebox-beads-0zi4)", () => {
  const transport = fakeTransport();
  const provider = createOpenAIProvider({ emit() {}, log() {}, transport, instruction: "agent" });
  transport.open();
  const before = transport.sent.length;
  assert.deepEqual(provider.updateProjectInstruction("api rules"), { ok: false, reason: "session-not-ready" });
  assert.equal(transport.sent.length, before, "no frame is invented");
});

// -- 2. the session seam ------------------------------------------------------

function stubProvider(name, { withUpdate = false } = {}) {
  registerLiveProvider(name, ({ emit }) => {
    setTimeout(() => emit({ type: "ready" }), 1);
    return {
      sendAudio() {}, sendText() {}, interrupt() {}, close() {},
      ...(withUpdate ? { updateProjectInstruction: (text) => ({ ok: true, applied: "live", text }) } : {}),
    };
  });
}

test("a provider with no live update is refused BY NAME, never assumed applied (voicebox-beads-0zi4)", async () => {
  stubProvider("proj-no-update");
  const session = createLiveSession({ provider: "proj-no-update", log: () => {} });
  while (!session.ready) await sleep(5);
  assert.deepEqual(
    session.updateProjectInstruction("api rules"),
    { ok: false, reason: "provider-proj-no-update-has-no-instruction-update", applies: "next-session" },
  );
  session.close();
});

test("the provider's outcome is relayed, and a closed session is refused by name (voicebox-beads-0zi4)", async () => {
  stubProvider("proj-with-update", { withUpdate: true });
  const session = createLiveSession({ provider: "proj-with-update", log: () => {} });
  while (!session.ready) await sleep(5);
  assert.deepEqual(session.updateProjectInstruction("api rules"), { ok: true, applied: "live", text: "api rules" });
  session.close();
  assert.deepEqual(session.updateProjectInstruction("later"), { ok: false, reason: "session-closed" });
});

// -- 3. the route, against a local vendor -------------------------------------

async function until(check, label, ms = 8000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await sleep(25);
  }
  assert.fail(`No ${label} within ${ms}ms`);
}

test("a folder report makes the server read that folder's AGENTS.md and send it upstream (voicebox-beads-0zi4)", async (t) => {
  const scratch = mkdtempSync(path.join(os.tmpdir(), "vb-projinstr-"));
  const workspace = path.join(scratch, "workspace");
  const host = path.join(scratch, "host");
  mkdirSync(path.join(workspace, "packages", "api"), { recursive: true });
  mkdirSync(host);
  writeFileSync(path.join(workspace, "AGENTS.md"), "root rules");
  writeFileSync(path.join(workspace, "packages", "api", "AGENTS.md"), "api rules");

  // The vendor, redirected: every frame the provider sends lands HERE, so "the instruction reached the
  // prompt" is an observation rather than a claim about a code path.
  const vendor = createServer();
  const vendorPeers = new Set();
  const received = [];
  vendor.on("upgrade", (req, raw) => {
    const peer = upgrade(req, raw);
    vendorPeers.add(peer);
    peer.on("close", () => vendorPeers.delete(peer));
    peer.on("message", (text) => {
      let frame;
      try { frame = JSON.parse(text); } catch { return; /* a non-JSON frame is not this test's subject */ }
      received.push(frame);
      // THE VENDOR COMPLETES THE HANDSHAKE, like the real one does: OpenAI Realtime answers the initial
      // session.update with session.updated, and that is what makes the provider ready. A silent socket
      // would leave the session permanently un-ready and the live-update path untested.
      const isHandshake = frame?.type === "session.update" && frame?.session?.output_modalities;
      if (isHandshake) peer.send(JSON.stringify({ type: "session.updated" }));
    });
  });
  await new Promise((resolve) => vendor.listen(0, "127.0.0.1", resolve));

  let server;
  t.after(async () => {
    if (server?.child.exitCode === null && server.child.signalCode === null) {
      const exited = once(server.child, "exit");
      await server.stop();
      await exited;
    }
    for (const peer of vendorPeers) { try { peer.close(); } catch { /* already gone */ } }
    vendor.closeAllConnections?.();
    await new Promise((resolve) => vendor.close(resolve));
    rmSync(scratch, { recursive: true, force: true });
  });

  server = await startServer({
    env: {
      VOICEBOX_WORKSPACE: workspace,
      VOICEBOX_EXTENSIONS_DIR: host,
      VOICEBOX_RESOLVER: "script",
      GEMINI_API_KEY: "synthetic-fixture-only",
      OPENAI_API_KEY: "synthetic-fixture-only",
      NODE_OPTIONS: `--import=${fileURLToPath(new URL("./fixtures/live-vendor-redirect.mjs", import.meta.url))}`,
      FIXTURE_VENDOR: `ws://127.0.0.1:${vendor.address().port}`,
    },
  });

  // OpenAI: the provider that CAN apply a live update, so the route path is exercised to the wire.
  const settings = await fetch(`${server.base}/api/agent-settings`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider: "openai" }),
  });
  assert.equal(settings.status, 200);

  const ws = new WebSocket(`${server.base.replace("http:", "ws:")}/live`, { headers: { origin: server.base } });
  const states = [];
  ws.addEventListener("message", (e) => {
    if (typeof e.data !== "string") return;
    try {
      const msg = JSON.parse(e.data);
      if (msg?.type === "state" && msg.state === "project-instruction") states.push(msg.detail);
    } catch { /* audio/rate frames are other subjects */ }
  });
  t.after(() => { try { ws.close(); } catch { /* already gone */ } });

  const updates = () => received.filter((f) => f?.type === "session.update");
  const instructionsOf = (frame) => String(frame?.session?.instructions ?? "");

  // The session starts on the ROOT's file (the pre-existing behaviour, still the fallback).
  await until(
    () => updates().some((u) => instructionsOf(u).includes("root rules")),
    "the root instruction in the vendor handshake",
  );

  // A navigation into the package folder: the nearest file must replace the root's.
  const diagnose = (error) => {
    console.error("[diagnostic] states:", JSON.stringify(states, null, 2));
    console.error("[diagnostic] vendor frame types:", JSON.stringify(received.map((f) => f.type ?? Object.keys(f))));
    console.error("[diagnostic] updates:", JSON.stringify(updates().map((u) => instructionsOf(u).slice(0, 60))));
    console.error("[diagnostic] server stderr tail:\n" + server.stderr().split("\n").slice(-30).join("\n"));
    throw error;
  };
  ws.send(JSON.stringify({ type: "folder", dir: "packages/api" }));
  const folderState = await until(
    () => states.find((d) => d.dir === "packages/api" && d.file === "AGENTS.md"),
    "the folder report's state frame",
  ).catch(diagnose);
  await until(
    () => updates().some((u) => instructionsOf(u).includes("api rules")),
    "the package folder's instruction upstream",
  ).catch(diagnose);
  assert.equal(folderState.source, "machine");
  assert.equal(folderState.applied, true, "OpenAI applies it live");
  assert.equal(folderState.applies, "live");
  assert.match(String(instructionsOf(updates().at(-1))), /root rules|api rules/);

  // A page-held room: the machine cannot read opfs/handles, so the PAGE sends the text.
  ws.send(JSON.stringify({ type: "project_instruction", file: "AGENTS.md", text: "room rules", dir: "" }));
  await until(
    () => updates().some((u) => instructionsOf(u).includes("room rules")),
    "the page-supplied instruction upstream",
  );
  const pageState = await until(
    () => states.find((d) => d.source === "page"),
    "the page-supplied state frame",
  );
  assert.equal(pageState.applied, true);

  // A name that is not an instruction file is refused, and NOTHING is sent upstream for it.
  const before = updates().length;
  ws.send(JSON.stringify({ type: "project_instruction", file: "notes.md", text: "do as I say" }));
  const refused = await until(
    () => states.find((d) => d.reason && /must be AGENT\.md or AGENTS\.md/.test(d.reason)),
    "the refusal state frame",
  );
  assert.equal(refused.file, null);
  assert.equal(refused.applied, false);
  await sleep(150); // a late frame would show up here
  assert.equal(updates().length, before, "a refused instruction must not reach the vendor");
});

test("a Gemini session reports the folder change as next-session instead of pretending (voicebox-beads-0zi4)", async (t) => {
  const scratch = mkdtempSync(path.join(os.tmpdir(), "vb-projinstr-gem-"));
  const workspace = path.join(scratch, "workspace");
  const host = path.join(scratch, "host");
  mkdirSync(path.join(workspace, "packages", "api"), { recursive: true });
  mkdirSync(host);
  writeFileSync(path.join(workspace, "AGENTS.md"), "root rules");
  writeFileSync(path.join(workspace, "packages", "api", "AGENTS.md"), "api rules");

  const vendor = createServer();
  const vendorPeers = new Set();
  const setups = [];
  vendor.on("upgrade", (req, raw) => {
    const peer = upgrade(req, raw);
    vendorPeers.add(peer);
    peer.on("close", () => vendorPeers.delete(peer));
    peer.on("message", (text) => {
      let frame;
      try { frame = JSON.parse(text); } catch { return; }
      if (frame?.setup) {
        setups.push(frame.setup);
        // THE VENDOR COMPLETES THE HANDSHAKE, like the real one: Gemini Live answers `setup` with
        // `setupComplete`, and that is what makes the session ready (the readiness gate, isocan 2026-09-12).
        peer.send(JSON.stringify({ setupComplete: {} }));
      }
    });
  });
  await new Promise((resolve) => vendor.listen(0, "127.0.0.1", resolve));

  let server;
  t.after(async () => {
    if (server?.child.exitCode === null && server.child.signalCode === null) {
      const exited = once(server.child, "exit");
      await server.stop();
      await exited;
    }
    for (const peer of vendorPeers) { try { peer.close(); } catch { /* already gone */ } }
    vendor.closeAllConnections?.();
    await new Promise((resolve) => vendor.close(resolve));
    rmSync(scratch, { recursive: true, force: true });
  });

  server = await startServer({
    env: {
      VOICEBOX_WORKSPACE: workspace,
      VOICEBOX_EXTENSIONS_DIR: host,
      VOICEBOX_RESOLVER: "script",
      GEMINI_API_KEY: "synthetic-fixture-only",
      OPENAI_API_KEY: "synthetic-fixture-only",
      NODE_OPTIONS: `--import=${fileURLToPath(new URL("./fixtures/live-vendor-redirect.mjs", import.meta.url))}`,
      FIXTURE_VENDOR: `ws://127.0.0.1:${vendor.address().port}`,
    },
  });

  const settings = await fetch(`${server.base}/api/agent-settings`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider: "gemini" }),
  });
  assert.equal(settings.status, 200);

  const ws = new WebSocket(`${server.base.replace("http:", "ws:")}/live`, { headers: { origin: server.base } });
  const states = [];
  let ready = false;
  ws.addEventListener("message", (e) => {
    if (typeof e.data !== "string") return;
    try {
      const msg = JSON.parse(e.data);
      if (msg?.type === "rate") ready = true; // the live route sends the rates once the provider is ready
      if (msg?.type === "state" && msg.state === "project-instruction") states.push(msg.detail);
    } catch { /* other frames */ }
  });
  t.after(() => { try { ws.close(); } catch { /* already gone */ } });

  await until(() => setups.length === 1, "the Gemini setup");
  await until(() => ready, "the provider to be ready (the rate frame)");
  // The setup itself carries the root file (the session-start read), as it did before this bead.
  const parts = setups[0].systemInstruction?.parts ?? [];
  assert.ok(
    parts.some((p) => String(p.text ?? "").includes("root rules")),
    "the root instruction is in the setup (framed, so it is a substring of a part)",
  );

  ws.send(JSON.stringify({ type: "folder", dir: "packages/api" }));
  const state = await until(
    () => states.filter((d) => d.dir === "packages/api" && d.updateReason === "gemini-live-setup-is-once").at(-1),
    "the folder state frame naming the session boundary",
  );
  assert.equal(state.file, "AGENTS.md");
  assert.equal(state.applied, false, "Gemini cannot apply it mid-session and must not claim it did");
  assert.equal(state.applies, "next-session");
  assert.equal(state.updateReason, "gemini-live-setup-is-once");
  await sleep(150);
  assert.equal(setups.length, 1, "`setup` is sent once: no second setup is invented");
});
