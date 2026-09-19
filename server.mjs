#!/usr/bin/env node
// voicebox server — the thinnest host for the loop:
//   browser captures a spoken turn -> POST /api/turn -> resolver -> action -> executor.
// Zero dependencies: node:http for the server, node:fs for the workspace.
// The resolver is a provider seam (lib/resolver.mjs) — swap it, don't rewrite the server.
import { createServer } from "node:http";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { resolveTurn } from "./lib/resolver.mjs";

const WORKSPACE = path.join(path.dirname(new URL(import.meta.url).pathname), "workspace");
mkdirSync(WORKSPACE, { recursive: true });

const PROVIDER = process.env.VOICEBOX_PROVIDER ?? "script";
const PORT = Number(process.env.PORT ?? 8787);

const json = (res, code, body) => {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

// The executor: the one place that touches the build environment. It grows;
// the resolver stays the same shape.
function execute(action) {
  if (action.verb === "list") return { ok: true, action: "listed workspace", files: readdirSync(WORKSPACE) };
  const safeName = path.basename(action.name ?? "");
  if (!safeName) return { ok: false, error: "action has no name" };
  const file = path.join(WORKSPACE, safeName);
  switch (action.verb) {
    case "write":
      writeFileSync(file, action.content ?? "");
      return { ok: true, action: `wrote ${safeName} (${(action.content ?? "").length} bytes)`, file: safeName };
    case "read":
      try { return { ok: true, action: safeName, content: readFileSync(file, "utf8") }; }
      catch { return { ok: false, error: `${safeName} does not exist` }; }
    default:
      return { ok: false, error: `unknown verb: ${action.verb}` };
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  if (req.method === "GET" && url.pathname === "/api/health") {
    return json(res, 200, { ok: true, provider: PROVIDER, workspace: "workspace/" });
  }
  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(readFileSync(path.join("public", "index.html")));
  }
  if (req.method === "GET" && url.pathname === "/app.js") {
    res.writeHead(200, { "content-type": "text/javascript" });
    return res.end(readFileSync(path.join("public", "app.js")));
  }
  if (req.method === "POST" && url.pathname === "/api/turn") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let transcript = "";
      try { transcript = String(JSON.parse(body).transcript ?? "").trim(); }
      catch { return json(res, 400, { error: "body must be JSON with a transcript" }); }
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
});

server.listen(PORT, "127.0.0.1", () =>
  console.log(`voicebox on http://127.0.0.1:${PORT} — provider: ${PROVIDER}, workspace: ${WORKSPACE}`));
