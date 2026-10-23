// tests/cswsh-origin-unit.test.mjs — unit tests for dev-front WebSocket Origin validation (voicebox-beads-efc6)

import test from "node:test";
import assert from "node:assert/strict";
import { isDevFrontOrigin } from "../vite.config.js";

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
