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
// this at it: VOICEBOX_UI_URL / VOICEBOX_API_URL / VOICEBOX_TREE.
//
// WHY THE ROOT DECLARATION IS IN HERE (2026-09-20, one-root): the old harness
// assumed a `workspace/` default; the environment retired that fallback on
// purpose — an undeclared root is a NAMED state that refuses with
// `root-not-declared`. So the harness now asserts BOTH states in order: first
// the refusal (the new contract, as a positive assertion), then it declares a
// scratch directory of its own and runs the disk comparisons against it.
// Together with the served-vs-disk marker check, this answers "is this
// environment current" better than the old workspace field ever did.
//
// Checks:
//   0. the environment is current       — served modules carry current markers
//   1. root-not-declared refuses        — the new contract, positively asserted
//   2. console clean on load            — the partial-update aborts class
//   3. zero POST /api/turn on load      — the phantom-turn defect
//   4. file list matches the workspace  — names, count, and byte counts
//   5. a typed turn writes a real file  — page ≡ disk ≡ content, exactly one POST
//   6. ../evil.sh is refused            — nothing lands outside the declared root
//   7. the mic state is honest          — never "listening" without a gesture;
//                                         the waveform may not lie either
//   8. the font actually loads          — through Vite AND through server.mjs
//   9. the run leaves no trace          — artefacts, scratch root, porcelain
import { spawn, execFileSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { existsSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// The tree whose public/ should be served — defaults to THIS repo root, i.e.
// the tree the harness itself runs from. For a candidate branch, point it at
// the candidate worktree. The default is stated in the output, because an
// unstated default is how "green on one machine" happened before.
const TREE = process.env.VOICEBOX_TREE ?? ROOT;
const UI = process.env.VOICEBOX_UI_URL ?? "http://127.0.0.1:5173";
const API = process.env.VOICEBOX_API_URL ?? "http://127.0.0.1:8787";
// per-run browser: two concurrent runs must never share one (2026-09-19,
// voicebox-ui's run and another lane's overlapped on a fixed port + profile
// and the typed-turn check failed with the OTHER run's timestamp)
const CDP_PORT = 9500 + (process.pid % 500);
const NAME = `acceptance-proof-${process.pid}.txt`; // hoisted: the finally must see it

const results = [];
const report = (name, ok, detail) => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

// Cleanup on every exit path — finally does not run on signals or direct
// process.exit, and a SIGTERM'd run (timeout, ctrl-C) used to leave its proof
// file in Paul's workspace. Re-asserted at the end by the artefact-free check.
const cleanupArtefacts = () => {
  try { if (scratchRoot) for (const f of readdirSync(scratchRoot)) if (/^acceptance-proof-.*\.txt$/.test(f)) rmSync(path.join(scratchRoot, f)); } catch {}
};
process.on("SIGTERM", () => { cleanupArtefacts(); process.exit(143); });
process.on("SIGINT", () => { cleanupArtefacts(); process.exit(130); });
process.on("uncaughtException", (e) => { cleanupArtefacts(); try { chromium?.kill(); } catch {} console.log(`FAIL  uncaught: ${String(e?.message ?? e).slice(0, 140)}`); process.exit(1); });

// One page, one driver: concurrent runs interleave typed turns into the same
// workspace and the list checks fail on each other's files. Serialise whole
// runs on a lockfile — wait up to 2 minutes, then refuse rather than overlap.
try { execFileSync("flock", ["-w", "120", "/tmp/vb-accept.lock", "-c", "true"]); }
catch { console.log("FAIL  another acceptance run holds the lock (>120s) — retry when it finishes"); process.exit(1); }

// ── bring up a headless browser and open the page ──────────────────────────
const chromium = spawn("/usr/bin/chromium", [
  "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
  `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=/tmp/vb-accept-profile-${process.pid}`, "about:blank",
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

console.log(`measuring tree: ${TREE}${TREE === ROOT ? "  (default: this repo — set VOICEBOX_TREE to measure a candidate)" : ""}`);

// ── 0. the environment is current: served modules carry current markers ───
// The class this catches: an ff-merge replaced public/audio-client.js, Vite's
// watcher never fired, and the server kept serving its cached transform while
// every file-level stamp reported the new sha. "The environment is current"
// is a claim someone has to make — this check makes it, FIRST, because every
// other check depends on it.
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
report("environment is current (served modules carry current markers)", staleModules.length === 0,
  staleModules.length ? `STALE: ${staleModules.join(", ")} — touch the file or restart vite` : `${compared.size} modules compared`);

// ── 1. the root lifecycle: refusal first, then the harness's own scratch ──
const priorRoot = await (await fetch(`${API}/api/root`)).json();
if (priorRoot.declared === false) {
  const refusal = await (await fetch(`${API}/api/root`)).json();
  const writeTry = await (await fetch(`${API}/api/turn`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ transcript: `create a file called should-refuse.txt with no` }),
  })).json();
  const refusedRight = refusal.refused === "root-not-declared"
    && writeTry.result?.refused === "root-not-declared"
    && typeof writeTry.result?.why === "string" && writeTry.result.why.length > 0;
  report("with no root declared, reads and writes refuse as root-not-declared", refusedRight,
    `get.refused=${refusal.refused} write.result.refused=${writeTry.result?.refused}`);
} else {
  console.log(`note: a root is already declared on this server ("${priorRoot.project}") — the root-not-declared refusal is asserted on a fresh server; this run will restore it at the end`);
}

// declare the harness's own scratch root — outside the repo, so the run can
// never dirty the tree it is gating
const scratchRoot = mkdtempSync(path.join(os.tmpdir(), "vb-accept-root-"));
const priorToRestore = priorRoot.declared ? { project: priorRoot.project, root: priorRoot.root } : null;
const declared = await (await fetch(`${API}/api/root`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ project: "page-acceptance", root: { kind: "machine", path: scratchRoot } }),
})).json();
report("scratch root declared", declared.ok === true,
  declared.ok ? `project "page-acceptance" at ${scratchRoot}` : `refused: ${declared.refused} — ${declared.why}`);

let rootDir = declared?.root?.path ?? scratchRoot; // the canonical path the server uses

try {
  await send("Page.navigate", { url: UI }, sessionId);
  await sleep(4000); // let load() finish whatever it does — including phantom turns

  // ── 2. console clean on load ─────────────────────────────────────────────
  report("console clean on load", consoleMsgs.length === 0,
    consoleMsgs.length ? `first: ${String(consoleMsgs[0]).slice(0, 140)}` : "");

  // ── 3. zero POST /api/turn while merely loading ──────────────────────────
  const loadTurns = turnPosts.filter((p) => p.phase === "load");
  report("zero POST /api/turn on page load", loadTurns.length === 0,
    loadTurns.length ? `${loadTurns.length} phantom turn(s), e.g. ${loadTurns[0].body.slice(0, 60)}` : "");

  // ── 4. the file list is the declared root ─────────────────────────────────
  const apiFiles = (await (await fetch(`${API}/api/files`)).json()).files.sort();
  const pageNames = ((await ev(`[...document.querySelectorAll('.file-name')].map(e => e.textContent)`)) ?? []).sort();
  const countText = await ev(`document.getElementById('file-count')?.textContent`);
  const expectedCount = apiFiles.length === 0 ? "nothing yet" : `${apiFiles.length} ${apiFiles.length === 1 ? "file" : "files"}`;
  report("file list matches /api/files (names)",
    JSON.stringify(apiFiles) === JSON.stringify(pageNames),
    `api=[${apiFiles}] page=[${pageNames}]`);
  report("file count matches", countText === expectedCount, `page says "${countText}", declared root has ${apiFiles.length}`);

  // byte counts: the page claims "N bytes" per file — compare against real disk
  let sizeMismatches = [];
  for (const name of apiFiles.slice(0, 8)) {
    const diskBytes = statSync(path.join(rootDir, name)).size;
    const pageMeta = await ev(`document.querySelector('.file-open[data-file=${JSON.stringify(name)}] .file-meta')?.textContent`);
    if (pageMeta !== `${diskBytes} bytes`) sizeMismatches.push(`${name}: page "${pageMeta}" vs disk ${diskBytes} bytes`);
  }
  report("page byte counts match disk", apiFiles.length === 0 || sizeMismatches.length === 0,
    sizeMismatches.join("; "));

  // ── 5 + 7. a typed turn writes a real file (the positive control) ────────
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
  const disk = existsSync(path.join(rootDir, NAME)) ? readFileSync(path.join(rootDir, NAME), "utf8") : null;
  report("typed turn writes a real file into the declared root", appeared && disk !== null,
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

  // ── 6. traversal refused — the boundary is now the DECLARED root ─────────
  phase = "typed";
  await ev(`
    const u = document.getElementById('utterance');
    u.value = "create a file called ../evil.sh with pwned";
    u.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('send').click();
    true;
  `);
  await sleep(1500);
  const evilOutside = existsSync(path.join(path.dirname(scratchRoot), "evil.sh"));
  const stillListed = (await (await fetch(`${API}/api/files`)).json()).files.includes("../evil.sh");
  report("../evil.sh is refused and nothing lands outside the declared root",
    !evilOutside && !stillListed,
    `outside=${evilOutside} listed=${stillListed}`);

  // ── 7. the mic state is honest ────────────────────────────────────────────
  const micState = (await ev(`document.getElementById('voice-state')?.textContent`)) ?? "";
  report("mic state never claims listening without a gesture", !/listening/i.test(micState),
    `state reads "${micState.trim().slice(0, 60)}"`);

  // ── 7b. the waveform may not lie either ── visual activity is gated by voice
  // state: nothing renders input energy when capture is off. The input-wave is
  // display:none unless [data-voice="listening"] and its path is only drawn
  // from real samples — assert the off case so a new visualisation inherits
  // the gate rather than inventing its own.
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

  // ── 8. the font actually loads — through Vite AND through server.mjs ─────
  const fontInPage = await ev(`document.fonts.check('14px Inter')`);
  report("font loads in the page (dev front)", fontInPage === true, `document.fonts.check says ${fontInPage}`);
  const fontResp = await fetch(`${API}/fonts/inter-latin.woff2`);
  report("font serves through the real server", fontResp.status === 200,
    `GET /fonts/inter-latin.woff2 -> ${fontResp.status} ${fontResp.headers.get("content-type") ?? ""}`);
} catch (e) {
  report("harness ran to completion", false, String(e?.message ?? e).slice(0, 140));
} finally {
  cleanupArtefacts();
  chromium.kill();
}

// ── 9. the run leaves no trace ─────────────────────────────────────────────
let postLeftovers = [];
try { postLeftovers = readdirSync(rootDir).filter((f) => /^acceptance-proof-.*\.txt$/.test(f)); } catch {}
report("workspace left artefact-free", postLeftovers.length === 0, postLeftovers.join(", "));

let porcelain = "";
try { porcelain = execFileSync("git", ["-C", TREE, "status", "--porcelain"]).toString().trim(); } catch {}
report("run leaves the tree clean (git status --porcelain empty)", porcelain === "",
  porcelain ? porcelain.split("\n").slice(0, 3).join(" | ") : "");

// Restore the root state the server had before this run, THEN remove the
// scratch — order matters: deleting a still-declared root leaves the
// executor aiming at a vanished directory (a write into it hung, 2026-09-20).
// And the OBSERVED exit state is asserted below: a cleanup that only ran on
// the happy path once left Paul's server holding a declaration at a deleted
// temp folder, and his page showed the gate's leftovers.
if (priorToRestore) {
  await fetch(`${API}/api/root`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(priorToRestore),
  });
  try { rmSync(scratchRoot, { recursive: true, force: true }); } catch {}
  console.log(`note: restored the previously declared root "${priorToRestore.project}"`);
} else {
  console.log(`note: the seam has no un-declare — the (empty) scratch root "page-acceptance" stays declared at ${scratchRoot}; a server restart clears it`);
}
const observed = await (await fetch(`${API}/api/root`)).json();
const observedPath = observed?.root?.kind === "machine" ? observed.root.path : null;
const deadDeclaration = observed?.declared === true
  && typeof observedPath === "string"
  && observedPath.startsWith(scratchRoot)
  && !existsSync(observedPath);
report("exit state: the server holds no declaration at a deleted path", !deadDeclaration,
  observed?.declared
    ? `server holds "${observed.project}" at ${observedPath}${deadDeclaration ? " — WHICH NO LONGER EXISTS" : ""}`
    : "server holds no declared root");

const failed = results.filter((ok) => !ok).length;
console.log(failed === 0 ? "\nALL CLEAR" : `\n${failed} CHECK(S) FAILED — named above`);
console.log(`(served-vs-disk markers + the root-declaration lifecycle answer "is this environment current" better than the old workspace field ever did)`);
process.exit(failed === 0 ? 0 : 1);
