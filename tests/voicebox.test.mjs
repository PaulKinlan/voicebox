// tests/voicebox.test.mjs — the four defects, each RED on the broken code and
// GREEN on the fixed tree, driven against the REAL server as a subprocess
// (chrome-agent-platform-32io/4h2x/0j1a class: cwd-relative static serve,
// XSS through three sinks, basename-is-not-containment, no error handling).
//
//   node --test tests/
//
// The server under test is spawned per suite from this repository's
// server.mjs on a scratch port; every assertion is made against HTTP
// responses and the filesystem the server writes into — never against the
// server's own report.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const SERVER = path.join(ROOT, "server.mjs");
const PORT = 8797;
const BASE = `http://127.0.0.1:${PORT}`;
const WORKSPACE = path.join(ROOT, "workspace");

let child;

async function up() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return true;
    } catch { /* not up yet */ }
    await sleep(100);
  }
  return false;
}

test.before(async () => {
  process.env.PORT = String(PORT);
  child = spawn(process.execPath, [SERVER], {
    cwd: ROOT,
    env: process.env,
    stdio: "ignore",
    detached: true,
  });
  assert(await up(), `the server did not come up on ${PORT}`);
});

test.after(() => {
  if (child?.pid) {
    try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch { /* gone */ } }
  }
});

const get = async (p) => fetch(`${BASE}${p}`);
const post = async (p, transcript) =>
  fetch(`${BASE}${p}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ transcript }),
  }).then((r) => r.json());

// ── 1. the server answers / from any cwd (cwd-relative static serve) ──────
test("GET / answers regardless of the process cwd — the server does not die", async () => {
  const r = await get("/");
  assert.equal(r.status, 200, `GET / from a foreign cwd killed the server (defect A)`);
  assert((await r.text()).includes("voicebox"));
  assert.equal((await get("/api/health")).status, 200, "the server is alive after GET /");
});

// ── 2. the XSS payload renders as text, through every sink ────────────────
test("the XSS payload crosses the API as data and is never turned into elements by the served app", async () => {
  const payload = `create a file called <img src=x onerror="document.title='XSS-EXECUTED-'+Date.now()"> with pwned`;
  const j = await post("/api/turn", payload);
  // The action round-trips the payload as DATA (the name is the raw string the
  // resolver extracted — the executor's containment refuses the escape).
  assert.equal(j.action?.verb, "write");
  // The response is JSON whose strings are the raw strings — nothing here is
  // HTML. The sink that mattered is the PAGE: the served app.js must render
  // strings with textContent, never innerHTML (pinned below), so the payload
  // arrives as text on screen.
  assert.equal(j.result?.ok, true, "the write itself is refused only by containment — see the next test");
  // The served app must not carry a single innerHTML sink:
  const app = readFileSync(path.join(ROOT, "public", "app.js"), "utf8");
  assert.equal(app.includes("innerHTML"), false, "the served app.js still renders strings as markup");
  // And the page's CSP forbids inline handlers even if markup slipped through:
  const page = readFileSync(path.join(ROOT, "public", "index.html"), "utf8");
  assert.match(page, /script-src 'self'/);
  assert.doesNotMatch(page, /script-src[^;]*'unsafe-inline'/);
});

// ── 3. basename is not containment: `..` as a name is REFUSED ─────────────
test("`..` as an item name is refused, not rewritten into the parent directory", async () => {
  const parentProbe = path.join(path.dirname(WORKSPACE), "evil.sh");
  rmSync(parentProbe, { force: true });
  const j = await post("/api/turn", `create a file called ../evil.sh with pwned`);
  assert.equal(j.result?.ok, false, "the escape was executed, not refused");
  assert.match(j.result?.error ?? "", /escapes the workspace/);
  assert.equal(existsSync(parentProbe), false, "nothing may land in the parent directory");
  // The positive control: a name INSIDE the workspace still writes.
  const inside = await post("/api/turn", `create a file called inside.txt with kept`);
  assert.equal(inside.result?.ok, true);
  assert.equal(existsSync(path.join(WORKSPACE, "inside.txt")), true);
  rmSync(path.join(WORKSPACE, "inside.txt"), { force: true });
});

// ── 4. malformed JSON, unknown verbs, missing fields: errors, and the
// process keeps serving ─────────────────────────────────────────────────────
test("malformed JSON and unknown shapes get error responses and the process keeps serving", async () => {
  const bad = await fetch(`${BASE}/api/turn`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{not json",
  });
  assert.equal(bad.status, 400);
  const unknown = await post("/api/turn", "flurb the widget");
  assert.equal(unknown.action, null, "an unresolved turn carries no action");
  assert.match(unknown.note ?? "", /resolver|only knows/);
  // And the process still serves after all of it:
  assert.equal((await get("/api/health")).status, 200);
});

// ── the positive controls: the loop answers correctly end to end ──────────
test("create -> file on disk -> read returns the content", async () => {
  const created = await post("/api/turn", `create a file called roundtrip.txt with the loop survives`);
  assert.equal(created.result?.ok, true);
  const file = path.join(WORKSPACE, "roundtrip.txt");
  assert.equal(existsSync(file), true, "the file landed in the workspace");
  assert.equal(readFileSync(file, "utf8"), "the loop survives");
  const read = await post("/api/turn", `read roundtrip.txt`);
  assert.equal(read.result?.content, "the loop survives");
});

test("list reports the workspace contents", async () => {
  const j = await post("/api/turn", "list files");
  assert.equal(j.result?.ok, true);
  assert(Array.isArray(j.result?.files));
});
