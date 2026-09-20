#!/usr/bin/env node
// voicebox server — the thinnest host for the loop:
//   browser captures a spoken turn -> POST /api/turn -> resolver -> action -> executor.
// Zero dependencies: node:http for the server, node:fs for the workspace.
// The resolver is a provider seam (lib/resolver.mjs) — swap it, don't rewrite the server.
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveTurn } from "./lib/resolver.mjs";
import { ROOT_FACTS, describeRoot, reachableFrom, resolveInRoot } from "./core/root.ts";
import { auditFileName, makeEntry, mergeAudit, nextSeq, parseEntry, resumeSeq, serializeEntry } from "./core/audit.ts";
import * as extensions from "./lib/extensions.mjs";
import { upgrade as wsUpgrade } from "./lib/ws-server.mjs";
import { createLiveSession, LIVE_MODEL } from "./lib/live-session.mjs";

// Module-relative, decoded: `new URL(...).pathname` percent-encodes spaces and
// silently points every read at a directory that does not exist.
const ROOT = path.dirname(fileURLToPath(import.meta.url));
// Movable workspace (tests point it at scratch; see lib/extensions.mjs).
const WORKSPACE = process.env.VOICEBOX_WORKSPACE ?? path.join(ROOT, "workspace");

// ── THE ACTIVE ROOT (core/root.ts is the seam) ────────────────────────────────────────────────
// The loop does not invent a root. It acts on the ACTIVE PROJECT'S root, which the environment
// declares (POST /api/root) and which may be any of the three kinds. Two of them this process
// cannot reach, and it says so by name rather than quietly writing somewhere else — that refusal is
// what stops a hard-coded `workspace/` from being a second, silent root.
let active = {
  project: "workspace",
  root: { kind: "machine", path: WORKSPACE },
  declaredAt: new Date().toISOString(),
};

// This process is a WRITER of the root it acts on, so it keeps its own file in that root's log —
// one file per (root, writer), which is what the log has always meant. Without this the loop would
// be a stranger writing into somebody's project with no record of what it did, and the machine root
// would be the one root in the product with no audit at all.
const INSTANCE = process.env.VOICEBOX_INSTANCE ?? "machine";

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

/** Resolve a name through the seam, or the refusal that says why — used by every path below. */
function resolveActive(name) {
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
      error: `refused: ${resolved.refused === "outside-root" ? "path escapes the active project root" : resolved.refused}`,
      why: resolved.why,
      root: active.root,
      logged: entry ? entry.seq : null,
    };
  }
  const candidate = resolved.path;
  if (action.verb === "write") {
    writeFileSync(candidate, action.content ?? "");
    const entry = logAct({ kind: "write", target: name, tool: "turn" }, "allow", "writes-inside", "ok", observeUnderRoot(name), action.turn ?? null);
    return {
      ok: true,
      action: `wrote ${name} (${(action.content ?? "").length} bytes)`,
      file: name,
      root: active.root,
      logged: entry ? entry.seq : null,
      auditLocation: `${active.root.path}/.audit/`,
    };
  }
  if (action.verb === "read") {
    const content = readFileSync(candidate, "utf8");
    const entry = logAct({ kind: "read", target: name, tool: "turn" }, "allow", "reads-inside", "ok", observeUnderRoot(name), action.turn ?? null, [{ path: name, bytes: Buffer.byteLength(content) }]);
    return { ok: true, action: name, content, root: active.root, logged: entry ? entry.seq : null };
  }
  return { ok: false, error: `unknown verb: ${action.verb}` };
}

const routes = {
  "GET /api/health": (req, res, url) => json(res, 200, { ok: true, provider: PROVIDER, workspace: WORKSPACE, root: active.root, project: active.project, build: BUILD }),
  // THE SEAM, read side: which root is the loop writing into, and may this process act on it?
  "GET /api/root": (req, res, url) => {
    const reach = reachableFrom(active.root, "machine");
    return json(res, 200, {
      ok: true,
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
  "GET /app.js": (req, res, url) => {
    res.writeHead(200, { "content-type": "text/javascript" });
    res.end(readFileSync(path.join(PUBLIC, "app.js")));
  },
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
    req.on("end", () => {
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
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/audit") {
    // The root's log, read by whoever can reach the root — the same read the environment does in its
    // own placement, so "what did it do here" has one answer per root rather than one per placement.
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
      const stat = statSync(real);
      if (stat.isDirectory()) return json(res, 400, { error: "cannot read directory" });
      const content = readFileSync(real, "utf8");
      return json(res, 200, { ok: true, name, content, bytes: stat.size });
    } catch (e) {
      if (e.code === "ENOENT") return json(res, 404, { error: "file not found" });
      throw e;
    }
  }

  if (req.method === "POST" && url.pathname === "/api/turn") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
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
    });
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

  let session = null;
  try {
    session = createLiveSession({
      onAudioOut: (pcm, mime) => { if (pcm.length > 4) ws.send(pcm); },
      onText: (text, role) => ws.send(JSON.stringify({ type: "text", role, text })),
      onState: (state, detail) => ws.send(JSON.stringify({ type: "state", state, detail, model: LIVE_MODEL })),
    });
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

server.listen(PORT, "127.0.0.1", () =>
  console.log(`voicebox on http://127.0.0.1:${PORT} — provider: ${PROVIDER}, workspace: ${WORKSPACE}`));
