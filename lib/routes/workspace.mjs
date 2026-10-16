/**
 * @summary Workspace file reading, writing, and directory search endpoints.
 */
// Workspace file routes (voicebox-beads-lrsp). The host retains root declaration, auth,
// bounded JSON parsing, path authorization and execution; route responses stay unchanged.
import path from "node:path";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { normaliseRelativeDir, parentDir } from "../../core/paths.ts";
import { noRootDeclared, reachableFromEnvironment } from "../../core/root.ts";
import { dispatchFor } from "../../core/dispatch.ts";

const READ = new Set(["GET /api/files", "GET /api/file"]);
const WRITE = new Set(["DELETE /api/file", "PUT /api/file", "PATCH /api/file", "POST /api/file/diff", "GET /api/grep"]);

/** A handled boolean keeps dispatch independent of json(), which returns undefined. */
export function createWorkspaceRoutes({ getActive, rootMissing, resolveActive, pageExecutorConnected, askPage, execute, json, readJsonBody, contentJsonBodyMaxBytes, selfEnvironment }) {
  return async function handleWorkspaceRoute(req, res, url, phase) {
    const key = `${req.method} ${url.pathname}`;
    if (phase === "read" ? !READ.has(key) : phase === "write" ? !WRITE.has(key) : true) return false;
    const active = getActive(); // declaration is mutable: do not capture it when the server starts
    const SELF_ENVIRONMENT = selfEnvironment;
    const CONTENT_JSON_BODY_MAX_BYTES = contentJsonBodyMaxBytes;
    const readJson = (maxBytes) => readJsonBody(req, res, maxBytes);
    await (async () => {
  if (req.method === "GET" && url.pathname === "/api/files") {
    // WHICH FOLDER: `?dir=proposals/drafts` lists INSIDE the root instead of listing the root itself
    // (voicebox-beads-tee). The path arrives from a person clicking a folder, so it is normalised and
    // bounded here — one shared helper, so the page and the server cannot disagree about what
    // `proposals/../..` means — and every refusal is named rather than quietly rewritten.
    const wanted = normaliseRelativeDir(url.searchParams.get("dir") ?? "");
    if (!wanted.ok) {
      return json(res, 200, { ok: false, refused: wanted.refused, why: wanted.why, dir: "", parent: null, files: [], entries: [] });
    }
    const dir = wanted.dir;
    const here = { dir, parent: parentDir(dir) };
    // NO SERVER ROOT, BUT THE PAGE HOLDS A PROJECT: list it through the page (voicebox-beads-fqq).
    // This is the fresh-room case — nothing declared, nothing picked — where the page has made a
    // browser-stored project and the room must be able to see it. The server declares nothing here and
    // stores nothing: it relays one question to the only side that can answer it, and every field of
    // the answer says whose listing it is. A refusal is the page's own words, never a blank list.
    if (!active && pageExecutorConnected()) {
      const onPage = await askPage({ verb: "list", name: dir });
      const observed = onPage.observed ?? {};
      if (onPage.ok) {
        return json(res, 200, {
          ok: true,
          via: "page",
          declared: false,
          root: observed.root ?? { kind: "opfs" },
          project: null,
          ...here,
          files: observed.files ?? [],
          entries: observed.entries ?? [],
          truncated: observed.truncated ?? false,
        });
      }
      // The page is connected but has nothing to list (no project open): that is a NAMED state with a
      // route, not an empty folder — the room prints the sentence and the link.
      if (onPage.refused && onPage.refused !== "no-page") {
        return json(res, 200, { ok: false, refused: onPage.refused, why: onPage.why, via: "page", root: observed.root ?? null, ...here, files: [], entries: [] });
      }
    }
    // The listing follows the ACTIVE root: a listing from a root the loop cannot reach would be the
    // two-root bug in miniature — a panel showing files from somewhere the project is not.
    if (!active) return json(res, 200, { ...noRootDeclared(), root: null, ...here, files: [], entries: [] });
    const vanishedFiles = rootMissing();
    if (vanishedFiles) return json(res, 200, { ...vanishedFiles, root: active.root, ...here, files: [], entries: [] });
    // A page-owned root lists through the page (core/dispatch.ts): the room sees the same
    // files whichever root kind the project is on, and the answer says whose listing it is.
    if (dispatchFor(active.root, SELF_ENVIRONMENT).executeOn === "page") {
      const answer = await askPage({ verb: "list", name: dir });
      if (!answer.ok) return json(res, 200, { ok: false, refused: answer.refused, why: answer.why, via: "page", root: active.root, ...here, files: [], entries: [] });
      const observed = answer.observed ?? {};
      return json(res, 200, { ok: true, via: "page", root: active.root, project: active.project, ...here, files: observed.files ?? [], entries: observed.entries ?? [], truncated: observed.truncated ?? false });
    }
    const reach = reachableFromEnvironment(active.root, { peer: "machine", environment: SELF_ENVIRONMENT });
    if (!reach.ok) {
      return json(res, 200, { ok: false, refused: reach.refused, why: reach.why, root: active.root, ...here, files: [], entries: [] });
    }
    // THE FOLDER ITSELF, through the SAME containment gate the file routes use: `..` escapes, a real-path
    // escape (a symlink), and the host-owned audit are all refused by name, so navigating down cannot
    // reach somewhere reading a file could not.
    // The ROOT is the one path that needs no resolution — it IS the root. Passing '.' to the shared
    // resolver made it name a file and list the root as `outside-root` (found by driving: the root listing
    // refused itself), so the empty path is answered directly and only subfolders go through the gate.
    const target = dir === "" ? { ok: true, path: active.root.path } : resolveActive(dir);
    if (!target.ok) {
      return json(res, 200, { ok: false, refused: target.refused, why: target.why, root: active.root, ...here, files: [], entries: [] });
    }
    let dirents;
    try {
      dirents = readdirSync(target.path, { withFileTypes: true });
    } catch (e) {
      const code = e?.code ?? "error";
      return json(res, 200, {
        ok: false,
        refused: code === "ENOENT" ? "folder-missing" : code === "ENOTDIR" ? "not-a-folder" : "folder-unreadable",
        why: code === "ENOENT"
          ? `'${dir}' is not there any more — it may have been renamed or removed since the listing you clicked`
          : code === "ENOTDIR"
            ? `'${dir}' is a file, not a folder`
            : `'${dir}' could not be listed: ${e?.message ?? e}`,
        root: active.root,
        ...here,
        files: [],
        entries: [],
      });
    }
    const visible = dirents.filter((entry) => !entry.name.startsWith("."));
    const entries = visible.map((entry) => {
      try {
        const stat = statSync(path.join(target.path, entry.name));
        return { name: entry.name, bytes: stat.size, kind: stat.isDirectory() ? "directory" : "file" };
      } catch {
        return { name: entry.name, bytes: 0, kind: entry.isDirectory() ? "directory" : "file" };
      }
    });
    return json(res, 200, { ok: true, root: active.root, project: active.project, ...here, files: entries.map((e) => e.name), entries });
  }

  if (req.method === "GET" && url.pathname === "/api/file") {
    const name = url.searchParams.get("name") ?? "";
    if (!name) return json(res, 400, { error: "action has no name" });
    // NO SERVER ROOT, BUT THE PAGE HOLDS A PROJECT: read through the page, the same way the listing
    // above does (voicebox-beads-fqq) — a listing whose files cannot be opened is half an answer.
    if (!active && pageExecutorConnected()) {
      const onPage = await askPage({ verb: "read", name });
      if (onPage.ok) {
        const observed = onPage.observed ?? {};
        return json(res, 200, { ok: true, via: "page", declared: false, name, content: observed.content ?? "", bytes: observed.bytes ?? 0, root: observed.root ?? null });
      }
      if (onPage.refused && onPage.refused !== "no-page") {
        return json(res, onPage.refused === "not-found" ? 404 : 409, { ok: false, refused: onPage.refused, error: `refused: ${onPage.refused}`, why: onPage.why, via: "page" });
      }
    }
    if (!active) return json(res, 409, { ...noRootDeclared() });
    const vanishedRead = rootMissing();
    if (vanishedRead) return json(res, 409, { ...vanishedRead, root: active.root });
    // A page-owned root reads through the page (core/dispatch.ts) — the room's reader works
    // for a picked folder exactly as for a machine folder, and says whose bytes it shows.
    if (dispatchFor(active.root, SELF_ENVIRONMENT).executeOn === "page") {
      const answer = await askPage({ verb: "read", name });
      if (!answer.ok) {
        return json(res, answer.refused === "not-found" ? 404 : 409, { ok: false, refused: answer.refused, error: `refused: ${answer.refused}`, why: answer.why, via: "page", root: active.root });
      }
      const observed = answer.observed ?? {};
      return json(res, 200, { ok: true, via: "page", name, content: observed.content ?? "", bytes: observed.bytes ?? 0 });
    }
    const resolved = resolveActive(name);
    if (!resolved.ok) {
      return json(res, resolved.refused === "root-not-reachable-from-here" ? 409 : 403, {
        ok: false,
        refused: resolved.refused,
        error: `refused: ${resolved.refused}`,
        why: resolved.why,
        root: active.root,
      });
    }
    try {
      // The dotfile refusal came through `resolveActive` above (lib/path-auth.mjs) — same line
      // as the verbs: containment first, then a hidden file inside the root is refused, because
      // the listing hides it and so must the read (voicebox-beads-q0a3).
      const real = resolved.path;
      const stat = statSync(real);
      if (stat.isDirectory()) return json(res, 400, { error: "cannot read directory" });
      const content = readFileSync(real, "utf8");
      return json(res, 200, { ok: true, name, content, bytes: stat.size });
    } catch (e) {
      if (e.code === "ENOENT") return json(res, 404, { error: "file not found" });
      // A READ THAT FAILS FOR ANY OTHER REASON IS NAMED TOO. This used to fall through to the generic
      // 500 ("internal error — the turn was not executed"), which is both unhelpful and untrue about a
      // file read, and the sentence a person saw was about turns. Found by asking the question of the
      // reader's failure line from the other side: the `where` had been fixed, and the `why` had not.
      const code = e?.code ?? "error";
      // THE LABEL AND THE REASON, both — which is safe because the PAGE prefers `why`
      // (`reasonFrom` in public/fused.js: why, then error, then note). Before that rule existed I had to
      // drop `error` here, because the reader showed `error` first and a short label shadowed the
      // platform's sentence; now every refusal in this route carries the same three facts — `refused`,
      // `error` as the label, `why` as the sentence — and the page chooses the useful one.
      //
      // The platform's words already begin with the code — prefixing it again produced
      // "EACCES: EACCES: permission denied…", so `why` is used exactly as it arrives.
      return json(res, code === "EACCES" || code === "EPERM" ? 403 : 500, {
        ok: false,
        refused: "unreadable",
        error: `refused: unreadable (${code})`,
        why: e?.message ?? String(e),
        path: resolved.path,
        root: active.root,
      });
    }
  }

  if (req.method === "DELETE" && url.pathname === "/api/file") {
    const name = url.searchParams.get("name") ?? "";
    const result = await execute({ verb: "delete", name });
    if (!result.ok) return json(res, result.refused === "not-found" ? 404 : 400, result);
    return json(res, 200, result);
  }

  // File CONTENT crosses these three routes, and a real file can exceed the 1 MiB default —
  // they pass the same content cap the transport import already used (voicebox-beads-d808).
  if (req.method === "PUT" && url.pathname === "/api/file") {
    const body = await readJson(CONTENT_JSON_BODY_MAX_BYTES);
    const result = await execute({ verb: "write", name: body?.name, content: body?.content });
    if (!result.ok) return json(res, result.refused === "not-found" ? 404 : 400, result);
    return json(res, 200, result);
  }

  if (req.method === "PATCH" && url.pathname === "/api/file") {
    const body = await readJson(CONTENT_JSON_BODY_MAX_BYTES);
    const result = await execute({ verb: "edit", name: body?.name, oldText: body?.oldText, newText: body?.newText });
    if (!result.ok) return json(res, result.refused === "not-found" ? 404 : 400, result);
    return json(res, 200, result);
  }

  if (req.method === "POST" && url.pathname === "/api/file/diff") {
    const body = await readJson(CONTENT_JSON_BODY_MAX_BYTES);
    const result = await execute({ verb: "diff", name: body?.name, content: body?.content });
    if (!result.ok) return json(res, 400, result);
    return json(res, 200, result);
  }

  if (req.method === "GET" && url.pathname === "/api/grep") {
    const query = url.searchParams.get("q") ?? url.searchParams.get("query") ?? "";
    const dir = url.searchParams.get("dir") ?? undefined;
    const result = await execute({ verb: "grep", query, ...(dir ? { dir } : {}) });
    if (!result.ok) return json(res, 400, result);
    return json(res, 200, result);
  }

    })();
    return true;
  };
}
