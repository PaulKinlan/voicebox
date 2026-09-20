#!/usr/bin/env node
// voicebox server — the thinnest host for the loop:
//   browser captures a spoken turn -> POST /api/turn -> resolver -> action -> executor.
// Zero dependencies: node:http for the server, node:fs for the workspace.
// The resolver is a provider seam (lib/resolver.mjs) — swap it, don't rewrite the server.
import { createServer } from "node:http";
import { execFile, execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveTurn } from "./lib/resolver.mjs";
import { ROOT_FACTS, ROOT_NOT_DECLARED, describeRoot, noRootDeclared, reachableFrom, resolveInRoot, rootVanished } from "./core/root.ts";
import {
  AGENT_BASE_INSTRUCTION,
  DEFAULT_AGENT_SETTINGS,
  PERSONALITIES,
  PROVIDERS,
  composeAgentInstruction,
  validateAgentSettings,
} from "./core/agent-settings.ts";
import { auditFileName, makeEntry, mergeAudit, nextSeq, parseEntry, resumeSeq, serializeEntry } from "./core/audit.ts";
import { activityEntry } from "./core/shared-log.ts";
import { randomBytes } from "node:crypto";
import {
  ENV_UNREACHABLE,
  listUnreadable,
  parseEnvironment,
  unreachable,
} from "./core/environment.ts";
import * as extensions from "./lib/extensions.mjs";
import { upgrade as wsUpgrade } from "./lib/ws-server.mjs";
import { createLiveSession, LIVE_MODEL, inputRateRequiredBy, resolvedLiveProviderName } from "./lib/live-session.mjs";

// Module-relative, decoded: `new URL(...).pathname` percent-encodes spaces and
// silently points every read at a directory that does not exist.
const ROOT = path.dirname(fileURLToPath(import.meta.url));
// Movable workspace (tests point it at scratch; see lib/extensions.mjs).
const WORKSPACE = process.env.VOICEBOX_WORKSPACE ?? path.join(ROOT, "workspace");

// ── THE ACTIVE ROOT (core/root.ts is the seam) ────────────────────────────────────────────────
// The loop does not invent a root, and it has NO DEFAULT. It acts on the ACTIVE PROJECT'S root,
// which the environment declares (POST /api/root) and which may be any of the three kinds. Two of
// them this process cannot reach, and it says so by name rather than quietly writing somewhere else.
//
// WHY THERE IS NO DEFAULT CONSULTED WHEN NOBODY DECLARED ONE: a default is a decision nobody made,
// and `workspace/` was exactly that — the second root the one-root change was supposed to retire,
// still sitting there as the thing a fresh placement falls back to. So the absence is an explicit,
// NAMED state (`root-not-declared`, whose why names the side that declares one) and no act happens.
//
// `VOICEBOX_WORKSPACE` still exists, but as a DECLARATION rather than a default: an operator who
// sets it has said where the files are, which is the same thing the environment says over HTTP.
// THE DEFAULT ROOT, and the note that belongs with it (isocan-wasm, review of e1m0/one-root):
// the default stays a machine root at `workspace/`, and THREE test files depend on that literal —
// channel.test.mjs:18, extensions.test.mjs:28/83 and voicebox.test.mjs:25. They are isolated (each
// spawns its own server on its own port, so no lane's declaration reaches them) and they exercise
// the default root, which is correct today. If the default ever stops being `workspace/`, those
// three are the readers that need the same treatment the retired "escapes the workspace" message
// got — a grep for the old literal is the check, and it should be run before changing this line.
/** null until somebody declares one — see the note above: no default is consulted when it is null. */
let active = null;

// ── THE ENVIRONMENT REGISTRY (core/environment.ts is the seam) ───────────────────────────────
// The list of hosts the page can act in, SERVER-OWNED so it is the same from every browser (Paul:
// "I might open the web page from many browsers so we lose client-side storage but sync on
// environments via server"). One file, one writer (this process), atomic. It lives in the server's
// own workspace so no active root has to exist and the list never depends on a project.
//
// THE TWO ABSENCES ARE DISTINCT, one level up from the root seam's pair: an unreadable registry file
// (`environment-list-unreadable` — fix the file) is not an unreachable host (`environment-unreachable`
// — start the service), and neither is the empty state (a fresh server, no environments yet — not an
// error at all). A list that showed a host that is not there without saying so would be the same
// defect as a footer promising files the live path could not write.
const ENV_FILE = path.join(WORKSPACE, "environments.json");

/** Read the registry. An absent file is the empty list; an unreadable/corrupt file is the named refusal. */
function readEnvironments() {
  if (!existsSync(ENV_FILE)) return { ok: true, environments: [], declared: false };
  try {
    const parsed = JSON.parse(readFileSync(ENV_FILE, "utf8"));
    const list = Array.isArray(parsed?.environments) ? parsed.environments : [];
    return { ok: true, environments: list, declared: true };
  } catch (err) {
    return { ok: false, ...listUnreadable(err?.message ?? "it is not JSON") };
  }
}

/** Write the registry atomically (tmp + rename), so a crashed write never leaves a torn list. */
function writeEnvironments(environments) {
  mkdirSync(WORKSPACE, { recursive: true });
  const tmp = `${ENV_FILE}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ environments }, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, ENV_FILE);
}

// ── AUTO-PROBE: the environment's capability report, observed and recorded ──────────────────────
// The probe script ships in tools/ so the harness runs the SAME probe the survey measured, not a
// copy. The report is cached next to the registry so the list can show it without re-running code
// on every read; the `when` inside it is the freshness marker.
const PROBE_FILE = path.join(WORKSPACE, "probe.json");
const PROBE_SCRIPT = path.join(ROOT, "tools", "sandbox-probe.mjs");

function readProbeCache() {
  try {
    const parsed = JSON.parse(readFileSync(PROBE_FILE, "utf8"));
    return parsed && typeof parsed === "object" && parsed.when ? parsed : null;
  } catch {
    return null;
  }
}

function writeProbeCache(report) {
  mkdirSync(WORKSPACE, { recursive: true });
  writeFileSync(PROBE_FILE, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
}

/** Run the probe in THIS process's environment. JSON on stdout; a non-zero exit is the boundary
 *  showing itself, and any stdout it produced is still the report. */
function runProbe() {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [PROBE_SCRIPT], { timeout: 15000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      const text = String(stdout ?? "").trim();
      if (!text) return reject(err ?? new Error("the probe printed nothing"));
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(err ?? new Error("the probe printed something that was not JSON"));
      }
    });
  });
}

/**
 * The probe's act, in the environment's own audit — because it ran unprompted, and the record is
 * what lets the system say so. An `activity` entry, not an `act`: no tier decision was made. The
 * write is best-effort (the probe's answer is the route's job; the audit is the record's), and it
 * is skipped rather than invented when this process has no loggable root.
 */
function recordProbeAct(report) {
  if (!loggableRoot()) return;
  try {
    const dir = path.join(active.root.path, ".audit");
    mkdirSync(dir, { recursive: true });
    const file = auditPathFor(active.root);
    resumeLog();
    const base = {
      seq: nextSeq(),
      instance: INSTANCE,
      actor: { name: "voicebox-server", harness: "voicebox", session: null, cwd: ROOT },
      project: active.project,
      root: `machine:${active.root.path}`,
      turn: null,
      at: new Date().toISOString(),
    };
    const entry = activityEntry(base, "probed itself (auto-probe)", `sandbox-probe @ ${report.when ?? "unknown time"}`);
    appendFileSync(file, `${serializeEntry(entry)}\n`);
  } catch {
    // A record that cannot be written must not fail the probe — but the route's answer stands on its own.
  }
}

/**
 * The registry, with each entry's reachability PROBED LAZILY (on read) rather than at declaration.
 * The local server this process is on is always a row; remote rows are probed over HTTP. A host that
 * does not answer is named unreachable, never silently shown as ready.
 */
async function environmentsWithStatus() {
  const stored = readEnvironments();
  if (!stored.ok) return stored;
  // The local server is an implicit row: this host, reachable by construction, ambient on loopback.
  const local = {
    key: "local",
    label: "this machine",
    kind: "server",
    origin: "same-origin",
    home: active ? active.root : null,
    // The probe report, if this host has probed itself: the boundary and the capability are the SAME
    // observed report, split by what they answer (boundary: what is fenced; capability: what is present).
    boundary: readProbeCache(),
    capability: readProbeCache(),
    reach: "ambient",
    reachable: true,
    refused: null,
    why: null,
  };
  const rows = [local];
  for (const env of stored.environments) {
    // boundary/capability are OBSERVED, never inherited from the file: the probe is the ONLY writer
    // of those fields, so a hand-edited or stale descriptor cannot echo a claim as a measurement.
    // A stored row arrives here with both re-nulled; only a live probe fills them.
    const declared = { ...env, boundary: null, capability: null };
    if (env.kind !== "server" || !env.origin) {
      rows.push({ ...declared, reachable: null, refused: null, why: "the browser environment is always present" });
      continue;
    }
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2500);
      const answer = await fetch(`${env.origin}/api/health`, { signal: controller.signal }).finally(() => clearTimeout(timer));
      const no = unreachable(env.label, env.origin);
      rows.push({ ...declared, reachable: answer.ok, refused: answer.ok ? null : no.refused, why: answer.ok ? null : no.why });
    } catch {
      const no = unreachable(env.label, env.origin);
      rows.push({ ...declared, reachable: false, refused: no.refused, why: no.why });
    }
  }
  return { ok: true, environments: rows, declared: true };
}

// ── THE AGENT'S OWN SETTINGS (provider · voice · personality) ─────────────────────────────────
// Kept in memory, and the payload SAYS SO rather than implying durability: a restart resets the
// request, and a person can see that instead of discovering it.
// (No type annotation here: this file is plain JS. The shapes live in core/agent-settings.ts, and
// the module is imported for its values — a `type` import would be a syntax error in a .mjs file,
// which is worth knowing because node --check is how you find that out.)
let agentSettings = { ...DEFAULT_AGENT_SETTINGS };

/** What a LIVE session actually started with — the difference between "stored" and "in use". */
let runningSession = null;

/** A declaration made by the operator at boot (VOICEBOX_WORKSPACE), which is a decision, not a default. */
if (process.env.VOICEBOX_WORKSPACE) {
  const declared = path.resolve(process.env.VOICEBOX_WORKSPACE);
  if (existsSync(declared) && statSync(declared).isDirectory()) {
    active = { project: path.basename(declared), root: { kind: "machine", path: realpathSync(declared) }, declaredAt: new Date().toISOString(), declaredBy: "VOICEBOX_WORKSPACE" };
  } else {
    console.error(`[root] VOICEBOX_WORKSPACE='${process.env.VOICEBOX_WORKSPACE}' is not a directory — no root is declared`);
  }
}

// This process is a WRITER of the root it acts on, so it keeps its own file in that root's log —
// one file per (root, writer), which is what the log has always meant. Without this the loop would
// be a stranger writing into somebody's project with no record of what it did, and the machine root
// would be the one root in the product with no audit at all.
const INSTANCE = process.env.VOICEBOX_INSTANCE ?? "machine";

/**
 * The log lives WITH THE ROOT, and only for a root this process can actually name.
 *
 * The guard is not defensive decoration: a root of kind `opfs` or `handle` carries a VIRTUAL path
 * (`v1/projects/atlas`, or a project name), and `path.join` on it produced a real directory inside
 * whatever the process's cwd happened to be. That is how a test run came to commit its own audit
 * files into the repository — an instrument writing into the thing it measures.
 */
function loggableRoot() {
  return active && active.root.kind === "machine" && path.isAbsolute(active.root.path);
}

function auditPathFor(root) {
  return path.join(root.path, ".audit", auditFileName(INSTANCE, `machine:${root.path}`));
}

/** Read this writer's file back so `seq` continues instead of restarting on every restart. */
function resumeLog() {
  try {
    const entries = readFileSync(auditPathFor(active.root), "utf8")
      .split("\n")
      .map(parseEntry)
      .filter(Boolean);
    resumeSeq(entries, INSTANCE);
  } catch {
    resumeSeq([], INSTANCE); // no log yet
  }
}

/** Append one entry. A refusal is an entry too: a log of successes cannot answer "what did it try". */
function logAct(act, decision, rule, result, observed, turn = null) {
  if (!loggableRoot()) {
    // Not silently skipped: the caller reports `logged: null` and `logRefused`, so the missing entry
    // is a fact on the response rather than a hole in the record.
    return null;
  }
  try {
    const dir = path.join(active.root.path, ".audit");
    mkdirSync(dir, { recursive: true });
    const file = auditPathFor(active.root);
    resumeLog();
    const entry = makeEntry(
      active.project,
      `machine:${active.root.path}`,
      INSTANCE,
      { name: "voicebox-server", harness: "voicebox", session: null, cwd: ROOT },
      act,
      decision,
      rule,
      result,
      observed,
      turn,
    );
    appendFileSync(file, `${serializeEntry(entry)}\n`);
    return entry;
  } catch {
    // A log that cannot be written must not take the act with it — but the act's outcome is then
    // reported without an entry, which the caller's `logged` field makes visible rather than silent.
    return null;
  }
}

/** What the world says happened. The audit reads the world, never the caller's account. */
function observeUnderRoot(relPath) {
  try {
    const stat = statSync(path.join(active.root.path, relPath));
    return { exists: true, bytes: stat.size, mtime: new Date(stat.mtimeMs).toISOString() };
  } catch {
    return { exists: false };
  }
}
const PUBLIC = path.join(ROOT, "public");
mkdirSync(WORKSPACE, { recursive: true });

const PROVIDER = process.env.VOICEBOX_PROVIDER ?? "script";
const PORT = Number(process.env.PORT ?? 8787);

const json = (res, code, body) => {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

// WHICH REVISION IS THIS SERVER?
//
// 2026-09-19: Paul lost an hour to "the voice does not work with the API keys".
// The API server had been started at 19:19, before /live existed at 19:45, so
// it answered `{"error":"not found"}` — and the page's build stamp said
// `main @ fbaf0ca` the whole time, because it reported the PAGE's revision and
// nothing about the server's. Vite reloads the page on every edit; this process
// never does. So the server is the half that goes stale, and it is the half that
// was invisible. It now names itself, at startup, in its own health response.
const git = (args, fallback) => {
  try {
    return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim() || fallback;
  } catch {
    return fallback;
  }
};
const BUILD = (() => {
  const branch = git(["branch", "--show-current"], "(detached)");
  const remote = git(["rev-parse", "--short", `origin/${branch}`], "");
  return {
    branch,
    commit: git(["rev-parse", "--short", "HEAD"], "unknown"),
    remote: remote || null,
    ahead: remote ? Number(git(["rev-list", "--count", `origin/${branch}..HEAD`], "0")) : null,
    dirty: git(["status", "--porcelain", "--untracked-files=no"], "") !== "",
    startedAt: new Date().toISOString(),
  };
})();

// Normalising is not checking: `resolve` collapses `..`, then the answer is
// yes-or-no — is the candidate inside the workspace? (chrome-agent-platform-0j1a
// class: `basename("..")` is `".."`, so join+basename silently rewrote the
// escape instead of refusing it.)
function containedIn(baseDir, p) {
  const rel = path.relative(baseDir, p);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function contained(p) {
  return containedIn(WORKSPACE, p);
}

/**
 * The machine placement's ADDITION to the shared containment: `core/paths.ts` is lexical, and a
 * lexical check follows a symlink out. So the lexical pass runs first (one implementation, refusing
 * `..` at any depth) and this pass resolves the real path — of the file if it exists, of its
 * directory if it does not — against the root's real path.
 */
function machineRootReal() {
  return realpathSync(active.root.path);
}

function machineContained(candidate) {
  const rootReal = machineRootReal();
  let probe = candidate;
  try {
    realpathSync(candidate);
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
    probe = path.dirname(candidate); // a write to a file that does not exist yet: check its directory
  }
  const real = realpathSync(probe);
  return containedIn(rootReal, real) || real === rootReal;
}

/**
 * Is the declared root still there? Asked BEFORE any filesystem access, because the filesystem is
 * where the hang came from: `realpathSync` on a deleted directory throws, and a throw inside an
 * unawaited async route callback leaves the caller waiting for a response that will never come.
 *
 * Only the machine kind can be checked from here — a page-owned root (OPFS, a picked handle) is
 * reachability's business, and that refusal already names who can act.
 */
function rootMissing() {
  if (!active) return noRootDeclared();
  if (active.root.kind !== "machine") return null;
  try {
    if (existsSync(active.root.path) && statSync(active.root.path).isDirectory()) return null;
  } catch {
    /* an unstattable root is a missing one */
  }
  return rootVanished(active.root.path);
}

/**
 * EVERY REQUEST GETS AN ANSWER. A route body that throws used to hang the caller: the async callback
 * was never awaited, so nothing wrote a response — measured, with the directory deleted under a live
 * declaration. The named refusal above is the product fix; this is the structural one, because a
 * server that answers "server-error" is wrong in a way a reader can act on and a server that says
 * nothing is not.
 */
function answerOnce(res, handler) {
  void (async () => {
    try {
      await handler();
    } catch (e) {
      console.error(`[route] ${e?.stack ?? e}`);
      try {
        if (!res.headersSent) json(res, 500, { ok: false, refused: "server-error", why: String(e?.message ?? e) });
        else res.end();
      } catch {
        /* the response is already gone */
      }
    }
  })();
}

/** Resolve a name through the seam, or the refusal that says why — used by every path below. */
function resolveActive(name) {
  if (!active) return { ...noRootDeclared() };
  const reach = reachableFrom(active.root, "machine");
  if (!reach.ok) return { ok: false, refused: reach.refused, why: reach.why };
  const resolved = resolveInRoot(active.root, name);
  if (!resolved.ok) return { ok: false, refused: resolved.rule, why: resolved.why };
  if (!machineContained(resolved.path)) {
    return { ok: false, refused: "outside-root", why: `'${name}' resolves outside '${active.root.path}' by real path` };
  }
  return { ok: true, path: resolved.path };
}

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".ts": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".png": "image/png",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".ico": "image/x-icon",
  ".wasm": "application/wasm",
  ".wat": "text/plain; charset=utf-8",
};

// Source served as source: the E1-M0 page imports core/ and browser/ directly, so the browser
// runs the SAME files the tests run and there is no build step and no second copy to drift from
// (N18, one level up). Node's own type-stripping is the transform — not a compiler, not a dep.
const SOURCE_DIRS = new Set(["core", "browser", "tools", "tests"]);

function serveSource(res, url) {
  const rel = url.pathname.replace(/^\/+/, "");
  const dir = rel.split("/")[0];
  const file = path.resolve(ROOT, rel);
  const allowed = path.join(ROOT, dir) + path.sep;
  if (!SOURCE_DIRS.has(dir) || !file.startsWith(allowed) || !existsSync(file)) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    return res.end("not found");
  }
  const ext = path.extname(file);
  const type = MIME_TYPES[ext];
  if (!type) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    return res.end("not found");
  }
  const body = ext === ".ts"
    ? stripTypeScriptTypes(readFileSync(file, "utf8"), { mode: "strip" })
    : readFileSync(file);
  res.writeHead(200, { "content-type": type });
  res.end(body);
}

// Resolves a request path under PUBLIC, preserving subdirectories (e.g. /fonts/...)
// while strictly enforcing that the target cannot escape PUBLIC (no .. or symlink escapes).
function resolvePublicFile(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const candidate = path.resolve(PUBLIC, "." + decoded);
  if (!containedIn(PUBLIC, candidate)) return null;
  try {
    const real = realpathSync(candidate);
    if (!containedIn(PUBLIC, real)) return null;
    return real;
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}

// The executor: the one place that touches the build environment. It grows;
// the resolver stays the same shape.
async function execute(action) {
  // make-tool: the model's authoring act (N10). It PROPOSES — a tier 1 write
  // into workspace/proposals/ — and nothing else. Registration is the host's
  // route (POST /api/extensions/admit), which the model does not reach.
  if (action.verb === "make-tool") {
    const r = extensions.propose(action.tool, "model");
    if (!r.ok) return r;
    return { ok: true, action: `proposed tool '${r.id}'`, state: r.state, note: "the proposal is NOT loaded — the host reviews and admits it (GET /api/extensions/proposals/<id>/plan, then POST /api/extensions/admit)" };
  }
  // tool: the ONLY way a tool runs — and only ADMITTED tools are here.
  if (action.verb === "tool") {
    return extensions.callTool(action.name, action.args ?? {});
  }
  // `logged` is present as null rather than absent: "there is no entry" must be a fact on the
  // response, not something a reader has to notice the absence of.
  if (!active) return { ...noRootDeclared(), error: `refused: ${ROOT_NOT_DECLARED}`, root: null, logged: null };
  const vanished = rootMissing();
  if (vanished) return { ...vanished, error: `refused: ${vanished.refused}`, root: active.root, logged: null };
  if (action.verb === "list") {
    const reach = reachableFrom(active.root, "machine");
    if (!reach.ok) return { ok: false, refused: reach.refused, error: `refused: ${reach.refused}`, why: reach.why, root: active.root };
    return { ok: true, action: `listed ${active.project}`, files: readdirSync(active.root.path).filter((f) => !f.startsWith(".")), root: active.root };
  }
  const name = String(action.name ?? "");
  if (!name) return { ok: false, error: "action has no name" };
  const resolved = resolveActive(name);
  if (!resolved.ok) {
    // A refusal is recorded as well: the log answers "what did it try", not only "what did it do".
    const kind = action.verb === "read" ? "read" : "write";
    const entry = logAct({ kind, target: name, tool: "turn" }, "refuse", resolved.refused, "refused", null, action.turn ?? null);
    return {
      ok: false,
      refused: resolved.refused,
      logged: entry ? entry.seq : null,
      ...(entry ? {} : { logRefused: resolved.refused === "root-not-reachable-from-here" ? "root-not-reachable-from-here" : "log-not-written" }),
      error: `refused: ${resolved.refused === "outside-root" ? "path escapes the active project root" : resolved.refused}`,
      why: resolved.why,
      root: active.root,
      logged: entry ? entry.seq : null,
    };
  }
  // Dotfiles are behind the same line as the listing: containment first (so `..` and
  // traversal keep their own, stronger refusal), then a hidden file inside the root is
  // refused — otherwise a declared root pointed at a sensitive directory (the host's
  // own extensions dir) hands over its secrets — including the admission token —
  // through a read, or loses them to a write over it. Driven chain, 2026-09-20:
  // declare -> read .host-token -> admit.
  if (action.verb === "read" || action.verb === "write") {
    const base = path.basename(resolved.path);
    if (base.startsWith(".")) {
      const entry = logAct({ kind: action.verb === "write" ? "write" : "read", target: name, tool: "turn" }, "refuse", "dotfile-refused", "refused", null, action.turn ?? null);
      return { ok: false, refused: "dotfile-refused", logged: entry ? entry.seq : null, error: "refused: dotfile-refused", why: "dotfiles are neither readable nor writable through the loop — the listing hides them and so does this verb; host secrets live behind that line", root: active.root };
    }
  }
  const candidate = resolved.path;
  if (action.verb === "write") {
    // THE WORST OUTCOME THIS SYSTEM CAN PRODUCE, refused here: a write with ABSENT content
    // used to fall into `?? ""` — the existing file was EMPTIED and the result said ok:true,
    // so nothing downstream could tell the data was gone (astra's live-tools review,
    // 2026-09-20; shared by the text path, so it is fixed at the shared validation).
    // Absent ≠ empty: `content: ""` is an intentional empty file and writes fine; a MISSING
    // argument is a malformed act, refused by name, and the file on disk is UNTOUCHED.
    if (action.content == null) {
      const entry = logAct({ kind: "write", target: name, tool: "turn" }, "refuse", "missing-content", "refused", null, action.turn ?? null);
      return {
        ok: false,
        refused: "missing-content",
        logged: entry ? entry.seq : null,
        error: "refused: missing-content",
        why: `the write to '${name}' carried no content — pass content explicitly (an empty string is a valid, intentional empty file). The existing file was NOT touched.`,
        root: active.root,
      };
    }
    writeFileSync(candidate, action.content);
    const entry = logAct({ kind: "write", target: name, tool: "turn" }, "allow", "writes-inside", "ok", observeUnderRoot(name), action.turn ?? null);
    return {
      ok: true,
      action: `wrote ${name} (${action.content.length} bytes)`,
      file: name,
      root: active.root,
      logged: entry ? entry.seq : null,
      auditLocation: `${active.root.path}/.audit/`,
    };
  }
  if (action.verb === "read") {
    let content;
    try {
      content = readFileSync(candidate, "utf8");
    } catch (e) {
      // A missing file is a NAMED REFUSAL, not a throw into the route — a throw in a batch
      // (the live tool-call path) used to swallow every sibling's response with it.
      if (e.code === "ENOENT") {
        const entry = logAct({ kind: "read", target: name, tool: "turn" }, "refuse", "not-found", "refused", null, action.turn ?? null);
        return { ok: false, refused: "not-found", logged: entry ? entry.seq : null, error: "refused: not-found", why: `'${name}' is not in ${active.project}`, root: active.root };
      }
      throw e;
    }
    const entry = logAct({ kind: "read", target: name, tool: "turn" }, "allow", "reads-inside", "ok", observeUnderRoot(name), action.turn ?? null, [{ path: name, bytes: Buffer.byteLength(content) }]);
    return { ok: true, action: name, content, root: active.root, logged: entry ? entry.seq : null };
  }
  return { ok: false, error: `unknown verb: ${action.verb}` };
}

/**
 * requested · applied · pending — computed, not stored, so it cannot go stale.
 *
 * `applied` reads the live path (the resolved provider and its model) and reports `null` for the two
 * settings no session reads yet, with the reason. Making `voice` or `personality` say "applied" before
 * a provider carries them would be the exact lie this payload exists to prevent.
 */
function agentSettingsPayload(extra = {}) {
  const provider = PROVIDERS[agentSettings.provider];
  const keyPresent = Boolean(process.env[provider.requires.env]);
  const capabilities = Object.values(PROVIDERS).map((facts) => ({
    id: facts.id,
    label: facts.label,
    model: facts.model,
    voices: facts.voices,
    available: Boolean(process.env[facts.requires.env]),
    ...(process.env[facts.requires.env] ? {} : { refused: "provider-not-configured", why: `${facts.requires.env} is not set — ${facts.requires.why}` }),
  }));

  return {
    ok: true,
    requested: agentSettings,
    applied: {
      // What the NEXT session will use (the setting is passed to createLiveSession, so this is a fact
      // rather than a promise), and `running` says what a live session started with — a person asking
      // "did my change take effect?" is usually asking about that second one.
      provider: agentSettings.provider,
      model: provider.model,
      // No provider reads a voice or an instruction yet. Stated as null-with-a-reason rather than
      // echoed back from the request.
      voice: null,
      instruction: null,
    },
    pending: {
      voice: provider.voices.length
        ? "stored, not applied: no provider carries a voice into its session yet (the setting lands with the provider seam)"
        : "this provider offers no voices",
      personality: "stored, not applied: no provider receives an instruction yet (the tone layer lands with the live-tools lane)",
    },
    base: {
      // The mandatory half, shown so a person can see what a personality is layered ON. Read-only by
      // construction: nothing here accepts a base instruction.
      instruction: AGENT_BASE_INSTRUCTION,
      editable: false,
      note: "personality appends a tone layer beneath these rules; it cannot replace them",
    },
    personalities: Object.values(PERSONALITIES).map((p) => ({ id: p.id, label: p.label })),
    // Which providers a person may choose AT ALL, and the ones that cannot run say why — the rule that
    // stops an option being offered that fails the moment it is chosen.
    capabilities,
    runningSession,
    providerAvailable: keyPresent,
    ...(keyPresent ? {} : { refused: "provider-not-configured", why: `${provider.requires.env} is not set — ${provider.requires.why}` }),
    persisted: "memory (until this process restarts)",
    ...extra,
  };
}

const routes = {
  // THE AGENT'S SETTINGS, and the distinction this whole surface exists to keep:
  //   requested — what a person asked for, stored whether or not anything can use it yet
  //   applied   — what the RUNNING session can be shown to use, never what was asked for
  //   pending   — for each setting that is stored but not yet read by a session, WHY
  // A setting that silently does nothing is worse than no setting, so the gap is in the payload.
  "GET /api/agent-settings": (req, res, url) => json(res, 200, agentSettingsPayload()),
  "PUT /api/agent-settings": (req, res, url) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => answerOnce(res, async () => {
      let asked;
      try {
        asked = JSON.parse(body || "{}");
      } catch {
        return json(res, 400, { ok: false, refused: "bad-request", why: "body must be JSON: {provider?, voice?, personality?}" });
      }
      const checked = validateAgentSettings(asked, agentSettings);
      if (!checked.ok) return json(res, 400, { ok: false, refused: checked.refused, why: checked.why });
      // Changing the provider does NOT start a session: the next one this page opens will use it, and
      // the payload says the live session is untouched rather than implying the change took effect now.
      agentSettings = checked.value;
      return json(res, 200, agentSettingsPayload({ note: "stored — a session already running keeps the provider it started with" }));
    }));
    return;
  },

  // UN-DECLARE: back to `root-not-declared`, deliberately and by request. The gate asserts that
  // state positively, and a state you cannot return to is one you can only test once per process —
  // and for a person, "close the project" has to have an expression that is not "restart the server".
  //
  // ORDERING LESSON, kept where the next person will read it: the harness that found the vanished-root
  // hang deleted its scratch directory BEFORE restoring the previous root, and left the live server
  // holding a declaration pointing at nothing. RESTORE THE PREVIOUS STATE FIRST, then remove your own.
  "DELETE /api/root": (req, res, url) => {
    const previous = active;
    active = null;
    return json(res, 200, {
      ok: true,
      declared: false,
      unDeclared: previous ? { project: previous.project, root: previous.root } : null,
      refused: ROOT_NOT_DECLARED,
      why: noRootDeclared().why,
    });
  },
  "GET /api/health": (req, res, url) => json(res, 200, {
    ok: true,
    provider: PROVIDER,
    // There is no default root to report; `declared` says whether one exists at all.
    declared: Boolean(active),
    root: active ? active.root : null,
    project: active ? active.project : null,
    refused: active ? null : ROOT_NOT_DECLARED,
    why: active ? null : noRootDeclared().why,
    build: BUILD,
  }),
  // THE SEAM, read side: which root is the loop writing into, and may this process act on it?
  "GET /api/root": (req, res, url) => {
    if (!active) {
      const absent = noRootDeclared();
      return json(res, 200, { ok: true, declared: false, project: null, root: null, reachableFromThisProcess: false, ...absent });
    }
    const reach = reachableFrom(active.root, "machine");
    return json(res, 200, {
      ok: true,
      declared: true,
      project: active.project,
      root: active.root,
      facts: ROOT_FACTS[active.root.kind],
      description: describeRoot(active.root),
      reachableFromThisProcess: reach.ok,
      refused: reach.ok ? null : reach.refused,
      why: reach.ok ? null : reach.why,
      declaredAt: active.declaredAt,
    });
  },
  "GET /": (req, res, url) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(readFileSync(path.join(PUBLIC, "index.html")));
  },
  "GET /index.html": (req, res, url) => routes["GET /"](req, res, url),
  "GET /fused.js": (req, res, url) => {
    res.writeHead(200, { "content-type": "text/javascript" });
    res.end(readFileSync(path.join(PUBLIC, "fused.js")));
  },
  "GET /styles.css": (req, res, url) => {
    res.writeHead(200, { "content-type": "text/css" });
    res.end(readFileSync(path.join(PUBLIC, "styles.css")));
  },
  // Static fallthrough: anything else the page asks for that lives in public/.
  // Preserves subdirectories (e.g. /fonts/x.woff2) with traversal guards.
  "GET /static": (req, res, url) => {
    const file = resolvePublicFile(url.pathname);
    if (!file || !existsSync(file)) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      return res.end("not found");
    }
    const type = MIME_TYPES[path.extname(file)] ?? "application/octet-stream";
    res.writeHead(200, { "content-type": type });
    res.end(readFileSync(file));
  },
};

async function handle(req, res) {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const key = `${req.method} ${url.pathname}`;
  // Fall through to public/ for any other path the page requests.
  if (req.method === "GET" && !routes[key] && !url.pathname.startsWith("/api/")) {
    const file = resolvePublicFile(url.pathname);
    if (file && existsSync(file)) {
      try {
        if (statSync(file).isFile()) {
          const type = MIME_TYPES[path.extname(file)] ?? "application/octet-stream";
          res.writeHead(200, { "content-type": type });
          return res.end(readFileSync(file));
        }
      } catch {}
    }
  }
  const route = routes[key];
  if (route) return route(req, res, url);

  if (req.method === "GET" && SOURCE_DIRS.has((url.pathname.split("/")[1] ?? ""))) {
    return serveSource(res, url);
  }

  // THE SEAM, declare side: the environment says which project is active and what kind of root it
  // has. A machine root is validated here (it is this process's own filesystem); the other two kinds
  // are RECORDED as the active project and reported as unreachable from here — accepted, because the
  // environment owning them is a fact, and refused, because this process must not pretend to act on
  // them. That is the whole difference between one root and two.
  if (req.method === "POST" && url.pathname === "/api/root") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => answerOnce(res, async () => {
      let declared;
      try {
        declared = JSON.parse(body);
      } catch {
        return json(res, 400, { ok: false, refused: "bad-request", why: "body must be JSON: {project, root}" });
      }
      const project = String(declared?.project ?? "").trim();
      const root = declared?.root;
      if (!project || !root || typeof root !== "object") {
        return json(res, 400, { ok: false, refused: "bad-request", why: "a declaration needs a project name and a root descriptor" });
      }
      if (!Object.prototype.hasOwnProperty.call(ROOT_FACTS, root.kind)) {
        return json(res, 400, { ok: false, refused: "unknown-root-kind", why: `'${root.kind}' is not a root kind this seam knows (${Object.keys(ROOT_FACTS).join(", ")})` });
      }

      if (root.kind === "machine") {
        const requested = String(root.path ?? "");
        if (!requested.trim()) {
          return json(res, 400, { ok: false, refused: "bad-request", why: "a machine root needs a path" });
        }
        const candidate = path.resolve(requested);
        if (!existsSync(candidate)) {
          return json(res, 404, { ok: false, refused: "path-missing", why: `'${requested}' does not exist on this machine` });
        }
        let real;
        try {
          real = realpathSync(candidate);
        } catch (e) {
          return json(res, 400, { ok: false, refused: "not-a-directory", why: `'${requested}' could not be resolved: ${e.code}` });
        }
        if (!statSync(real).isDirectory()) {
          return json(res, 400, { ok: false, refused: "not-a-directory", why: `'${requested}' is a file; a project root is a folder` });
        }
        active = { project, root: { kind: "machine", path: real }, declaredAt: new Date().toISOString() };
        return json(res, 200, {
          ok: true,
          project: active.project,
          root: active.root,
          canonical: real !== candidate,
          facts: ROOT_FACTS.machine,
          description: describeRoot(active.root),
          reachableFromThisProcess: true,
          declaredAt: active.declaredAt,
        });
      }

      // opfs | handle: the page's roots. Recorded as the active project, and this process says
      // plainly that the act belongs to the page.
      active = { project, root: { kind: root.kind, ...(root.path ? { path: String(root.path) } : {}), ...(root.id ? { id: String(root.id) } : {}) }, declaredAt: new Date().toISOString() };
      const reach = reachableFrom(active.root, "machine");
      return json(res, 200, {
        ok: true,
        project: active.project,
        root: active.root,
        facts: ROOT_FACTS[active.root.kind],
        description: describeRoot(active.root),
        reachableFromThisProcess: false,
        refused: reach.refused,
        why: reach.why,
        declaredAt: active.declaredAt,
      });
    }));
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/audit") {
    // The root's log, read by whoever can reach the root — the same read the environment does in its
    // own placement, so "what did it do here" has one answer per root rather than one per placement.
    if (!active) return json(res, 200, { ...noRootDeclared(), root: null, entries: [] });
    const vanished = rootMissing();
    if (vanished) return json(res, 200, { ...vanished, root: active.root, entries: [] });
    const reach = reachableFrom(active.root, "machine");
    if (!reach.ok) return json(res, 200, { ok: false, refused: reach.refused, why: reach.why, root: active.root, entries: [] });
    const dir = path.join(active.root.path, ".audit");
    const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".jsonl")) : [];
    const entries = files.flatMap((f) =>
      readFileSync(path.join(dir, f), "utf8").split("\n").map(parseEntry).filter(Boolean),
    );
    return json(res, 200, { ok: true, root: active.root, instance: INSTANCE, files, entries: mergeAudit(entries) });
  }

  if (req.method === "GET" && url.pathname === "/api/files") {
    // The listing follows the ACTIVE root: a listing from a root the loop cannot reach would be the
    // two-root bug in miniature — a panel showing files from somewhere the project is not.
    if (!active) return json(res, 200, { ...noRootDeclared(), root: null, files: [], entries: [] });
    const vanishedFiles = rootMissing();
    if (vanishedFiles) return json(res, 200, { ...vanishedFiles, root: active.root, files: [], entries: [] });
    const reach = reachableFrom(active.root, "machine");
    if (!reach.ok) {
      return json(res, 200, { ok: false, refused: reach.refused, why: reach.why, root: active.root, files: [], entries: [] });
    }
    const dir = active.root.path;
    const fileNames = readdirSync(dir).filter(f => !f.startsWith("."));
    const entries = fileNames.map(name => {
      try {
        const full = path.join(dir, name);
        const stat = statSync(full);
        return { name, bytes: stat.size, kind: stat.isDirectory() ? "directory" : "file" };
      } catch {
        return { name, bytes: 0, kind: "file" };
      }
    });
    return json(res, 200, { ok: true, root: active.root, project: active.project, files: fileNames, entries });
  }

  if (req.method === "GET" && url.pathname === "/api/file") {
    const name = url.searchParams.get("name") ?? "";
    if (!name) return json(res, 400, { error: "action has no name" });
    if (!active) return json(res, 409, { ...noRootDeclared() });
    const vanishedRead = rootMissing();
    if (vanishedRead) return json(res, 409, { ...vanishedRead, root: active.root });
    const resolved = resolveActive(name);
    if (!resolved.ok) {
      return json(res, resolved.refused === "root-not-reachable-from-here" ? 409 : 403, {
        refused: resolved.refused,
        error: `refused: ${resolved.refused}`,
        why: resolved.why,
        root: active.root,
      });
    }
    try {
      const real = resolved.path;
      if (path.basename(real).startsWith(".")) {
        // Same line as the verbs: containment first, then a hidden file inside the
        // root is refused — the listing hides it, so the read does too.
        return json(res, 403, { ok: false, refused: "dotfile-refused", error: "refused: dotfile-refused", why: "dotfiles are not readable through the loop — the listing hides them and so does this read; host secrets live behind that line", root: active.root });
      }
      const stat = statSync(real);
      if (stat.isDirectory()) return json(res, 400, { error: "cannot read directory" });
      const content = readFileSync(real, "utf8");
      return json(res, 200, { ok: true, name, content, bytes: stat.size });
    } catch (e) {
      if (e.code === "ENOENT") return json(res, 404, { error: "file not found" });
      throw e;
    }
  }

  if (req.method === "GET" && url.pathname === "/api/environments") {
    // The list, with each host's reachability probed NOW and its STORED capability report merged in.
    // An unreadable registry is the named refusal, not an empty list.
    const result = await environmentsWithStatus();
    if (!result.ok) return json(res, 500, result);
    return json(res, 200, { ok: true, environments: result.environments });
  }

  /**
   * **`GET /api/probe` — this environment probes ITSELF and says what it found.**
   *
   * Paul (2026-09-20): the probe runs AUTOMATICALLY (not a button), and because it runs code inside
   * the environment unprompted, THE ACT IS RECORDED — an `activity` entry in the environment's own
   * audit, so the first time something runs somewhere unasked, the system can say it did. The report
   * is OBSERVED (the probe runs and reads), never a manifest, and it is cached with its `when` so a
   * stale one reads as stale. A probe that cannot run is a named refusal, not a blank.
   */
  if (req.method === "GET" && url.pathname === "/api/probe") {
    const cached = readProbeCache();
    if (cached) return json(res, 200, { ok: true, probe: cached, cached: true });
    try {
      const report = await runProbe();
      writeProbeCache(report);
      recordProbeAct(report);
      return json(res, 200, { ok: true, probe: report, cached: false });
    } catch (err) {
      return json(res, 500, { ok: false, refused: "probe-failed", why: `the environment could not probe itself — ${(err?.message ?? err)}` });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/environments") {
    // The "+" button: declare an environment. It is written to the list, NOT started — a declared
    // host that is not running will say so by name the next time the list is read. The server
    // generates the key; the person supplies the label and the origin.
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        return json(res, 400, { ok: false, refused: "bad-request", why: "body must be JSON: {label, kind, origin, home?}" });
      }
      const candidate = parseEnvironment({ ...parsed, key: `env_${randomBytes(8).toString("hex")}` });
      if (!candidate.ok) return json(res, 400, candidate);
      const stored = readEnvironments();
      if (!stored.ok) return json(res, 500, stored);
      const descriptor = { ...candidate.value, declaredAt: new Date().toISOString() };
      writeEnvironments([...stored.environments, descriptor]);
      return json(res, 200, { ok: true, environment: descriptor });
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/turn") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => answerOnce(res, async () => {
      let transcript = "";
      try {
        transcript = String(JSON.parse(body).transcript ?? "").trim();
      } catch {
        return json(res, 400, { error: "body must be JSON with a transcript" });
      }
      if (!transcript) return json(res, 400, { error: "empty transcript" });
      const action = resolveTurn(transcript, PROVIDER);
      if (action.unresolved) {
        return json(res, 200, { transcript, action: null, note: action.unresolved });
      }
      return json(res, 200, { transcript, action, result: await execute(action) });
    }));
    return;
  }

  // ── the extension surface (N17): discover, inventory, sideload ──────────
  // The disclosure sits between the verbs: every confirm-first act returns
  // the RESOLVED PLAN — the extension's source, what it declares, what will
  // be enforced and by which mechanism, what it cannot have — before the act
  // runs. The page (astra's bead) renders this; the API is the surface.
  const readJson = () => new Promise((resolve) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => { try { resolve(JSON.parse(body || "{}")); } catch { resolve(null); } });
  });

  if (req.method === "GET" && url.pathname === "/api/extensions") {
    return json(res, 200, extensions.inventory());
  }
  if (req.method === "GET" && url.pathname === "/api/extensions/catalogue") {
    return json(res, 200, { catalogue: extensions.catalogue() });
  }
  if (req.method === "POST" && url.pathname === "/api/extensions/proposals") {
    // The model's door over HTTP (what a model resolver calls): the same
    // destination as the transcript path — a PENDING proposal, nothing loaded.
    const body = await readJson();
    const r = extensions.propose(body?.descriptor, body?.descriptor?.source ?? "model");
    return r.ok ? json(res, 200, { ...r, note: "staged as a pending proposal — NOT loaded; the host admits it" }) : json(res, 400, r);
  }
  const planMatch = url.pathname.match(/^\/api\/extensions\/(proposals|catalogue)\/([a-z0-9_-]+)\/plan$/);
  if (req.method === "GET" && planMatch) {
    const plan = planMatch[1] === "proposals" ? extensions.proposalPlan(planMatch[2]) : extensions.cataloguePlan(planMatch[2]);
    return plan ? json(res, 200, plan) : json(res, 404, { error: `no ${planMatch[1].replace(/s$/, "")} '${planMatch[2]}'` });
  }
  if (req.method === "POST" && url.pathname === "/api/extensions/sideload") {
    const body = await readJson();
    if (!body?.id) return json(res, 400, { error: "body must be JSON with an id" });
    const plan = extensions.cataloguePlan(body.id);
    if (!plan) return json(res, 404, { error: `no catalogue entry '${body.id}'` });
    if (body.confirm !== true) {
      // Confirm-first: show the plan, stage nothing.
      return json(res, 200, { confirmFirst: true, plan, note: "nothing staged — repeat with confirm:true to stage the sideload as a PENDING proposal (it does not load; admission is still the host's)" });
    }
    const r = extensions.sideload(body.id);
    return r.ok ? json(res, 200, { ...r, note: "staged as a pending proposal — NOT loaded; the host admits it" }) : json(res, 400, r);
  }
  if (req.method === "POST" && url.pathname === "/api/extensions/admit") {
    // Admission is the HOST's act (bead voicebox-beads-m2i): the route requires
    // the host token (docs/02 §1.5's mechanism — a 0600 file in the host's own
    // directory, readable by the person's shell, by neither the page nor the
    // model). Driven finding, 2026-09-20: without this the page admitted its
    // own proposal in two fetches. The refusal is named, like every other one.
    if (!extensions.hostTokenOk(req.headers["x-voicebox-host-token"])) {
      return json(res, 403, { ok: false, refused: "host-token-required", why: "admission is the host's act — this route requires the host token (x-voicebox-host-token); the page cannot hold it" });
    }
    const body = await readJson();
    if (!body?.id) return json(res, 400, { error: "body must be JSON with an id" });
    const plan = extensions.proposalPlan(body.id);
    if (!plan) return json(res, 404, { error: `no proposal '${body.id}'` });
    if (body.confirm !== true) {
      // Confirm-first: the Tier 2 review act whose resolved plan is the source.
      return json(res, 200, { confirmFirst: true, plan, note: "nothing decided — repeat with confirm:true and decision 'admit'|'deny' to decide" });
    }
    const r = extensions.admitProposal(body.id, body.decision === "deny" ? "deny" : "admit");
    return json(res, 200, r);
  }
  json(res, 404, { error: "not found" });
}

// The host survives a bad turn: malformed JSON, a throwing handler, anything —
// an error message and an audit entry, and the server keeps serving.
const server = createServer(async (req, res) => {
  try {
    await handle(req, res);
  } catch (e) {
    console.error(`[audit] ${new Date().toISOString()} ${req.method} ${req.url}:`, e?.message ?? e);
    try { json(res, 500, { error: "internal error — the turn was not executed" }); } catch { /* response gone */ }
  }
});
process.on("uncaughtException", (e) => console.error(`[uncaught] ${e?.stack ?? e}`));
process.on("unhandledRejection", (e) => console.error(`[unhandledRejection] ${e?.reason ?? e}`));

// ── the live voice socket ─────────────────────────────────────────────────
// Page ⇄ /live ⇄ Gemini Live. Binary frames are PCM16 audio (16 kHz up,
// 24 kHz down); text frames are JSON control ({"type":"text"} turns,
// {"type":"stop"}). The session owns the readiness gate and the model label.
server.on("upgrade", (req, socket) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  if (url.pathname !== "/live") { socket.destroy(); return; }
  const ws = wsUpgrade(req, socket);
  if (!ws) { socket.destroy(); return; }

  // STEP 2 OF THE RATE WORK: the page is told what rate to capture at BEFORE any audio is sent, ever.
  //
  // The defect this closes (journal-6g0): the browser captured at 16 kHz, the OpenAI provider declared
  // 24 kHz to its vendor, and the PCM was forwarded unchanged — the provider told OpenAI one thing and sent
  // another, and nothing in the path could notice. It hid because Gemini also takes 16 kHz: with one
  // implementation nobody had to negotiate. So the FIRST frame on this socket is the requirement, it comes
  // from the provider that will receive the audio, and a provider that has not declared one is REFUSED —
  // guessing a provider's rate is the defect, so the host will not guess.
  let inputRate = null;
  try {
    inputRate = inputRateRequiredBy(resolvedLiveProviderName());
  } catch (e) {
    ws.send(JSON.stringify({ type: "error", error: e?.message ?? String(e) }));
    ws.close(1011, "provider has not declared the input rate its protocol requires");
    return;
  }
  ws.send(JSON.stringify({ type: "rate", inputRate, provider: resolvedLiveProviderName() }));

  let session = null;
  try {
    session = createLiveSession({
      // THE AGENT SETTINGS APPLY HERE, which is what stops them being dead controls: the provider a
      // person chose is the provider this session dials, and its model comes with it.
      provider: agentSettings.provider,
      model: PROVIDERS[agentSettings.provider].model,
      onAudioOut: (pcm, mime) => { if (pcm.length > 4) ws.send(pcm); },
      onText: (text, role) => ws.send(JSON.stringify({ type: "text", role, text })),
      onState: (state, detail) => ws.send(JSON.stringify({ type: "state", state, detail, model: PROVIDERS[agentSettings.provider].model })),
    });
    runningSession = { provider: session.state?.provider ?? agentSettings.provider, startedAt: new Date().toISOString() };
  } catch (e) {
    ws.send(JSON.stringify({ type: "error", error: e?.message ?? String(e) }));
    ws.close(1011, "live session failed to start");
    return;
  }

  ws.on("message", (data) => {
    if (typeof data === "string") {
      let msg = null;
      try { msg = JSON.parse(data); } catch { /* not JSON — ignore */ }
      if (msg?.type === "text" && typeof msg.text === "string") session.sendText(msg.text);
      if (msg?.type === "stop") { session.close(); ws.close(); }
      return;
    }
    // A binary frame is a PCM16 audio frame from the page's microphone.
    // VALIDATE before forwarding — this is not defensive padding. Measured
    // (ds-flash-1b, 2026-09-19): a single 3-byte frame reaches the model and
    // the upstream closes 1007 "Request contains an invalid argument" — the
    // SESSION dies while the page's socket stays open, so the user keeps
    // talking into nothing. One malformed frame must cost a frame, never the
    // conversation. PCM16 is always a non-empty EVEN number of bytes, and a
    // frame past a bounded size is a fault, not audio.
    const frameError =
      data.length === 0 ? "empty audio frame" :
      data.length % 2 !== 0 ? `odd-length audio frame (${data.length} bytes — PCM16 is even-length)` :
      data.length > 1_048_576 ? `audio frame too large (${data.length} bytes)` :
      null;
    if (frameError) {
      ws.send(JSON.stringify({ type: "error", error: `dropped malformed audio frame — ${frameError} (the session is fine)` }));
      return; // rejected WITHOUT forwarding: one bad frame costs a frame.
    }
    session.sendAudio(data.toString("base64"));
  });
  ws.on("close", () => session.close());
  ws.on("error", () => session.close());
});

/**
 * BINDING IS RETRIED, NOT FATAL — and this is the union of two fixes to the same defect, so say
 * which half came from where.
 *
 * The defect (five sightings in one day — Paul's console, coord's curls, the acceptance gate, and an
 * eight-hour stretch where the front served while the API was dead): a `node --watch` supervisor
 * restarts the child on every landing, the fresh child lost the bind race to the dying old one, and
 * then NOTHING restarted it until the next file change. A port serving nothing, with the page none
 * the wiser. What produces the taken port is usually ANOTHER SUPERVISOR (measured: the manager swept
 * two strays in one recovery), so:
 *
 *   · THE RETRY IS THE SAFETY NET, sized for that evidence: 30s, with a NAMED line at each attempt,
 *     because a retry nobody can see is a hang that happens to succeed. When the deadline passes the
 *     process exits with a sentence naming the port and how to find the holder — a dead port has to be
 *     announced, not left as a stack trace nobody reads.
 *   · THE GRACEFUL RELEASE IS THE FIX: a supervisor restarts by signalling its child, and that child
 *     letting go immediately is what stops the next start from ever seeing a taken port. SIGINT too,
 *     since half the actors here start it by hand.
 *   · AND ERRORS AFTER BINDING ARE NOT SILENCE: a single steady-state handler, so a later socket
 *     error says what happened instead of taking the process down with a stack trace.
 */
const BIND_RETRY_MS = Number(process.env.VOICEBOX_BIND_RETRY_MS ?? 250);
const BIND_DEADLINE_MS = Number(process.env.VOICEBOX_BIND_DEADLINE_MS ?? 30000);

function bindWithRetry(port, startedAt = Date.now()) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      const waited = Date.now() - startedAt;
      if (error?.code === "EADDRINUSE" && waited < BIND_DEADLINE_MS) {
        console.error(
          `[bind] waiting for 127.0.0.1:${port} to be released — held by another process (EADDRINUSE), ` +
            `${waited}ms so far; retrying every ${BIND_RETRY_MS}ms for up to ${BIND_DEADLINE_MS}ms. ` +
            `A supervisor shutting down holds it briefly; a second supervisor holds it until it is stopped.`,
        );
        setTimeout(() => resolve(bindWithRetry(port, startedAt)), BIND_RETRY_MS);
        return;
      }
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve(server.address().port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });
}

try {
  const bound = await bindWithRetry(PORT);
  // The REAL port, not the requested one: PORT=0 asks the OS for a free port, and a test suite that
  // binds an ephemeral port has to be able to read back which one it got. A suite that pins a fixed
  // port cannot run beside another, and the failure appears in someone else's lane as an unexplained
  // block — the most expensive kind, because they cannot tell it is your test.
  console.log(
    `voicebox on http://127.0.0.1:${bound} — provider: ${PROVIDER}, root: ${active ? active.root.path : "(none declared)"}`,
  );
} catch (error) {
  console.error(
    `[bind] giving up after waiting ${BIND_DEADLINE_MS}ms for 127.0.0.1:${PORT} (${error?.code ?? error?.message}). ` +
      `Something else is serving that port — find it (ss -ltnp | grep ${PORT}) and stop it, or start this on another port.`,
  );
  process.exit(1);
}

// AND THE OUTGOING PROCESS LETS GO. A supervisor restarts by signalling the child; exiting on the
// signal releases the socket immediately, instead of leaving the next process to collide with a
// socket this one still holds. The force-exit is for open sockets (the live-voice WebSocket keeps
// `close()` waiting), so a clean stop never becomes a hang.
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref(); // sockets must not outlive the exit
  });
}

// Once bound, an error is still not silence: a socket-level failure says what it was rather than
// ending the process with a stack trace nobody reads.
server.on("error", (e) => {
  console.error(`[server] socket error on 127.0.0.1:${PORT} (${e?.code ?? e})`);
});
