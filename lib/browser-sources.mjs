// lib/browser-sources.mjs — WHICH DIRECTORIES THE SERVER SERVES AS THE BROWSER'S MODULES.
//
// ONE LIST, TWO READERS. `server.mjs` serves these directories (transformed, as JavaScript) and the
// dev front must FORWARD them, because the page and its worker import them as absolute paths
// (`/core/paths.ts`, `/lib/channel.mjs`, `/browser/worker.ts`).
//
// WHY THIS IS A FILE AND NOT A LINE IN server.mjs (voicebox-beads-geq, 2026-09-23): the rule lived in
// server.mjs alone and the front kept a hand-written copy holding ONE of the five prefixes. The day the
// environment page's worker started importing `/core`, the front answered `/core/paths.ts` with its
// SPA fallback — 200 `text/html`, 16 KB, `/@vite/client` inside — and a module worker cannot execute an
// HTML document, so it died without an error: the page looked alive and could not act at all. Every
// page test drives the server's own port, so nothing in the suite could see it.
//
// a list that exists twice drifts. This one exists once, and tools/page-acceptance.mjs drives the real
// front once per prefix so the drift is loud rather than silent.
export const SOURCE_DIRS = new Set(["core", "browser", "tools", "tests", "lib"]);

/** The URL prefixes a front in front of this server must forward, in a stable order. */
export const SOURCE_PREFIXES = [...SOURCE_DIRS].map((dir) => `/${dir}`);
