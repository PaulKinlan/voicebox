// scripts/docs-check.mjs — the mechanism that keeps the descriptions of this system true.
//
//   node scripts/docs-check.mjs            # check: exit 1 when a doc has drifted from the code
//   node scripts/docs-check.mjs --write    # regenerate the generated blocks in place
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
// The generated blocks live between <!-- BEGIN GENERATED: name --> and <!-- END GENERATED: name --> in the
// docs below. Anything enumerable goes in one; anything a person writes stays outside.
//
// A check that cannot fail is a description of the code, not a check on it — which is why the suite runs
// this in check mode (`tests/docs-drift.test.mjs`) and why the receipt for it includes a perturbation that
// turns it red.

import { spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import { registeredResolvers, resolveTurn } from "../lib/resolver.mjs";
import { admit, PRIMITIVES, PRIMITIVE_NEEDS, GETS } from "../core/extensions.ts";
import { availableLiveProviders, resolvedLiveProviderName } from "../lib/live-session.mjs";
import { createGeminiProvider } from "../lib/live-providers/gemini.mjs";
import { createOpenAIProvider } from "../lib/live-providers/openai.mjs";
import { functionDeclarations, liveSystemInstruction } from "../lib/commands.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WRITE = process.argv.includes("--write");

// This check describes the TREE, not the shell it runs in: a provider chosen by this machine's
// environment would print itself into a committed document.
delete process.env.LIVE_PROVIDER;
delete process.env.VOICEBOX_LIVE_PROVIDER;
delete process.env.VOICEBOX_RESOLVER;

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
  const scratch = mkdtempSync(join(tmpdir(), "voicebox-docs-check-"));
  const dirs = { workspace: join(scratch, "workspace"), extensions: join(scratch, "extensions"), root: join(scratch, "project") };
  for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });
  // THE PROBE MUST NOT INHERIT A ROOT FROM THE SHELL (248f6c6): with VOICEBOX_WORKSPACE in the operator's
  // shell the block computed `declared: true` and the document depended on the shell. Here the variable is
  // pinned to a SCRATCH PATH (never removed and never "" — an empty string kills the server on `mkdir ''`),
  // and the boot-time declaration it causes is un-declared over DELETE /api/root below, so the routes are
  // probed in a fresh server's state.
  // PIN THE CHILD'S ENVIRONMENT (the suite's own lesson, d8af9a0): with a real GEMINI_API_KEY in the shell,
  // the /live upgrade probe below was opening a REAL vendor session during a docs check. Blank keys make the
  // provider refuse by name after the 101 — which is the only fact the line reports.
  const env = { ...process.env, PORT: String(port), VOICEBOX_EXTENSIONS_DIR: dirs.extensions, VOICEBOX_WORKSPACE: dirs.workspace, GEMINI_API_KEY: "", OPENAI_API_KEY: "" };
  for (const k of ["LIVE_PROVIDER", "VOICEBOX_LIVE_PROVIDER", "VOICEBOX_PROVIDER", "VOICEBOX_RESOLVER", "VOICEBOX_INSTANCE"]) delete env[k];
  const child = spawn(process.execPath, ["server.mjs"], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  let errOut = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (errOut += d)); // read it, or a chatty server fills the pipe and stalls
  const until = Date.now() + 8000;
  try {
    let health = null;
    while (Date.now() < until) {
      // Readiness is the server's OWN stdout line ("voicebox on http://…"), not a route:
      // probing /api/health here would couple the instrument to the very claim it checks, and a
      // perturbed health route crashed the check instead of reporting drift. Found by perturbing it.
      if (out.includes("voicebox on http")) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!out.includes("voicebox on http")) throw new Error(`server did not start on ${port}: ${out.slice(0, 200)}`);
    const token = readFileSync(join(dirs.extensions, ".host-token"), "utf8").trim();
    // VOICEBOX_WORKSPACE declared a root at boot; un-declare it so the routes are probed in the state a
    // fresh server is in, and so the loop drive below can show `root-not-declared` and the declaration.
    await fetch(`http://127.0.0.1:${port}/api/root`, { method: "DELETE", headers: { "x-voicebox-host-token": token } });
    {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`);
      health = r.ok ? await r.json() : { provider: "(no /api/health answer)", workspace: "?" };
    }
    // The routes the doc may claim, probed for real. A method mismatch is a fact about the route.
    const probes = [
      ["GET", "/", 200],
      ["GET", "/api/health", 200],
      ["GET", "/api/files", 200],
      ["POST", "/api/turn", 200],
    ];
    const routes = [];
    for (const [method, path, expect] of probes) {
      const r = await fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        ...(method === "POST" ? { body: JSON.stringify({ transcript: "list files" }), headers: { "content-type": "application/json" } } : {}),
      });
      routes.push({ method, path, status: r.status, matches_documented_expectation: r.status === expect });
    }
    // ORDER MATTERS: everything that needs the server runs HERE, before `finally` kills it. The /live line
    // used to be probed AFTER this function returned — against a port nobody was listening on — and the
    // document said "closed without an HTTP response" about a server that answers 101. Found by probing
    // the line's own claim by hand (2026-09-20).
    const liveUpgradeLine = await probeLiveUpgrade(port);
    const surface = await probeExtensionSurface(port);
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
  return { beforeRoot, declared, write, escape, audit, propose, plan, admitted, call, inventory, auditAfter, extAuditLines, rootFiles };
}

/** The extension surface, asked over HTTP — including the host's act attempted from where the page stands. */
async function probeExtensionSurface(port) {
  const base = `http://127.0.0.1:${port}`;
  const inventory = await (await fetch(`${base}/api/extensions`)).json();
  const catalogue = await (await fetch(`${base}/api/extensions/catalogue`)).json();
  const admitAttempt = await fetch(`${base}/api/extensions/admit`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "anything" }),
  });
  const admitNoToken = { status: admitAttempt.status, ...(await admitAttempt.json()) };
  // The environment's self-report (GET /api/probe): the process runs tools/sandbox-probe.mjs on itself and
  // caches the report in ITS workspace — the scratch one here, so a docs check never writes into the repo.
  const probeRes = await fetch(`${base}/api/probe`);
  const probe = { status: probeRes.status, ...(await probeRes.json()) };
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
    "the gate (`core/extensions.ts`)": ["core/extensions.ts", /rule:\s*"([a-z][a-z0-9-]*)"/g],
    "the routes and the root seam (`server.mjs`, `core/root.ts`)": ["server.mjs core/root.ts", /refused:\s*"([a-z][a-z0-9-]*)"/g],
    "admitted tools at run time (`lib/extensions.mjs`)": ["lib/extensions.mjs", /refused:\s*"([a-z][a-z0-9-]*)"/g],
    "task admission/readback (`core/tasks.ts`, `lib/tasks.mjs`)": ["core/tasks.ts lib/tasks.mjs", /(?:refused:\s*|(?:refusal|fail|no)\(\s*)"([a-z][a-z0-9-]*)"/g],
  };
  return Object.entries(sources).map(([label, [files, re]]) => {
    const names = new Set();
    for (const f of files.split(" ")) for (const m of readFileSync(join(ROOT, f), "utf8").matchAll(re)) names.add(m[1]);
    return { label, names: [...names].sort() };
  });
}

/** Every environment variable the server and its libraries read, with where. */
const ENV_MEANING = {
  PORT: "the port the server binds (default 8787)",
  VOICEBOX_RESOLVER: "which TURN resolver answers `POST /api/turn` (default `script`) — **not** the live provider, which is a different concept",
  VOICEBOX_PROVIDER: "the OLD NAME of `VOICEBOX_RESOLVER`, honoured for one release: a shell that exports it keeps working and gets a line on stderr",
  VOICEBOX_WORKSPACE: "declares a machine root at boot — a decision, not a default — and is where the extension system keeps `proposals/` and `audit.jsonl`",
  VOICEBOX_EXTENSIONS_DIR: "the host's extension directory: admitted descriptors, `.host-token` (0600), `.ledger.jsonl`, and `.pairings.json` (the bearer custody store — outside every root)",
  VOICEBOX_SANDBOX_HOMES: "where a fence's writable home is bound from (default `~/sandbox-homes/<key>`) — the one place a fenced environment may write. Must live OUTSIDE /tmp: an L1.5 unit's PrivateTmp hides /tmp in its namespace and a home there fails to bind (status 226/NAMESPACE)",
  VOICEBOX_INSTANCE: "this writer's name in the active root's shared log (default `machine`)",
  VOICEBOX_BIND_RETRY_MS: "how often to retry a bind that lost the port race",
  VOICEBOX_BIND_DEADLINE_MS: "how long to keep retrying before giving up by name",
  VOICEBOX_HELLO_BOUND_MS: "how long to wait for a hello frame on /channel or /live before refusing (default 5000ms)",
  VOICEBOX_LIVE_PROVIDER: "the live transport's fallback when the session passes no provider; `/live` passes the agent-settings provider explicitly — **not** the turn resolver",
  LIVE_PROVIDER: "the OLD NAME of `VOICEBOX_LIVE_PROVIDER`, honoured for one release",
  GEMINI_API_KEY: "the Gemini Live key — without it the live session refuses to start, by name",
  OPENAI_API_KEY: "the OpenAI Realtime key — without it that provider refuses to start, by name",
};
function envVars() {
  const files = ["server.mjs", ...readdirSync(join(ROOT, "lib"), { recursive: true }).filter((f) => f.endsWith(".mjs")).map((f) => join("lib", f))];
  const where = new Map();
  for (const f of files) {
    for (const m of readFileSync(join(ROOT, f), "utf8").matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) {
      if (!where.has(m[1])) where.set(m[1], new Set());
      where.get(m[1]).add(f);
    }
  }
  return [...where.keys()].sort().map((name) => ({
    name,
    files: [...where.get(name)].sort(),
    meaning: ENV_MEANING[name] ?? "(undocumented — add a line to ENV_MEANING in scripts/docs-check.mjs)",
  }));
}

// ── the generated blocks ─────────────────────────────────────────────────────

function block(name, body) {
  return `<!-- BEGIN GENERATED: ${name} -->\n${body.trim()}\n<!-- END GENERATED: ${name} -->`;
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

  if (process.env.DOCS_DEBUG) console.error("DEBUG live =", JSON.stringify(live), "| ROOT =", ROOT, "| tags =", JSON.stringify(tags));

  return {
    providers: block("providers", [
      `Registered resolvers: ${providers.map((p) => "`" + p + "`").join(", ")}${providers.length === 1 ? " (one — a placeholder)" : ""}`,
      "",
      `* \`registerResolver(name, fn)\` is the seam; \`resolveTurn(transcript, provider = "${sampleProvider ?? "—"}")\` picks one.`,
      `* The **${sampleProvider ?? "—"}** provider handles \`write\`, \`read\` and \`list\`: \`"create a file called hello.txt with hi"\` → \`${JSON.stringify(sample)}\`.`,
      `* Anything else is **unresolved**, by design: \`"book me a flight to Lisbon"\` → \`${JSON.stringify(unresolved.unresolved?.slice(0, 42) + "…")}\`.`,
      `* The live voice providers (${availableLiveProviders().map((p) => "`" + p + "`").join(", ")}) live behind a **different** seam, \`registerLiveProvider\` in \`lib/live-session.mjs\`; none of them is a turn resolver — see the tool path below.`,
    ].join("\n")),

    routes: block("routes", [
      `The zero-dependency server (\`server.mjs\`, \`node:http\`) binds **127.0.0.1** and serves:`,
      "",
      "| method | path | probed status |",
      "|---|---|---|",
      ...routes.map((r) => `| \`${r.method}\` | \`${r.path}\` | ${r.status}${r.matches_documented_expectation ? "" : " ⚠️ differs from what this table expects"} |`),
      "",
      `Anything else that exists under \`public/\` is served from there (\`GET /static\` and a fall-through), which is how the page, its scripts and the styles arrive. \`/api/health\` answers \`provider: "${health.provider}"\`, \`declared: ${declared}\` and \`root: { kind, path }\` for the ACTIVE project root — which the environment declares (\`POST /api/root\`); the loop has no root of its own, and refuses by name (\`root-not-declared\`) until one is declared.`,
      "",
      liveUpgradeLine,   // DERIVED by probeLiveUpgrade() — this line used to be a typed sentence about state
    ].join("\n")),

    page: block("page", [
      `The page loads ${tags.map((t) => "`" + t + "`").join(" and ")} from \`public/\`.`,
      worklets.length
        ? `Audio worklets loaded by that code: ${worklets.map((w) => "`" + w + "`").join(", ")}.`
        : "**No audio worklet is loaded** — `addModule(…)` appears nowhere in the page's scripts, so the audio path is not wired on this tree.",
      "",
      "`verify.mjs` sits in `public/` but is **not** loaded by `index.html`; it is a support script, not part of the page's load set.",
    ].join("\n")),

    "live-session": block("live-session", [
      `\`lib/live-session.mjs\` is present. Registered live providers, with the model each one's handshake names (captured from the provider against a recording transport — never dialed): ${handshakes.map((h) => "`" + h.name + "` → `" + h.model + "`").join(", ")}. The library fallback is \`${resolvedLiveProviderName()}\`, overridable by \`VOICEBOX_LIVE_PROVIDER\`; the server's \`/live\` route instead passes the agent-settings provider explicitly.`,
    ].join("\n")),

    loop: block("loop", [
      "**One turn, driven end to end on a scratch root while this document was generated.** Every value in the last column was read back from the server, not typed.",
      "",
      "| step | what happens | the mechanism | driven |",
      "|---|---|---|---|",
      `| **1 · a turn starts** | words arrive | \`POST /api/turn {transcript}\` — from the composer or browser dictation; the live model's words do **not** arrive here yet (see *the tool path*) | \`"${loop.write.transcript}"\` |`,
      `| **2 · something decides** | the resolver turns words into an action, or says it cannot (\`unresolved\`) | \`resolveTurn(transcript, "${health.provider}")\` in \`lib/resolver.mjs\` — the server never parses language itself | → \`${JSON.stringify(loop.write.action)}\` |`,
      `| **3 · something acts** | the executor runs the verb in the **active root** — the one declared over \`POST /api/root\`; none is assumed | \`execute(action)\` in \`server.mjs\` | → \`${loop.write.result?.action}\` in a root of kind \`${loop.write.result?.root?.kind}\` |`,
      `| **4 · the result returns** | the page gets the whole story in one response | \`{transcript, action, result}\` — \`result.ok\`, \`result.action\`, \`result.root\`, \`result.logged\` | → \`ok: ${loop.write.result?.ok}\`, \`logged: ${loop.write.result?.logged}\` |`,
      `| **5 · the act is recorded** | one entry per act — allowed **or refused** — appended to the root's own log and readable back | \`<root>/.audit/<writer>.jsonl\` (\`core/shared-log.ts\`), \`GET /api/audit\` | → entry seq ${loop.audit.entries?.[0]?.seq}: kind \`${loop.audit.entries?.[0]?.act?.kind}\`, decision \`${loop.audit.entries?.[0]?.decision}\`, rule \`${loop.audit.entries?.[0]?.rule}\` |`,
      "",
      `**Where it fails, by name** (driven): the same turn **before any root is declared** → \`refused: ${loop.beforeRoot.result?.refused}\`, \`logged: ${loop.beforeRoot.result?.logged}\` (no root, so nowhere to hold a log — the response says so rather than omitting the field); \`"${loop.escape.transcript}"\` → \`refused: ${loop.escape.result?.refused}\`, and the refusal is itself logged as entry seq ${loop.escape.result?.logged}. Declaring the root answered \`ok: ${loop.declared.ok}\`, \`reachableFromThisProcess: ${loop.declared.reachableFromThisProcess}\`, and the turn that was refused a moment earlier then succeeded.`,
      "",
      "**The same loop, making a tool and then calling it** (driven, in this order):",
      `1. \`"${loop.propose.transcript}"\` → verb \`${loop.propose.action?.verb}\` → \`${loop.propose.result?.action}\`, state \`${loop.propose.result?.state}\` — a **file** under the extension workspace's \`proposals/\`, not loaded.`,
      `2. \`GET /api/extensions/proposals/${loop.propose.result?.action?.match(/'([^']+)'/)?.[1]}/plan\` → the gate would say \`${loop.plan.gate?.decision}\`; enforced: ${Object.entries(loop.plan.gate?.enforced ?? {}).map(([c, m]) => `${c} via \`${m}\``).join(", ") || "nothing needed"}.`,
      `3. \`POST /api/extensions/admit {id, confirm: true, decision: "admit"}\` **with the host token** (the 0600 file in the host's extension directory) → \`${loop.admitted.decision}\`. Without the token → HTTP ${surface.admitNoToken.status} \`${surface.admitNoToken.refused}\`.`,
      `4. \`"${loop.call.transcript}"\` → verb \`${loop.call.action?.verb}\` → \`callTool("${loop.call.action?.name}")\` in \`lib/extensions.mjs\` → \`ok: ${loop.call.result?.ok}\`, files \`${JSON.stringify(loop.call.result?.files)}\`.`,
      `5. \`GET /api/extensions\` now lists \`${loop.inventory.extensions?.[0]?.id}\`: declared \`${(loop.inventory.extensions?.[0]?.declared ?? []).join(", ")}\`, enforced \`${JSON.stringify(loop.inventory.extensions?.[0]?.enforced)}\`, tools \`${(loop.inventory.extensions?.[0]?.tools ?? []).join(", ")}\`.`,
      "",
      (loop.call.result?.files ?? []).includes("hello.txt")
        ? `**One root**: the admitted tool listed \`${JSON.stringify(loop.call.result?.files)}\` — the same root the turn wrote \`hello.txt\` into.`
        : `**Two roots, not one — a fact the drive exposes rather than a claim.** The turn wrote \`${loop.rootFiles.join(", ")}\` into the declared root, but the admitted tool listed \`${JSON.stringify(loop.call.result?.files)}\`: it sees the **extension workspace** (\`VOICEBOX_WORKSPACE\`), not the root declared over \`/api/root\`. Its act was recorded in that workspace's \`audit.jsonl\` (${loop.extAuditLines} entries) and **not** in the root's \`.audit/\` log (still ${loop.auditAfter.entries?.length} entries). The design says one root; the wiring today is two. When they become one, this paragraph flips and the check goes red.`,
    ].join("\n")),

    "tool-path": block("tool-path", [
      "**Three ways words reach this server; all reach the shared executor.**",
      "",
      "| path | wired today | what carries the words | what runs |",
      "|---|---|---|---|",
      `| typed in the composer | ${routes.find((r) => r.path === "/api/turn")?.status === 200 ? "yes" : "**no** (route probe failed)"} | \`public/fused.js\` → \`POST /api/turn\` | \`resolveTurn()\` (\`lib/resolver.mjs\`, provider \`${health.provider}\`) → \`execute()\` (\`server.mjs\`) → for tools, \`callTool()\` (\`lib/extensions.mjs\`) |`,
      `| dictated (browser \`SpeechRecognition\`, no key) | ${dictation ? "yes — the same route" : "**no** — `SpeechRecognition` is not in `public/fused.js`"} | \`public/fused.js\` → \`POST /api/turn\` | the same |`,
      `| spoken to the live model | audio yes; tools **${liveReachesExecutor ? "yes" : "no"}** | \`public/live-voice.js\` → \`/live\` → \`lib/live-session.mjs\` → the provider | ${liveReachesExecutor ? "provider tool call → `commandToAction()` → `execute()` → correlated tool response — and the server tells the page (`{type:\"tool\"}`), which re-reads the file list so a file the model wrote appears as it arrives" : "the model's words come back to the page as text frames; the `/live` handler calls neither `resolveTurn()` nor `execute()`"} |`,
      "",
      `What each live handshake declares, captured from the provider with the server's shared command list: ${handshakes.map((h) => "`" + h.name + "` → tools: " + (h.tools === null ? "(not captured)" : h.tools.length ? h.tools.map((t) => "`" + t + "`").join(", ") : "**none**")).join("; ")}. Extension discovery reads the current registry; invocation goes through the existing admission and runtime bounds.`,
      "",
      `Verbs the \`${health.provider}\` resolver produces, driven: ${(await resolverVerbs()).map((v) => "`\"" + v.utterance + "\"` → `" + v.verb + "`").join(", ")}. \`make-tool\` **proposes** (a pending file the host must admit); \`tool\` calls an **admitted** tool and nothing else.`,
    ].join("\n")),

    tools: block("tools", [
      `**The default tools are a closed set of ${PRIMITIVES.length} primitives** (\`PRIMITIVES\` in \`core/extensions.ts\`). A model authors a descriptor that *parameterises* one; it never authors a body, so nothing in the runtime evaluates model-written code.`,
      "",
      "| primitive | consumes | what the host hands the tool |",
      "|---|---|---|",
      ...PRIMITIVES.map((p) => `| \`${p}\` | ${PRIMITIVE_NEEDS[p].join(", ") || "—"} | ${PRIMITIVE_NEEDS[p].map((c) => GETS[c]).join("; ") || "nothing — it answers with the clock"} |`),
      "",
      `**What no tool can have on the \`${surface.placement}\` placement**, asked of the gate itself:`,
      ...admit({ id: "probe", name: "probe", description: "", source: "builtin", runsIn: "host", capabilities: [], bounds: {}, tools: [{ name: "probe", description: "", primitive: "now", params: {} }] }, "machine").cannotHave.map((line) => `* ${line}`),
      "",
      `**The catalogue** — \`catalogue/*.json\`, ${surface.catalogueIds.length} tracked descriptors (strangers' extensions you can sideload). **None is loaded until the host admits it**; the last column is what \`admit()\` says today:`,
      "",
      "| id | tools | declares | bounds | the gate's verdict |",
      "|---|---|---|---|---|",
      ...catalogueVerdicts().map((c) => `| \`${c.id}\` | ${c.tools} | ${c.declared} | ${c.bounds} | ${c.verdict} |`),
      "",
      "**What it refuses, by name** — literal refusal declarations collected from these sources:",
      ...refusalNames().map((r) => `* ${r.label}: ${r.names.map((n) => "`" + n + "`").join(", ")}`),
      "",
      `**Listable at run time** — \`GET /api/extensions\` answers \`{ ${surface.inventoryKeys.join(", ")} }\` (probed: placement \`${surface.placement}\`, catalogueCount ${surface.catalogueCount}); \`GET /api/extensions/catalogue\` previews the gate's verdict on every stranger before anything is staged; \`GET /api/extensions/{proposals|catalogue}/<id>/plan\` is the disclosure — source, declared, enforced-by-which-mechanism, what it gets, what it cannot have — before any decision.`,
      "",
      surface.probe.ok
        ? `**What the process itself can reach** — \`GET /api/probe\` runs \`tools/sandbox-probe.mjs\` on this environment and answers an **observed** report (probed: HTTP ${surface.probe.status}, sections ${surface.probe.sections.map((s) => "`" + s + "`").join(", ")}), cached with its \`when\` and recorded as an activity in the environment's own audit. It reports files, network and limits as facts with the method beside them — a different question from "which tools are admitted", answered by a different instrument.`
        : `**What the process itself can reach** — \`GET /api/probe\` exists but could not run here: HTTP ${surface.probe.status}, \`${surface.probe.refused}\`.`,
      "",
      `**Admission is the host's act**, probed from where the page stands: \`POST /api/extensions/admit\` with no token → HTTP ${surface.admitNoToken.status}, \`${surface.admitNoToken.refused}\`.`,
    ].join("\n")),

    config: block("config", [
      "Every environment variable the server and its libraries read, and where:",
      "",
      "| variable | read in | what it does |",
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
const generated = await blocks();

/** Every backticked file path a document names must exist — the hand-written regions are the ones that rot. */
function missingPaths(text) {
  const named = new Set([...text.matchAll(/`((?:[\w.-]+\/)+[\w-]+\.[a-z]+)`/g)].map((m) => m[1]));
  return [...named].filter((p) => !existsSync(join(ROOT, p))).sort();
}

function replaceBlock(text, name, body) {
  // GLOBAL: a document may carry the same block twice (07 does — the audio path appears under two headings),
  // and a non-global replace leaves the second one empty. "The block is present" and "the block says
  // something" are two different assertions, and the first one passed while the second failed.
  const re = new RegExp(`<!-- BEGIN GENERATED: ${name} -->[\\s\\S]*?<!-- END GENERATED: ${name} -->`, "g");
  if (!re.test(text)) return { text, found: false };
  return { text: text.replace(re, body), found: true };
}

let drifted = [];
let missing = [];
for (const { rel, blocks: wanted } of DOCS) {
  const p = join(ROOT, rel);
  if (!existsSync(p)) { missing.push(rel); continue; }
  let text = readFileSync(p, "utf8");
  let changed = false;
  for (const [name, body] of Object.entries(generated)) {
    if (!wanted.includes(name)) continue;
    const r = replaceBlock(text, name, body);
    // A MISSING MARKER IS AN ERROR, not a skip. The first version `continue`d silently, which meant a
    // document could carry no generated block at all and the check would call it current — a check that
    // cannot fail, which is a description of the code rather than a check on it.
    if (!r.found) {
      console.error(`docs-check: ${rel} has no generated block named '${name}' — add the markers:`);
      console.error(`  <!-- BEGIN GENERATED: ${name} --> … <!-- END GENERATED: ${name} -->`);
      process.exit(1);
    }
    if (process.env.DOCS_DEBUG) console.error(`DEBUG ${rel} block=${name} found=${r.found} changed=${r.text !== text} bodyLen=${String(body).length}`);
    // THE FILE'S block, after the replacement — not the generated body, which is never empty. My first
    // version of this guard watched the wrong side and passed while the document carried a blank block.
    const after = text.slice(text.indexOf(`<!-- BEGIN GENERATED: ${name} -->`));
    const inner = after.slice(after.indexOf("-->") + 3, after.indexOf(`<!-- END GENERATED: ${name} -->`));
    // In WRITE mode a blank block is the thing being seeded — a new marker pair starts empty by
    // definition, and refusing to fill it made every new block impossible to add (2026-09-20).
    if (!WRITE && inner.trim() === "") {
      console.error(`docs-check: the generated block '${name}' in ${rel} is EMPTY after the replace —`);
      console.error("  a block that says nothing is not a block that says something, and this one is blank.");
      process.exit(1);
    }
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
  if (gone.length) {
    console.error(`docs-check: ${rel} names files that do not exist in this tree — a renamed or deleted file left the prose behind:`);
    for (const g of gone) console.error(`  - ${g}`);
    process.exit(1);
  }
  const retired = retiredHits(text);
  if (retired.length) {
    console.error(`docs-check: ${rel} carries retired literals in its hand-written regions — these name things that no longer exist:`);
    for (const r of retired) console.error(`  - ${r}`);
    console.error("  a line that must name the mechanism marks itself: <!-- docs-check: names the mechanism -->");
    process.exit(1);
  }
  if (!changed) continue;
  if (WRITE) { writeFileSync(p, text); console.log(`  wrote ${rel}`); }
  else drifted.push(rel);
}

if (missing.length) {
  console.error("docs-check: a document this check is responsible for is missing:");
  for (const m of missing) console.error(`  - ${m}`);
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

const CLAIMS_FILE = join(ROOT, "docs", "claims.json");
if (!existsSync(CLAIMS_FILE)) {
  console.error(`docs-check: ${relative(ROOT, CLAIMS_FILE)} is missing — the hand-written claims pass has no policy to run.`);
  process.exit(1);
}
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
    ...readdirSync(join(ROOT, "docs"))
      .filter((f) => f.endsWith(".md"))
      .map((f) => join("docs", f)),
    "README.md",
  ]),
].filter((rel) => existsSync(join(ROOT, rel)) && !pathIgnores.some((p) => rel.startsWith(p)));

const claimFailures = [];
let pathClaimsChecked = 0;
for (const rel of HANDWRITTEN_DOCS) {
  const text = readFileSync(join(ROOT, rel), "utf8");
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

for (const f of claims.forbid ?? []) {
  const targets = f.docs ?? DOCS.map((d) => d.rel);
  for (const rel of targets) {
    const lines = readFileSync(join(ROOT, rel), "utf8").split("\n");
    lines.forEach((line, i) => {
      if (line.includes(f.literal)) claimFailures.push(`${rel}:${i + 1} — FORBIDDEN literal "${f.literal}": ${f.why}`);
    });
  }
}

for (const r of claims.require ?? []) {
  const p = join(ROOT, r.doc);
  if (!existsSync(p)) { claimFailures.push(`${r.doc} — required by claims.json but the document is missing`); continue; }
  if (!readFileSync(p, "utf8").includes(r.contains)) claimFailures.push(`${r.doc} — REQUIRED literal "${r.contains}" is gone: ${r.why}`);
}

if (claimFailures.length) {
  console.error(`docs-check: FAILED — ${claimFailures.length} hand-written claim(s) do not hold:`);
  for (const f of claimFailures) console.error(`  - ${f}`);
  console.error("");
  console.error("Hand-written claims are checked for EXISTENCE and RETIREMENT, not truth — docs/claims.json is the policy");
  console.error("and every entry carries its why. Fix the doc, or fix the claims file, and say which in the commit.");
  process.exit(1);
}

if (drifted.length && !WRITE) {
  console.error("docs-check: FAILED — these documents no longer describe the code:");
  for (const d of drifted) console.error(`  - ${d}`);
  console.error("");
  console.error("The system answers for itself: providers come from lib/resolver.mjs, routes from a live");
  console.error("server on a scratch port, the page's scripts from public/index.html. Fix the docs, or run:");
  console.error("  node scripts/docs-check.mjs --write");
  process.exit(1);
}

console.log(
  `docs-check: ${WRITE ? "regenerated" : "OK"} — ${DOCS.reduce((n, d) => n + d.blocks.length, 0)} generated blocks across ${DOCS.length} documents, ${pathClaimsChecked} hand-written path claims and ${(claims.forbid ?? []).length + (claims.require ?? []).length} curated claims checked`,
);
