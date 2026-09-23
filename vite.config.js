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
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { cspSafeViteClient } from "./tools/vite-plugin-csp-safe-client.mjs";
import { SOURCE_PREFIXES } from "./lib/browser-sources.mjs";

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
// THE TWO LINES THIS FEATURE EXISTS TO PRODUCE. Both were seen on the real page
// on 2026-09-19, before and after restarting the server, unasked — which is the
// only validation that matters for a stamp:
//
//   page main @ 5e805cc · 2 commits ahead of origin/main (not landed)
//     · server main @ 3da3268 · the server is a different revision — restart it
//
//   page main @ 5e805cc · 2 commits ahead of origin/main (not landed)
//     · server main @ 5e805cc
//
// That first line carries every fact that cost an hour the same evening: which
// half is which, that the page is ahead of its remote and NOT LANDED, and that
// the server is a different revision — named, instead of discovered by a voice
// path that fails for reasons nobody can see.
//
// A stamp that can be wrong in the direction of "looks like main" is worse than
// no stamp. The served page said `main @ 41b9045` while origin/main
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
        // Root-level served trees (browser/ at least) are TRANSFORMED modules —
        // the alias below maps them outside root and Vite must resolve them;
        // judging them here would 404 a live module before its transform
        // (environment.html's ui.ts, Paul's console, 2026-09-20).
        if (/^\/(browser|core|lib|docs|tests|tools)\//.test(url)) return next();
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
      // A BRANCH WITH NO REMOTE-TRACKING REF used to render as `0635dd5no origin/feat/serve-help`:
      // the clause carried no leading separator, so the sha ran straight into the sentence and the
      // stamp read as nonsense — on Paul's page, from this stamp's own text. The separator is the bug.
      //
      // And the words now say what is actually unknown. "no origin/<branch>" named a missing ref as
      // though the reader knew what a remote-tracking ref is; what a person needs from this line is
      // whether the number of commits AHEAD OF THE REMOTE can be known at all. A branch that was never
      // pushed, one whose remote ref was pruned, and one fetched from elsewhere all look identical from
      // here, so the line says only the thing that is true of all three.
      const where = build.ahead === null
        ? ` · no origin/${build.branch} here, so the distance from a remote is unknown`
        : build.ahead === 0
        ? ""
        : ` · ${build.ahead} commit${build.ahead === 1 ? "" : "s"} ahead of origin/${build.branch} (not landed)`;
      const content = `${build.branch} @ ${build.commit}${where}${build.dirty ? " · uncommitted changes" : ""}`;
      return html.replace("__VOICEBOX_BUILD_STAMP__", content);
    },
  };
}

export default defineConfig({
  resolve: {
    alias: {
      // environment.html's modules live at the project root, outside this
      // root (public/) — alias so Vite RESOLVES and transforms them (a raw
      // .ts through any static server would 200 and then fail to parse).
      "/browser": path.join(path.dirname(fileURLToPath(import.meta.url)), "browser"),
    },
  },
  plugins: [buildStamp(), cspSafeViteClient(), loudStaticMiss()],
  root: "public",
  publicDir: false, // public/ IS the root; there is no second static dir
  // appType stays default ("spa") so "/" serves index.html. The loud 404 for a
  // missing asset comes from the loudStaticMiss middleware above, not from
  // removing index.html from the server — see the comment there for why.
  server: {
    port: 5173,
    strictPort: true,
    fs: { allow: [path.dirname(fileURLToPath(import.meta.url))] }, // the alias serves outside root
    host: true, // listen on all interfaces: LAN 192.168.x.x + Tailscale 100.x
    // Tailscale Serve puts a real HTTPS name in front of this port (https://omarchy.tail9d22b9.ts.net),
    // and Vite refuses any Host it does not recognise — a 403 that looks like the server being down.
    // WHY THIS LINE EXISTS: https://omarchy.tail9d22b9.ts.net/ is Tailscale Serve — the secure
    // context the PHONE MICROPHONE needs, and the front door for the proxied-custody environment
    // work. Lose this line and both disappear, with nothing but a 403 to say so.
    // The .ts.net suffix is the tailnet's own domain (tailnet membership is the access control);
    // localhost stays for the local case. A second tailnet machine fronting THIS dev server is the
    // only case that would justify widening further.
    // AND THE FIREWALL HALF, which lives outside this repo: if a peer sees ERR_CONNECTION_ABORTED
    // on the tailnet URL while every local check passes, ufw is refusing incoming on tailscale0 —
    // fix: sudo ufw allow in on tailscale0. A local test never crosses that interface.
    allowedHosts: [".ts.net", "localhost"],
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
      //
      // THE ORIGIN IS THE SERVER'S OWN, because this hop is ours.
      //
      // The API's hello gate (bead voicebox-beads-eet) entitles "the local page" by
      // its Origin: it recognises the port THE SERVER BOUND, because a page this
      // process serves announces itself with the server's own origin. A browser on
      // this dev front sends `Origin: http://127.0.0.1:5173`, Vite forwards it
      // verbatim, the gate does not recognise it, and the socket is closed in
      // silence — after which the PAGE blames the audio rate, because from its side
      // a live socket ended before any `{type:"rate"}` frame arrived. Measured on
      // 2026-09-23: same socket, `Origin: …:8787` -> {"type":"rate","inputRate":16000,
      // "provider":"gemini"}; `Origin: …:5173` -> no frame at all. The owner's
      // "the server has not said what audio rate its provider needs" was that.
      //
      // Rewriting it here is the honest place: Vite IS this server's dev front on
      // the same machine, and a proxy hop terminating its own origin is what a proxy
      // is for. The gate keeps its rule unchanged for every non-proxied caller.
      "/live": {
        target: API_TARGET,
        ws: true,
        configure: (proxy) => {
          proxy.on("proxyReqWs", (proxyReq) => {
            proxyReq.setHeader("origin", API_TARGET);
          });
        },
      },
      // environment.html's modules live at the project root (browser/ui/ui.ts),
      // one level above this root — Paul's console caught the 404 as a
      // pre-transform error while the page itself returned 200 (2026-09-20).
      // THE EXECUTOR CHANNEL. The environment page connects here to act on a folder it owns
      // (vb-resolver's router: a page-owned root is executed BY THE PAGE). Without this line the page
      // never registers as the executor through the dev front — `window.e1m0.ready` stays pending
      // forever, a page-owned root reports executor.connected:false, and the room tells a person
      // "The tab that holds this folder is not open" WHILE THE TAB IS OPEN. Measured on 2026-09-23:
      // router tests drive the page against the server's own port, so they never see it, and the owner's
      // URL is this front.
      //
      // THE EXECUTOR CHANNEL. The environment page connects here to act on a folder it owns
      // (vb-resolver's router: a page-owned root is executed BY THE PAGE).
      // Rewrites Origin to API_TARGET so the server's local origin check admits the dev front,
      // matching the /live proxy configuration.
      "/channel": {
        target: API_TARGET,
        ws: true,
        configure: (proxy) => {
          proxy.on("proxyReqWs", (proxyReq) => {
            proxyReq.setHeader("origin", API_TARGET);
          });
        },
      },
      // THE PAGE'S OWN MODULE GRAPH — GENERATED, NOT COPIED. The server serves the browser's TypeScript
      // modules (its SOURCE_DIRS) and the page and its worker import them as absolute paths
      // (`/core/paths.ts`, `/lib/channel.mjs`, `/browser/worker.ts`). Every one of those directories must
      // be forwarded here, or the request falls through to Vite's SPA fallback and the front answers a
      // MODULE with an HTML DOCUMENT: measured 2026-09-23, `/core/paths.ts` -> 200 text/html, 16 KB, with
      // `/@vite/client` in it, against 200 text/javascript, 3.6 KB from the server. A module worker cannot
      // execute HTML, so the environment page's worker died without an error and `window.e1m0.ready` never
      // resolved: the page looked alive and could not act at all.
      //
      // The list is IMPORTED from the file the server reads, so the two cannot drift; and
      // tools/page-acceptance.mjs fetches one module per prefix through this front so the next drift fails
      // loudly instead of silently (voicebox-beads-geq).
      ...Object.fromEntries(SOURCE_PREFIXES.map((prefix) => [prefix, { target: API_TARGET }])),
      "/browser": { target: API_TARGET },
    },
  },
});
