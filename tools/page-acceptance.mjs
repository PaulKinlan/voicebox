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
// Checks (each one traces to a defect somebody actually hit):
//   1. console clean on load            — the partial-update aborts class
//   2. zero POST /api/turn on load      — the phantom-turn defect
//   3. file list matches the workspace  — names, count, and byte counts
//   4. a typed turn writes a real file  — page ≡ disk ≡ content, exactly one POST
//   5. ../evil.sh is refused            — nothing outside workspace/
//   6. the mic state is honest          — never "listening" without a gesture
//   7. the font actually loads          — through Vite AND through server.mjs
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORKSPACE = path.join(ROOT, "workspace");
// Override to acceptance-test a CANDIDATE branch's own server pair, e.g.:
//   PORT=8802 node server.mjs &  PORT=8802 ./node_modules/.bin/vite --port 5174 &
//   VOICEBOX_UI_URL=http://127.0.0.1:5174 VOICEBOX_API_URL=http://127.0.0.1:8802 npm run accept
const UI = process.env.VOICEBOX_UI_URL ?? "http://127.0.0.1:5173";
const API = process.env.VOICEBOX_API_URL ?? "http://127.0.0.1:8787";
const CDP_PORT = 9521;

const results = [];
const report = (name, ok, detail) => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

// ── bring up a headless browser and open the page ──────────────────────────
const chromium = spawn("/usr/bin/chromium", [
  "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
  `--remote-debugging-port=${CDP_PORT}`, "--user-data-dir=/tmp/vb-accept-profile", "about:blank",
], { stdio: ["ignore", "ignore", "ignore"] });

let wsUrl = "";
const t0 = Date.now();
while (!wsUrl && Date.now() - t0 < 10000) {
  try { wsUrl = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json()).webSocketDebuggerUrl; }
  catch { await sleep(200); }
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
const apiFiles = (await (await fetch(`${API}/api/files`)).json()).files.sort();
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
const NAME = "acceptance-proof.txt";
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
  appeared = (await (await fetch(`${API}/api/files`)).json()).files.includes(NAME);
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
const evilOutside = existsSync(path.join(ROOT, "evil.sh"));
const evilInside = existsSync(path.join(WORKSPACE, "..", "evil.sh"));
const stillListed = (await (await fetch(`${API}/api/files`)).json()).files.includes("../evil.sh");
report("../evil.sh is refused and nothing lands outside workspace/",
  !evilOutside && !evilInside && !stillListed,
  `outside=${evilOutside} listed=${stillListed}`);

// ── 6. the mic state is honest ─────────────────────────────────────────────────────
const micState = (await ev(`document.getElementById('voice-state')?.textContent`)) ?? "";
report("mic state never claims listening without a gesture", !/listening/i.test(micState),
  `state reads "${micState.trim().slice(0, 60)}"`);

// ── 6b. the waveform may not lie either ── visual activity is gated by voice
// state (2026-09-19, as voicebox-ui's waveform lands: the invariant is that
// nothing renders input energy when capture is off). The input-wave is
// display:none unless [data-voice="listening"] and its path is only drawn
// from real samples — assert the off case from the live page so a new
// visualisation inherits the gate rather than inventing its own.
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
report("font serves through the real server (:8787)", fontResp.status === 200,
  `GET /fonts/inter-latin.woff2 -> ${fontResp.status} ${fontResp.headers.get("content-type") ?? ""}`);

// ── leave no residue: remove exactly the file this run created ────────────
try { rmSync(path.join(WORKSPACE, NAME)); } catch { /* already gone */ }

chromium.kill();
const failed = results.filter((ok) => !ok).length;
console.log(failed === 0 ? "\nALL CLEAR" : `\n${failed} CHECK(S) FAILED — named above`);
process.exit(failed === 0 ? 0 : 1);
