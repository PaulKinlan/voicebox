// tools/page-acceptance.mjs — the page acceptance harness.
//
// WHY: every UI defect Paul found on 2026-09-19 was found by a human looking,
// and every one was invisible to the checks we had. This drives the REAL page
// on the REAL dev environment and asserts what we now know matters. It is
// runnable by one command (`npm run accept`) and its output names what failed,
// never a bare count.
//
// Requires the environment up (`voicebox-serve`): Vite on :5173, server.mjs on
// :8787, and a headless Chromium. No new dependencies — CDP over the global
// WebSocket.
//
// To acceptance-test a CANDIDATE branch, run its own server pair and point
// this at it: VOICEBOX_UI_URL / VOICEBOX_API_URL.
//
// Checks (each one traces to a defect somebody actually hit):
//   0. the environment is current       — served bytes == disk bytes, FIRST,
//                                         because every other check depends on it
//   1. console clean on load            — the partial-update aborts class
//   2. zero POST /api/turn on load      — the phantom-turn defect
//   3. file list matches the workspace  — names, count, and byte counts
//   4. a typed turn writes a real file  — page ≡ disk ≡ content, exactly one POST
//   5. ../evil.sh is refused            — nothing outside workspace/
//   6. the mic state is honest          — never "listening" without a gesture;
//                                         the waveform may not lie either
//   7. the font actually loads          — through Vite AND through server.mjs
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { existsSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// The workspace under test belongs to the SERVER we talk to, not to the tree
// this script runs from — a lane worktree and the served tree are different
// directories, and stat'ing the wrong one is a false FAIL (2026-09-19,
// voicebox-ui blocked twice). /api/health names the server's own workspace.
let WORKSPACE = null; // resolved from /api/health, below
const NAME = `acceptance-proof-${process.pid}.txt`; // hoisted: the finally must see it
const UI = process.env.VOICEBOX_UI_URL ?? "http://127.0.0.1:5173";
const API = process.env.VOICEBOX_API_URL ?? "http://127.0.0.1:8787";
// Per-run browser, on an EPHEMERAL debugging port. Two concurrent runs must never share one
// (2026-09-19: two lanes overlapped on a fixed port + profile and the typed-turn check failed with
// the other run's timestamp). A pid-derived band only narrows that window — `pid % 500` collides for
// any two pids 500 apart — so this asks the OS and reads back what it got, which cannot collide.
let CDP_PORT = 0;

const results = [];
// Cleanup on every exit path — finally does not run on signals or direct
// process.exit, and a SIGTERM'd run (timeout, ctrl-C) used to leave its proof
// file in Paul's workspace. Re-asserted at the end by the artefact-free check.
const cleanupArtefacts = () => {
  try { if (WORKSPACE) for (const f of readdirSync(WORKSPACE)) if (/^acceptance-proof-.*\.txt$/.test(f)) rmSync(path.join(WORKSPACE, f)); } catch {}
};
process.on("SIGTERM", () => { cleanupArtefacts(); process.exit(143); });
process.on("SIGINT", () => { cleanupArtefacts(); process.exit(130); });
process.on("uncaughtException", (e) => { cleanupArtefacts(); try { chromium?.kill(); } catch {} console.log(`FAIL  uncaught: ${String(e?.message ?? e).slice(0, 140)}`); process.exit(1); });
// One page, one driver: concurrent runs interleave typed turns into the same
// workspace and the list checks fail on each other's files. Serialise whole
// runs on a lockfile — wait up to 2 minutes, then refuse rather than overlap.
import { execFileSync } from "node:child_process";
try { execFileSync("flock", ["-w", "120", "/tmp/vb-accept.lock", "-c", "true"]); }
catch { console.log("FAIL  another acceptance run holds the lock (>120s) — retry when it finishes"); process.exit(1); }
const report = (name, ok, detail) => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

// ── bring up a headless browser and open the page ──────────────────────────
const chromium = spawn("/usr/bin/chromium", [
  "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
  `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=/tmp/vb-accept-profile-${process.pid}`, "about:blank",
], { stdio: ["ignore", "pipe", "pipe"] });

// Chromium prints "DevTools listening on ws://127.0.0.1:<port>/devtools/browser/<id>" when asked for
// port 0, and that line is the only place the chosen port appears.
let wsUrl = "";
const t0 = Date.now();
await new Promise((resolve) => {
  let buffer = "";
  const scan = (chunk) => {
    buffer += String(chunk);
    const match = buffer.match(/ws:\/\/127\.0\.0\.1:(\d+)\/devtools\/browser\/[0-9a-f-]+/);
    if (match) {
      wsUrl = match[0];
      CDP_PORT = Number(match[1]);
      resolve();
    }
  };
  chromium.stderr.on("data", scan);
  chromium.stdout.on("data", scan);
  const timer = setInterval(() => {
    if (wsUrl || Date.now() - t0 > 10000) { clearInterval(timer); resolve(); }
  }, 200);
});
if (!wsUrl) {
  // Fall back to the discovery endpoint only if the banner was missed; a silent browser is a FAIL.
  while (!wsUrl && Date.now() - t0 < 10000) {
    try { wsUrl = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json()).webSocketDebuggerUrl; }
    catch { await sleep(200); }
  }
}
if (!wsUrl) { console.log("FAIL  harness could not start a browser — is chromium present?"); chromium.kill(); process.exit(1); }

const ws = new WebSocket(wsUrl);
let idc = 0;
const pending = new Map();
const send = (method, params = {}, sessionId) => new Promise((res) => {
  const id = ++idc; pending.set(id, res); ws.send(JSON.stringify({ id, method, params, sessionId }));
});
const consoleMsgs = [];   // console errors/warnings + exceptions during load
const turnPosts = [];     // { at: "load" | "typed", url }
let phase = "load";       // turn posts are attributed to the phase they happen in
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.method === "Runtime.consoleAPICalled" && ["error", "warning"].includes(m.params.type))
    consoleMsgs.push(m.params.args.map(a => a.value ?? a.description ?? "").join(" "));
  if (m.method === "Log.entryAdded" && ["error", "warning"].includes(m.params.entry.level))
    consoleMsgs.push(m.params.entry.text);
  if (m.method === "Runtime.exceptionThrown")
    consoleMsgs.push(m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text ?? "exception");
  if (m.method === "Network.requestWillBeSent" && m.params.request.url.endsWith("/api/turn") && m.params.request.method === "POST")
    turnPosts.push({ phase: m.params.request.postData?.includes("acceptance-proof") ? "typed" : phase, body: m.params.request.postData ?? "" });
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
};
await new Promise((r) => (ws.onopen = r));
const { targetId } = await send("Target.createTarget", { url: "about:blank" });
const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
for (const d of ["Runtime", "Log", "Page", "Network"]) await send(`${d}.enable`, {}, sessionId);

const ev = async (expr) =>
  (await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, sessionId))?.result?.value;

// ── 0. the environment is current: served bytes == disk bytes ─────────────
// The class this catches: an ff-merge replaced public/audio-client.js, Vite's
// watcher never fired, and the server kept serving its cached transform while
// every file-level stamp reported the new sha. "The environment is current"
// is a claim someone has to make — this check makes it, FIRST, because every
// other check depends on it. The tree under test is the SERVER's tree, taken
// from /api/health.
const health = await (await fetch(`${API}/api/health`)).json().catch(() => null);
WORKSPACE = health?.workspace ?? null;
// Some server revisions report a RELATIVE workspace ("workspace/") — anchor
// it to the server process's own cwd (same-box instrument: the port names the
// process), or every stat below becomes cwd-relative and fails from any other
// worktree (2026-09-19, voicebox-ui blocked on exactly this).
if (WORKSPACE && !path.isAbsolute(WORKSPACE)) {
  try {
    const port = new URL(API).port;
    const out = execFileSync("ss", ["-ltnp"]).toString();
    const pid = (out.match(new RegExp(`:${port}\\b[^\\n]*pid=(\\d+)`)) ?? [])[1];
    if (pid) WORKSPACE = path.join(readlinkSync(`/proc/${pid}/cwd`), WORKSPACE);
  } catch { /* fall through: the TREE check below reports it */ }
}
const TREE = WORKSPACE ? path.dirname(WORKSPACE) : null;
if (!TREE || !existsSync(TREE)) {
  console.log(`FAIL  cannot locate the server's tree — /api/health said ${JSON.stringify(health?.workspace ?? null)}`);
  chromium.kill(); process.exit(1);
}
// THE RULE (coord, 2026-09-19): compare a MARKER, not bytes. Vite transforms
// everything it serves — CSS arrives as a JS wrapper, JS arrives with
// rewritten imports, HMR lines and a source map — so byte-equality against a
// transforming server can only pass by accident. The marker is the longest
// line of the current disk file: it survives every transform above while
// still being absent from a STALE served copy (the audio-client defect).
// Virtual, query-suffixed and directory-shaped refs are skipped before they
// are ever treated as a comparison.
const servedRefs = [];
const indexHtml = await (await fetch(`${UI}/`)).text();
for (const m of indexHtml.matchAll(/(?:src|href)="([^"#][^"]*)"/g)) {
  const raw = m[1].split("?")[0];
  if (raw === "" || !/\.[a-z0-9]+$/i.test(raw)) continue;
  if (raw.startsWith("@") || raw.startsWith("/")) continue;
  servedRefs.push(raw);
}
const staleModules = [];
const compared = new Set();
while (servedRefs.length) {
  const ref = servedRefs.shift();
  if (compared.has(ref) || /^https?:/.test(ref)) continue;
  compared.add(ref);
  let served, disk;
  try {
    served = await (await fetch(`${UI}/${ref}`)).text();
    disk = readFileSync(path.join(TREE, "public", ref), "utf8");
  } catch (e) {
    staleModules.push(`${ref} (${e.message})`);
    continue;
  }
  const lines = disk.split("\n").filter((l) => l.trim() !== "");
  const marker = lines.reduce((a, b) => (b.length > a.length ? b : a), "");
  if (marker.length < 8) continue; // nothing distinctive to look for
  // CSS is served as a JS wrapper: unwrap the __vite__css literal (a quoted
  // JS string) so the marker search runs against real CSS, not escaped bytes.
  const cssMatch = served.match(/const __vite__css = ("(?:[^"\\]|\\.)*");/s);
  const core = cssMatch ? JSON.parse(cssMatch[1]) : served;
  if (!core.includes(marker)) { staleModules.push(ref); continue; }
  if (ref.endsWith(".js")) {
    for (const m of served.matchAll(/from\s*"\.\/([^"]+)"|import\s*"\.\/([^"]+)"/g))
      servedRefs.push(path.posix.join(path.posix.dirname(ref), m[1] ?? m[2]));
  }
}
// sweep our own past: a crashed run's proof file would fail THIS run's list
// comparison — the gate jamming itself (2026-09-19). The lock guarantees no
// concurrent run owns these.
let swept = 0;
try {
  for (const f of readdirSync(WORKSPACE)) {
    if (/^acceptance-proof-.*\.txt$/.test(f)) { rmSync(path.join(WORKSPACE, f)); swept++; }
  }
} catch { /* workspace unreadable: the list check will name it */ }
if (swept) console.log(`note: swept ${swept} leftover harness artefact(s) from an earlier failed run`);

report("environment is current (served modules carry current markers)", staleModules.length === 0,
  staleModules.length ? `STALE: ${staleModules.join(", ")} — touch the file or restart vite` : `${compared.size} modules compared`);

try {
await send("Page.navigate", { url: UI }, sessionId);
await sleep(4000); // let load() finish whatever it does — including phantom turns

// ── 1. console clean on load ───────────────────────────────────────────────
report("console clean on load", consoleMsgs.length === 0,
  consoleMsgs.length ? `first: ${String(consoleMsgs[0]).slice(0, 140)}` : "");

// ── 2. zero POST /api/turn while merely loading ────────────────────────────
const loadTurns = turnPosts.filter((p) => p.phase === "load");
report("zero POST /api/turn on page load", loadTurns.length === 0,
  loadTurns.length ? `${loadTurns.length} phantom turn(s), e.g. ${loadTurns[0].body.slice(0, 60)}` : "");

// ── 3. the file list is the workspace ──────────────────────────────────────
const safeJson = async (url, options) => {
  try { return await (await fetch(url, options)).json(); } catch (e) {
    report(`server reachable (${url.replace("http://127.0.0.1:", "")})`, false, String(e.cause ?? e).slice(0, 80));
    throw new Error("API_UNREACHABLE");
  }
};
const apiFiles = (await safeJson(`${API}/api/files`)).files.sort();
const pageNames = ((await ev(`[...document.querySelectorAll('.file-name')].map(e => e.textContent)`)) ?? []).sort();
const countText = await ev(`document.getElementById('file-count')?.textContent`);
const expectedCount = apiFiles.length === 0 ? "nothing yet" : `${apiFiles.length} ${apiFiles.length === 1 ? "file" : "files"}`;
report("file list matches /api/files (names)",
  JSON.stringify(apiFiles) === JSON.stringify(pageNames),
  `api=[${apiFiles}] page=[${pageNames}]`);
report("file count matches", countText === expectedCount, `page says "${countText}", workspace has ${apiFiles.length}`);

// byte counts: the page claims "N bytes" per file — compare against real disk
let sizeMismatches = [];
for (const name of apiFiles.slice(0, 8)) {
  const diskBytes = statSync(path.join(WORKSPACE, name)).size;
  const pageMeta = await ev(`document.querySelector('.file-open[data-file=${JSON.stringify(name)}] .file-meta')?.textContent`);
  if (pageMeta !== `${diskBytes} bytes`) sizeMismatches.push(`${name}: page "${pageMeta}" vs disk ${diskBytes} bytes`);
}
report("page byte counts match disk", apiFiles.length === 0 || sizeMismatches.length === 0,
  sizeMismatches.join("; "));

// ── 4 + 7. a typed turn writes a real file (the positive control) ─────────
const CONTENT = `acceptance ${Date.now()}`;
const turnsBeforeTyped = turnPosts.length;
phase = "typed";
await ev(`
  const u = document.getElementById('utterance');
  const s = document.getElementById('send');
  u.value = ${JSON.stringify(`create a file called ${NAME} with ${CONTENT}`)};
  // the composer enables Send from an input event — programmatic .value does
  // not fire one, so the button stays disabled and a bare click is a no-op
  u.dispatchEvent(new Event('input', { bubbles: true }));
  s.click();
  true;
`);
let appeared = false;
for (let i = 0; i < 20 && !appeared; i++) {
  appeared = (await safeJson(`${API}/api/files`)).files.includes(NAME);
  if (!appeared) await sleep(400);
}
const disk = existsSync(path.join(WORKSPACE, NAME)) ? readFileSync(path.join(WORKSPACE, NAME), "utf8") : null;
report("typed turn writes a real file", appeared && disk !== null,
  appeared ? "" : "the file never appeared in /api/files");
report("page ≡ disk ≡ content", disk === CONTENT,
  disk === CONTENT ? "" : `disk has ${JSON.stringify(String(disk).slice(0, 60))}, sent ${JSON.stringify(CONTENT)}`);
const typedTurns = turnPosts.length - turnsBeforeTyped;
report("a typed turn produces exactly one POST /api/turn", typedTurns === 1, `${typedTurns} posts`);
let pageShowsIt = false;
for (let i = 0; i < 15 && !pageShowsIt; i++) {
  pageShowsIt = (await ev(`[...document.querySelectorAll('.file-name')].some(e => e.textContent === ${JSON.stringify(NAME)})`)) === true;
  if (!pageShowsIt) await sleep(400);
}
report("the page's list shows the new file", pageShowsIt, pageShowsIt ? "" : "the list never refreshed to include it");

// ── 5. traversal refused ───────────────────────────────────────────────────
phase = "typed";
await ev(`
  const u = document.getElementById('utterance');
  u.value = "create a file called ../evil.sh with pwned";
  u.dispatchEvent(new Event('input', { bubbles: true }));
  document.getElementById('send').click();
  true;
`);
await sleep(1500);
const evilOutside = existsSync(path.join(WORKSPACE, "..", "evil.sh"));
const stillListed = (await safeJson(`${API}/api/files`)).files.includes("../evil.sh");
report("../evil.sh is refused and nothing lands outside workspace/",
  !evilOutside && !stillListed,
  `outside=${evilOutside} listed=${stillListed}`);

// ── 6. the mic state is honest ─────────────────────────────────────────────
const micState = (await ev(`document.getElementById('voice-state')?.textContent`)) ?? "";
report("mic state never claims listening without a gesture", !/listening/i.test(micState),
  `state reads "${micState.trim().slice(0, 60)}"`);

// ── 6b. the waveform may not lie either ── visual activity is gated by voice
// state (as voicebox-ui's waveform lands: the invariant is that nothing
// renders input energy when capture is off). The input-wave is display:none
// unless [data-voice="listening"] and its path is only drawn from real
// samples — assert the off case from the live page so a new visualisation
// inherits the gate rather than inventing its own.
const visual = await ev(`(() => {
  const stage = document.getElementById('voice-ring-wrap');
  const state = stage?.dataset.voice ?? "?";
  const wave = document.querySelector('.input-wave');
  const waveShown = wave ? getComputedStyle(wave).display !== "none" : null;
  const wavePath = document.getElementById('input-path')?.getAttribute('d') ?? "";
  return { state, waveShown, pathEmpty: wavePath.trim() === "" };
})()`);
const claimedListening = visual?.state === "listening" || visual?.state === "speaking";
report("waveform visual activity is gated by voice state",
  claimedListening ? true
    : (visual?.waveShown === false && (visual?.pathEmpty === true || visual?.waveShown === null)),
  `data-voice=${visual?.state} waveShown=${visual?.waveShown} pathEmpty=${visual?.pathEmpty}`);

// ── 7. the font actually loads — through Vite AND through server.mjs ──────
const fontInPage = await ev(`document.fonts.check('14px Inter')`);
report("font loads in the page (dev front)", fontInPage === true, `document.fonts.check says ${fontInPage}`);
const fontResp = await fetch(`${API}/fonts/inter-latin.woff2`);
report("font serves through the real server", fontResp.status === 200,
  `GET /fonts/inter-latin.woff2 -> ${fontResp.status} ${fontResp.headers.get("content-type") ?? ""}`);

  } catch (e) {
    report("harness ran to completion", false, String(e?.message ?? e).slice(0, 140));
  } finally {
    // the proof file is OURS — remove it whether the run passed, failed or
    // was interrupted. A leftover fails the NEXT run's list comparison, which
    // is the gate jamming itself (2026-09-19).
    cleanupArtefacts();
    chromium.kill();
  }
  let postLeftovers = [];
  try { postLeftovers = readdirSync(WORKSPACE).filter((f) => /^acceptance-proof-.*\.txt$/.test(f)); } catch {}
  report("workspace left artefact-free", postLeftovers.length === 0, postLeftovers.join(", "));
  const failed = results.filter((ok) => !ok).length;
  console.log(failed === 0 ? "\nALL CLEAR" : `\n${failed} CHECK(S) FAILED — named above`);
  process.exit(failed === 0 ? 0 : 1);
