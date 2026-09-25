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
//                   (:5173). No mutating requests: other lanes may change its
//                   state, so read idempotence is measured on the private instance.
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
//   [private]      root-not-declared refusal · scratch declaration · seeded GET
//                  response + disk idempotence before page traffic · typed
//                  turn page≡disk≡content (exactly one POST) · ../ traversal
//                  refused · artefact-free · porcelain-clean
//   journal-omr's case is LANDED here: the private half declares a root,
//   deletes its directory out from under the declaration, acts, and asserts
//   the named `root-vanished` refusal with a remedy, in bounded time.
//
// SCOPE OF THE EYES: this gate measures 127.0.0.1:5173/8787 ONLY. Paul's
// Tailscale and LAN surfaces are outside it — ALL CLEAR is a statement about
// the local front, not about the product.
import { spawn, execFileSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync, statSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { SOURCE_PREFIXES } from "../lib/browser-sources.mjs";
import { refusalVocabulary, identifiersInRenderedText, ID_PATTERNS, JARGON, READ_VISIBLE_TEXT } from "./rendered-plain-language.mjs";
import { driftBetween } from "./served-vs-disk.mjs";
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

// Hard ceiling: acceptance MUST NEVER hang or block merging indefinitely
const HARNESS_TIMEOUT_MS = 40000;
const deadlineTimer = setTimeout(() => {
  console.log("FAIL  [harness] acceptance timed out after 40s — aborting");
  cleanupArtefacts();
  killPrivate();
  try { chromium?.kill(); } catch {}
  process.exit(1);
}, HARNESS_TIMEOUT_MS);
deadlineTimer.unref();

process.on("SIGTERM", () => { cleanupArtefacts(); killPrivate(); process.exit(143); });
process.on("SIGINT", () => { cleanupArtefacts(); killPrivate(); process.exit(130); });
process.on("uncaughtException", (e) => { cleanupArtefacts(); killPrivate(); try { chromium?.kill(); } catch {} console.log(`FAIL  uncaught: ${String(e?.cause?.code ? `${e.message} (${e.cause.code})` : e?.message ?? e).slice(0, 140)}`); process.exit(1); });

// One browser, two phases: the browser itself is per-run (port + profile
// derived from pid — two concurrent runs must never share one). The phases
// are sequential, so no lock is needed: the shared half writes nothing, and
// the private half owns its own server.
const CHROME_BIN = [
  process.env.VOICEBOX_CHROME,
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/google-chrome",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
].filter(Boolean).find((b) => existsSync(b)) ?? "/usr/bin/chromium";

const chromium = spawn(CHROME_BIN, [
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

// WHAT A PERSON CAN READ, read the way a person reads it: TEXT NODES OF VISIBLE ELEMENTS.
// Deliberately not `innerText` and deliberately not a regex over the HTML source, because both would
// include things a person cannot see (`title`, `data-*`) — and the diagnostic allowance depends on that
// difference: an identifier in a title PASSES, the same identifier visible FAILS (voicebox-beads-0ye).
// code/pre/samp/kbd are skipped by ELEMENT, with the reason recorded here rather than as a word allowlist:
// they quote commands and output, they do not make claims about the system.

/** The rendered half of the plain-language check. Reads the served page, then names any identifier a
 *  person can see — from the vocabulary THIS RUN's own responses used, and from the documented shapes. */
async function renderedPlainLanguage(group, vocabulary, label) {
  // The settings surface is on screen only when it is open, so open it: coverage that skips a whole
  // surface is coverage that reports green while the surface is unread (0ye's own lesson, one level up).
  await ev(`(() => { const d = document.getElementById("settings"); if (d && !d.open) { try { d.showModal(); } catch {} } return Boolean(d); })()`);
  await sleep(200);
  const text = String((await ev(READ_VISIBLE_TEXT)) ?? "");
  const hits = identifiersInRenderedText(text, vocabulary);
  const vacuous = text.trim().length < 40; // nothing to read is not a pass: it is a check that covered nothing
  if (vacuous) hits.push({ token: "(no readable text)", label: "the page was not read", remedy: "navigate to the page before the rendered check runs" });
  report(group, `what a person can read is plain language (${label})`, hits.length === 0,
    hits.length
      ? `${hits.length} identifier(s) VISIBLE: ${hits.slice(0, 4).map((h) => `"${h.token}" (${h.label}) → ${h.remedy}`).join("; ")}`.slice(0, 400)
      : `${text.length} characters of visible text, this run's own refusal vocabulary included · driven pages and states only — it cannot prove anything about unvisited dialogs, another provider's text, or an inaccessible frame`);
}

let sharedRootPayload = null;
let environmentsPayload = null;
let sharedFilesPayload = null; // responses retained for the rendered refusal vocabulary
// When the currency check skips by name (the front is serving a different tree), the verdict must SAY so:
// an ALL CLEAR over a skipped check is a green that measured nothing, which is one level up from the
// defect the check itself was fixed for (vb-resolver's review, 2026-09-23).
let currencySkipReason = null;
let sharedServersRunning = false;
// WHY the front is absent, recorded rather than swallowed: a skip that cannot name the address it could not
// reach costs a debugging cycle to act on, and the address is the only actionable part of it.
let sharedFrontFailure = null;

async function frontReachable(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(1200) });
    if (!res.ok) { sharedFrontFailure ??= { url, code: `HTTP ${res.status}` }; return null; }
    return res;
  } catch (e) {
    sharedFrontFailure ??= { url, code: e?.cause?.code ?? e?.message ?? String(e) };
    return null;
  }
}

try {
  const rootRes = await frontReachable(`${SHARED_API}/api/root`);
  const uiRes = await frontReachable(`${SHARED_UI}/`);
  if (rootRes && uiRes) {
    sharedServersRunning = true;
    sharedRootPayload = await rootRes.json().catch(() => null);
    // The environment rows are rendered on the page, and an unreachable one used to print its refusal
    // IDENTIFIER as the visible label (fixed alongside this check): the vocabulary has to include them.
    environmentsPayload = await fetch(`${SHARED_API}/api/environments`, { signal: AbortSignal.timeout(1200) }).then((r) => r.json()).catch(() => null);
    const filesRes = await fetch(`${SHARED_API}/api/files`, { signal: AbortSignal.timeout(1200) }); // the front answered above, so this is inside the same window
    const filesJson = await filesRes.json().catch(() => ({ files: [] }));
    sharedFilesPayload = filesJson;
  }
} catch (e) {
  // The front answered the probe and then went away mid-block (it flaps: its server restarts on landings), or
  // the files fetch timed out. This is ALSO a reason, and it was the one path that recorded nothing — so the
  // skip said "unreachable" when it knew perfectly well which request died.
  sharedFrontFailure ??= { url: `${SHARED_API}/api/files`, code: e?.cause?.code ?? e?.message ?? String(e) };
  sharedServersRunning = false;
}

try {
  // ════ PHASE A — [shared-front]: GET-only, no shared-state stability claim ═
  if (sharedServersRunning) {
    console.log(`── phase A: shared front ${SHARED_UI} (GET-only; not a shared-state stability check) · measuring tree: ${TREE}${TREE === ROOT ? " (default: this repo)" : ""}`);

  const servedRefs = [];
// ── WHICH TREE IS THE FRONT? The markers below compare the front's SERVED modules
// against THIS tree's disk — an answer only when the front serves THIS tree.
// Measured 2026-09-23 (the moving-object repro): a front serving another branch failed
// a push with 'STALE: fused.js' while nothing was wrong with the branch, and the same
// run against a front serving the measured tree passed. So the check reads the front's
// OWN stamp and the tree's HEAD, and when they differ it SKIPS BY NAME — the currency of
// a shared front is the landing's business, not this push's. A skip is named, never a
// pass and never a failure.
let currencySkipped = null;
const treeGit = (args, fallback) => {
  try { return execFileSync("git", ["-C", TREE, ...args], { encoding: "utf8" }).trim() || fallback; } catch { return fallback; }
};
const treeId = {
  commit: treeGit(["rev-parse", "--short", "HEAD"], "unknown"),
  dirty: treeGit(["status", "--porcelain", "--untracked-files=no"], "") !== "",
};
const frontHtml = await (await fetch(`${SHARED_UI}/`)).text();
const stamp = frontHtml.match(/name="voicebox-build" content="([^"]*)"/)?.[1] ?? "";
const stampCommit = stamp.match(/@\s*([a-f0-9]+)/i)?.[1] ?? null;
if (!stamp || stamp.includes("__VOICEBOX_BUILD_STAMP__") || !stampCommit) {
  currencySkipped = `the front does not name the tree it serves (no build stamp at ${SHARED_UI}/)`;
} else if (treeId.dirty) {
  currencySkipped = `the measured tree has uncommitted changes the front cannot serve (tree ${treeId.commit}, dirty)`;
} else if (stampCommit !== treeId.commit) {
  currencySkipped = `the front serves ${stamp}; this run measures ${treeId.commit} — different trees, so served-vs-disk is not this push's question`;
}
if (currencySkipped) {
  console.log(`SKIP  [shared-front]  environment currency — ${currencySkipped}`);
}

// EVERY page in public/, not just index — environment.html loaded a module
// that 404'd through the dev front while its HTML returned 200, and a walk of
// index.html alone could never see it (Paul's console, 2026-09-20).
for (const page of readdirSync(path.join(TREE, "public")).filter((f) => f.endsWith(".html"))) {
  const html = await (await fetch(`${SHARED_UI}/${page}`)).text();
  for (const m of html.matchAll(/(?:src|href)="([^"#][^"]*)"/g)) {
    const raw = m[1].split("?")[0];
    if (raw === "" || !/\.[a-z0-9]+$/i.test(raw)) continue;
    if (raw.startsWith("/@") || raw.startsWith("/@fs")) continue; // vite's virtual namespaces
    servedRefs.push(raw.startsWith("/") ? raw.slice(1) : path.posix.join(path.posix.dirname(page), raw));
  }
}
  // ── WHOSE TREE IS THE FRONT SERVING? ─────────────────────────────────────────────────────────────
  // The currency question has two halves and they answer different things (voicebox-beads-590):
  //   · IDENTITY — is the front serving the tree being measured? (this gate; vb-resolver's half)
  //   · CONTENT  — if it is, is every file the same? (driftBetween, below)
  // Without identity, the content half is red for every lane whose tree is not on the front: true, and
  // useless to that lane. Without content, a lane that edits the SERVED TREE without committing has the
  // SAME head as the front's stamp and DIFFERENT bytes — the orphan edit that nearly went under a
  // fast-forward on 2026-09-23 — and identity alone cannot see it.
  //
  // The front's identity is the stamp it publishes in its own HTML (Vite writes it from the tree it runs
  // in); the measured identity is this tree's HEAD. A mismatch is NOT a failure: it means the question
  // cannot be answered from here, and the check says so BY NAME rather than reporting drift that is not
  // drift.
  const shortSha = (text) => (String(text).match(/@\s*([0-9a-f]{7,40})/) ?? [])[1] ?? null;
  const frontStamp = (frontHtml.match(/<meta name="voicebox-build" content="([^"]*)"/) ?? [])[1] ?? null;
  let treeSha = null;
  try { treeSha = execFileSync("git", ["-C", TREE, "rev-parse", "--short", "HEAD"]).toString().trim(); } catch { treeSha = null; }
  const frontSha = shortSha(frontStamp ?? "");
  const identityMismatch = frontSha && treeSha && frontSha !== treeSha;
  if (identityMismatch) {
    currencySkipReason = `the front is serving ${frontStamp}, and the measured tree is at ${treeSha}`;
    report("shared-front", "environment is current (the front is serving the tree being measured)", true,
      `SKIPPED BY NAME — ${currencySkipReason}. ` +
      `Currency cannot be answered from here, and that is not a failure: land the change, move the served ` +
      `tree onto it, and run the gate from there.`);
  } else if (!frontSha) {
    // NO STAMP ON THE FRONT: identity cannot decide, so the content comparison runs alone. That is the
    // STRONGER check, not the weaker one — it needs no identity to be exact — so this is a note rather
    // than a skip, and it lives here so the next reader does not have to work it out.
    report("shared-front", "environment is current (the front is serving the tree being measured)", true,
      "NOTE — the front publishes no build stamp, so identity cannot decide; the content comparison runs on its own");
  }

  const staleModules = [];
  const compared = new Set();
  while (!identityMismatch && servedRefs.length) {
    const ref = servedRefs.shift();
    if (compared.has(ref) || /^https?:/.test(ref)) continue;
    compared.add(ref);
    let served, disk;
    try {
      served = await (await fetch(`${SHARED_UI}/${ref}`)).text();
      const diskCandidates = [path.join(TREE, "public", ref), path.join(TREE, ref)];
    const diskPath = diskCandidates.find((c) => existsSync(c));
    if (!diskPath) { staleModules.push(`${ref} (not on disk under the measured tree)`); continue; }
    disk = readFileSync(diskPath, "utf8");
    } catch (e) {
      staleModules.push(`${ref} (${e.message})`);
      continue;
    }
    const cssMatch = served.match(/const __vite__css = ("(?:[^"\\]|\\.)*");/s);
    const core = cssMatch ? JSON.parse(cssMatch[1]) : served;
    // EVERY non-empty line, not just the longest — and the reason names the line, so a failure says
    // WHAT drifted rather than only which module (voicebox-beads-590: the marker rule passed two
    // different files as current whenever their longest line was a shared comment).
    const kind = ref.endsWith(".css") ? "stylesheet" : ref.endsWith(".ts") ? "compiled" : "module";
    const drift = driftBetween(disk, core, { ref, kind });
    if (drift) { staleModules.push(drift); continue; }
    // FOLLOW THE MODULE GRAPH, INCLUDING THE WORKER'S. Two things were not walked and both are page code:
    //   · `.ts` imports — only `.js` refs were followed, so a compiled module's own imports were never
    //     fetched (the served copy is compiled JS, so the same specifier regex applies);
    //   · the WORKER ENTRY POINTS — a worker is constructed at runtime
    //     (`new Worker("/browser/worker.ts", …)`), so nothing in the HTML or the import graph points at it,
    //     and its whole graph (browser/acts.ts, browser/opfs.ts, …) went uncompared. Measured 2026-09-23:
    //     a code-only edit to browser/acts.ts was invisible to this check for exactly that reason — the
    //     comparison was right and never reached the file.
    if (/\.(?:js|ts|mjs)$/.test(ref)) {
      for (const m of served.matchAll(/from\s*"\.\/([^"]+)"|import\s*"\.\/([^"]+)"/g))
        servedRefs.push(path.posix.join(path.posix.dirname(ref), m[1] ?? m[2]));
      for (const m of served.matchAll(/new\s+(?:Shared)?Worker\s*\(\s*["']([^"']+)["']/g))
        servedRefs.push(m[1].startsWith("/") ? m[1].slice(1) : path.posix.join(path.posix.dirname(ref), m[1]));
      for (const m of served.matchAll(/new\s+(?:Shared)?Worker\s*\(\s*new\s+URL\s*\(\s*["']([^"']+)["']\s*,\s*import\.meta\.url\s*\)/g))
        servedRefs.push(path.posix.join(path.posix.dirname(ref), m[1]));
    }
  }
  if (identityMismatch) {
    // Already reported by name above; saying it twice would be the "one fact, three times" defect in a
    // log instead of on a page.
  } else {
    report("shared-front", "environment is current (served modules match the measured tree)", staleModules.length === 0,
      staleModules.length ? `STALE: ${staleModules.join(", ")} — touch the file or restart vite` : `${compared.size} modules compared`);
  }
  // ── 0a-iii. WHAT A PERSON CAN READ, on the front Paul is looking at ─────────────────────────────
  // The vocabulary comes from the responses THIS RUN received, so the assertion is "the page does not
  // show the identifier the server just sent" rather than "this text looks like a token" — a person's
  // own words are content, and a pattern-only check fails on them.
  const sharedVocabulary = new Set();
  for (const payload of [sharedRootPayload, sharedFilesPayload, environmentsPayload]) refusalVocabulary(payload, sharedVocabulary);
  // NAVIGATE FIRST. The first version of this check ran before the page was loaded and read `0 characters`
  // — a green line that covered nothing, which is the whole class this session keeps finding. A rendered
  // check that can report zero text is not a check, so zero text is a FAILURE here.
  await send("Page.navigate", { url: SHARED_UI }, sessionId);
  await sleep(1200);
  await renderedPlainLanguage("shared-front", sharedVocabulary, "the shared front, as served");

  // ── 0a-ii. THE BROWSER'S MODULE GRAPH MUST ARRIVE AS JAVASCRIPT ──────────────────────────────
  // The page and its worker import absolute paths served by the SERVER (`/core/paths.ts`,
  // `/lib/channel.mjs`, `/browser/worker.ts`), so every front in front of that server must forward
  // every directory it serves. When one falls through, the front answers with its SPA fallback —
  // **200 `text/html`** — and a module worker cannot execute an HTML document, so it dies WITHOUT AN
  // ERROR: the page looks alive and cannot act at all (voicebox-beads-geq, 2026-09-23: the executor
  // channel was unproxied, then the worker's whole module graph was).
  //
  // The list is IMPORTED from the file the server reads, not copied here, so a directory added to the
  // rule is checked the moment it exists — and the failure names the prefix and the content-type
  // rather than reporting "the page is broken".
  const firstModuleIn = (dir) => {
    const abs = path.join(TREE, dir);
    if (!existsSync(abs)) return null;
    const found = readdirSync(abs, { recursive: true })
      .map(String)
      .filter((f) => f.endsWith(".ts") || f.endsWith(".mjs"))
      .sort()[0];
    return found ?? null;
  };
  const moduleFailures = [];
  let moduleChecked = 0;
  for (const prefix of SOURCE_PREFIXES) {
    const dir = prefix.slice(1);
    const file = firstModuleIn(dir);
    if (!file) continue; // nothing in this tree to ask for; the prefix is still forwarded by the list
    moduleChecked += 1;
    const url = `${SHARED_UI}${prefix}/${file}`;
    const res = await fetch(url);
    const type = (res.headers.get("content-type") ?? "").split(";")[0].trim();
    const body = (await res.text()).slice(0, 300);
    const looksHtml = /html/i.test(type) || /^\s*<(!doctype|html)/i.test(body);
    if (!res.ok || looksHtml || !/javascript/i.test(type)) {
      moduleFailures.push(`${prefix}/${file} -> ${res.status} ${type || "(no type)"}${looksHtml ? " (the SPA fallback)" : ""}`);
    }
  }
  report("shared-front", "the front serves the browser's module graph as JavaScript", moduleFailures.length === 0,
    moduleFailures.length
      ? `NOT A MODULE: ${moduleFailures.join(", ")} — the front has no proxy for that prefix, so a page module will fail silently`
      : `${moduleChecked} module${moduleChecked === 1 ? "" : "s"} fetched through ${SOURCE_PREFIXES.length} forwarded prefixes`);

  // ── 0b. plain language: internal identifiers and jargon are not user-facing ──
  // Paul, 2026-09-20: "make it a priority to use plain language in this project
  // that a human would understand and respect." The boundary is the RENDERED
  // string — comments and docs may carry ticket ids; what a person can read on
  // the page may not. Fails by name: file + the string it appeared in.
  // Every hit carries a REMEDY — a refusal without a remedy is the one thing
  // this system does not do. The instruction we are following: state the
  // consequence, not the mechanism; say what a person would call it.
  // THE VOCABULARY LIVES IN tools/rendered-plain-language.mjs and is used TWICE: here, on source
  // literals (what did we write?), and further down, on RENDERED text (what is on the page?). A list
  // that exists in two places drifts — the lesson of lib/browser-sources.mjs, one file earlier.
  const stripCommentsHtml = (t) => t
  // <style> blocks are colours and layout, not user-facing text — without this
  // a hex colour (#101014) reads as an issue reference (first run, 2026-09-20)
  .replace(/<style[\s\S]*?<\/style>/gi, " ")
  .replace(/<!--[\s\S]*?-->/g, " ");
  const stripCommentsJs = (t) => t.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
  const stringLiterals = (js) =>
    [...js.matchAll(/"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g)].map((m) => m[1] ?? m[2] ?? m[3]);
  const langHits = [];
  try {
    for (const f of readdirSync(path.join(TREE, "public")).filter((f) => /\.html$|\.js$/.test(f))) {
      const raw = readFileSync(path.join(TREE, "public", f), "utf8");
      const isJs = f.endsWith(".js");
      const body = isJs ? stripCommentsJs(raw) : stripCommentsHtml(raw);
      const texts = isJs ? stringLiterals(body) : [body];
      for (const t of texts) {
        const lineFor = (needle) => (t.split("\n").find((l) => l.includes(needle)) ?? t).trim().slice(0, 90);
        for (const [re, label, remedy] of ID_PATTERNS) {
          const m = t.match(re);
          if (m) langHits.push(`${f}: ${label} "${m[0]}" — …${lineFor(m[0])}… → say: ${remedy}`);
        }
        for (const [w, remedy] of JARGON) {
          const re = new RegExp(`\\b${w}\\b`, "i");
          if (re.test(t)) langHits.push(`${f}: jargon "${w}" — …${lineFor(w)}… → say: ${remedy}`);
        }
      }
    }
  } catch (e) {
    langHits.push(`the scan itself failed: ${String(e?.message ?? e)}`);
  }
  report("harness", "user-facing strings are plain language (no internal ids, no project jargon)", langHits.length === 0,
    langHits.length ? `${langHits.length} hit(s): ${langHits.slice(0, 5).join(" · ")}` : "clean");

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
  // Folders render with a trailing slash ('notes/') per ed0dbad
  const normalizedPageNames = pageNames.map(n => n.replace(/\/$/, ''));
  report("shared-front", "file list rendering matches the served workspace (names)",
    JSON.stringify(apiFiles) === JSON.stringify(normalizedPageNames),
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

  // bp8 isolation (voicebox-beads-ubk): Do NOT assert that the shared server's root declaration or
  // file list is untouched across Phase A. The dev server is shared with other concurrent lanes
  // (e.g. 7cd-poll re-declaring roots every 20s), so measuring global state across an unowned server
  // violates bp8 ("a process that writes must write outside anything another process measures").
  // The CDP witness checks for page-load turns, not side effects inside a GET handler.
  // Read idempotence and mutating lifecycle checks belong on Phase B's private instance.
  } else {
    console.log(
        `SKIP  [shared-front]  phase A skipped: the shared front is not up ` +
          `(${sharedFrontFailure?.code ?? "unreachable"} at ${sharedFrontFailure?.url ?? SHARED_API}) — it makes NO claim ` +
          `about what Paul sees; phase B (its own private instance) carries this run.`,
      );
  }

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
  const privateVocabulary = new Set();
  const refusal = await (await fetch(`${PRIVATE_ORIGIN}/api/root`)).json();
  refusalVocabulary(refusal, privateVocabulary);
  const writeTry = await (await fetch(`${PRIVATE_ORIGIN}/api/turn`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ transcript: `create a file called should-refuse.txt with no` }),
  })).json();
  refusalVocabulary(writeTry, privateVocabulary);
  report("private", "with no root declared, reads and writes refuse as root-not-declared",
    refusal.refused === "root-not-declared"
    && writeTry.result?.refused === "root-not-declared"
    && typeof writeTry.result?.why === "string" && writeTry.result.why.length > 0,
    `get.refused=${refusal.refused} write.result.refused=${writeTry.result?.refused}`);

  scratchRoot = mkdtempSync(path.join(os.tmpdir(), "vb-accept-root-"));
  // the harness SPAWNS the server, so it is the host: the declaration carries
  // the host token the helper read from this server's own scratch extensions
  // dir (an unauthenticated declaration is refused — cfn, 2026-09-20)
  const declared = await (await fetch(`${PRIVATE_ORIGIN}/api/root`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-voicebox-host-token": started.hostToken },
    body: JSON.stringify({ project: "page-acceptance", root: { kind: "machine", path: scratchRoot } }),
  })).json();
  report("private", "scratch root declared", declared.ok === true,
    declared.ok ? `project "page-acceptance" at ${scratchRoot}` : `refused: ${declared.refused} — ${declared.why}`);
  const rootDir = declared?.root?.path ?? scratchRoot;

  // f2o: before private-page navigation, no page polling competes with these reads.
  // Seed known nonempty bytes, not an empty-list equality. Compare the actual disk too:
  // a GET can return the same listing while changing bytes or writing a hidden file.
  const readName = `acceptance-proof-read-${process.pid}.txt`;
  const readPath = path.join(scratchRoot, readName);
  const readBytes = Buffer.from("Reads must leave this nonempty witness unchanged.\n");
  writeFileSync(readPath, readBytes);
  const readFileState = () => {
    const { mode, mtimeNs, ctimeNs } = statSync(readPath, { bigint: true });
    return { mode, mtimeNs, ctimeNs, bytes: readFileSync(readPath) }; // atime may change on a legitimate read
  };
  const beforeReads = readFileState();
  const reads = [];
  for (let i = 0; i < 3; i++) {
    const rootResponse = await fetch(`${PRIVATE_ORIGIN}/api/root`);
    const root = await rootResponse.json();
    const filesResponse = await fetch(`${PRIVATE_ORIGIN}/api/files`);
    reads.push({ rootStatus: rootResponse.status, root,
      filesStatus: filesResponse.status, files: await filesResponse.json() });
  }
  const nonempty = readBytes.length > 0 && reads.length === 3 && reads.every(({ rootStatus, root, filesStatus, files }) =>
    rootStatus === 200 && root?.ok === true && root.declared === true
    && root.project === declared.project && isDeepStrictEqual(root.root, declared.root)
    && root.declaredAt === declared.declaredAt
    && filesStatus === 200 && files?.ok === true && files.project === declared.project
    && isDeepStrictEqual(files.root, declared.root) && isDeepStrictEqual(files.files, [readName])
    && isDeepStrictEqual(files.entries, [{ name: readName, bytes: readBytes.length, kind: "file" }]));
  const sameResponses = reads.every((read) => isDeepStrictEqual(read, reads[0]));
  const sameDisk = beforeReads.bytes.equals(readBytes) && isDeepStrictEqual(readdirSync(scratchRoot), [readName])
    && isDeepStrictEqual(readFileState(), beforeReads);
  report("private", "repeated GET /api/root and /api/files preserve nonempty responses and seeded disk state",
    nonempty && sameResponses && sameDisk,
    `${reads.length}/3 rounds, ${readBytes.length} seeded bytes; nonempty=${nonempty} responsesSame=${sameResponses} diskSame=${sameDisk}`);
  rmSync(readPath, { force: true }); // the later UI/turn checks start from their own empty root

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

  // ── journal-omr, regression-tested where it is testable ──────────────────
  // A vanished root must refuse BY NAME with a remedy, in bounded time — it
  // must never hang. Only the private half can run this: it declares, deletes
  // the directory out from under the declaration, and acts. Wait for the
  // condition, bound the wait, PRINT the latency — a slow refusal is
  // information, a hang is an outage.
  const vStart = Date.now();
  rmSync(scratchRoot, { recursive: true, force: true });
  let vResp = null;
  try { vResp = await (await fetch(`${PRIVATE_ORIGIN}/api/files`)).json(); } catch (e) {
    report("private", "a vanished root refuses by name with a remedy, fast", false,
      `the act did not answer at all: ${String(e?.cause ?? e).slice(0, 80)}`);
  }
  const vMs = Date.now() - vStart;
  if (vResp) {
    refusalVocabulary(vResp, privateVocabulary);
    report("private", "a vanished root refuses by name with a remedy, fast",
      vResp?.refused === "root-vanished" && typeof vResp?.why === "string" && vResp.why.length > 0 && vMs < 2000,
      `refused=${vResp?.refused} in ${vMs}ms — why: ${String(vResp?.why ?? "").slice(0, 90)}`);
  }

  // ── 0ye: WHAT A PERSON CAN READ, after the states above have been DRIVEN ────────────────────────
  // This is the check that was missing: every refusal this run provoked has a name, and the page is
  // read afterwards to prove the name is not what a person is shown. The vocabulary is the run's own,
  // so an identifier that exists in no source literal — one that arrived in a payload — is still caught.
  await renderedPlainLanguage("private", privateVocabulary, `after ${privateVocabulary.size} driven refusal name(s)`);
} catch (e) {
  report("harness", "run completed without crashing", false, String(e?.cause?.code ? `${e.message} (${e.cause.code})` : e?.message ?? e).slice(0, 140));
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
console.log(
  failed !== 0
    ? `\n${failed} CHECK(S) FAILED — named above`
    : !sharedServersRunning
      ? `\nALL CLEAR — PHASE B ONLY; phase A could not witness the served front ` +
        `(${sharedFrontFailure?.code ?? "unreachable"} at ${sharedFrontFailure?.url ?? SHARED_API}). ` +
        `Nothing in this run says the served front is current.`
      : currencySkipReason
        ? `\nALL CLEAR — but the currency check was skipped: ${currencySkipReason}. ` +
          `Everything else passed; nothing here says the served front is current.`
        : "\nALL CLEAR",
);
console.log("(served-vs-disk markers on the shared front + the root-declaration lifecycle on a private instance answer \"is this environment current\" better than the old workspace field ever did)");
process.exit(failed === 0 ? 0 : 1);
