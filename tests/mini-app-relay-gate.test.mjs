// tests/mini-app-relay-gate.test.mjs — the mini-app fetch relay's gate, executed rather than grepped
// (voicebox-beads-zus7).
//
// The finding: the relay admitted a target by STRING PREFIX (`url.startsWith("/") && !url.startsWith("//")`).
// The WHATWG URL parser strips ASCII tab/CR/LF and treats a backslash as "/" for special schemes, so
// `"/\t//127.0.0.1:9999/leak"` passes both prefix tests and resolves to a FOREIGN origin — the sandboxed
// frame (opaque origin) reached a visitor's other local services through the bridge page's own fetch, and its
// POST body left the machine.
//
// So this file imports the one gate (public/relay-target.mjs) and RUNS it over the parser's own edge cases;
// it also pins that the injected frame SDK is built from that same function, because a second hand-written
// copy in the frame is how the two halves drift apart again.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { relayTarget } from "../public/relay-target.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bridge = readFileSync(path.join(root, "public", "mini-app-bridge.js"), "utf8");

const BRIDGE_ORIGIN = "http://127.0.0.1:8787";

test("same-origin targets are admitted and named by their resolved path", () => {
  for (const url of ["/api/health", "/api/keys?x=1", "/api/branches/candidates#top", `${BRIDGE_ORIGIN}/api/health`]) {
    const target = relayTarget(url, BRIDGE_ORIGIN);
    assert.ok(target, `${url} must be relayable`);
    assert.equal(target.origin, BRIDGE_ORIGIN, `${url} must still be on the bridge's origin`);
    assert.match(target.pathname, /^\//, `${url} must resolve to a path on that origin`);
  }
});

test("a control character cannot carry the target to another origin", () => {
  // The escape the finding measured. Each of these starts with exactly one "/" and does not start with "//".
  const escapes = [
    "/\t//127.0.0.1:9999/leak",
    "/\n//127.0.0.1:9999/leak",
    "/\r//127.0.0.1:9999/leak",
    "/\t\\127.0.0.1:9999/leak",
    "/\u0000//127.0.0.1:9999/leak",
  ];
  for (const url of escapes) {
    const prefixed = url.startsWith("/") && !url.startsWith("//");
    assert.ok(prefixed, `${JSON.stringify(url)} is exactly the shape the old prefix gate admitted`);
    assert.equal(relayTarget(url, BRIDGE_ORIGIN), null, `${JSON.stringify(url)} must be refused`);
  }
});

test("scheme-relative, absolute and backslash forms are refused, not normalised into the relay", () => {
  const foreign = [
    "//127.0.0.1:9999/leak",
    "http://127.0.0.1:9999/leak",
    "https://example.invalid/leak",
    "\\\\127.0.0.1:9999/leak",
    "\\/\\/127.0.0.1:9999/leak",
    "javascript:alert(1)",
    "data:text/plain,hi",
    "file:///etc/passwd",
    "http://127.0.0.1:8787@evil.invalid/leak",
  ];
  for (const url of foreign) {
    assert.equal(relayTarget(url, BRIDGE_ORIGIN), null, `${JSON.stringify(url)} must be refused`);
  }
});

test("the gate refuses every non-string and empty target instead of throwing", () => {
  for (const url of [undefined, null, "", 0, {}, [], new String("/api/health")]) {
    assert.equal(relayTarget(url, BRIDGE_ORIGIN), null, `${String(url)} must be refused, not relayed`);
  }
});

test("the frame SDK is built from this same function, so the two halves cannot drift", () => {
  // One implementation, two realms: the bridge imports it, and the injected SDK text embeds its source.
  assert.match(bridge, /import \{ relayTarget \} from "\.\/relay-target\.mjs";/, "the bridge must import the gate");
  assert.match(
    bridge,
    /var relayTarget = \(\$\{String\(relayTarget\)\}\);/,
    "the injected SDK must be built from this function's own source, not a second copy",
  );
  // The boundary itself: the bridge asks for the resolved target and fetches THAT, and the frame asks before
  // it posts. A future edit that goes back to a prefix test has to delete both lines.
  assert.match(bridge, /const target = relayTarget\(url, window\.location\.origin\);/, "the bridge must resolve the target");
  assert.match(bridge, /const res = await fetch\(target\.href, \{/, "the bridge must fetch the RESOLVED target");
  assert.match(bridge, /var target = relayTarget\(url, RELAY_BASE\);/, "the frame must ask the same gate");
  assert.match(bridge, /url: target\.pathname \+ target\.search \+ target\.hash,/, "the frame must send a resolved path");
  // The list of relayable methods is unchanged: this fix is about WHERE, not what.
  assert.match(bridge, /\[\"GET\", \"POST\", \"PUT\", \"PATCH\", \"DELETE\", \"HEAD\"\]\.includes\(method\)/);
});
