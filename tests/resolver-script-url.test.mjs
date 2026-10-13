// tests/resolver-script-url.test.mjs — the script resolver's "gets <url>" tool door, fed a TRANSCRIPT.
//
// voicebox-beads-lg5z (factory vuln-discovery run-20261013-031134): the door read transcript text
// straight into `new URL(get[1]).hostname`, so "create a tool called fetchy that gets http://[bad"
// raised ERR_INVALID_URL out of `script()` — and POST /api/turn has no handler between the resolver
// and its answer, so the caller got a 500 where the contract is `unresolved`. The same file already
// wrapped its other `new URL` (the extension `defaultUrl` path) in try/catch, which is how a second
// unguarded read of the same input shape survived.
//
// UNIT lane on purpose: the defect is entirely inside `script()`, and the route adds nothing between
// it and the response. `resolveTurn` is driven too, because that is the function the route calls —
// so the test would go red if the guard moved and only the unregistered path kept it.
import test from "node:test";
import assert from "node:assert/strict";
import { script, resolveTurn } from "../lib/resolver.mjs";

const authoring = "create a tool called fetchy that gets ";

// Each of these matches the door's `gets? (https?://[^\s,;]+)` capture and then throws in `new URL`:
// a bracketed host, a hostless authority, a query where the host should be, a port out of range, a
// non-numeric port, and an address no IPv4/IPv6 parser accepts.
const HOSTLESS = [
  "http://[bad",
  "https:///",
  "https://?x=1",
  "http://example.com:99999",
  "http://example.com:abc",
  "http://999.999.999.999",
  "http://[::1",
];

test("a URL with no readable host is unresolved, never a thrown ERR_INVALID_URL", () => {
  for (const url of HOSTLESS) {
    const action = script(authoring + url);
    assert.equal(action.verb, undefined, `${url} must not resolve to a verb`);
    assert.equal(typeof action.unresolved, "string", `${url} must come back as a reason`);
    assert.match(action.unresolved, /host/, `${url} reason must name the missing host`);
    assert.ok(action.unresolved.includes(url), `${url} reason must name the URL it could not read`);
    assert.doesNotMatch(action.unresolved, /undefined|\[object/, `${url} reason must not leak a JS value`);
  }
});

test("the turn door answers the same way the resolver does", async () => {
  const action = await resolveTurn(authoring + "http://[bad");
  assert.equal(typeof action.unresolved, "string");
  assert.match(action.unresolved, /http:\/\/\[bad/);
});

test("a URL that does name a host still builds the same tool", () => {
  const action = script(authoring + "https://api.example.com/data");
  assert.equal(action.verb, "make-tool");
  assert.deepEqual(action.tool.bounds, { hosts: ["api.example.com"], maxRequests: 5 });
  assert.deepEqual(action.tool.capabilities, ["network"]);
  assert.equal(action.tool.tools[0].params.url, "https://api.example.com/data");
});

test("a port and an address that are legal are still read as the host", () => {
  const action = script(authoring + "http://api.example.com:8443/v1/now");
  assert.equal(action.verb, "make-tool");
  assert.deepEqual(action.tool.bounds.hosts, ["api.example.com"]);
  assert.equal(action.tool.tools[0].params.url, "http://api.example.com:8443/v1/now");
});
