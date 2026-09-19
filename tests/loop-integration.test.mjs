// tests/loop-integration.test.mjs — N18's anti-drift guarantee, driven.
//
// The claim under test: the browser page and node run the SAME loop module
// against the running server and get the SAME decisions for the same inputs —
// and the page cannot silently grow its own copy of the cycle again.
//
//   node --test tests/loop-integration.test.mjs
//
// The server under test is spawned from this repository's server.mjs on a
// scratch port with the deterministic script provider, so "same decisions"
// is an exact comparison, not a statistical one. The model-backed provider
// is verified live (see the branch's report), never in CI — no network here.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { createLoop } from "../lib/loop.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const SERVER = path.join(ROOT, "server.mjs");
const PORT = 8798;
const BASE = `http://127.0.0.1:${PORT}`;
const WORKSPACE = path.join(ROOT, "workspace");

let child;

test.before(async () => {
  child = spawn(process.execPath, [SERVER], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), VOICEBOX_PROVIDER: "script" },
    stdio: "ignore",
    detached: true,
  });
  for (let i = 0; i < 40; i++) {
    try {
      if ((await fetch(`${BASE}/api/health`)).ok) return;
    } catch { /* not up yet */ }
    await sleep(100);
  }
  throw new Error(`the server did not come up on ${PORT}`);
});

test.after(() => {
  if (child?.pid) {
    try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch { /* gone */ } }
  }
});

const post = async (p, payload) =>
  fetch(`${BASE}${p}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  }).then((r) => r.json());

// A loop driven over HTTP seams — exactly what the page does in fused.js,
// here in node so the two can be compared.
function remoteLoop() {
  const loop = createLoop({
    execute: (action) => post("/api/execute", action).then((r) => r.result),
  });
  loop.registerResolver("remote", async (transcript) => {
    const r = await post("/api/resolve", { transcript });
    return r.action ?? { unresolved: r.note ?? "the server did not resolve the turn" };
  });
  return loop;
}

// ── 1. the page's cycle IS the library: served byte-for-byte ──────────────
test("GET /lib/loop.mjs serves the library byte-for-byte — the page has no copy to drift", async () => {
  const r = await fetch(`${BASE}/lib/loop.mjs`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type") ?? "", /javascript/);
  const served = Buffer.from(await r.arrayBuffer());
  const onDisk = readFileSync(path.join(ROOT, "lib", "loop.mjs"));
  assert(served.equals(onDisk), "the served module and lib/loop.mjs differ — the page would run a different cycle");

  // And the page's script imports that module rather than re-implementing the
  // cycle. If someone re-inlines turn → decide → dispatch into the page, this
  // is the assertion that fails.
  const page = readFileSync(path.join(ROOT, "public", "fused.js"), "utf8");
  assert.match(page, /import\s*{\s*createLoop\s*}\s*from\s*"\/lib\/loop\.mjs"/, "fused.js no longer drives the shared loop");
  assert.match(page, /loop\.runTurn\(/, "fused.js no longer runs turns through the loop");
});

test("/lib/ refuses traversal and non-modules", async () => {
  for (const p of ["/lib/../server.mjs", "/lib/%2e%2e/server.mjs", "/lib/loop.js", "/lib/nope.mjs"]) {
    const r = await fetch(`${BASE}${p}`);
    assert.equal(r.status, 404, `${p} must not be served`);
  }
});

// ── 2. same module, two placements, same decisions ─────────────────────────
test("node driving the loop over HTTP seams gets the same decision as the server's own cycle", async () => {
  const transcript = "create a file called parity.txt with one cycle, two placements";
  const direct = await post("/api/turn", { transcript });           // the server's in-process loop
  const remote = await remoteLoop().runTurn(transcript, { provider: "remote" }); // node's loop, HTTP seams

  assert.deepEqual(remote.action, direct.action, "the decisions differ between placements");
  assert.equal(remote.action?.verb, "write");
  assert.equal(remote.result?.ok, true);
  // The file the remote-driven cycle wrote is on disk, byte for byte:
  const file = path.join(WORKSPACE, "parity.txt");
  assert.equal(readFileSync(file, "utf8"), "one cycle, two placements");
  rmSync(file, { force: true });

  // And the unresolved path agrees too:
  const miss = "flurb the widget";
  const directMiss = await post("/api/turn", { transcript: miss });
  const remoteMiss = await remoteLoop().runTurn(miss, { provider: "remote" });
  assert.equal(remoteMiss.action, null);
  assert.equal(remoteMiss.note, directMiss.note, "the unresolved messages differ between placements");
});

// ── 3. the dispatch seam keeps the executor as the guard ──────────────────
test("/api/execute applies the same containment as a server-resolved turn", async () => {
  const escape = await post("/api/execute", { verb: "write", name: "../evil.sh", content: "pwned" });
  assert.equal(escape.result.ok, false);
  assert.match(escape.result.error, /escapes the workspace/);
  const badVerb = await post("/api/execute", { verb: "delete", name: "x" });
  assert.equal(badVerb.result.ok, false);
  const malformed = await fetch(`${BASE}/api/execute`, { method: "POST", body: "{nope" });
  assert.equal(malformed.status, 400);
});

// ── 4. the page itself drives the loop: composer → file on disk ───────────
test("the browser page runs a turn through lib/loop.mjs and the file lands byte-for-byte", async () => {
  const cdpPort = 19997;
  const chrome = spawn("/usr/bin/chromium", [
    "--headless=new", "--no-sandbox", "--disable-gpu",
    `--remote-debugging-port=${cdpPort}`, "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe"] });

  const file = path.join(WORKSPACE, "page-loop.txt");
  rmSync(file, { force: true });
  try {
    let wsUrl = "";
    for (let i = 0; i < 40; i++) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json();
        const page = list.find((p) => p.type === "page");
        if (page?.webSocketDebuggerUrl) { wsUrl = page.webSocketDebuggerUrl; break; }
      } catch {}
      await sleep(100);
    }
    assert(wsUrl, "could not find page target");

    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    let id = 1;
    const pending = new Map();
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.id && pending.has(msg.id)) {
        const { resolve } = pending.get(msg.id);
        pending.delete(msg.id);
        resolve(msg.result);
      }
    };
    const call = (method, params = {}) => new Promise((resolve) => {
      const reqId = id++;
      pending.set(reqId, { resolve });
      ws.send(JSON.stringify({ id: reqId, method, params }));
    });
    const evaluate = async (expression) => {
      const r = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(`page evaluation failed: ${JSON.stringify(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)}`);
      return r.result?.value;
    };

    await call("Page.enable");
    await call("Page.navigate", { url: BASE });
    await sleep(1200);

    // The page's module graph really did load the shared library:
    const loopLoaded = await evaluate(`import("/lib/loop.mjs").then((m) => typeof m.createLoop === "function")`);
    assert.equal(loopLoaded, true, "the page could not import the shared loop module");

    // Drive the composer, exactly as a person would:
    await evaluate(`
      const input = document.getElementById("utterance");
      input.value = "create a file called page-loop.txt with driven by the page's own loop";
      document.getElementById("text-form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    `);

    let content = null;
    for (let i = 0; i < 30; i++) {
      await sleep(200);
      if (existsSync(file)) { content = readFileSync(file, "utf8"); break; }
    }
    assert.equal(content, "driven by the page's own loop", "the page-driven turn did not land byte-for-byte");

    // And the page reported the outcome of a real cycle, not an error:
    const report = await evaluate(`document.getElementById("turn-report")?.textContent ?? ""`);
    assert.match(report, /wrote page-loop\.txt/, `the page did not report the write: ${report}`);

    ws.close();
  } finally {
    chrome.kill("SIGKILL");
    rmSync(file, { force: true });
  }
});
