// tests/cswsh-origin-unit.test.mjs — unit tests for dev-front WebSocket Origin validation (voicebox-beads-efc6)

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDevFrontOrigin, forwardDevFrontOrigin } from "../vite.config.js";

test("isDevFrontOrigin admits legitimate same-origin loopback requests", () => {
  // Standard localhost on port 5173
  assert.equal(isDevFrontOrigin("http://localhost:5173", "localhost:5173"), true);
  assert.equal(isDevFrontOrigin("http://localhost:5173", "LOCALHOST:5173"), true);

  // IPv4 loopback
  assert.equal(isDevFrontOrigin("http://127.0.0.1:5173", "127.0.0.1:5173"), true);
  assert.equal(isDevFrontOrigin("http://127.0.0.1:41234", "127.0.0.1:41234"), true);

  // IPv6 loopback
  assert.equal(isDevFrontOrigin("http://[::1]:5173", "[::1]:5173"), true);

  // Tailscale HTTPS front
  assert.equal(isDevFrontOrigin("https://omarchy.tail9d22b9.ts.net:5173", "omarchy.tail9d22b9.ts.net:5173"), true);
  assert.equal(isDevFrontOrigin("https://mybox.ts.net", "mybox.ts.net"), true);
});

test("isDevFrontOrigin rejects cross-origin and mismatched requests", () => {
  // External hostile domains
  assert.equal(isDevFrontOrigin("http://evil.com", "localhost:5173"), false);
  assert.equal(isDevFrontOrigin("https://attacker.example", "localhost:5173"), false);
  assert.equal(isDevFrontOrigin("http://evil.com", "127.0.0.1:5173"), false);

  // Mismatched ports (another service on loopback)
  assert.equal(isDevFrontOrigin("http://127.0.0.1:8080", "127.0.0.1:5173"), false);
  assert.equal(isDevFrontOrigin("http://localhost:3000", "localhost:5173"), false);

  // Spoofing API target port on dev front host
  assert.equal(isDevFrontOrigin("http://127.0.0.1:8787", "localhost:5173"), false);
  assert.equal(isDevFrontOrigin("http://127.0.0.1:8787", "127.0.0.1:5173"), false);

  // Domain ending with ts.net lookalike
  assert.equal(isDevFrontOrigin("http://fake-ts.net", "fake-ts.net"), false);
  assert.equal(isDevFrontOrigin("http://notts.net:5173", "notts.net:5173"), false);

  // Invalid / non-HTTP protocols
  assert.equal(isDevFrontOrigin("ws://localhost:5173", "localhost:5173"), false);
  assert.equal(isDevFrontOrigin("data:text/html,test", "localhost:5173"), false);
  assert.equal(isDevFrontOrigin("javascript:void(0)", "localhost:5173"), false);

  // Userinfo injection
  assert.equal(isDevFrontOrigin("http://user:pass@localhost:5173", "localhost:5173"), false);

  // Malformed / non-string / null
  assert.equal(isDevFrontOrigin(null, "localhost:5173"), false);
  assert.equal(isDevFrontOrigin(undefined, "localhost:5173"), false);
  assert.equal(isDevFrontOrigin("not-a-url", "localhost:5173"), false);
  assert.equal(isDevFrontOrigin("http://localhost:5173", null), false);
  assert.equal(isDevFrontOrigin("http://localhost:5173", undefined), false);
});

// ── ONE ENTITLEMENT RULE FOR EVERY HOP (voicebox-beads-pdr6) ──────────────────────────────────────
//
// The finding: the WS hops (`/live`, `/channel`) had required the caller to PROVE it was this dev front
// since voicebox-beads-efc6, and the /api hop had not — it rewrote Origin to API_TARGET for every caller.
// `hasExtensionAuthority()` rule 3 reads exactly that Origin, so through the dev front a hostile page was
// entitled to the 16 host-authority routes: the repro got `404 refused=extension-not-admitted` via the front
// where a direct call got `403 refused=host-token-required`. These cases drive the function all three hops
// now share, so a hop that goes back to minting an Origin for anyone fails here.

const fakeProxyReq = () => ({
  headers: {},
  setHeader(name, value) { this.headers[name.toLowerCase()] = String(value); },
  removeHeader(name) { delete this.headers[name.toLowerCase()]; },
});

const forward = (origin, host) => {
  const proxyReq = fakeProxyReq();
  forwardDevFrontOrigin(proxyReq, { headers: { ...(origin === undefined ? {} : { origin }), host } });
  return proxyReq.headers.origin;
};

test("the dev front's own page is entitled on every spelling of the front", () => {
  for (const host of ["localhost:5173", "127.0.0.1:5173", "[::1]:5173", "voicebox.example.ts.net"]) {
    const origin = `http://${host}`;
    const written = forward(origin, host);
    assert.ok(written, `${origin} must be rewritten, not left unset`);
    assert.notEqual(written, origin, "the front's page keeps its spelling only if no rewrite happened");
    assert.equal(written, forward(`http://${host}`, host), "the same caller must be entitled identically on every hop");
  }
});

test("a hostile Origin is NOT laundered into the room's own page (the finding's shape)", () => {
  assert.equal(
    forward("https://attacker.example", "127.0.0.1:5173"),
    "https://attacker.example",
    "a foreign Origin must reach the server as itself, so hasExtensionAuthority answers for it",
  );
  // The tailnet spelling is allowed only when the Origin host IS the addressed Host.
  assert.equal(
    forward("https://other.ts.net", "voicebox.example.ts.net"),
    "https://other.ts.net",
    "a different tailnet name is not this front",
  );
});

test("a loopback Origin that does not match the addressed Host is a claim we cannot verify", () => {
  assert.equal(
    forward("http://127.0.0.1:9999", "127.0.0.1:5173"),
    "http://mismatched-loopback.invalid",
    "the sentinel (not the caller's own spelling) is what the server must see",
  );
  assert.equal(forward("http://localhost:5173", "127.0.0.1:5173"), "http://mismatched-loopback.invalid");
});

test("no Origin at all mints nothing — a machine caller is not turned into the page", () => {
  assert.equal(forward(undefined, "127.0.0.1:5173"), undefined, "a proxy hop must not invent an entitlement");
  assert.equal(forward("", "127.0.0.1:5173"), undefined);
});

test("the unconditional rewrite that caused the finding cannot come back", () => {
  const source = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "vite.config.js"), "utf8")
    // CODE, not prose: the comment that explains this finding quotes the line it removed, and a quoted line is
    // not a written one. `//` only counts as a comment when it starts a token, so `http://` survives.
    .replace(/(^|\s)\/\/[^\n]*/g, "$1");
  const unconditional = [...source.matchAll(/proxyReq\.setHeader\(\s*["']origin["']\s*,\s*API_TARGET\s*\)/g)];
  assert.equal(
    unconditional.length,
    1,
    `exactly one site may write the API's own Origin — the shared forwarder; found ${unconditional.length}`,
  );
  assert.match(
    source,
    /function forwardDevFrontOrigin\([\s\S]{0,400}?isDevFrontOrigin\(req\?\.headers\?\.origin, req\?\.headers\?\.host\)/,
    "the one site must be gated on the caller proving it is this dev front",
  );
});
