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
import path from "node:path";
import { cspSafeViteClient } from "./tools/vite-plugin-csp-safe-client.mjs";

const API_TARGET = `http://127.0.0.1:${process.env.PORT ?? 8787}`;

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

export default defineConfig({
  plugins: [cspSafeViteClient(), loudStaticMiss()],
  root: "public",
  publicDir: false, // public/ IS the root; there is no second static dir
  // appType stays default ("spa") so "/" serves index.html. The loud 404 for a
  // missing asset comes from the loudStaticMiss middleware above, not from
  // removing index.html from the server — see the comment there for why.
  server: {
    port: 5173,
    strictPort: true,
    host: true, // listen on all interfaces: LAN 192.168.x.x + Tailscale 100.x
    proxy: {
      "/api": { target: API_TARGET },
      // The audio socket (k3's live session, landing separately). ws: true so
      // the WebSocket upgrade is forwarded and survives HMR reloads.
      "/live": { target: API_TARGET, ws: true },
    },
  },
});
