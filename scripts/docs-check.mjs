// scripts/docs-check.mjs — the mechanism that keeps the descriptions of this system true.
//
//   node scripts/docs-check.mjs                     # check: exit 1 when a doc has drifted from the code
//   node scripts/docs-check.mjs --write             # regenerate the generated blocks in place
//   node scripts/docs-check.mjs --docs-root <dir>   # either of the above, on the documents under <dir>
//                                                   # (README.md, docs/) instead of this checkout's — see DOCS_ROOT
//
// Exit 0: the documents describe the code. Exit 1: a refusal, named on stderr. Exit 2: the command line
// itself is wrong (`--docs-root` without a directory) — nothing was checked.
//
// WHY THIS EXISTS. A README claimed "streamed as PCM16 over /live to models/gemini-3.8-live" four lines
// above "No live model. The resolver is scripted; nothing calls Gemini Live." Both were true of different
// halves — the audio path in a tree that had not landed, the turn path in the tree that had — and the
// largest gap in the product was invisible because one word, "live", covered two different things.
// A document kept current by remembering is a document that contradicts itself again within a week.
//
// SO THE CLAIMS ARE DERIVED, NOT TYPED:
//   * the providers come from the module that registers them (`registeredResolvers()`), imported, not grepped;
//   * the routes and the workspace come from a REAL SERVER on a scratch port, probed over HTTP — the same
//     thing the suite does, because "it serves" and "the doc says it serves" are different claims;
//   * the page's scripts come from `public/index.html`, read as HTML rather than matched as text.
//
// The generated blocks live between <!-- BEGIN GENERATED: name … --> and <!-- END GENERATED: name --> in the
// docs below. Anything enumerable goes in one; anything a person writes stays outside.
//
// A check that cannot fail is a description of the code, not a check on it — which is why the suite runs
// this in check mode (`tests/docs-drift.test.mjs`) and why the receipt for it includes a perturbation that
// turns it red.
//
// THE CHEAP HALF REFUSES FIRST (voicebox-beads-qxy2). In check mode the static passes — every document
// present with its markers, no blank block, no hand-written path to a file that is gone, no retired literal,
// docs/claims.json holding — run BEFORE the scratch server boots. When any of them fails, the run refuses
// with ALL of them and says the generated blocks were not compared; it used to wait ~7s for a server and
// /api/probe whose answers could not change that verdict, and then name only the first problem. When they
// pass, the full pass runs exactly as before. `--write` keeps its old order: it regenerates first, because
// regenerating is what it is for.

import { spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, rmSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve } from "node:path";
import { registeredResolvers, resolveTurn } from "../lib/resolver.mjs";
import { makeScratchDir } from "../tools/tree-dirt.mjs";
import { admit, PRIMITIVES, PRIMITIVE_NEEDS, GETS } from "../core/extensions.ts";
import { availableLiveProviders, resolvedLiveProviderName } from "../lib/live-session.mjs";
import { createGeminiProvider } from "../lib/live-providers/gemini.mjs";
import { createOpenAIProvider } from "../lib/live-providers/openai.mjs";
import { functionDeclarations, liveSystemInstruction } from "../lib/commands.mjs";
import { FACTS as STATE_DIR_FACTS } from "../lib/state-dirs.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WRITE = process.argv.includes("--write");

/**
 * WHERE THE DOCUMENTS ARE READ FROM: this checkout, or `--docs-root <dir>` (voicebox-beads-qxy2).
 *
 * The drift test used to prove the denylist by rewriting the TRACKED docs/08-how-it-runs.md IN PLACE for
 * the length of a run — a writer inside a measured tree (voicebox-beads-bp8): a concurrent `git status`
 * saw a modification nobody authored, and a killed test left the document modified. Now the test copies
 * the documents into scratch and points this check at the copy; the checkout is never written.
 *
 * WHAT MOVES AND WHAT DOES NOT. `<dir>` is laid out like this repository's documentation — `README.md`,
 * `docs/*.md`, `docs/claims.json` — and every DOCUMENT this script reads (or, with --write, writes)
 * resolves under it: the three documents that carry generated blocks, every markdown file the
 * hand-written passes scan, and the claims policy that governs them. Everything a document is CHECKED
 * AGAINST stays in this checkout: the code, the page, the scratch server, and every file path a document
 * names — a path claim is a claim about the TREE, and resolving it against the copy would be checking the
 * copy against itself.
 */
const DOCS_ROOT = (() => {
  const args = process.argv.slice(2);
  const at = args.findIndex((a) => a === "--docs-root" || a.startsWith("--docs-root="));
  if (at < 0) return ROOT;
  const value = args[at].startsWith("--docs-root=") ? args[at].slice("--docs-root=".length) : args[at + 1];
  if (!value || value.startsWith("--")) {
    console.error("docs-check: --docs-root needs a directory: node scripts/docs-check.mjs --docs-root <dir>");
    process.exit(2);
  }
  const dir = resolve(value);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    console.error(`docs-check: --docs-root '${value}' is not a directory`);
    process.exit(2);
  }
  return dir;
})();
/** A document's path: `rel` is the name it has in the repository ("docs/07-architecture.md"). */
const docPath = (rel) => join(DOCS_ROOT, rel);
if (DOCS_ROOT !== ROOT) console.log(`docs-check: documents from ${DOCS_ROOT}; code, server and every path they name from ${ROOT}`);

// This check describes the TREE, not the shell it runs in: a provider chosen by this machine's
// environment would print itself into a committed document.
delete process.env.LIVE_PROVIDER;
delete process.env.VOICEBOX_LIVE_PROVIDER;
delete process.env.VOICEBOX_RESOLVER;
delete process.env.ANTHROPIC_API_KEY;

// ── derived facts ────────────────────────────────────────────────────────────

/** The page's own script tags, read as HTML. */
function pageScripts() {
  const html = readFileSync(join(ROOT, "public/index.html"), "utf8");
  const tags = [...html.matchAll(/<script[^>]*\bsrc="([^"]+)"/g)].map((m) => m[1]);
  // A worklet is loaded by code, not by a tag: count them from the sources, so a doc cannot
  // claim an audio path the page never builds.
  const sources = tags
    .map((t) => (existsSync(join(ROOT, "public", t)) ? readFileSync(join(ROOT, "public", t), "utf8") : ""))
    .join("\n");
  // A worklet arrives two ways: a literal addModule("…") call, or a config value the adapter passes
  // on (live-voice.js sets `workletUrl: "pcm-worklet.js"`). Matching only addModule() produced a
  // GENERATED BLOCK THAT WAS FALSE — "No audio worklet is loaded" — which is the exact failure this
  // script exists to prevent, caught by reading its own output against the tree.
  const direct = [...sources.matchAll(/addModule\(\s*["']([^"']+)["']/g)].map((m) => m[1]);
  const configured = [...sources.matchAll(/workletUrl\s*:\s*["']([^"']+)["']/g)]
    .map((m) => m[1])
    .filter((f) => existsSync(join(ROOT, "public", f)));
  return { tags, worklets: [...new Set([...direct, ...configured])] };
}

/** Start the real server on a scratch port and ask it what it is. */
async function probeServer() {
  // A FREE PORT, PROPERLY: bind one, read the number, release it, hand it to the server. The previous
  // version picked 8700+random(200) — a narrow fixed range, in my own instrument, which collided with other
  // test files running in parallel (three failures in parallel, 71/71 serialized). PORT=0 does not work
  // here because server.mjs logs the env value rather than the port it bound, so the probe socket it is.
  let port = await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const p = probe.address().port;
      probe.close(() => resolve(p));
    });
  });
  // The extension directory is per-machine state (gitignored; whatever THIS box has admitted). The probe
  // server gets a scratch one so the runtime report below describes the tree, not the machine.
  // Three scratch directories, deliberately DISTINCT: the extension workspace (where proposals and the
  // extension audit land), the host's extension directory, and a project root to declare over /api/root.
  // Keeping the workspace and the declared root apart is what lets the loop drive below SEE whether an
  // admitted tool acts in the declared root or somewhere else — the same directory would hide the answer.
  // bp8: the probe's scratch comes from the guard, which refuses a destination resolving inside
  // the tree this check measures — a writer's output belongs outside anything another process
  // measures, and that is asserted where the directory is made rather than assumed from os.tmpdir().
  const scratch = makeScratchDir("voicebox-docs-check-", { tree: ROOT });
  const dirs = { workspace: join(scratch, "workspace"), extensions: join(scratch, "extensions"), root: join(scratch, "project"), shelf: join(scratch, "shelf") };
  for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });
  // THE PROBE MUST NOT INHERIT A ROOT FROM THE SHELL (248f6c6): with VOICEBOX_WORKSPACE in the operator's
  // shell the block computed `declared: true` and the document depended on the shell. Here the variable is
  // pinned to a SCRATCH PATH (never removed and never "" — an empty string kills the server on `mkdir ''`),
  // and the boot-time declaration it causes is un-declared over DELETE /api/root below, so the routes are
  // probed in a fresh server's state.
  // PIN THE CHILD'S ENVIRONMENT (the suite's own lesson, d8af9a0): with a real GEMINI_API_KEY in the shell,
  // the /live upgrade probe below was opening a REAL vendor session during a docs check. Blank keys make the
  // provider refuse by name after the 101 — which is the only fact the line reports.
  const env = { ...process.env, PORT: String(port), VOICEBOX_EXTENSIONS_DIR: dirs.extensions, VOICEBOX_WORKSPACE: dirs.workspace, VOICEBOX_WASM_SHELF_DIR: dirs.shelf, GEMINI_API_KEY: "", OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "" };
  for (const k of ["LIVE_PROVIDER", "VOICEBOX_LIVE_PROVIDER", "VOICEBOX_PROVIDER", "VOICEBOX_INSTANCE"]) delete env[k];
  env.VOICEBOX_RESOLVER = "script";
  // ITS CWD IS THE SCRATCH, NOT THE CHECKOUT (voicebox-beads-qxy2, the bp8 rule again): /api/probe runs
  // tools/sandbox-probe.mjs, which proves each directory writable by creating and unlinking a marker file IN
  // it — its own cwd among them. With `cwd: ROOT` that marker existed in the checkout for the instant between
  // write and unlink, so a `git status` racing a docs check could list a file nobody authored. The server and
  // the probe resolve everything else from their own module location (`server.mjs` has no relative reads),
  // and the block reports the probe's SECTION NAMES, not its paths — so the rendered blocks are byte-identical
  // (dumped and diffed when this moved); only where that write lands has changed.
  const child = spawn(process.execPath, [join(ROOT, "server.mjs")], { cwd: scratch, env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  let errOut = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (errOut += d)); // read it, or a chatty server fills the pipe and stalls
  try {
    // Readiness is the server's OWN stdout line ("voicebox on http://…"), not a route:
    // probing /api/health here would couple the instrument to the very claim it checks, and a
    // perturbed health route crashed the check instead of reporting drift. Found by perturbing it.
    // AWAITED, NOT POLLED (voicebox-beads-qxy2): the line is seen the moment it arrives rather than on the
    // next 100ms tick, and a server that EXITS before printing it fails the check at once instead of after
    // the whole 8s budget.
    await new Promise((ready, fail) => {
      const settle = (err) => {
        clearTimeout(timer);
        child.stdout.off("data", onData);
        child.off("exit", onExit);
        if (err) fail(err);
        else ready();
      };
      const onData = () => { if (out.includes("voicebox on http")) settle(); };
      const onExit = (code, signal) => settle(new Error(`server exited (${signal ?? `code ${code}`}) before it was ready on ${port}: ${out.slice(0, 200)}`));
      const timer = setTimeout(() => settle(new Error(`server did not start on ${port}: ${out.slice(0, 200)}`)), 8000);
      child.stdout.on("data", onData); // after the accumulator above, so `out` already holds the chunk
      child.on("exit", onExit);
      onData();
    });
    const token = readFileSync(join(dirs.extensions, ".host-token"), "utf8").trim();
    const base = `http://127.0.0.1:${port}`;
    // VOICEBOX_WORKSPACE declared a root at boot; un-declare it so the routes are probed in the state a
    // fresh server is in, and so the loop drive below can show `root-not-declared` and the declaration.
    await fetch(`${base}/api/root`, { method: "DELETE", headers: { "x-voicebox-host-token": token } });
    // The routes the doc may claim, probed for real. A method mismatch is a fact about the route.
    const probes = [
      ["GET", "/", 200],
      ["GET", "/api/health", 200],
      ["GET", "/api/files", 200],
      ["POST", "/api/turn", 200],
    ];
    // THE READ-ONLY PROBES RUN TOGETHER (voicebox-beads-qxy2): health, the four routes, the /live upgrade and
    // the extension surface ran one after another, and each only READS the state the un-declare above left —
    // `POST /api/turn` included: with no root declared it is refused by name and logs nothing, because there
    // is nowhere to hold a log. None of them changes what another answers, so they are asked at once; their
    // results land in the same slots (Promise.all keeps order), so the rendered blocks are byte-identical.
    // Two things keep their order, because they are not reads: the un-declare runs BEFORE them (they
    // describe a fresh server), and the loop drive runs AFTER them (it declares a root, writes, proposes and
    // admits — and /api/probe, the slow one, must not still be running once a root exists: see
    // probeExtensionSurface).
    // ORDER MATTERS: everything that needs the server runs HERE, before `finally` kills it. The /live line
    // used to be probed AFTER this function returned — against a port nobody was listening on — and the
    // document said "closed without an HTTP response" about a server that answers 101. Found by probing
    // the line's own claim by hand (2026-09-20).
    const [health, routes, liveUpgradeLine, surface] = await Promise.all([
      fetch(`${base}/api/health`).then(async (r) => (r.ok ? await r.json() : { provider: "(no /api/health answer)", workspace: "?" })),
      Promise.all(probes.map(async ([method, path, expect]) => {
        const r = await fetch(`${base}${path}`, {
          method,
          ...(method === "POST" ? { body: JSON.stringify({ transcript: "list files" }), headers: { "content-type": "application/json" } } : {}),
        });
        return { method, path, status: r.status, matches_documented_expectation: r.status === expect };
      })),
      probeLiveUpgrade(port),
      probeExtensionSurface(port),
    ]);
    const loop = await driveLoop(port, dirs, token);
    return { health, routes, liveUpgradeLine, surface, loop };
  } catch (e) {
    // A probe that dies mid-run must say WHICH step and what the server was saying — one run in sixteen
    // crashed with a bare stack trace on 2026-09-20 (not reproduced in 500 targeted iterations), and the
    // trace was all there was to read. Named, with the server's own stderr beside it.
    e.message = `docs-check: the probe against the scratch server failed — ${e.message}\n  server stderr (tail):\n${errOut.split("\n").filter(Boolean).slice(-8).map((l) => "    " + l).join("\n")}`;
    throw e;
  } finally {
    child.kill("SIGKILL");
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * THE AGENT LOOP, DRIVEN: one turn end to end, then a tool made and called — on the scratch root, against
 * the real server, every value read back. Paul (voicebox-beads-8uc): "I don't see in the docs or README any
 * concept of the agent loop." A hand-written description of a loop is the paragraph that rots first, so the
 * loop describes itself: what starts a turn, what decides, who acts, what returns, what is recorded, and
 * where it fails — each with the value the server actually answered.
 */
async function driveLoop(port, dirs, token) {
  const base = `http://127.0.0.1:${port}`;
  const post = async (p, body, headers = {}) => {
    const r = await fetch(base + p, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
    return { status: r.status, ...(await r.json()) };
  };
  const get = async (p) => (await fetch(base + p)).json();
  const turn = (transcript) => post("/api/turn", { transcript });

  const beforeRoot = await turn("create a file called hello.txt with hi");
  const declared = await post("/api/root", { project: "docs-check", root: { kind: "machine", path: dirs.root } }, { "x-voicebox-host-token": token });
  const write = await turn("create a file called hello.txt with hi");
  // READ THE LOG BETWEEN THE TWO ACTS, so the write's entries can be told from the refusal's. Row 5
  // used to TYPE "one entry per act" while reading only entries[0]; the shape it described had
  // already changed under it (attempt-first, voicebox-beads-y69) and nothing could go red, because
  // the false half was never derived. Counting here is what makes that row answer for itself.
  const auditAfterWrite = await get("/api/audit");
  const escape = await turn("read ..");
  const audit = await get("/api/audit");
  const propose = await turn("create a tool called peek that lists files");
  const plan = await get("/api/extensions/proposals/peek-tool/plan");
  const admitted = await post("/api/extensions/admit", { id: "peek-tool", confirm: true, decision: "admit" }, { "x-voicebox-host-token": token });
  const call = await turn("run the tool peek");
  const inventory = await get("/api/extensions");
  const auditAfter = await get("/api/audit");
  const extAuditFile = join(dirs.workspace, "audit.jsonl");
  const extAuditLines = existsSync(extAuditFile) ? readFileSync(extAuditFile, "utf8").trim().split("\n").filter(Boolean).length : 0;
  const rootFiles = readdirSync(dirs.root).filter((f) => !f.startsWith(".")).sort();
  return { beforeRoot, declared, write, escape, audit, auditAfterWrite, propose, plan, admitted, call, inventory, auditAfter, extAuditLines, rootFiles };
}

/** The extension surface, asked over HTTP — including the host's act attempted from where the page stands. */
async function probeExtensionSurface(port) {
  const base = `http://127.0.0.1:${port}`;
  // FOUR READS AT ONCE (voicebox-beads-qxy2). The inventory and the catalogue are reads; the token-less admit
  // is refused (403) before it reaches anything that decides; /api/probe writes only its own cache (in the
  // scratch workspace) and SKIPS its audit entry while no root is declared (`recordProbeAct` in server.mjs
  // returns early without a loggable root). That last fact is why all four finish BEFORE driveLoop, which
  // declares a root: a probe still running then would append an `activity` entry, with its own seq, to the
  // very log the loop block counts — and /api/probe is the slow one (seconds; everything else is ms).
  const [inventory, catalogue, admitNoToken, probe] = await Promise.all([
    fetch(`${base}/api/extensions`).then((r) => r.json()),
    fetch(`${base}/api/extensions/catalogue`).then((r) => r.json()),
    fetch(`${base}/api/extensions/admit`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "anything" }),
    }).then(async (r) => ({ status: r.status, ...(await r.json()) })),
    // The environment's self-report (GET /api/probe): the process runs tools/sandbox-probe.mjs on itself and
    // caches the report in ITS workspace — the scratch one here, so a docs check never writes into the repo.
    fetch(`${base}/api/probe`).then(async (r) => ({ status: r.status, ...(await r.json()) })),
  ]);
  return {
    probe: { status: probe.status, ok: probe.ok, refused: probe.refused ?? null, sections: Object.keys(probe.probe ?? {}).filter((k) => !["probe", "when"].includes(k)) },
    inventoryKeys: Object.keys(inventory),
    placement: inventory.placement,
    catalogueCount: inventory.catalogueCount,
    catalogueIds: (catalogue.catalogue ?? []).map((c) => c.id).sort(),
    admitNoToken,
  };
}

/**
 * What happens when something tries to UPGRADE /live — measured, not typed.
 *
 * false by the time merger read it (server.mjs handles the upgrade for /live), which makes it a hardcoded
 * claim about state inside the check that exists to catch hardcoded claims about state. It is a PROBE now:
 * send an upgrade request, report what came back. The typed version of this line was true when written and
 * false by the time a reviewer read it, which is the whole reason the line is a probe now.
 */
async function probeLiveUpgrade(port) {
  return await new Promise((resolve) => {
    const req = http.request({
      host: "127.0.0.1", port, path: "/live", method: "GET",
      headers: {
        Connection: "Upgrade", Upgrade: "websocket",
        "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==", "Sec-WebSocket-Version": "13",
      },
    });
    let settled = false;
    const done = (line) => { if (!settled) { settled = true; try { req.destroy(); } catch { /* gone */ } resolve(line); } };
    req.on("upgrade", (res) => done(`A WEBSOCKET UPGRADE ON /live IS ACCEPTED (${res.statusCode}) — the zero-dependency server owns it.`));
    req.on("response", (res) => done(`A WEBSOCKET UPGRADE ON /live GOT HTTP ${res.statusCode} — it is not an upgrade route on this tree.`));
    req.on("error", () => done("A WEBSOCKET UPGRADE ON /live CLOSED WITHOUT AN HTTP RESPONSE — the server destroys it (also a form of owning the route)."));
    req.end();
    const t = setTimeout(() => done("THE /live UPGRADE PROBE DID NOT SETTLE."), 2000);
    if (t.unref) t.unref();
  });
}

/**
 * What each live provider's HANDSHAKE actually declares — captured from a fake transport, never dialed.
 *
 * The previous version regex-matched a model name out of lib/live-session.mjs, and when the constant moved
 * into the provider files the README said `using model (not found — the check could not read it)` for a
 * day. This asks the provider itself: construct it against a transport that records the handshake, fire
 * `open`, read what it sent. The model AND the tool declaration come from the same bytes the vendor would.
 */
function liveHandshakes() {
  const factories = { gemini: createGeminiProvider, openai: createOpenAIProvider };
  const keyVar = { gemini: "GEMINI_API_KEY", openai: "OPENAI_API_KEY" };
  return availableLiveProviders().map((name) => {
    const factory = factories[name];
    if (!factory) return { name, model: "(registered, but this check has no capture for it)", tools: null };
    let handshake = null;
    const transport = {
      refused: { audioBeforeReady: 0, afterClose: 0 },
      connect(url, next = {}) { next.onEvent?.({ kind: "open" }); return true; },
      send(kind, payload) { if (kind === "handshake") handshake = JSON.parse(payload); return true; },
      close() {},
      get connected() { return true; },
    };
    // The factory refuses to exist without a key; this value never leaves the process (the transport is fake).
    const saved = process.env[keyVar[name]];
    process.env[keyVar[name]] = "docs-check-placeholder";
    try {
      factory({ emit: () => {}, log: () => {}, transport, tools: functionDeclarations(), systemInstruction: liveSystemInstruction() });
    } finally {
      if (saved === undefined) delete process.env[keyVar[name]]; else process.env[keyVar[name]] = saved;
    }
    const body = handshake?.setup ?? handshake?.session ?? {};
    // Gemini nests them (`tools: [{ functionDeclarations: [{name}] }]`); OpenAI lists them flat (`{type, name}`).
    const tools = Array.isArray(body.tools)
      ? body.tools.flatMap((t) => (Array.isArray(t.functionDeclarations) ? t.functionDeclarations.map((f) => f.name) : [t.name ?? t.type ?? JSON.stringify(t)]))
      : [];
    return { name, model: body.model ?? "(no model in the handshake)", tools };
  });
}

/** Does the /live handler hand the model's words to the executor? A regex over the handler's source. */
function liveHandlerReachesExecutor() {
  // ponytail: regex, because there is no routed call to drive yet. When vb-resolver wires one this
  // flips, the block changes and the check goes red — which is the moment the README's sentence about
  // the voice path must change too.
  const src = readFileSync(join(ROOT, "server.mjs"), "utf8");
  const at = src.indexOf('server.on("upgrade"');
  return at < 0 ? null : /\b(resolveTurn|execute|callTool)\(/.test(src.slice(at));
}

/** The verbs the turn resolver produces — driven, one utterance per verb. */
async function resolverVerbs() {
  const utterances = [
    "create a file called hello.txt with hi",
    "read hello.txt",
    "list files",
    "create a tool called clock that tells the time",
    "run the tool clock",
  ];
  return Promise.all(utterances.map(async (utterance) => ({ utterance, verb: (await resolveTurn(utterance)).verb ?? "(unresolved)" })));
}

/** The catalogue: every tracked descriptor, and what the REAL gate says about it on this placement. */
function catalogueVerdicts() {
  const dir = join(ROOT, "catalogue");
  return readdirSync(dir).filter((f) => f.endsWith(".json")).sort().map((f) => {
    const d = JSON.parse(readFileSync(join(dir, f), "utf8"));
    const gate = admit(d, "machine", new Set());
    const bounds = Object.entries(d.bounds ?? {}).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : v}`).join("; ");
    return {
      id: d.id,
      tools: (d.tools ?? []).map((t) => `\`${t.name}\` → \`${t.primitive}\``).join(", "),
      declared: (d.capabilities ?? []).join(", ") || "—",
      bounds: bounds || "—",
      verdict: gate.decision === "admitted"
        ? `admitted — ${Object.entries(gate.enforced).map(([c, m]) => `${c} via \`${m}\``).join(", ") || "no capability needed"}`
        : `**refused** \`${gate.rule}\``,
    };
  });
}

/** Literal refusal declarations in the listed sources, not an exhaustive dynamic error catalogue. */
function refusalNames() {
  // Direct declarations and the task module's small refusal helpers; no AST dependency needed.
  const sources = {
    "Extension admission gate (`core/extensions.ts`)": ["core/extensions.ts", /rule:\s*"([a-z][a-z0-9-]*)"/g],
    "HTTP routes and workspace root boundary (`server.mjs`, `core/root.ts`, `browser/acts.ts`)": ["server.mjs core/root.ts browser/acts.ts", /refused:\s*"([a-z][a-z0-9-]*)"/g],
    "Extension runtime (`lib/extensions.mjs`)": ["lib/extensions.mjs", /refused:\s*"([a-z][a-z0-9-]*)"/g],
    "Task delegation and lifecycle (`core/tasks.ts`, `lib/tasks.mjs`)": ["core/tasks.ts lib/tasks.mjs", /(?:refused:\s*|(?:refusal|fail|no)\(\s*)"([a-z][a-z0-9-]*)"/g],
  };
  return Object.entries(sources).map(([label, [files, re]]) => {
    const names = new Set();
    for (const f of files.split(" ")) for (const m of readFileSync(join(ROOT, f), "utf8").matchAll(re)) names.add(m[1]);
    return { label, names: [...names].sort() };
  });
}

/** Every environment variable the server and its libraries read, with where. */
const ENV_MEANING = {
  PORT: "HTTP server port bound on `127.0.0.1` (default `8787`).",
  VOICEBOX_RESOLVER: "Default text turn resolver used by `POST /api/turn` (`script`, `gemini`, `openai`, or `claude`; default `script`).",
  VOICEBOX_PROVIDER: "Deprecated alias for `VOICEBOX_RESOLVER`, retained for backward compatibility.",
  VOICEBOX_WORKSPACE: "Declares an active machine project root at startup and stores extension proposals (`proposals/`) and extension audit logs (`audit.jsonl`).",
  VOICEBOX_EXTENSIONS_DIR: "Host state directory storing admitted extensions, `.host-token`, `.ledger.jsonl`, `.pairings.json`, `.api-keys.json`, and `.harness-settings.json` (mode `0600`).",
  VOICEBOX_SANDBOX_HOMES: "Base directory for fenced sandbox home directories (default `~/sandbox-homes/<key>`, located outside `/tmp` for `PrivateTmp` compatibility).",
  VOICEBOX_INSTANCE: "Writer identifier recorded in the active workspace's `.audit/<writer>.jsonl` log (default `machine`).",
  VOICEBOX_ENABLE_STUB_PROVIDER: "Set to `1` to register the key-free `stub` live voice provider for local audio testing.",
  VOICEBOX_BIND_RETRY_MS: "Interval in milliseconds between port bind retries at startup.",
  VOICEBOX_BIND_DEADLINE_MS: "Maximum duration in milliseconds to retry binding the server port before failing.",
  VOICEBOX_HELLO_BOUND_MS: "Timeout in milliseconds to receive an authentication `hello` frame on `/channel` or `/live` (default `5000`).",
  VOICEBOX_LIVE_PROVIDER: "Fallback live voice provider (`gemini`, `openai`, or `claude`) when the client session does not specify one.",
  VOICEBOX_LOOPBACK_AUTH: "Set to `1` to require a single-use bootstrap ticket (`?bootstrap=<ticket>`) and `HttpOnly` session cookie for local browser access. Redemption answers `303` to the plain route with the ticket removed, so the first refresh is authenticated rather than a re-used-ticket `401`. **Default off** (accepted testing posture): with the gate off, unauthenticated loopback clients — including browser-originated requests — can reach state-mutating routes such as active-workspace writes, so the server prints a startup warning naming the exposure and this remedy (see `docs/18-loopback-session-auth.md`).",
  LIVE_PROVIDER: "Deprecated alias for `VOICEBOX_LIVE_PROVIDER`, retained for backward compatibility.",
  GEMINI_API_KEY: "Google Gemini API key for Gemini Live voice sessions and the `gemini` text turn resolver (can also be configured in the UI Settings dialog).",
  OPENAI_API_KEY: "OpenAI API key for OpenAI Realtime voice sessions and the `openai` text turn resolver (can also be configured in the UI Settings dialog).",
  BRAVE_API_KEY: "Brave Search API subscription token used by `http-get` extensions targeting `api.search.brave.com`.",
  FORCE_COLOR: "Terminal color override (`0` disables ANSI colors in `lib/logger.mjs`; non-zero enables them when stdout is not a TTY).",
  NO_COLOR: "Disables ANSI color sequences in `lib/logger.mjs` when set to a non-empty value.",
  NODE_DISABLE_COLORS: "Node.js built-in flag that disables ANSI terminal colors alongside `NO_COLOR`.",
  VOICEBOX_ACP_ADAPTER: "Path or command override for the `pi-acp` stdio adapter binary in `lib/pi-acp.mjs`.",
  ANTHROPIC_API_KEY: "Anthropic API key used by the `claude` resolver/provider and forwarded to the `pi-acp` adapter as a fallback when no store credential exists (can also be configured in the UI Settings dialog).",
  VOICEBOX_ACP_PI: "Path or command override for the `pi` coding agent CLI used by `lib/pi-acp.mjs`.",
  PATH: "System executable search path, also inherited by task-adapter child processes.",
  VOICEBOX_CLAUDE_CLI: "Path override for the Claude Code CLI executable (`CLAUDE_CODE_EXECUTABLE`) used by `lib/claude-acp.mjs`.",
  VOICEBOX_CLAUDE_KEEP_API_KEY: "Set to `1` to retain `ANTHROPIC_API_KEY` in the Claude Code adapter child environment (omitted by default so CLI login takes precedence).",
  VOICEBOX_HARNESS: "Default host coding agent harness (`pi` or `claude`; can also be switched at runtime in the Harnesses UI dialog).",
  VOICEBOX_OPENAI_INPUT_TRANSCRIPTION: "Set to `1` to enable `gpt-4o-mini-transcribe` input audio transcription in the OpenAI Realtime session handshake.",
  VOICEBOX_WASM_SHELF_DIR: "Directory containing the digest-pinned WebAssembly tool shelf (`manifest.json` and `.wasm` binaries; default `~/.isocan/modules/wasm-tools`).",
};
const BEFORE_REGEX = new Set(["return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else", "yield", "await"]);
const HEADS = new Set(["if", "for", "while", "with"]);
const OPENS = { ")": "(", "]": "[", "}": "{" };
const isIdStart = (c) => (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_" || c === "$" || (c > "\x7f" && /\p{ID_Start}/u.test(c));
const isIdPart = (c) => isIdStart(c) || (c >= "0" && c <= "9") || (c > "\x7f" && /[\p{ID_Continue}\u200c\u200d]/u.test(c));

function regexEnd(src, i) {
  let inClass = false;
  for (let j = i + 1; j < src.length && src[j] !== "\n"; j++) {
    if (src[j] === "\\") j++;
    else if (src[j] === "[") inClass = true;
    else if (src[j] === "]") inClass = false;
    else if (src[j] === "/" && !inClass) {
      for (j++; j < src.length && isIdPart(src[j]); j++);
      return j;
    }
  }
  return -1;
}

export function lex(src) {
  const tokens = [];
  const open = [];
  const n = src.length;
  let i = 0;
  let afterValue = false;
  const push = (k, s, e, v) => tokens.push({ k, s, e, v });
  const template = () => {
    for (const s = i; i < n; i++) {
      if (src[i] === "\\") {
        i++;
      } else if (src[i] === "`") {
        push("tpl", s, i++);
        afterValue = true;
        return true;
      } else if (src[i] === "$" && src[i + 1] === "{") {
        push("tpl", s, i);
        push("punct", i, i + 2, "${");
        open.push("${");
        i += 2;
        afterValue = false;
        return true;
      }
    }
    return false;
  };
  if (src.startsWith("#!")) {
    i = src.includes("\n") ? src.indexOf("\n") : n;
    push("com", 0, i);
  }
  while (i < n) {
    const c = src[i];
    const s = i;
    let end;
    if (c === "/" && src[i + 1] === "/") {
      i = src.indexOf("\n", i) < 0 ? n : src.indexOf("\n", i);
      push("com", s, i);
    } else if (c === "/" && src[i + 1] === "*") {
      end = src.indexOf("*/", i + 2);
      if (end < 0) return null;
      i = end + 2;
      push("com", s, i);
    } else if (c === '"' || c === "'") {
      for (i++; src[i] !== c; i++) {
        if (i >= n || src[i] === "\n") return null;
        if (src[i] === "\\") i += src[i + 1] === "\r" && src[i + 2] === "\n" ? 2 : 1;
      }
      push("str", s, ++i);
      afterValue = true;
    } else if (c === "`") {
      i++;
      if (!template()) return null;
    } else if (c === "/" && !afterValue && (end = regexEnd(src, i)) > 0) {
      i = end;
      push("re", s, i);
      afterValue = true;
    } else if (isIdStart(c)) {
      while (++i < n && isIdPart(src[i]));
      const word = src.slice(s, i);
      push("word", s, i, word);
      afterValue = !BEFORE_REGEX.has(word);
    } else if (c >= "0" && c <= "9") {
      while (++i < n && (isIdPart(src[i]) || src[i] === "."));
      push("num", s, i);
      afterValue = true;
    } else if (/\s/.test(c)) {
      i++;
    } else {
      i++;
      let value = false;
      if (c === "(" || c === "[" || c === "{") open.push(c === "(" && HEADS.has(tokens.at(-1)?.v) ? "head" : c);
      else if (c === ")" || c === "]" || c === "}") {
        const top = open.pop();
        if (c === "}" && top === "${") {
          push("punct", s, i, "}");
          if (!template()) return null;
          continue;
        }
        if ((top === "head" ? "(" : top) !== OPENS[c]) return null;
        value = top !== "head";
      }
      push("punct", s, i, c);
      afterValue = value;
    }
  }
  return open.length === 0 ? tokens : null;
}

/**
 * Strip comments using the lexer (voicebox-beads-5qox), so comment-adjacent code
 * (/* inside strings/regexes, // in templates) is not lost and phantom reads in real
 * comments are eliminated.
 */
export function stripComments(source) {
  const tokens = lex(source);
  if (!tokens) return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^\:\\])\/\/.*$/gm, "$1");
  const chars = source.split("");
  for (const { k, s, e } of tokens) {
    if (k === "com") {
      for (let j = s; j < e; j++) {
        if (chars[j] !== "\n") chars[j] = " ";
      }
    }
  }
  return chars.join("");
}

export function envVars() {
  const files = ["server.mjs", ...readdirSync(join(ROOT, "lib"), { recursive: true }).filter((f) => f.endsWith(".mjs")).map((f) => join("lib", f))];
  const where = new Map();
  const remember = (name, file) => {
    if (!where.has(name)) where.set(name, new Set());
    where.get(name).add(file);
  };
  // THE DECLARED STATE FACTS COME FROM THEIR OWNER, imported rather than grepped. `lib/state-dirs.mjs`
  // reads its variables through `process.env[env]` so that each name is written down once, which a text
  // scan cannot see — and when that module took ownership, three rows silently VANISHED from this table
  // (2026-09-25). A table that says where a variable is read must ask the thing that reads it; the
  // declaration is the source, exactly as the provider list is imported rather than matched.
  for (const fact of Object.values(STATE_DIR_FACTS ?? {})) remember(fact.env, "lib/state-dirs.mjs");

  // EXTENSION HEADER INTERPOLATION (voicebox-beads-5qox): catalogue/*.json can declare headers
  // like { "X-Subscription-Token": "$BRAVE_API_KEY" }, which lib/extensions.mjs interpolates
  // from process.env. Scan the catalogue declarations so extension-declared variables are derived
  // from their declarations rather than hardcoded.
  const catalogueDir = join(ROOT, "catalogue");
  if (existsSync(catalogueDir)) {
    for (const f of readdirSync(catalogueDir).filter((f) => f.endsWith(".json"))) {
      try {
        const cat = JSON.parse(readFileSync(join(catalogueDir, f), "utf8"));
        for (const tool of cat.tools ?? []) {
          for (const val of Object.values(tool.params?.headers ?? {})) {
            if (typeof val === "string" && val.startsWith("$")) {
              remember(val.slice(1), "lib/extensions.mjs");
            }
          }
        }
      } catch {}
    }
  }

  for (const f of files) {
    // BOTH SHAPES, because one of them was invisible: `process.env.X` and the optional-chained
    // `globalThis.process?.env?.X` that `lib/resolver.mjs` uses to stay runnable off-host. The narrow
    // pattern omitted the resolver's own GEMINI_API_KEY read, so the generated table named the key
    // against the live provider only and a reader would not know the resolver wanted it too
    // (reviewer finding, voicebox-beads-smx). A derived table is only as wide as its pattern.
    // Strip comments with the lexer before scanning (voicebox-beads-5qox) so prose mentions like
    // "process.env.X" in comments do not invent phantom environment variables in the generated table.
    const src = readFileSync(join(ROOT, f), "utf8");
    const stripped = stripComments(src);
    for (const m of stripped.matchAll(/(?:globalThis\s*\.\s*)?process\s*\??\.\s*env\s*\??\.\s*([A-Z][A-Z0-9_]*)/g)) {
      remember(m[1], f);
    }
  }
  return [...where.keys()].sort().map((name) => ({
    name,
    files: [...where.get(name)].sort(),
    meaning: ENV_MEANING[name] ?? "(undocumented — add a line to ENV_MEANING in scripts/docs-check.mjs)",
  }));
}

// ── the generated blocks ─────────────────────────────────────────────────────

/**
 * WHY EVERY BLOCK CARRIES A MARKER SAYING IT IS NOT ENTIRELY DERIVED.
 *
 * `BEGIN GENERATED` reads as "all of this came from the code". It does not. Each block is prose with
 * derived values interpolated into it, and the prose is TYPED — so a sentence can be false while every
 * number around it is current, and nothing goes red, because only the numbers are compared.
 *
 * That is not hypothetical: row 5 of the loop block said "one entry per act" for three days after the
 * write path started recording an attempt AND an outcome (voicebox-beads-y69). The row's `seq` values
 * were derived and correct; the sentence describing them was typed and wrong. Found by a reviewer
 * reading the page against the server (voicebox-beads-smx), which is the only thing that could find it.
 *
 * WHY THE MARKER IS A SENTENCE AND NOT A PERCENTAGE: by the time this function receives `body`, the
 * interpolation has already happened — there is no seam left at which derived and typed can be told
 * apart, so any per-block fraction would itself be a typed claim, which is the defect. What is stated
 * here is true of the mechanism rather than of any one block, so it cannot rot: regeneration makes the
 * VALUES current, and it makes no promise at all about the sentences around them.
 */
const DERIVATION_NOTE =
  "values below are derived and re-checked; the prose around them is written by a person and is only as " +
  "true as its last reading";

function block(name, body) {
  return `<!-- BEGIN GENERATED: ${name} — ${DERIVATION_NOTE} -->\n${body.trim()}\n<!-- END GENERATED: ${name} -->`;
}

async function blocks() {
  const { health, routes, liveUpgradeLine, surface, loop } = await probeServer();
  const providers = registeredResolvers();
  const { tags, worklets } = pageScripts();
  const handshakes = liveHandshakes();
  const liveReachesExecutor = liveHandlerReachesExecutor();
  const dictation = /SpeechRecognition/.test(readFileSync(join(ROOT, "public/fused.js"), "utf8"));
  // A COMMITTED DOCUMENT CANNOT CONTAIN AN ABSOLUTE PATH — and the loop no longer HAS a default root to
  // report either: the active root is declared by the environment, so what belongs in the document is the
  // SHAPE of that declaration (\`declared\` and the root object), not a path that is true in one checkout.
  const declared = health.declared === true ? "true" : "false";

  // The sample runs against the deterministic provider and NAMES it: naming
  // providers[0] would attribute the script resolver's output to whatever
  // sorts first — a generated lie the moment a second resolver registered.
  const sampleProvider = providers.includes("script") ? "script" : providers[0];
  const sample = await resolveTurn("create a file called hello.txt with hi", sampleProvider);
  const unresolved = await resolveTurn("book me a flight to Lisbon", sampleProvider);

  // WHAT THE LOG DID, counted rather than described (voicebox-beads-smx, reviewer finding). The write's
  // entries are everything present after the write; the refusal's are what the next turn added. Both are
  // read from `GET /api/audit`, so the row below reports the shape the server actually produced and goes
  // red when that shape changes — which is exactly what the typed version could not do.
  // Driven ONCE and used twice (the providers block and the tool-path block): two drives of the same
  // resolver could disagree, and a document that contradicts itself in two places is worse than one
  // that is merely wrong in one.
  const verbSamples = await resolverVerbs();

  const writeEntries = loop.auditAfterWrite.entries ?? [];
  const refusalEntries = (loop.audit.entries ?? []).slice(writeEntries.length);
  const linkedAttempt = writeEntries.some((e) => e.attempt != null);

  // DOCS_DEBUG printed `live` — a variable c95e101 removed — so setting it crashed the check with a
  // ReferenceError before anything was generated (found reaching for it in voicebox-beads-qxy2). It names
  // what exists now: the captured live handshakes, and both roots.
  if (process.env.DOCS_DEBUG) console.error("DEBUG handshakes =", JSON.stringify(handshakes), "| ROOT =", ROOT, "| DOCS_ROOT =", DOCS_ROOT, "| tags =", JSON.stringify(tags));

  return {
    providers: block("providers", [
      `**Registered turn resolvers** (\`lib/resolver.mjs\`): ${providers.map((p) => "`" + p + "`").join(", ")}${providers.length === 1 ? " (single resolver)" : ""}`,
      "",
      `* **Registration & Dispatch**: \`registerResolver(name, fn)\` registers a text turn resolver; \`resolveTurn(transcript, provider = "${sampleProvider ?? "—"}")\` resolves a user transcript into a structured action.`,
      `* **Deterministic Script Resolver (\`${sampleProvider ?? "—"}\`)**: Maps common file and tool commands without requiring an external API key (for example, \`"create a file called hello.txt with hi"\` → \`${JSON.stringify(sample)}\`).`,
      `* **Supported Verbs**: ${verbSamples.map((v) => `\`${v.verb}\``).join(", ")}. Prompts outside the deterministic grammar return an explicit \`unresolved\` response (for example, \`"book me a flight to Lisbon"\` → \`${JSON.stringify(unresolved.unresolved?.slice(0, 42) + "…")}\`).`,
      `* **Live Voice Providers**: Full-duplex audio providers (${availableLiveProviders().map((p) => "`" + p + "`").join(", ")}) are registered separately via \`registerLiveProvider\` in \`lib/live-session.mjs\` and stream audio and tool calls over \`/live\`.`,
    ].join("\n")),

    routes: block("routes", [
      `The HTTP server (\`server.mjs\`, built on \`node:http\`) binds **127.0.0.1** and serves the core routes below:`,
      "",
      "| Method | Route | Probed Status |",
      "|---|---|---|",
      ...routes.map((r) => `| \`${r.method}\` | \`${r.path}\` | ${r.status}${r.matches_documented_expectation ? "" : " ⚠️ unexpected status"} |`),
      "",
      `Static frontend assets are served from \`public/\`. \`GET /api/health\` reports the active turn resolver (\`provider: "${health.provider}"\`), whether a workspace root is declared (\`declared: ${declared}\`), and the active \`root: { kind, path }\` configured via \`POST /api/root\`. Before a root is declared, root-scoped file operations return \`root-not-declared\`.`,
      "",
      liveUpgradeLine,
    ].join("\n")),

    page: block("page", [
      `\`public/index.html\` loads ${tags.map((t) => "`" + t + "`").join(", ")} from \`public/\`.`,
      worklets.length
        ? `AudioWorklet modules loaded by the frontend audio engine: ${worklets.map((w) => "`" + w + "`").join(", ")}.`
        : "**No AudioWorklet module is loaded** in the current frontend scripts.",
      "",
      "`verify.mjs` resides in `public/` as a standalone verification utility and is not loaded by `index.html`.",
    ].join("\n")),

    "live-session": block("live-session", [
      `**Live Voice Providers (\`lib/live-session.mjs\`)**: ${handshakes.map((h) => "`" + h.name + "` (`" + h.model + "`)").join(", ")}. The default fallback provider is \`${resolvedLiveProviderName()}\` (configurable via \`VOICEBOX_LIVE_PROVIDER\` or selected per session in the UI Settings dialog).`,
    ].join("\n")),

    loop: block("loop", [
      "The table below traces a complete turn executed against a temporary workspace during documentation generation:",
      "",
      "| Step | Stage | Mechanism | Verified Output |",
      "|---|---|---|---|",
      `| **1. Turn Request** | Client submits transcript | \`POST /api/turn { transcript }\` | \`"${loop.write.transcript}"\` |`,
      `| **2. Turn Resolution** | Resolver parses transcript into an action | \`resolveTurn(transcript, "${health.provider}")\` in \`lib/resolver.mjs\` | \`${JSON.stringify(loop.write.action)}\` |`,
      `| **3. Action Execution** | Executor runs action inside the active root | \`execute(action)\` in \`server.mjs\` (\`POST /api/root\`) | \`${loop.write.result?.action}\` (\`root.kind: "${loop.write.result?.root?.kind}"\`) |`,
      `| **4. Turn Response** | Server returns structured result to client | \`{ transcript, action, result }\` | \`ok: ${loop.write.result?.ok}\`, \`logged: ${loop.write.result?.logged}\` |`,
      `| **5. Audit Trail** | Append-only log records ${writeEntries.length === 1 ? "1 entry" : `**${writeEntries.length} entries**`} (${writeEntries.map((e) => `\`${e.decision}\`/\`${e.rule}\``).join(" → ") || "none"}${linkedAttempt ? ", linking outcome to attempt sequence" : ""}) and ${refusalEntries.length} entry for pre-flight refusal | \`<root>/.audit/<writer>.jsonl\` (\`core/shared-log.ts\`), \`GET /api/audit\` | ${writeEntries.map((e) => `seq ${e.seq} \`${e.decision}\``).join(", ")}; refusal: ${refusalEntries.map((e) => `seq ${e.seq} \`${e.decision}\`/\`${e.rule}\``).join(", ") || "none"} |`,
      "",
      "**Boundary & Admission Guarantees (Verified Against Live Server):**",
      `* **Undeclared Root Refusal**: Running the turn before declaring a project root returns \`refused: "${loop.beforeRoot.result?.refused}"\` (\`logged: ${loop.beforeRoot.result?.logged}\`). Once declared via \`POST /api/root\` (\`ok: ${loop.declared.ok}\`, \`reachableFromThisProcess: ${loop.declared.reachableFromThisProcess}\`), the turn succeeds.`,
      `* **Path Containment**: Attempting to read outside the workspace (\`"${loop.escape.transcript}"\`) is refused with \`refused: "${loop.escape.result?.refused}"\` and logged at audit sequence \`${loop.escape.result?.logged}\`.`,
      `* **Extension Lifecycle (\`make-tool\` → \`admit\` → \`tool\`)**:`,
      `  1. **Propose**: \`"${loop.propose.transcript}"\` resolves to \`${loop.propose.action?.verb}\` and writes a pending descriptor (\`${loop.propose.result?.action}\`, state \`${loop.propose.result?.state}\`) under \`proposals/\` without loading code.`,
      `  2. **Inspect Plan**: \`GET /api/extensions/proposals/${loop.propose.result?.action?.match(/'([^']+)'/)?.[1]}/plan\` previews the admission verdict (\`${loop.plan.gate?.decision}\`; enforced: ${Object.entries(loop.plan.gate?.enforced ?? {}).map(([c, m]) => `${c} via \`${m}\``).join(", ") || "none"}).`,
      `  3. **Host Admission**: \`POST /api/extensions/admit\` with \`x-voicebox-host-token\` admits the descriptor (\`${loop.admitted.decision}\`); requests without the host token fail with HTTP ${surface.admitNoToken.status} (\`${surface.admitNoToken.refused}\`).`,
      `  4. **Invoke**: \`"${loop.call.transcript}"\` dispatches \`${loop.call.action?.verb}\` → \`callTool("${loop.call.action?.name}")\` in \`lib/extensions.mjs\` (\`ok: ${loop.call.result?.ok}\`, files \`${JSON.stringify(loop.call.result?.files)}\`).`,
      `  5. **Inventory**: \`GET /api/extensions\` lists \`${loop.inventory.extensions?.[0]?.id}\` with declared capabilities \`[${(loop.inventory.extensions?.[0]?.declared ?? []).join(", ")}]\`, enforcement \`${JSON.stringify(loop.inventory.extensions?.[0]?.enforced)}\`, and tools \`[${(loop.inventory.extensions?.[0]?.tools ?? []).join(", ")}]\`.`,
      "",
      (loop.call.result?.files ?? []).includes("hello.txt")
        ? `**Unified Workspace Root**: Admitted file extensions operate on the active project root (\`${JSON.stringify(loop.call.result?.files)}\`).`
        : `**Extension Workspace Scope**: Admitted file extensions operate on \`VOICEBOX_WORKSPACE\` (\`${JSON.stringify(loop.call.result?.files)}\`, ${loop.extAuditLines} extension audit entries) while turn actions target the declared root (\`${loop.rootFiles.join(", ")}\`, ${loop.auditAfter.entries?.length} root audit entries).`,
    ].join("\n")),

    "tool-path": block("tool-path", [
      "User input reaches the shared action executor through three paths:",
      "",
      "| Input Path | Active | Transport | Execution Pipeline |",
      "|---|---|---|---|",
      `| **Text Composer** | ${routes.find((r) => r.path === "/api/turn")?.status === 200 ? "Yes" : "No"} | \`public/fused.js\` → \`POST /api/turn\` | \`resolveTurn()\` (\`lib/resolver.mjs\`, default \`${health.provider}\`) → \`execute()\` (\`server.mjs\`) → \`callTool()\` (\`lib/extensions.mjs\`) |`,
      `| **Browser Dictation** (\`SpeechRecognition\`) | ${dictation ? "Yes" : "No"} | \`public/fused.js\` → \`POST /api/turn\` | Same pipeline as Text Composer |`,
      `| **Live Voice Audio** | Audio: Yes; Tools: **${liveReachesExecutor ? "Yes" : "No"}** | \`public/live-voice.js\` → \`/live\` → \`lib/live-session.mjs\` | ${liveReachesExecutor ? "Provider tool call → `commandToAction()` → `execute()` → correlated tool response + `{type:\"tool\"}` UI notification" : "Audio/text streaming only"} |`,
      "",
      `**Live Session Tool Declarations**: ${handshakes.map((h) => "`" + h.name + "` declares: " + (h.tools === null ? "(not captured)" : h.tools.length ? h.tools.map((t) => "`" + t + "`").join(", ") : "**none**")).join("; ")}.`,
      "",
      `**Script Resolver Sample Utterances**: ${verbSamples.map((v) => "`\"" + v.utterance + "\"` → `" + v.verb + "`").join(", ")}.`,
    ].join("\n")),

    tools: block("tools", [
      `**Built-In Extension Primitives** (\`${PRIMITIVES.length}\` closed primitives in \`core/extensions.ts\`; extensions parameterize primitives as pure JSON descriptors rather than executing arbitrary model-authored code):`,
      "",
      "| Primitive | Capability Required | Host-Mediated Interface |",
      "|---|---|---|",
      ...PRIMITIVES.map((p) => `| \`${p}\` | ${PRIMITIVE_NEEDS[p].join(", ") || "—"} | ${PRIMITIVE_NEEDS[p].length ? PRIMITIVE_NEEDS[p].map((c) => GETS[c]).join("; ") : p === "now" ? "Returns current host timestamp" : "Isolated WebAssembly module verified by SHA-256 digest at admission and invocation under strict host memory and timeout ceilings"} |`),
      "",
      `**Capabilities Prohibited on \`${surface.placement}\` Placement**:`,
      ...admit({ id: "probe", name: "probe", description: "", source: "builtin", runsIn: "host", capabilities: [], bounds: {}, tools: [{ name: "probe", description: "", primitive: "now", params: {} }] }, "machine").cannotHave.map((line) => `* ${line}`),
      "",
      `**Extension Catalogue (\`catalogue/*.json\`, ${surface.catalogueIds.length} descriptors)**:`,
      "",
      "| Extension ID | Tools | Declared Capabilities | Bounds | Admission Verdict |",
      "|---|---|---|---|---|",
      ...catalogueVerdicts().map((c) => `| \`${c.id}\` | ${c.tools} | ${c.declared} | ${c.bounds} | ${c.verdict} |`),
      "",
      "**Named Refusal Codes by Subsystem**:",
      ...refusalNames().map((r) => `* **${r.label}**: ${r.names.map((n) => "`" + n + "`").join(", ")}`),
      "",
      "**Runtime Inspection & Admission Endpoints**:",
      `* \`GET /api/extensions\`: Returns \`{ ${surface.inventoryKeys.join(", ")} }\` (placement: \`${surface.placement}\`, catalogueCount: ${surface.catalogueCount}).`,
      `* \`GET /api/extensions/catalogue\`: Previews admission verdicts for all catalogue descriptors.`,
      `* \`GET /api/extensions/{proposals|catalogue}/<id>/plan\`: Returns capability and enforcement disclosure prior to admission.`,
      surface.probe.ok
        ? `* \`GET /api/probe\`: Runs \`tools/sandbox-probe.mjs\` and returns an observed environment report (HTTP ${surface.probe.status}; sections: ${surface.probe.sections.map((s) => "`" + s + "`").join(", ")}).`
        : `* \`GET /api/probe\`: Environment probe endpoint (HTTP ${surface.probe.status}, \`${surface.probe.refused}\`).`,
      `* \`POST /api/extensions/admit\`: Requires \`x-voicebox-host-token\` (unauthenticated requests fail with HTTP ${surface.admitNoToken.status} \`${surface.admitNoToken.refused}\`).`,
    ].join("\n")),

    config: block("config", [
      "Environment variables read by the server and runtime libraries:",
      "",
      "| Variable | Read In | Description |",
      "|---|---|---|",
      ...envVars().map((e) => `| \`${e.name}\` | ${e.files.map((f) => "`" + f + "`").join(", ")} | ${e.meaning} |`),
    ].join("\n")),
  };
}

// ── check or write ───────────────────────────────────────────────────────────

// Which document must carry which generated block. Explicit, because "missing marker fails loudly"
// only helps if the expectation is stated: the README needs the two halves Paul asked about (the
// providers and whether a live session exists), the architecture doc carries all four, and the
// operating model is prose whose claims the others check.
// ── the denylist pass: hand-written regions must not name retired things ─────
//
// FOUND WHILE LANDING THE workspace/ PHRASING FIX: docs:check verified only its
// GENERATED blocks, so a retired default sat in three hand-written lines while
// the check reported clean. A check that watches part of the thing will report
// clean about the whole of it. This pass scans ONLY the hand-written regions
// (generated blocks removed) for literals that name things that no longer exist
// — retirements, not style opinions — and refuses by name, with file and line.
//
// A line that must name the mechanism anyway (a route, a command, a refusal
// vocabulary) marks itself, visibly and greppably:
//   <!-- docs-check: names the mechanism -->
// An unmarked line does not get an exemption by asking nicely; the list is the
// list. THE NAMED LIMIT: a denylist catches RETIREMENT, not ROT — a sentence
// can become false without using a forbidden word. Progress, not coverage.
const RETIRED_LITERALS = [
  { literal: "workspace/", why: "the workspace/ default root was retired — a location claim must name the declared root (GET /api/root)" },
  { literal: "escapes the workspace", why: "the containment refusal is 'outside-root', and the workspace default no longer exists to escape" },
  { literal: "About this room", why: "retired copy — the room's own labels carry this now" },
];
const RETIRED_RES = [
  { re: /\bE\d-M\d\b|\be1m0\b/, label: "internal project id (E1-M0)", why: "name the thing, not the ticket — e.g. 'the environment library', 'the create-asset tool'" },
  { re: /\bN\d{1,3}\b/, label: "internal note number (N20 shape)", why: "say the idea, not the note number" },
];
const stripGenerated = (text) => text.replace(/<!-- BEGIN GENERATED:[\s\S]*?<!-- END GENERATED: [^>]+ -->\n?/g, "");
function retiredHits(text) {
  const MECHANISM_MARKER = "docs-check: names the mechanism";
  // raw line numbers: generated blocks are skipped by RANGE, not by stripping,
  // so every hit names the line a person would open.
  const ranges = [];
  const re = /<!-- BEGIN GENERATED:[\s\S]*?<!-- END GENERATED: [^>]+ -->\n?/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const startLine = text.slice(0, m.index).split("\n").length;
    ranges.push([startLine, startLine + m[0].split("\n").length - 1]);
  }
  const inGenerated = (n) => ranges.some(([a, b]) => n >= a && n <= b);
  const hits = [];
  text.split("\n").forEach((line, i) => {
    const n = i + 1;
    if (inGenerated(n)) return;
    if (line.includes(MECHANISM_MARKER)) return;
    for (const { literal, why } of RETIRED_LITERALS) {
      if (line.includes(literal)) hits.push(`line ${n}: retired literal "${literal}" — ${why}`);
    }
    for (const { re: r, label, why } of RETIRED_RES) {
      const m2 = line.match(r);
      if (m2) hits.push(`line ${n}: ${label} "${m2[0]}" — ${why}`);
    }
  });
  return hits;
}

const DOCS = [
  { rel: "README.md", blocks: ["providers", "live-session", "loop", "tool-path", "tools", "config"] },
  { rel: join("docs", "07-architecture.md"), blocks: ["providers", "routes", "page", "live-session", "loop", "tool-path", "tools", "config"] },
  { rel: join("docs", "08-how-it-runs.md"), blocks: [] },
];

/** Every backticked file path a document names must exist — the hand-written regions are the ones that rot. */
function missingPaths(text) {
  const named = new Set([...text.matchAll(/`((?:[\w.-]+\/)+[\w-]+\.[a-z]+)`/g)].map((m) => m[1]));
  // ROOT, not DOCS_ROOT (voicebox-beads-qxy2): a path a document names is a claim about the TREE, wherever
  // the document itself was read from.
  return [...named].filter((p) => !existsSync(join(ROOT, p))).sort();
}

function replaceBlock(text, name, body) {
  // GLOBAL: a document may carry the same block twice (07 does — the audio path appears under two headings),
  // and a non-global replace leaves the second one empty. "The block is present" and "the block says
  // something" are two different assertions, and the first one passed while the second failed.
  // THE OPENING MARKER NOW CARRIES A NOTE after the name, so this must match `name` followed by
  // ANYTHING up to the comment's close — which also migrates a document written before the note
  // existed, rather than failing to find a block that is plainly there.
  const re = new RegExp(`<!-- BEGIN GENERATED: ${name}(?:[^>]*)?-->[\\s\\S]*?<!-- END GENERATED: ${name} -->`, "g");
  if (!re.test(text)) return { text, found: false };
  return { text: text.replace(re, body), found: true };
}

/**
 * The text between a block's markers AS THE DOCUMENT CARRIES IT (the first occurrence) — the side the
 * blank-block guard has to watch. One computing site for the full pass and the static pre-pass (qxy2).
 */
function blockInner(text, name) {
  const after = text.slice(text.search(new RegExp(`<!-- BEGIN GENERATED: ${name}(?:[^>]*)?-->`)));
  return after.slice(after.indexOf("-->") + 3, after.indexOf(`<!-- END GENERATED: ${name} -->`));
}

// ── the refusals, worded once ────────────────────────────────────────────────
//
// The static pre-pass and the full pass refuse for the same reasons, and a reason worded in two places is
// two sentences that will drift apart — in the one script whose job is catching exactly that
// (voicebox-beads-qxy2). Each entry returns the lines of ONE refusal: the full pass prints one and stops,
// the pre-pass collects every one it finds. The words are the ones this script has always printed.
const REFUSE = {
  noMarker: (rel, name) => [
    `docs-check: ${rel} has no generated block named '${name}' — add the markers:`,
    `  <!-- BEGIN GENERATED: ${name} --> … <!-- END GENERATED: ${name} -->   (the note after the name is added by --write)`,
  ],
  emptyBlock: (rel, name) => [
    `docs-check: the generated block '${name}' in ${rel} is EMPTY after the replace —`,
    "  a block that says nothing is not a block that says something, and this one is blank.",
  ],
  missingPaths: (rel, gone) => [
    `docs-check: ${rel} names files that do not exist in this tree — a renamed or deleted file left the prose behind:`,
    ...gone.map((g) => `  - ${g}`),
  ],
  retired: (rel, hits) => [
    `docs-check: ${rel} carries retired literals in its hand-written regions — these name things that no longer exist:`,
    ...hits.map((r) => `  - ${r}`),
    "  a line that must name the mechanism marks itself: <!-- docs-check: names the mechanism -->",
  ],
  missingDocs: (rels) => ["docs-check: a document this check is responsible for is missing:", ...rels.map((m) => `  - ${m}`)],
  noClaimsFile: () => [`docs-check: ${relative(DOCS_ROOT, CLAIMS_FILE)} is missing — the hand-written claims pass has no policy to run.`],
  claims: (failures) => [
    `docs-check: FAILED — ${failures.length} hand-written claim(s) do not hold:`,
    ...failures.map((f) => `  - ${f}`),
    "",
    "Hand-written claims are checked for EXISTENCE and RETIREMENT, not truth — docs/claims.json is the policy",
    "and every entry carries its why. Fix the doc, or fix the claims file, and say which in the commit.",
  ],
};
/** The full pass's way with a refusal: print it, stop. */
function refuse(lines) {
  console.error(lines.join("\n"));
  process.exit(1);
}

// ── the hand-written claims ──────────────────────────────────────────────────
//
// GENERATED blocks are derived from the code, so they cannot lie about it. Everything OUTSIDE those
// blocks is hand-written, and a hand-written sentence can be false with no forbidden word in sight —
// the rot that started voicebox-beads-f0b was a sentence that survived a rebase and said a thing the
// tree no longer did. Two passes watch the hand-written half of the covered documents, both
// deliberately partial (docs/claims.json is the policy, and every entry carries its why):
//
//   REPO-PATH CLAIMS — every backtick token that looks like a repo path must exist in this tree.
//   This is the check that would have caught tonight's rot: a document claiming a mechanism "at"
//   a path that no longer exists. It reads EXISTENCE, never truth — a path that exists says
//   nothing about the sentence around it, and this pass does not pretend otherwise.
//
//   CURATED CLAIMS — docs/claims.json names literals some document must keep (require) and must
//   never carry again (forbid): the retirees from f0b's list and the load-bearing facts a doc must
//   not lose. A denylist catches RETIREMENT, not ROT — f0b's own named limit, kept here so nobody
//   mistakes the check for completeness. What neither pass can do is read a sentence for truth;
//   the inventory printed below is the honest size of that gap.
//
// A FUNCTION since voicebox-beads-qxy2, because two callers need the same answer: the static pre-pass
// (check mode, before any server) and the full pass (after the generated blocks — and in --write mode after
// they are written, as it always ran). The policy is a document too, so it is read from DOCS_ROOT; every
// path it judges is judged against ROOT.

const CLAIMS_FILE = docPath(join("docs", "claims.json"));

/** Both hand-written passes. Returns the refusal (null when every claim holds) and the counts the closing line reports. */
function claimsPass() {
  if (!existsSync(CLAIMS_FILE)) return { refusal: REFUSE.noClaimsFile(), pathClaimsChecked: 0, curatedClaims: 0 };
  const claims = JSON.parse(readFileSync(CLAIMS_FILE, "utf8"));
  const pathIgnores = (claims.pathIgnorePrefixes ?? []).map((p) => p.prefix);

  // THE HAND-WRITTEN SET IS EVERY MARKDOWN DOCUMENT, not only the three the generated blocks live in.
  // The first version of this pass iterated the DOCS list and a mutation appended to an uncovered doc
  // stayed green — the exact "a check that watches part of the thing will report clean about the whole
  // of it" defect f0b was filed for, rebuilt by me in miniature. Path claims need no markers, so they
  // are checked everywhere markdown exists; evidence receipts are exempt as history (their paths
  // describe the tree as it was). Curated claims stay scoped to the documents their entries name.
  const HANDWRITTEN_DOCS = [
    ...new Set([
      ...DOCS.map((d) => d.rel),
      ...readdirSync(docPath("docs"))
        .filter((f) => f.endsWith(".md"))
        .map((f) => join("docs", f)),
      "README.md",
      "PRODUCT.md",
      join("designs", "README.md"),
    ]),
  ].filter((rel) => existsSync(docPath(rel)) && !pathIgnores.some((p) => rel.startsWith(p)));

  const claimFailures = [];
  let pathClaimsChecked = 0;
  for (const rel of HANDWRITTEN_DOCS) {
    const text = readFileSync(docPath(rel), "utf8");
    const lines = text.split("\n");
    lines.forEach((line, index) => {
      for (const m of line.matchAll(/`([^`\n]+)`/g)) {
        let token = m[1].trim();
        token = token.replace(/:\d+$/, ""); // a :line suffix is an anchor; existence is checked, the line is not
        token = token.replace(/[.,;]+$/, "");
        if (!token.includes("/") || !/\.[a-z0-9]+$/i.test(token)) continue; // paths with an extension, not verbs or flags
        if (/[\s<>*=]/.test(token)) continue; // globs (`catalogue/*.json`), shape placeholders (`<root>/…`), and command lines are not existence claims
        if (/^(https?:|npm:|~|\.\.?\/|\/)/.test(token)) continue; // URLs, package specs, homes, site-absolute paths, and relative prose are outside this tree's claim
        if (pathIgnores.some((p) => token.startsWith(p))) continue;
        const allowed = (claims.allowPaths ?? []).some((a) => (a.doc === "*" || a.doc === rel) && a.path === token);
        if (allowed) continue;
        pathClaimsChecked++;
        if (!existsSync(join(ROOT, token))) claimFailures.push(`${rel}:${index + 1} — backtick path \`${token}\` does not exist in this tree`);
      }
    });
  }

  // A forbid entry's document that is not there is NAMED, once, rather than read (which threw): the
  // pre-pass runs these while a missing document is still only a finding, and a check that crashes on
  // the second problem cannot report the first. `require` already worked this way.
  const forbidTargetsMissing = new Set();
  for (const f of claims.forbid ?? []) {
    const targets = f.docs ?? DOCS.map((d) => d.rel);
    for (const rel of targets) {
      if (!existsSync(docPath(rel))) { forbidTargetsMissing.add(rel); continue; }
      const lines = readFileSync(docPath(rel), "utf8").split("\n");
      lines.forEach((line, i) => {
        if (line.includes(f.literal)) claimFailures.push(`${rel}:${i + 1} — FORBIDDEN literal "${f.literal}": ${f.why}`);
      });
    }
  }
  for (const rel of forbidTargetsMissing) claimFailures.push(`${rel} — named by a forbid entry in claims.json but the document is missing`);

  for (const r of claims.require ?? []) {
    const p = docPath(r.doc);
    if (!existsSync(p)) { claimFailures.push(`${r.doc} — required by claims.json but the document is missing`); continue; }
    if (!readFileSync(p, "utf8").includes(r.contains)) claimFailures.push(`${r.doc} — REQUIRED literal "${r.contains}" is gone: ${r.why}`);
  }

  return {
    refusal: claimFailures.length ? REFUSE.claims(claimFailures) : null,
    pathClaimsChecked,
    curatedClaims: (claims.forbid ?? []).length + (claims.require ?? []).length,
  };
}

// ── the static pre-pass: the cheap half refuses first ────────────────────────
//
// Everything below reads the documents and the tree, and nothing needs the scratch server: whether each
// document exists and carries its markers, whether a block is blank, whether a hand-written path names a
// file that is gone, whether a retired literal is back, whether docs/claims.json holds. These used to run
// only AFTER blocks() — after a server had booted and /api/probe had run, ~7s on 2026-09-28, most of a
// unit-lane run — and each refused alone, so a document with three problems took three runs to learn them.
// In check mode they now run FIRST, every one of them, and the run stops without booting anything.
//
// It is a SUBSET of the full pass, not a second opinion: the same predicates on the same documents,
// worded by the same REFUSE lines, so it cannot refuse anything the full pass would have let through.
// Two reads differ, deliberately. Paths are taken from the HAND-WRITTEN regions only here — the full pass
// also reads the paths inside the regenerated blocks, which needs the blocks. And a line number here is the
// document's own, the line a person opens, even when a block above it has drifted in length. When the
// pre-pass is clean the full pass runs exactly as it always has — which is what keeps every refusal the
// default invocation made before, including the ones only a live server can find.
function staticRefusals() {
  const refusals = [];
  const missing = [];
  for (const { rel, blocks: wanted } of DOCS) {
    if (!existsSync(docPath(rel))) { missing.push(rel); continue; }
    const text = readFileSync(docPath(rel), "utf8");
    for (const name of wanted) {
      if (!replaceBlock(text, name, "").found) refusals.push(REFUSE.noMarker(rel, name));
      else if (blockInner(text, name).trim() === "") refusals.push(REFUSE.emptyBlock(rel, name));
    }
    const gone = missingPaths(stripGenerated(text));
    if (gone.length) refusals.push(REFUSE.missingPaths(rel, gone));
    const retired = retiredHits(text);
    if (retired.length) refusals.push(REFUSE.retired(rel, retired));
  }
  if (missing.length) refusals.push(REFUSE.missingDocs(missing));
  const { refusal } = claimsPass();
  if (refusal) refusals.push(refusal);
  return refusals;
}

export async function runDocsCheck() {
  if (!WRITE) {
    const refusals = staticRefusals();
    if (refusals.length) {
      for (const lines of refusals) console.error(lines.join("\n"));
      console.error("docs-check: generated blocks were not compared — fix the failures above, then re-run.");
      process.exit(1);
    }
  }

  // ── the full pass: generate, compare (or write), and every check again ───────

  const generated = await blocks();

  let drifted = [];
  let missing = [];
  for (const { rel, blocks: wanted } of DOCS) {
    const p = docPath(rel);
    if (!existsSync(p)) { missing.push(rel); continue; }
    let text = readFileSync(p, "utf8");
    let changed = false;
    for (const [name, body] of Object.entries(generated)) {
      if (!wanted.includes(name)) continue;
      const r = replaceBlock(text, name, body);
      // A MISSING MARKER IS AN ERROR, not a skip. The first version `continue`d silently, which meant a
      // document could carry no generated block at all and the check would call it current — a check that
      // cannot fail, which is a description of the code rather than a check on it.
      if (!r.found) refuse(REFUSE.noMarker(rel, name));
      if (process.env.DOCS_DEBUG) console.error(`DEBUG ${rel} block=${name} found=${r.found} changed=${r.text !== text} bodyLen=${String(body).length}`);
      // THE FILE'S block, after the replacement — not the generated body, which is never empty. My first
      // version of this guard watched the wrong side and passed while the document carried a blank block.
      const inner = blockInner(text, name);
      // In WRITE mode a blank block is the thing being seeded — a new marker pair starts empty by
      // definition, and refusing to fill it made every new block impossible to add (2026-09-20).
      if (!WRITE && inner.trim() === "") refuse(REFUSE.emptyBlock(rel, name));
      if (String(body).includes("undefined")) {
        console.error(`docs-check: the generated block '${name}' for ${rel} contains the word 'undefined' —`);
        console.error("  that is a template that did not interpolate, and it reached a document once already (07-architecture.md:80).");
        process.exit(1);
      }
      if (/\/(home|tmp|Users)\//.test(String(body))) {
        console.error(`docs-check: the generated block '${name}' for ${rel} contains an absolute path — a committed document cannot carry one.`);
        process.exit(1);
      }
      if (r.text !== text) { changed = true; text = r.text; }
    }
    const gone = missingPaths(text);
    if (gone.length) refuse(REFUSE.missingPaths(rel, gone));
    const retired = retiredHits(text);
    if (retired.length) refuse(REFUSE.retired(rel, retired));
    if (!changed) continue;
    if (WRITE) { writeFileSync(p, text); console.log(`  wrote ${rel}`); }
    else drifted.push(rel);
  }

  if (missing.length) refuse(REFUSE.missingDocs(missing));

  const claimed = claimsPass();
  if (claimed.refusal) refuse(claimed.refusal);

  if (drifted.length && !WRITE) {
    console.error("docs-check: FAILED — these documents no longer describe the code:");
    for (const d of drifted) console.error(`  - ${d}`);
    console.error("");
    console.error("The system answers for itself: providers come from lib/resolver.mjs, routes from a live");
    console.error("server on a scratch port, the page's scripts from public/index.html. Fix the docs, or run:");
    // The hint regenerates the documents that DRIFTED: from a --docs-root copy, a bare `--write` would
    // rewrite the checkout's instead — the one tree the flag exists to leave alone (voicebox-beads-qxy2).
    console.error(`  node scripts/docs-check.mjs --write${DOCS_ROOT === ROOT ? "" : ` --docs-root ${DOCS_ROOT}`}`);
    process.exit(1);
  }

  console.log(
    `docs-check: ${WRITE ? "regenerated" : "OK"} — ${DOCS.reduce((n, d) => n + d.blocks.length, 0)} generated blocks across ${DOCS.length} documents, ${claimed.pathClaimsChecked} hand-written path claims and ${claimed.curatedClaims} curated claims checked`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await runDocsCheck();
}
