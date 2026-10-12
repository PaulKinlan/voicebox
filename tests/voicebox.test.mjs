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
import { startServer } from "./lib/server.mjs";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { findBrowserBinary } from "../lib/browser-binaries.mjs";
import { tmpdir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { trackBrowserProcessGroup } from "./lib/cdp.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const SERVER = path.join(ROOT, "server.mjs");
// A SCRATCH root, declared to the server rather than assumed: the loop has no default root any more,
// and a suite that wrote into the repository would be an instrument changing the thing it measures.
const SCRATCH = mkdtempSync(path.join(os.tmpdir(), "voicebox-suite-"));
const WORKSPACE = path.join(SCRATCH, "workspace");
mkdirSync(WORKSPACE, { recursive: true });

let server;
let BASE;

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
  // VOICEBOX_WORKSPACE is a DECLARATION of the active root (an operator's, at boot) — it is not a
  // default the server falls back to. With it unset the loop refuses every act by name.
  process.env.VOICEBOX_WORKSPACE = WORKSPACE;
  server = await startServer({
    cwd: ROOT,
    env: { VOICEBOX_WORKSPACE: WORKSPACE },
  });
  BASE = server.base;
});

test.after(async () => {
  await server?.stop();
});

const get = async (p) => fetch(`${BASE}${p}`);
const post = async (p, transcript) =>
  fetch(`${BASE}${p}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ transcript }),
  }).then((r) => r.json());

// Parse the served CSP, not raw HTML prose (voicebox-beads-8tk2). The server
// currently supplies a meta policy, but a future response header is checked too.
function assertInlineScriptsBlocked(headers, html) {
  const policies = [];
  const header = headers.get("content-security-policy");
  if (header !== null) policies.push(header);
  const withoutComments = html.replace(/<!--[\s\S]*?-->/g, "");
  assert.equal(withoutComments.includes("<!--"), false, "unterminated HTML comment before CSP");
  for (const [tag] of withoutComments.matchAll(/<meta\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi)) {
    const attrs = new Map();
    const text = tag.slice(5, -1);
    const attr = /\s+([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/gy;
    let offset = 0;
    while (offset < text.length && !/^\s*\/?\s*$/.test(text.slice(offset))) {
      attr.lastIndex = offset;
      const match = attr.exec(text);
      assert.ok(match, `malformed CSP meta tag: ${tag}`);
      const name = match[1].toLowerCase();
      assert.equal(attrs.has(name), false, `duplicate meta attribute: ${name}`);
      attrs.set(name, match[2] ?? match[3] ?? match[4] ?? null);
      offset = attr.lastIndex;
    }
    if (attrs.get("http-equiv")?.toLowerCase() === "content-security-policy") {
      assert.ok(attrs.get("content"), "CSP meta has no content attribute");
      policies.push(attrs.get("content"));
    }
  }
  assert.ok(policies.length, "the served page has no CSP header or meta policy");
  const inlinePermissions = [];
  for (const policy of policies) {
    const directives = new Map();
    for (const segment of policy.split(";")) {
      const tokens = segment.trim().split(/\s+/).filter(Boolean);
      if (!tokens.length) continue;
      const name = tokens.shift().toLowerCase();
      assert.match(name, /^[a-z][a-z0-9-]*$/, `malformed CSP directive: ${name}`);
      assert.equal(directives.has(name), false, `duplicate CSP directive: ${name}`);
      directives.set(name, tokens);
    }
    const script = directives.get("script-src");
    assert.ok(script?.length, "CSP must explicitly declare a nonempty script-src");
    for (const name of ["script-src", "script-src-elem", "script-src-attr"]) {
      const sources = directives.get(name);
      if (!sources) continue;
      assert.ok(sources.length, `${name} must not be empty`);
      for (const source of sources) {
        assert.match(source, /^(?:'[^']+'|[^'"\s]+)$/, `malformed ${name} source: ${source}`);
      }
    }
    const permitsInline = (sources) => sources.some((source) =>
      /^'(?:unsafe-inline|unsafe-hashes|nonce-|sha(?:256|384|512)-)/i.test(source));
    inlinePermissions.push({
      scripts: permitsInline(directives.get("script-src-elem") ?? script),
      handlers: permitsInline(directives.get("script-src-attr") ?? script),
    });
  }
  // Header and meta policies are enforced together: a stricter policy still
  // blocks inline code even when another policy would have allowed it.
  assert.equal(inlinePermissions.every((policy) => policy.scripts), false,
    "effective CSP permits inline scripts");
  assert.equal(inlinePermissions.every((policy) => policy.handlers), false,
    "effective CSP permits inline handlers");
}

// ── 1. the server answers / from any cwd (cwd-relative static serve) ──────
test("GET / answers regardless of the process cwd — the server does not die", async () => {
  const r = await get("/");
  assert.equal(r.status, 200, `GET / from a foreign cwd killed the server (defect A)`);
  assert((await r.text()).includes("voicebox"));
  assert.equal((await get("/api/health")).status, 200, "the server is alive after GET /");
});

test("HEAD /api/health answers 200 exactly like GET — a liveness probe must not 500 (voicebox-beads-sdxn)", async () => {
  const r = await fetch(`${BASE}/api/health`, { method: "HEAD" });
  assert.equal(r.status, 200, "a HEAD fell past the route table; the dev proxy reports that as 500");
  assert.match(r.headers.get("content-type") ?? "", /application\/json/);
  assert.equal(await r.text(), "", "a HEAD carries no body");
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
  // The served app must not carry a single innerHTML sink. This reads EVERY
  // script the page declares rather than one named file: app.js was deleted on
  // 2026-09-20 (no page loaded it) and a guard that dies with the file it
  // watched is how a security property is quietly removed. Whatever the page
  // loads is what this checks.
  const servedPage = readFileSync(path.join(ROOT, "public", "index.html"), "utf8");
  const scripts = [...servedPage.matchAll(/<script[^>]*src="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(scripts.length > 0, "the page declares no scripts, so this guard would be vacuous");
  for (const src of scripts) {
    const onDisk = path.join(ROOT, "public", src.replace(/^\//, ""));
    if (!existsSync(onDisk)) continue; // a module served from elsewhere (the environment page)
    const body = readFileSync(onDisk, "utf8");
    assert.equal(body.includes("innerHTML"), false, `${src} still renders strings as markup`);
  }
  // And the ACTUALLY SERVED policy forbids inline handlers even if markup slipped through.
  const served = await get("/");
  assert.equal(served.status, 200);
  assertInlineScriptsBlocked(served.headers, await served.text());
});

test("served CSP ignores comments but refuses reordered inline permission", async () => {
  const served = await get("/");
  assert.equal(served.status, 200);
  const html = await served.text();
  const commented = html.replace("</head>", "<!-- script-src 'self' says why 'unsafe-inline' is forbidden -->\n</head>");
  assert.notEqual(commented, html, "negative control must inject the prose into the served page");
  assertInlineScriptsBlocked(served.headers, commented);

  const permissive = html.replace("script-src 'self';", "script-src 'unsafe-inline' 'self';");
  assert.notEqual(permissive, html, "positive mutant must alter the actual meta policy");
  assert.throws(() => assertInlineScriptsBlocked(served.headers, permissive),
    /effective CSP permits inline scripts/);
  // A header-only policy is also a live enforcement path; the source order must not matter.
  assert.throws(() => assertInlineScriptsBlocked(new Headers({
    "content-security-policy": "default-src 'self'; script-src 'self' 'unsafe-inline'",
  }), "<html></html>"), /effective CSP permits inline scripts/);
  assert.throws(() => assertInlineScriptsBlocked(new Headers({
    "content-security-policy": "script-src 'self'; script-src-attr 'unsafe-inline'",
  }), "<html></html>"), /effective CSP permits inline handlers/);
  assert.throws(() => assertInlineScriptsBlocked(new Headers({
    "content-security-policy": "script-src 'self' 'nonce-abc123'",
  }), "<html></html>"), /effective CSP permits inline scripts/);
  // A permissive meta does not override a restrictive response header.
  assertInlineScriptsBlocked(new Headers({ "content-security-policy": "script-src 'self'" }), permissive);
  assertInlineScriptsBlocked(new Headers(),
    "<meta content=\"script-src 'self'\" http-equiv=\"Content-Security-Policy\">");
  assert.throws(() => assertInlineScriptsBlocked(new Headers(), "<html></html>"), /no CSP/);
  assert.throws(() => assertInlineScriptsBlocked(new Headers(),
    "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'self'\">"), /script-src/);
  assert.throws(() => assertInlineScriptsBlocked(new Headers(),
    "<meta http-equiv=\"Content-Security-Policy\" content=\"script-src 'self' 'unsafe-inline\">"), /malformed script-src source/);
});

// ── 3. basename is not containment: `..` as a name is REFUSED ─────────────
test("`..` as an item name is refused, not rewritten into the parent directory", async () => {
  const parentProbe = path.join(path.dirname(WORKSPACE), "evil.sh");
  rmSync(parentProbe, { force: true });
  const j = await post("/api/turn", `create a file called ../evil.sh with pwned`);
  assert.equal(j.result?.ok, false, "the escape was executed, not refused");
  // The message names the ACTIVE PROJECT ROOT rather than "the workspace", because the loop now
  // writes into whichever root the environment declared (core/root.ts) and a hard-coded word would
  // become a lie the first time somebody declared a different folder.
  assert.match(j.result?.error ?? "", /escapes the active project root/);
  assert.equal(j.result?.refused, "outside-root", "the refusal does not name the rule");
  assert.match(j.result?.why ?? "", /'\.\.' segment/, "the refusal does not use the mechanism's own words");
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

// ── the loud-miss rule: a static miss is a 404, never a 200 of the wrong type
// (2026-09-19: vite's SPA fallback served index.html for /fonts/inter-latin.woff2
// with a 200; the font parser choked on "<!do" and nothing reported wrong.)
test("a missing asset is a loud 404 from the server, never a 200 of the wrong type", async () => {
  // /fonts/inter-latin.woff2 and /icon.svg EXIST now (see the class guard) —
  // the paths pinned here are the permanently-missing ones.
  for (const p of ["/no-such-thing.js", "/a/deep/link", "/missing.woff2"]) {
    const r = await get(p);
    assert.equal(r.status, 404, `${p} must 404, not pretend to exist`);
  }
});

// ── the class guard: every local file the page references must exist ──────
test("the page references only files that exist in public/", () => {
  const page = readFileSync(path.join(ROOT, "public", "index.html"), "utf8");
  const css = readFileSync(path.join(ROOT, "public", "style.css"), "utf8");
  const refs = new Set();
  for (const m of page.matchAll(/(?:src|href)="([^"#][^"]*)"/g)) refs.add(m[1]);
  for (const m of css.matchAll(/url\("([^"]+)"\)/g)) refs.add(m[1]);
  for (const ref of refs) {
    if (/^https?:/.test(ref)) continue;
    const file = path.join(ROOT, "public", ref);
    assert(existsSync(file), `the page references ${ref} and it does not exist — a silent miss`);
  }
});

// ── nested static assets and traversal guards on static paths ─────────────
test("nested static assets serve with correct content-type and traversal is refused", async () => {
  // Nested asset serves 200 with font/woff2
  const fontRes = await get("/fonts/inter-latin.woff2");
  assert.equal(fontRes.status, 200, "nested font file should return 200");
  assert.equal(fontRes.headers.get("content-type"), "font/woff2");
  const body = await fontRes.arrayBuffer();
  assert.ok(body.byteLength > 0, "font body should not be empty");

  // Traversal attempts must 404
  for (const p of [
    "/../server.mjs",
    "/../../etc/passwd",
    "/fonts/../../server.mjs",
    "/%2e%2e/server.mjs",
    "/%2e%2e/%2e%2e/etc/passwd",
  ]) {
    const r = await get(p);
    assert.equal(r.status, 404, `traversal path ${p} must be refused with 404`);
  }
});

// ── read API endpoint: GET /api/file and GET /api/files ───────────────────
test("read API endpoints: GET /api/file reads file without turn, and GET /api/files returns entries", async () => {
  // Create a test file
  const testFile = path.join(WORKSPACE, "api-read-test.txt");
  writeFileSync(testFile, "test file content for api read", "utf8");

  // GET /api/files should return both files array and entries with bytes
  const filesRes = await get("/api/files");
  assert.equal(filesRes.status, 200);
  const filesJson = await filesRes.json();
  assert.ok(filesJson.files.includes("api-read-test.txt"));
  const entry = filesJson.entries.find((e) => e.name === "api-read-test.txt");
  assert.ok(entry, "entry should exist in entries array");
  assert.equal(entry.bytes, 30);

  // GET /api/file?name=
  const fileRes = await get("/api/file?name=api-read-test.txt");
  assert.equal(fileRes.status, 200);
  const fileJson = await fileRes.json();
  assert.equal(fileJson.ok, true);
  assert.equal(fileJson.name, "api-read-test.txt");
  assert.equal(fileJson.content, "test file content for api read");
  assert.equal(fileJson.bytes, 30);

  // Error cases
  const noName = await get("/api/file");
  assert.equal(noName.status, 400);

  const missing = await get("/api/file?name=does-not-exist.txt");
  assert.equal(missing.status, 404);

  const traversal = await get("/api/file?name=../../server.mjs");
  assert.equal(traversal.status, 403);

  rmSync(testFile, { force: true });
});

// ── the phantom turns guard: loading page with N files does zero POST /api/turn ─
test("page load with files produces zero POST /api/turn calls (no phantom turns)", async (t) => {
  // THE ONE OWNER, ASKED FIRST (voicebox-beads-phs9): the browser list is lib/browser-binaries.mjs's,
  // and a box with no browser says so BY NAME rather than dying inside the spawn with a message that
  // reads as something else (the failure mode 80vw measured). Asked BEFORE any setup, so a skip
  // leaves nothing behind — no profile directory, no seeded files (review finding).
  const chromeBin = findBrowserBinary();
  if (!chromeBin) {
    console.log("SKIP BY NAME: no browser binary (set VOICEBOX_CHROME) — this phantom-turns case drives a real browser");
    t.skip("no browser binary — set VOICEBOX_CHROME; this case drives a real browser");
    return;
  }
  const f1 = path.join(WORKSPACE, "alpha.txt");
  const f2 = path.join(WORKSPACE, "beta.txt");
  writeFileSync(f1, "hello alpha", "utf8");
  writeFileSync(f2, "hello beta", "utf8");

  // A DYNAMIC port, not 19996. A fixed CDP port is the same defect as a fixed service port: it makes the
  // suite un-runnable beside any other lane (found by astra, voicebox-beads-xin: a live lane's chromium
  // held 19996 and this test refused to steal or kill it — correctly). `--remote-debugging-port=0` asks
  // Chromium to choose, and it writes the choice to DevToolsActivePort in the user-data-dir.
  const profile = mkdtempSync(path.join(tmpdir(), "voicebox-cdp-"));
  const chrome = spawn(chromeBin, [
    "--headless=new",
    "--no-sandbox",
    "--no-zygote",
    "--disable-crash-reporter",
    "--disable-gpu",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "about:blank",
  ], { detached: true, stdio: ["ignore", "ignore", "pipe"] });
  // The finally below covers the ordinary path; this covers a signal, which never runs a finally
  // (voicebox-beads-selv: a SIGTERM'd runner used to leave this browser behind).
  const untrackBrowser = trackBrowserProcessGroup(chrome.pid);

  try {
    let cdpPort = "";
    for (let i = 0; i < 60 && !cdpPort; i++) {
      try {
        const line = readFileSync(path.join(profile, "DevToolsActivePort"), "utf8").split("\n")[0].trim();
        if (line) cdpPort = line;
      } catch { /* not written yet */ }
      if (!cdpPort) await sleep(100);
    }
    assert(cdpPort, "chromium did not publish a DevTools port in DevToolsActivePort");
    let wsUrl = "";
    for (let i = 0; i < 40; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${cdpPort}/json`);
        const list = await res.json();
        const page = list.find((p) => p.type === "page");
        if (page?.webSocketDebuggerUrl) {
          wsUrl = page.webSocketDebuggerUrl;
          break;
        }
      } catch {}
      await sleep(100);
    }
    assert(wsUrl, "could not find page target");

    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

    let id = 1;
    const pending = new Map();
    const networkRequests = [];
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.id && pending.has(msg.id)) {
        const { resolve } = pending.get(msg.id);
        pending.delete(msg.id);
        resolve(msg.result);
      }
      if (msg.method === "Network.requestWillBeSent") {
        networkRequests.push({
          url: msg.params.request.url,
          method: msg.params.request.method,
        });
      }
    };

    const call = (method, params = {}) => new Promise((resolve) => {
      const reqId = id++;
      pending.set(reqId, { resolve });
      ws.send(JSON.stringify({ id: reqId, method, params }));
    });

    await call("Network.enable");
    await call("Page.enable");
    await call("Runtime.enable");

    // Navigate to page with files already present
    await call("Page.navigate", { url: BASE });
    await sleep(1500);

    const postTurnsBefore = networkRequests.filter(
      (r) => r.method === "POST" && r.url.includes("/api/turn")
    );
    // ABSENCE ASSERTION: loading the page made ZERO POST /api/turn calls
    assert.equal(postTurnsBefore.length, 0, `Page load produced ${postTurnsBefore.length} phantom POST /api/turn requests!`);

    // POSITIVE CONTROL: a typed user turn DOES make a POST /api/turn call
    await call("Runtime.evaluate", {
      expression: `
        const input = document.getElementById("utterance");
        const form = document.getElementById("text-form");
        if (input && form) {
          input.value = "list files";
          form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
        }
      `,
    });

    await sleep(1000);

    const postTurnsAfter = networkRequests.filter(
      (r) => r.method === "POST" && r.url.includes("/api/turn")
    );
    assert.equal(postTurnsAfter.length, 1, `Expected exactly 1 POST /api/turn after user action, got ${postTurnsAfter.length}`);

    ws.close();
  } finally {
    untrackBrowser();
    try {
      process.kill(-chrome.pid, "SIGKILL");
    } catch {
      try { chrome.kill("SIGKILL"); } catch {}
    }
    try { rmSync(profile, { recursive: true, force: true }); } catch {}
    rmSync(f1, { force: true });
    rmSync(f2, { force: true });
  }
});


// ── the prose sweep: claims the served pages make about the running system ──
test("the pages' prose matches the running system (prose sweep, 2026-09-20)", async () => {
  const page = readFileSync(path.join(ROOT, "public", "index.html"), "utf8");
  // Whose disk, and WHEN: the server's, and only for a folder it can reach. The
  // first version of this pinned the exact phrase "read from the server's disk",
  // which was true for a machine root and FALSE for a picked folder or origin
  // storage — where the server cannot read the folder at all. So this pins the
  // CLAIM (the server is the reader, the project folder is the subject, and it is
  // conditional on reachability) rather than a sentence, because a test that
  // demands exact prose fails the moment the prose gets more honest.
  assert.match(page, /the local server, which reads and writes the project folder/,
    "the footer no longer says who reads and writes the folder");
  assert.match(page, /when the folder is one it can reach/,
    "the footer claims the server reads every project folder, which is false for a picked one");
  // The retired refusal message must not come back through any served page:
  for (const served of ["index.html", "environment.html"]) {
    const text = readFileSync(path.join(ROOT, "public", served), "utf8");
    assert.doesNotMatch(text, /escapes the workspace/, `${served} still carries the retired "escapes the workspace" message`);
  }
  // THE LIVE-VOICE CLAIM IS PINNED BY THE CODE IT DESCRIBES, and the direction of this assertion reversed
  // on 2026-09-24 (voicebox-beads-a93) for a reason worth keeping: it used to forbid the words "tool" in
  // live-voice.js, to keep the footer's "takes no tools yet, so it cannot write files" honest. Live tools
  // had landed days earlier, so that footer sentence was ALREADY FALSE — and the guard, correct in
  // mechanism, was defending a stale claim. What invalidated it was a change that made live-voice.js
  // mention tools (forwarding the server's `{type:"tool"}` frame so the list updates when a tool writes).
  // So the pairing is kept and flipped: the adapter must forward tool calls, and the footer must say that
  // live voice can write files — if either half moves alone, this fails and somebody re-reads the prose.
  const live = readFileSync(path.join(ROOT, "public", "live-voice.js"), "utf8");
  assert.match(live, /onToolCalls/, "live-voice.js no longer forwards tool calls, so a tool-written file would not reach the list");
  assert.match(page, /Live voice runs through the same server and uses the same tools, so the model can write files/,
    "the footer's live-voice claim does not match what live-voice.js does (it forwards tool calls)");
});
