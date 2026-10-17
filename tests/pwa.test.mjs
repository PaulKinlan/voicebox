import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { identifiersInRenderedText } from "../tools/rendered-plain-language.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST_PATH = path.join(ROOT, "public", "manifest.webmanifest");
const SW_PATH = path.join(ROOT, "public", "sw.js");
const ICON_PATH = path.join(ROOT, "public", "icon.svg");

describe("PWA manifest and service worker (voicebox-beads-0jxa)", () => {
  it("public/manifest.webmanifest is valid JSON with standalone display and existing icon asset", () => {
    assert.equal(existsSync(MANIFEST_PATH), true, "public/manifest.webmanifest must exist");
    const raw = readFileSync(MANIFEST_PATH, "utf8");
    const manifest = JSON.parse(raw);

    assert.equal(manifest.name, "Voicebox");
    assert.equal(manifest.short_name, "Voicebox");
    assert.equal(manifest.display, "standalone");
    assert.ok(typeof manifest.start_url === "string" && manifest.start_url.length > 0);
    assert.ok(typeof manifest.background_color === "string" && manifest.background_color.startsWith("#"));
    assert.ok(typeof manifest.theme_color === "string" && manifest.theme_color.startsWith("#"));
    assert.ok(Array.isArray(manifest.icons) && manifest.icons.length >= 1);
    assert.equal(manifest.icons[0].src, "icon.svg");
    assert.equal(existsSync(ICON_PATH), true, "public/icon.svg referenced by manifest must exist");
  });

  it("public/sw.js registers install/activate/fetch listeners, bypasses /api/ routes, caches network-first with offline fallback, and passes plain-language scan", async () => {
    assert.equal(existsSync(SW_PATH), true, "public/sw.js must exist");
    const swSource = readFileSync(SW_PATH, "utf8");

    // Plain-language check on string literals in public/sw.js
    const hits = identifiersInRenderedText(swSource);
    assert.deepEqual(hits, [], `expected 0 plain-language violations in public/sw.js, got ${JSON.stringify(hits)}`);

    // Drive the service worker in an isolated VM context to verify install, activate, and fetch behavior
    const listeners = new Map();
    const cacheStore = new Map();
    let skipWaitingCalled = false;
    let clientsClaimCalled = false;
    let networkOnline = true;

    const mockCache = {
      async addAll(urls) {
        for (const u of urls) {
          cacheStore.set(u, { status: 200, ok: true, body: `cached:${u}` });
        }
      },
      async put(req, res) {
        const key = typeof req === "string" ? req : req.url;
        cacheStore.set(key, res);
      },
    };

    const mockCaches = {
      async open() {
        return mockCache;
      },
      async keys() {
        return ["old-cache-v0", "voicebox-shell-v1"];
      },
      async delete(key) {
        cacheStore.delete(key);
        return true;
      },
      async match(req) {
        const key = typeof req === "string" ? req : req.url;
        return cacheStore.get(key) ?? null;
      },
    };

    const sandbox = {
      self: {
        location: { origin: "http://127.0.0.1:8080" },
        addEventListener(type, fn) {
          listeners.set(type, fn);
        },
        skipWaiting() {
          skipWaitingCalled = true;
          return Promise.resolve();
        },
        clients: {
          claim() {
            clientsClaimCalled = true;
            return Promise.resolve();
          },
        },
      },
      caches: mockCaches,
      URL,
      Promise,
      fetch: async (req) => {
        if (!networkOnline) {
          throw new Error("offline");
        }
        return {
          ok: true,
          status: 200,
          type: "basic",
          body: `fresh:${req.url}`,
          clone() {
            return { ...this };
          },
        };
      },
    };

    vm.runInNewContext(swSource, sandbox);

    assert.equal(listeners.has("install"), true, "sw.js must register install listener");
    assert.equal(listeners.has("activate"), true, "sw.js must register activate listener");
    assert.equal(listeners.has("fetch"), true, "sw.js must register fetch listener");

    // 1. Trigger install
    let installPromise = null;
    listeners.get("install")({
      waitUntil(p) {
        installPromise = p;
      },
    });
    await installPromise;
    assert.equal(skipWaitingCalled, true, "install should call self.skipWaiting()");
    assert.equal(cacheStore.has("./styles/tokens.css"), true, "tokens.css must be in precache store");
    assert.equal(cacheStore.has("./styles/stage.css"), true, "stage.css must be in precache store");
    assert.equal(cacheStore.has("./styles/deck.css"), true, "deck.css must be in precache store");
    assert.equal(cacheStore.has("./styles/dialogs.css"), true, "dialogs.css must be in precache store");
    assert.equal(cacheStore.has("./styles/mini-apps.css"), true, "mini-apps.css must be in precache store");

    // 2. Trigger activate
    let activatePromise = null;
    listeners.get("activate")({
      waitUntil(p) {
        activatePromise = p;
      },
    });
    await activatePromise;
    assert.equal(clientsClaimCalled, true, "activate should call self.clients.claim()");

    // 3. /api/ and /live requests are bypassed (respondWith is NOT called)
    let apiResponded = false;
    listeners.get("fetch")({
      request: { method: "GET", url: "http://127.0.0.1:8080/api/health", mode: "cors" },
      respondWith() {
        apiResponded = true;
      },
    });
    assert.equal(apiResponded, false, "/api/* requests must bypass the service worker");

    // 4. Same-origin static asset uses network-first when online and populates cache, then falls back to cache when offline
    let assetResponsePromise = null;
    const assetUrl = "http://127.0.0.1:8080/style.css";
    listeners.get("fetch")({
      request: { method: "GET", url: assetUrl, mode: "same-origin" },
      respondWith(p) {
        assetResponsePromise = p;
      },
    });
    assert.ok(assetResponsePromise, "static asset fetch should be handled");
    const onlineRes = await assetResponsePromise;
    assert.equal(onlineRes.body, `fresh:${assetUrl}`);

    // Now go offline and fetch the same asset -> returns cached copy
    networkOnline = false;
    let offlineResponsePromise = null;
    listeners.get("fetch")({
      request: { method: "GET", url: assetUrl, mode: "same-origin" },
      respondWith(p) {
        offlineResponsePromise = p;
      },
    });
    const offlineRes = await offlineResponsePromise;
    assert.equal(offlineRes.body, `fresh:${assetUrl}`, "offline fetch must return cached response");
  });

  it("every stylesheet linked in public/index.html is included in the PWA precache SHELL_ASSETS (voicebox-beads-q35r)", () => {
    const html = readFileSync(path.join(ROOT, "public", "index.html"), "utf8");
    const swSource = readFileSync(SW_PATH, "utf8");

    const linkedStylesheets = [];
    const linkRegex = /<link[^>]+rel=["']stylesheet["'][^>]*>/gi;
    for (const linkTag of html.match(linkRegex) || []) {
      const hrefMatch = linkTag.match(/href=["']([^"']+)["']/i);
      if (hrefMatch) {
        linkedStylesheets.push(hrefMatch[1]);
      }
    }
    assert.ok(linkedStylesheets.length > 0, "index.html must link stylesheets");

    const match = swSource.match(/const\s+SHELL_ASSETS\s*=\s*\[([\s\S]*?)\];/);
    assert.ok(match, "public/sw.js must define SHELL_ASSETS");
    const shellAssets = match[1]
      .split(",")
      .map((s) => s.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean);

    for (const relHref of linkedStylesheets) {
      const normalized = relHref.startsWith("./") ? relHref : `./${relHref}`;
      const hasAsset = shellAssets.some((asset) => asset === relHref || asset === normalized || asset === `/${relHref}`);
      assert.ok(
        hasAsset,
        `stylesheet ${relHref} linked in index.html must be present in SHELL_ASSETS precache list`,
      );
    }
  });

  it("every asset listed in SHELL_ASSETS exists on disk in public/ (voicebox-beads-q35r)", () => {
    const swSource = readFileSync(SW_PATH, "utf8");
    const match = swSource.match(/const\s+SHELL_ASSETS\s*=\s*\[([\s\S]*?)\];/);
    const shellAssets = match[1]
      .split(",")
      .map((s) => s.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean);

    for (const asset of shellAssets) {
      if (asset === "./" || asset === "/") continue;
      const cleanPath = asset.replace(/^\.\//, "");
      const fullPath = path.join(ROOT, "public", cleanPath);
      assert.ok(existsSync(fullPath), `SHELL_ASSETS item ${asset} must exist on disk at ${fullPath}`);
    }
  });
});
