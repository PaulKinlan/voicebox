#!/usr/bin/env node
// voicebox server — the thinnest host for the loop:
//   browser captures a spoken turn -> POST /api/turn -> resolver -> action -> executor.
// Zero dependencies: node:http for the server, node:fs for the workspace.
// The resolver is a provider seam (lib/resolver.mjs) — swap it, don't rewrite the server.
import { createServer } from "node:http";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveTurn } from "./lib/resolver.mjs";
import { upgrade as wsUpgrade } from "./lib/ws-server.mjs";
import { createLiveSession, LIVE_MODEL } from "./lib/live-session.mjs";

// Module-relative, decoded: `new URL(...).pathname` percent-encodes spaces and
// silently points every read at a directory that does not exist.
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE = path.join(ROOT, "workspace");
const PUBLIC = path.join(ROOT, "public");
mkdirSync(WORKSPACE, { recursive: true });

const PROVIDER = process.env.VOICEBOX_PROVIDER ?? "script";
const PORT = Number(process.env.PORT ?? 8787);

const json = (res, code, body) => {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

// Normalising is not checking: `resolve` collapses `..`, then the answer is
// yes-or-no — is the candidate inside the workspace? (chrome-agent-platform-0j1a
// class: `basename("..")` is `".."`, so join+basename silently rewrote the
// escape instead of refusing it.)
function contained(p) {
  const rel = path.relative(WORKSPACE, p);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

// The executor: the one place that touches the build environment. It grows;
// the resolver stays the same shape.
function execute(action) {
  if (action.verb === "list") return { ok: true, action: "listed workspace", files: readdirSync(WORKSPACE) };
  const name = String(action.name ?? "");
  if (!name) return { ok: false, error: "action has no name" };
  const candidate = path.resolve(WORKSPACE, name);
  if (!contained(candidate)) return { ok: false, error: "refused: path escapes the workspace" };
  if (action.verb === "write") {
    // A symlink already sitting at the target must not carry the write outside.
    try {
      const real = realpathSync(candidate);
      if (!contained(real)) return { ok: false, error: "refused: path escapes the workspace" };
    } catch (e) {
      if (e.code !== "ENOENT") throw e; // the common case: the file does not exist yet
    }
    writeFileSync(candidate, action.content ?? "");
    return { ok: true, action: `wrote ${name} (${(action.content ?? "").length} bytes)`, file: name };
  }
  if (action.verb === "read") {
    const real = realpathSync(candidate); // ENOENT here is the honest "missing"
    if (!contained(real)) return { ok: false, error: "refused: path escapes the workspace" };
    return { ok: true, action: name, content: readFileSync(real, "utf8") };
  }
  return { ok: false, error: `unknown verb: ${action.verb}` };
}

const routes = {
  "GET /api/health": (req, res, url) => json(res, 200, { ok: true, provider: PROVIDER, workspace: "workspace/" }),
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
  // Added because the route table had /styles.css while the page asked for style.css,
  // and neither build-stamp.js nor icon.svg was routed at all - so the page silently
  // lost its stylesheet and its stamp. A page asking for a file the server does not
  // serve is a failure with no error in it.
  "GET /static": (req, res, url) => {
    const name = path.basename(url.pathname);
    const file = path.join(PUBLIC, name);
    if (!file.startsWith(PUBLIC) || !existsSync(file)) { res.writeHead(404); return res.end("not found"); }
    const type = { ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png" }[path.extname(file)] ?? "application/octet-stream";
    res.writeHead(200, { "content-type": type });
    res.end(readFileSync(file));
  },
};

async function handle(req, res) {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const key = `${req.method} ${url.pathname}`;
  // Fall through to public/ for any other path the page requests.
  if (req.method === "GET" && !routes[key]) {
    const candidate = path.join(PUBLIC, path.basename(url.pathname));
    if (url.pathname !== "/" && existsSync(candidate)) {
      return routes["GET /static"](req, res, url);
    }
  }
  const route = routes[key];
  if (route) return route(req, res, url);

  if (req.method === "GET" && url.pathname === "/api/files") {
    const files = readdirSync(WORKSPACE).filter(f => !f.startsWith("."));
    return json(res, 200, { files });
  }

  if (req.method === "POST" && url.pathname === "/api/turn") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
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
      return json(res, 200, { transcript, action, result: execute(action) });
    });
    return;
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
    session.sendAudio(data.toString("base64"));
  });
  ws.on("close", () => session.close());
  ws.on("error", () => session.close());
});

server.listen(PORT, "127.0.0.1", () =>
  console.log(`voicebox on http://127.0.0.1:${PORT} — provider: ${PROVIDER}, workspace: ${WORKSPACE}`));
