// vite.config.js — DEV SERVER ONLY.
//
// The runtime contract is unchanged: server.mjs stays zero-dependency
// (node:http) and remains the production path. Vite exists so the page
// self-updates while you edit — Paul, 2026-09-19: "I don't want to have to
// ask you to reboot it all the time."
//
// Shape of a dev session:
//   npm run serve   # the real server:  http://127.0.0.1:8787  (zero-dep)
//   npm run dev     # Vite in front:    http://localhost:5173  (proxies /api)
//
// strictPort: a server that silently lands on another port gets measured as
// the wrong server (2026-09-13 note). If 5173 is taken, Vite must EXIT, not
// drift to 5174.
//
// host: true — Vite advertises the LAN and Tailscale addresses itself, which
// replaces the hand-rolled /tmp LAN-forwarder chain the reboot wiped.
//
// PORT IS THE ONE NAME (review finding A, 2026-09-19): server.mjs:20 reads
// process.env.PORT for its listen port, and this config reads the SAME variable
// for the proxy target. One variable moves both sides together, so a dev UI
// can never silently point at another lane's instance on 8787 — the review
// demonstrated that mis-point as a cross-instance write with no error.
import { defineConfig } from "vite";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { cspSafeViteClient } from "./tools/vite-plugin-csp-safe-client.mjs";

const API_TARGET = `http://127.0.0.1:${process.env.PORT ?? 8787}`;

// WHICH REVISION AM I LOOKING AT?
//
// 2026-09-19: three URLs served three revisions and a stale copy silently beat a
// fixed one twice. The page states its own identity, baked at serve time rather
// than fetched at runtime — a runtime fetch would report the identity of
// whatever answers, which is the lie we were chasing.
//
// `cwd` is resolved from THIS config, not from the shell that launched Vite, so
// a dev server started from another directory still stamps its own checkout.
// Every call is wrapped: a config that cannot run git must still start.
const gitOptions = { cwd: path.dirname(new URL(import.meta.url).pathname), encoding: "utf8" };
const git = (args, fallback) => {
  try {
    return execFileSync("git", args, gitOptions).trim() || fallback;
  } catch {
    return fallback;
  }
};
// Read per HTML request, not once at startup: a stamp that keeps naming the
// revision the server started on goes stale the moment anything lands, which is
// exactly the confusion this line exists to prevent.
// A stamp that can be wrong in the direction of "looks like main" is worse than
// no stamp. 2026-09-19: the served page said `main @ 41b9045` while origin/main
// was 674aa66 — the tree really was on the branch *main*, and that local main
// was a commit ahead of the remote one, with a dirty file. Every human reading
// the footer concluded the page was main at a revision main does not have. So
// the stamp now says how far ahead of its remote it is, and the dirty flag.
const buildIdentity = () => {
  const branch = git(["branch", "--show-current"], "(detached)");
  const commit = git(["rev-parse", "--short", "HEAD"], "unknown");
  const remote = git(["rev-parse", "--short", `origin/${branch}`], "");
  const ahead = remote ? Number(git(["rev-list", "--count", `origin/${branch}..HEAD`], "0")) : null;
  return {
    branch,
    commit,
    remote: remote || null,
    ahead,
    dirty: git(["status", "--porcelain", "--untracked-files=no"], "") !== "",
    servedAt: new Date().toISOString(),
  };
};

// A MISSING ASSET MUST BE LOUD, without removing index.html from the server.
//
// The property we want: a request for a file that does not exist gets a 404,
// not Vite's spa fallback (which answers ANY unmatched GET with index.html and
// a 200 — that is how a missing .woff2 arrived as HTML, the font parser choked
// on "<!do", and nothing at the HTTP layer reported anything wrong).
//
// The first attempt at this was `appType: "custom"`, which does not mean "no
// history fallback" — it means Vite does not serve index.html AT ALL, and the
// root 404'd. So: appType stays at its default so / still serves the page, and
// this middleware 404s only a request whose path LOOKS LIKE A FILE and is not
// on disk. Everything else falls through to Vite untouched.
//
// Rule recorded explicitly (a wrong rule here would 404 real navigations):
// file-looking = has a dot-separated extension, and is not .html.
function loudStaticMiss() {
  return {
    name: "loud-static-miss",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = (req.url || "/").split("?")[0];
        // Vite's own namespaces are never ours to judge: /@fs/ paths carry
        // extensions and live outside root BY DESIGN (root is public/), so the
        // on-disk check below would 404 Vite's dev client itself — env.mjs
        // died exactly this way (2026-09-19, found by ds-flash-1b, browser
        // console: "Failed to load resource 404" for /@fs/.../env.mjs).
        if (/^\/@(vite|fs)\//.test(url) || url.startsWith("/node_modules/")) return next();
        const looksLikeFile = /\.[a-z0-9]+$/i.test(url) && !/\.html$/i.test(url);
        if (!looksLikeFile) return next();
        let onDisk;
        try {
          onDisk = path.join(server.config.root, decodeURIComponent(url));
        } catch {
          return next(); // undecodable URL: not ours to judge
        }
        if (existsSync(onDisk)) return next();
        res.statusCode = 404;
        res.setHeader("content-type", "text/plain; charset=utf-8");
        res.end(`not found: ${url}\n`);
      });
    },
  };
}

// The identity is baked into the served HTML, not fetched at runtime and not
// injected into the page's JS: Vite serves public/ root files straight to the
// browser, so an `define` would never reach them, and index.html is the one
// document every server in this repo has to produce.
function buildStamp() {
  return {
    name: "voicebox-build-stamp",
    transformIndexHtml(html) {
      const build = buildIdentity();
      const where = build.ahead === null
        ? `no origin/${build.branch}`
        : build.ahead === 0
        ? ""
        : ` · ${build.ahead} commit${build.ahead === 1 ? "" : "s"} ahead of origin/${build.branch} (not landed)`;
      const content = `${build.branch} @ ${build.commit}${where}${build.dirty ? " · uncommitted changes" : ""}`;
      return html.replace("__VOICEBOX_BUILD_STAMP__", content);
    },
  };
}

export default defineConfig({
  plugins: [buildStamp(), cspSafeViteClient(), loudStaticMiss()],
  root: "public",
  publicDir: false, // public/ IS the root; there is no second static dir
  // appType stays default ("spa") so "/" serves index.html. The loud 404 for a
  // missing asset comes from the loudStaticMiss middleware above, not from
  // removing index.html from the server — see the comment there for why.
  server: {
    port: 5173,
    strictPort: true,
    host: true, // listen on all interfaces: LAN 192.168.x.x + Tailscale 100.x
    // POLLING WATCHER, 2026-09-19. A `git merge --ff-only` replaced
    // public/audio-client.js and Vite's watcher never fired, so the server kept
    // serving its cached transform of the OLD module: the disk had the new
    // `level()` and :5173 served a file with no `level()` in it at all. A build
    // stamp cannot catch that — page and server both reported the new sha while
    // the JavaScript was old. Polling costs a little CPU and is immune to a
    // missed inotify event.
    watch: { usePolling: true, interval: 300 },
    proxy: {
      "/api": { target: API_TARGET },
      // The audio socket (k3's live session, landing separately). ws: true so
      // the WebSocket upgrade is forwarded and survives HMR reloads.
      "/live": { target: API_TARGET, ws: true },
    },
  },
});
