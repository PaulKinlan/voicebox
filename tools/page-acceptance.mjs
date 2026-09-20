// tools/page-acceptance.mjs — the page acceptance harness.
//
// WHY: every UI defect Paul found on 2026-09-19 was found by a human looking,
// and every one was invisible to the checks we had. This drives the REAL page
// and asserts what we now know matters. One command (`npm run accept`); the
// output names what failed and WHICH INSTANCE each result describes.
//
// TWO INSTANCES, SPLIT BY READ/WRITE (2026-09-20 — a gate that ran its
// mutating checks on the shared dev server twice took Paul's page's root
// away mid-session, even with perfect cleanup: the declaration is process
// memory, so restoring it still flaps the state a person is looking at):
//   [shared-front]  GET-ONLY checks against the dev front Paul uses
//                   (:5173). Nothing here writes. The server's root state is
//                   captured before and asserted identical after — a witness,
//                   not an assumption.
//   [private]       every state-mutating check runs against a server this
//                   harness spawns itself (ephemeral port, killed at exit).
//                   On a fresh instance `declared:false` is guaranteed, so the
//                   root-not-declared refusal is asserted EVERY run. The
//                   scratch declaration lives and dies with this process.
//   Overrides (explicit shared-surface gating, when measuring the real
//   surface is the point): VOICEBOX_UI_URL / VOICEBOX_API_URL / VOICEBOX_TREE.
//
// Checks:
//   [shared-front] environment currency · console clean on load · zero phantom
//                  turns · file list rendering · mic + waveform honesty · font
//   [private]      root-not-declared refusal · scratch declaration · typed
//                  turn page≡disk≡content (exactly one POST) · ../ traversal
//                  refused · artefact-free · porcelain-clean
//   PENDING (journal-omr): once the vanished-root hang is fixed, declare a
//   root, delete its directory, act, and assert a named refusal with a remedy.
//
// SCOPE OF THE EYES: this gate measures 127.0.0.1:5173/8787 ONLY. Paul's
// Tailscale and LAN surfaces are outside it — ALL CLEAR is a statement about
// the local front, not about the product.
import { spawn, execFileSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "../tests/lib/server.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TREE = process.env.VOICEBOX_TREE ?? ROOT;
const SHARED_UI = process.env.VOICEBOX_UI_URL ?? "http://127.0.0.1:5173";
const SHARED_API = process.env.VOICEBOX_API_URL ?? "http://127.0.0.1:8787";
let PRIVATE_ORIGIN = "(private instance: port read at spawn)"; // ephemeral: PORT=0, read from the startup banner
const NAME = `acceptance-proof-${process.pid}.txt`; // hoisted: the finally must see it

const results = [];
const report = (inst, name, ok, detail) => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  [${inst}]  ${name}${detail ? ` — ${detail}` : ""}`);
};

let scratchRoot = null;
const cleanupArtefacts = () => {
  try { if (scratchRoot) for (const f of readdirSync(scratchRoot)) if (/^acceptance-proof-.*\.txt$/.test(f)) rmSync(path.join(scratchRoot, f)); } catch {}
};
let privateServer = null;
let privateStop = null;
const killPrivate = () => { try { privateStop?.(); } catch { try { privateServer?.kill(); } catch {} } };
process.on("SIGTERM", () => { cleanupArtefacts(); killPrivate(); process.exit(143); });
process.on("SIGINT", () => { cleanupArtefacts(); killPrivate(); process.exit(130); });
process.on("uncaughtException", (e) => { cleanupArtefacts(); killPrivate(); try { chromium?.kill(); } catch {} console.log(`FAIL  uncaught: ${String(e?.message ?? e).slice(0, 140)}`); process.exit(1); });

// One browser, two phases: the browser itself is per-run (port + profile
// derived from pid — two concurrent runs must never share one). The phases
// are sequential, so no lock is needed: the shared half writes nothing, and
// the private half owns its own server.
const chromium = spawn("/usr/bin/chromium", [
  "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
  "--remote-debugging-port=0", `--user-data-dir=/tmp/vb-accept-profile-${process.pid}`, "about:blank",
], { stdio: ["ignore", "pipe", "pipe"] });

let wsUrl = "";
chromium.stderr.on("data", (d) => {
  const m = String(d).match(/ws:\/\/[^\s]+\/devtools\/browser\/[^\s]+/);
  if (m && !wsUrl) wsUrl = m[0];
});
const t0 = Date.now();
while (!wsUrl && Date.now() - t0 < 10000) await sleep(200);
if (!wsUrl) { console.log("FAIL  harness could not start a browser — is chromium present?"); chromium.kill(); process.exit(1); }

const ws = new WebSocket(wsUrl);
let idc = 0;
const pending = new Map();
const send = (method, params = {}, sessionId) => new Promise((res) => {
  const id = ++idc; pending.set(id, res); ws.send(JSON.stringify({ id, method, params, sessionId }));
});
let consoleMsgs = [];
let turnPosts = [];
let pageOrigin = SHARED_UI;
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.method === "Runtime.consoleAPICalled" && ["error", "warning"].includes(m.params.type))
    consoleMsgs.push(m.params.args.map(a => a.value ?? a.description ?? "").join(" "));
  if (m.method === "Log.entryAdded" && ["error", "warning"].includes(m.params.entry.level))
    consoleMsgs.push(m.params.entry.text);
  if (m.method === "Runtime.exceptionThrown")
    consoleMsgs.push(m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text ?? "exception");
  if (m.method === "Network.requestWillBeSent" && m.params.request.url.endsWith("/api/turn") && m.params.request.method === "POST")
    turnPosts.push({ origin: new URL(m.params.request.url).origin, body: m.params.request.postData ?? "" });
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
};
await new Promise((r) => (ws.onopen = r));
const { targetId } = await send("Target.createTarget", { url: "about:blank" });
const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
for (const d of ["Runtime", "Log", "Page", "Network"]) await send(`${d}.enable`, {}, sessionId);
const ev = async (expr) =>
  (await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, sessionId))?.result?.value;

const sharedRootBefore = await (await fetch(`${SHARED_API}/api/root`)).json().catch(() => null);
const sharedFilesBefore = JSON.stringify(((await (await fetch(`${SHARED_API}/api/files`)).json().catch(() => ({ files: [] }))).files ?? []).sort());

try {
  // ════ PHASE A — [shared-front]: GET-only, witnessed ══════════════════════
  console.log(`── phase A: shared front ${SHARED_UI} (GET-only; witness below) · measuring tree: ${TREE}${TREE === ROOT ? " (default: this repo)" : ""}`);

  const servedRefs = [];
  const indexHtml = await (await fetch(`${SHARED_UI}/`)).text();
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
      served = await (await fetch(`${SHARED_UI}/${ref}`)).text();
      disk = readFileSync(path.join(TREE, "public", ref), "utf8");
    } catch (e) {
      staleModules.push(`${ref} (${e.message})`);
      continue;
    }
    const lines = disk.split("\n").filter((l) => l.trim() !== "");
    const marker = lines.reduce((a, b) => (b.length > a.length ? b : a), "");
    if (marker.length < 8) continue;
    const cssMatch = served.match(/const __vite__css = ("(?:[^"\\]|\\.)*");/s);
    const core = cssMatch ? JSON.parse(cssMatch[1]) : served;
    if (!core.includes(marker)) { staleModules.push(ref); continue; }
    if (ref.endsWith(".js")) {
      for (const m of served.matchAll(/from\s*"\.\/([^"]+)"|import\s*"\.\/([^"]+)"/g))
        servedRefs.push(path.posix.join(path.posix.dirname(ref), m[1] ?? m[2]));
    }
  }
  report("shared-front", "environment is current (served modules carry current markers)", staleModules.length === 0,
    staleModules.length ? `STALE: ${staleModules.join(", ")} — touch the file or restart vite` : `${compared.size} modules compared`);

  consoleMsgs = []; turnPosts = [];
  await send("Page.navigate", { url: SHARED_UI }, sessionId);
  await sleep(4000);

  report("shared-front", "console clean on load", consoleMsgs.length === 0,
    consoleMsgs.length ? `first: ${String(consoleMsgs[0]).slice(0, 140)}` : "");
  // F1: the old filter compared a literal "http://x" origin against the real
  // one — always false, so the check passed unconditionally. A check that
  // cannot fail is not a check. Posts from the shared page carry ITS origin.
  const sharedOrigin = new URL(SHARED_UI).origin;
  const loadTurns = turnPosts.filter((p) => p.origin === sharedOrigin);
  report("shared-front", "zero POST /api/turn on page load", loadTurns.length === 0,
    loadTurns.length ? `${loadTurns.length} phantom turn(s), e.g. ${loadTurns[0].body.slice(0, 60)}` : "");

  const apiFiles = (await (await fetch(`${SHARED_API}/api/files`)).json().catch(() => ({ files: [] }))).files.sort();
  const pageNames = ((await ev(`[...document.querySelectorAll('.file-name')].map(e => e.textContent)`)) ?? []).sort();
  report("shared-front", "file list rendering matches the served workspace (names)",
    JSON.stringify(apiFiles) === JSON.stringify(pageNames),
    `api=[${apiFiles}] page=[${pageNames}]`);

  const micState = (await ev(`document.getElementById('voice-state')?.textContent`)) ?? "";
  report("shared-front", "mic state never claims listening without a gesture", !/listening/i.test(micState),
    `state reads "${micState.trim().slice(0, 60)}"`);
  const visual = await ev(`(() => {
    const stage = document.getElementById('voice-ring-wrap');
    const wave = document.querySelector('.input-wave');
    return {
      state: stage?.dataset.voice ?? "?",
      waveShown: wave ? getComputedStyle(wave).display !== "none" : null,
      pathEmpty: (document.getElementById('input-path')?.getAttribute('d') ?? "").trim() === "",
    };
  })()`);
  const claimedListening = visual?.state === "listening" || visual?.state === "speaking";
  report("shared-front", "waveform visual activity is gated by voice state",
    claimedListening ? true
      : (visual?.waveShown === false && (visual?.pathEmpty === true || visual?.waveShown === null)),
    `data-voice=${visual?.state} waveShown=${visual?.waveShown} pathEmpty=${visual?.pathEmpty}`);
  const fontInPage = await ev(`document.fonts.check('14px Inter')`);
  report("shared-front", "font loads in the page (dev front)", fontInPage === true, `document.fonts.check says ${fontInPage}`);

  // THE WITNESS: the shared server's root state is identical to what it was
  // before phase A. "Nothing writes to it" is a contract; this is the proof.
  const sharedRootAfter = await (await fetch(`${SHARED_API}/api/root`)).json().catch(() => null);
  const sharedFilesAfter = JSON.stringify(((await (await fetch(`${SHARED_API}/api/files`)).json().catch(() => ({ files: [] }))).files ?? []).sort());
  const stateOf = (r) => JSON.stringify({ declared: r?.declared ?? null, project: r?.project ?? null, root: r?.root ?? null });
  report("shared-front", "the shared server's root declaration is untouched", stateOf(sharedRootBefore) === stateOf(sharedRootAfter),
    `before=${stateOf(sharedRootBefore)} after=${stateOf(sharedRootAfter)}`);
  // F2: the declaration alone was BLIND to the mutation that mattered — a
  // phantom turn with a declared root writes a file while the witness reads
  // PASS. The files list is the second half of the witness.
  report("shared-front", "the shared server's file list is untouched", sharedFilesBefore === sharedFilesAfter,
    sharedFilesBefore === sharedFilesAfter ? `${JSON.parse(sharedFilesAfter).length} files, unchanged` : `before=${sharedFilesBefore} after=${sharedFilesAfter}`);

  // ════ PHASE B — [private]: every mutating check, own server ══════════════
  console.log(`── phase B: private instance ${PRIVATE_ORIGIN} (spawned by this run; killed at exit)`);
  // F3/F4 resolved by REUSE: tests/lib/server.mjs (vb-e1m0's helper, taken
  // verbatim into this landing) binds PORT=0, reads the real port off the
  // server's own startup line, health-waits, and its stop() kills the whole
  // process group — an EADDRINUSE can no longer hide, and nothing self-collides.
  const started = await startServer({ cwd: TREE });
  privateServer = started.child;
  privateStop = started.stop;
  PRIVATE_ORIGIN = started.base;

  // on a FRESH instance the refusal is guaranteed, so it is asserted EVERY run
  const refusal = await (await fetch(`${PRIVATE_ORIGIN}/api/root`)).json();
  const writeTry = await (await fetch(`${PRIVATE_ORIGIN}/api/turn`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ transcript: `create a file called should-refuse.txt with no` }),
  })).json();
  report("private", "with no root declared, reads and writes refuse as root-not-declared",
    refusal.refused === "root-not-declared"
    && writeTry.result?.refused === "root-not-declared"
    && typeof writeTry.result?.why === "string" && writeTry.result.why.length > 0,
    `get.refused=${refusal.refused} write.result.refused=${writeTry.result?.refused}`);

  scratchRoot = mkdtempSync(path.join(os.tmpdir(), "vb-accept-root-"));
  const declared = await (await fetch(`${PRIVATE_ORIGIN}/api/root`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ project: "page-acceptance", root: { kind: "machine", path: scratchRoot } }),
  })).json();
  report("private", "scratch root declared", declared.ok === true,
    declared.ok ? `project "page-acceptance" at ${scratchRoot}` : `refused: ${declared.refused} — ${declared.why}`);
  const rootDir = declared?.root?.path ?? scratchRoot;

  consoleMsgs = []; turnPosts = [];
  pageOrigin = PRIVATE_ORIGIN;
  await send("Page.navigate", { url: `${PRIVATE_ORIGIN}/` }, sessionId);
  await sleep(3000);

  const pApiFiles = (await (await fetch(`${PRIVATE_ORIGIN}/api/files`)).json()).files.sort();
  const pPageNames = ((await ev(`[...document.querySelectorAll('.file-name')].map(e => e.textContent)`)) ?? []).sort();
  report("private", "file list matches /api/files (names)",
    JSON.stringify(pApiFiles) === JSON.stringify(pPageNames),
    `api=[${pApiFiles}] page=[${pPageNames}]`);
  let sizeMismatches = [];
  for (const name of pApiFiles.slice(0, 8)) {
    const diskBytes = statSync(path.join(scratchRoot, name)).size;
    const pageMeta = await ev(`document.querySelector('.file-open[data-file=${JSON.stringify(name)}] .file-meta')?.textContent`);
    if (pageMeta !== `${diskBytes} bytes`) sizeMismatches.push(`${name}: page "${pageMeta}" vs disk ${diskBytes} bytes`);
  }
  report("private", "page byte counts match disk", pApiFiles.length === 0 || sizeMismatches.length === 0,
    sizeMismatches.join("; "));

  const turnsBeforeTyped = turnPosts.length;
  const CONTENT = `acceptance ${Date.now()}`;
  await ev(`
    const u = document.getElementById('utterance');
    const s = document.getElementById('send');
    u.value = ${JSON.stringify(`create a file called ${NAME} with ${CONTENT}`)};
    u.dispatchEvent(new Event('input', { bubbles: true }));
    s.click();
    true;
  `);
  let appeared = false;
  for (let i = 0; i < 20 && !appeared; i++) {
    appeared = (await (await fetch(`${PRIVATE_ORIGIN}/api/files`)).json()).files.includes(NAME);
    if (!appeared) await sleep(400);
  }
  const disk = existsSync(path.join(scratchRoot, NAME)) ? readFileSync(path.join(scratchRoot, NAME), "utf8") : null;
  const sentContent = (turnPosts.find((p) => p.body?.includes(NAME))?.body.match(/"transcript":"create a file called [^"]+ with (.*?)"/) ?? [])[1];
  report("private", "typed turn writes a real file into the declared root", appeared && disk !== null,
    appeared ? "" : "the file never appeared in /api/files");
  report("private", "page ≡ disk ≡ content", disk !== null && sentContent !== undefined && disk === sentContent,
    disk === sentContent ? "" : `disk=${JSON.stringify(String(disk).slice(0, 50))} sent=${JSON.stringify(sentContent ?? "?")}`);
  const typedTurns = turnPosts.filter((p) => p.origin === PRIVATE_ORIGIN).length - (turnPosts.filter((p) => p.origin === PRIVATE_ORIGIN && p.body?.includes("should-refuse")).length);
  report("private", "a typed turn produces exactly one POST /api/turn", typedTurns === 1, `${typedTurns} posts`);
  let pageShowsIt = false;
  for (let i = 0; i < 15 && !pageShowsIt; i++) {
    pageShowsIt = (await ev(`[...document.querySelectorAll('.file-name')].some(e => e.textContent === ${JSON.stringify(NAME)})`)) === true;
    if (!pageShowsIt) await sleep(400);
  }
  report("private", "the page's list shows the new file", pageShowsIt, pageShowsIt ? "" : "the list never refreshed to include it");

  await ev(`
    const u = document.getElementById('utterance');
    u.value = "create a file called ../evil.sh with pwned";
    u.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('send').click();
    true;
  `);
  await sleep(1500);
  const evilOutside = existsSync(path.join(path.dirname(scratchRoot), "evil.sh"));
  const stillListed = (await (await fetch(`${PRIVATE_ORIGIN}/api/files`)).json()).files.includes("../evil.sh");
  report("private", "../evil.sh is refused and nothing lands outside the declared root",
    !evilOutside && !stillListed, `outside=${evilOutside} listed=${stillListed}`);

  const fontPrivate = await fetch(`${PRIVATE_ORIGIN}/fonts/inter-latin.woff2`);
  report("private", "font serves through the production server", fontPrivate.status === 200,
    `GET /fonts/inter-latin.woff2 -> ${fontPrivate.status} ${fontPrivate.headers.get("content-type") ?? ""}`);
} catch (e) {
  report("harness", "run completed without crashing", false, String(e?.message ?? e).slice(0, 140));
} finally {
  cleanupArtefacts();
  killPrivate(); // first: the declaration is process memory — dead server, no pointer
  try { if (scratchRoot) rmSync(scratchRoot, { recursive: true, force: true }); } catch {} // F5: the dir too, not only its files
  chromium.kill();
}

// ── the run leaves no trace ────────────────────────────────────────────────
let porcelain = "";
try { porcelain = execFileSync("git", ["-C", TREE, "status", "--porcelain"]).toString().trim(); } catch {}
// F6: beads' own untracked sync dir is not this run's dirt — filter it before
// judging, so the check can pass on a tree that carries a healthy .beads/
porcelain = porcelain.split("\n").filter((l) => !l.includes(".beads/")).join("\n").trim();
report("harness", "run leaves the tree clean (git status --porcelain empty, .beads/ excluded)", porcelain === "",
  porcelain ? porcelain.split("\n").slice(0, 3).join(" | ") : "");

const failed = results.filter((ok) => !ok).length;
console.log(failed === 0 ? "\nALL CLEAR" : `\n${failed} CHECK(S) FAILED — named above`);
console.log("(served-vs-disk markers on the shared front + the root-declaration lifecycle on a private instance answer \"is this environment current\" better than the old workspace field ever did)");
process.exit(failed === 0 ? 0 : 1);
