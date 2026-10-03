// public/sw.js — Voicebox Progressive Web App Service Worker.
//
// Uses a Network-First with Cache Fallback strategy for same-origin static shell
// assets so fresh updates on disk are always served immediately while online,
// and falls back to the shell cache when offline. Dynamic API and streaming
// routes (/api/*, /live, /channel) are never intercepted.

const CACHE_NAME = "voicebox-shell-v1";
const SHELL_ASSETS = [
  "./",
  "./index.html",
  "./style.css",
  "./fused.js",
  "./icon.svg",
  "./manifest.webmanifest",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL_ASSETS).catch(() => {}))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== CACHE_NAME)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;

  let url;
  try {
    url = new URL(event.request.url);
  } catch {
    return;
  }

  if (url.origin !== self.location.origin) return;

  if (
    url.pathname.startsWith("/api/") ||
    url.pathname.startsWith("/live") ||
    url.pathname.startsWith("/channel")
  ) {
    return;
  }

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response && response.ok && response.type === "basic") {
          const copy = response.clone();
          caches
            .open(CACHE_NAME)
            .then((cache) => cache.put(event.request, copy))
            .catch(() => {});
        }
        return response;
      })
      .catch(async () => {
        const cached = await caches.match(event.request);
        if (cached) return cached;
        if (event.request.mode === "navigate") {
          const fallback = await caches.match("./index.html");
          if (fallback) return fallback;
        }
        throw new Error("Network request failed and no cached asset is available.");
      }),
  );
});
