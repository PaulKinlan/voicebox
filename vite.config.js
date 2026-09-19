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

const API_TARGET = `http://127.0.0.1:${process.env.PORT ?? 8787}`;

export default defineConfig({
  root: "public",
  publicDir: false, // public/ IS the root; there is no second static dir
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
