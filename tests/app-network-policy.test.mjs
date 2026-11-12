// tests/app-network-policy.test.mjs — the Mini-App network policy, as pure functions (voicebox-beads-cwx5.16).
//
// The policy is default-deny: an app document may reach an outside origin only if the app DECLARED it and the
// room GRANTED it. These tests drive public/app-network-policy.mjs directly — what a declaration may say, that a
// grant can only narrow, and exactly what the resulting CSP admits. The browser half (the policy is really the
// first thing the frame parses, a blocked load is reported, Allow is remembered) is in
// tests/mini-app-network.test.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_DOMAINS_PER_LIST, applyNetworkPolicy, blockedOrigin, buildAppCsp, cspMetaTag, grantWithin, networkRequestKey,
  normalizeDomain, normalizeDomainList, readAppNetworkRequest,
} from "../public/app-network-policy.mjs";

const manifest = (json) => `<!doctype html><script type="application/voicebox-app+json">${typeof json === "string" ? json : JSON.stringify(json)}</script><p>app</p>`;
const directive = (policy, name) => policy.split("; ").find((d) => d.startsWith(`${name} `)) ?? null;

test("a declared origin is https or wss, a host name, and nothing more", () => {
  assert.deepEqual(normalizeDomain("https://API.Example.com/"), { ok: true, origin: "https://api.example.com" });
  assert.deepEqual(normalizeDomain(" wss://live.example.com:8443 "), { ok: true, origin: "wss://live.example.com:8443" });
  assert.deepEqual(normalizeDomain("https://*.example.com"), { ok: true, origin: "https://*.example.com" });
  for (const refused of [
    "http://example.com", "ws://example.com", "ftp://example.com", "data:text/html,x", "blob:x", "javascript:alert(1)",
    "*", "https://*", "https://*.com", "https://a.*.example.com", "example.com", "//example.com",
    "https://example.com/path", "https://example.com?x=1", "https://example.com#f", "https://user:pw@example.com",
    "https://example.com:0", "https://example.com:99999", "https://exa mple.com", "https://example.com; script-src *",
    "https://127.0.0.1", "https://localhost", "https://app.localhost", "https://[::1]", "https://under_score.com",
    "", 7, null, undefined, {},
  ]) {
    assert.equal(normalizeDomain(refused).ok, false, `${JSON.stringify(refused)} must be refused`);
  }
});

test("a list is de-duplicated, sorted, capped, and says what it refused", () => {
  const list = normalizeDomainList(["https://b.example.com", "https://a.example.com", "https://B.example.com", "http://nope.example.com"]);
  assert.deepEqual(list.origins, ["https://a.example.com", "https://b.example.com"]);
  assert.equal(list.refused.length, 1);
  assert.deepEqual(normalizeDomainList(undefined), { origins: [], refused: [] });
  assert.equal(normalizeDomainList("https://a.example.com").origins.length, 0, "a string is not a list");
  const many = normalizeDomainList(Array.from({ length: MAX_DOMAINS_PER_LIST + 5 }, (_, i) => `https://h${i}.example.com`));
  assert.equal(many.origins.length, MAX_DOMAINS_PER_LIST);
  assert.match(many.refused.at(-1), /only the first 16/);
});

test("an app with no manifest, or a broken one, asks for nothing and says why", () => {
  assert.deepEqual(readAppNetworkRequest("<!doctype html><p>hi</p>"), { declared: false, connectDomains: [], resourceDomains: [], problems: [] });
  assert.equal(readAppNetworkRequest(undefined).declared, false);
  assert.match(readAppNetworkRequest(manifest("{not json")).problems[0], /not valid JSON/);
  assert.match(readAppNetworkRequest(manifest({ csp: ["https://a.example.com"] })).problems[0], /csp must be an object/);
  assert.match(readAppNetworkRequest(manifest(JSON.stringify({ csp: {}, pad: "x".repeat(9000) }))).problems[0], /larger than 8192 bytes/);
  assert.equal(readAppNetworkRequest(manifest({ title: "no csp here" })).declared, false);
  // A plain JSON script that is not the manifest type is not a declaration.
  assert.equal(readAppNetworkRequest(`<script type="application/json">{"csp":{"connectDomains":["https://a.example.com"]}}</script>`).declared, false);
});

test("a manifest's two lists are read separately, and bad entries are dropped without dropping the good ones", () => {
  const request = readAppNetworkRequest(manifest({ csp: {
    connectDomains: ["https://api.example.com", "http://insecure.example.com"],
    resourceDomains: ["https://cdn.jsdelivr.net"],
  } }));
  assert.equal(request.declared, true);
  assert.deepEqual(request.connectDomains, ["https://api.example.com"]);
  assert.deepEqual(request.resourceDomains, ["https://cdn.jsdelivr.net"]);
  assert.equal(request.problems.length, 1);
  // Single-quoted type attribute and extra attributes are still the manifest.
  assert.equal(readAppNetworkRequest(`<script id="m" type='application/voicebox-app+json'>{"csp":{"connectDomains":["https://a.example.com"]}}</script>`).declared, true);
});

test("a grant can only NARROW what the app declared", () => {
  const request = { connectDomains: ["https://api.example.com"], resourceDomains: ["https://cdn.example.com"] };
  assert.deepEqual(grantWithin(request, undefined), { connectDomains: [], resourceDomains: [] }, "no grant is no network");
  assert.deepEqual(grantWithin(request, request), request);
  assert.deepEqual(
    grantWithin(request, { connectDomains: ["https://api.example.com", "https://evil.example.net"], resourceDomains: [] }),
    { connectDomains: ["https://api.example.com"], resourceDomains: [] },
    "an origin the app never declared cannot be granted to it",
  );
  assert.deepEqual(grantWithin({}, request), { connectDomains: [], resourceDomains: [] }, "an app that declares nothing gets nothing, whatever is granted");
  // The two lists do not leak into each other.
  assert.deepEqual(grantWithin(request, { connectDomains: ["https://cdn.example.com"], resourceDomains: ["https://api.example.com"] }), { connectDomains: [], resourceDomains: [] });
});

test("an approval key names the exact origin set, in a stable order", () => {
  const a = networkRequestKey({ connectDomains: ["https://b.example.com", "https://a.example.com"], resourceDomains: [] });
  const b = networkRequestKey({ connectDomains: ["https://a.example.com", "https://b.example.com"], resourceDomains: [] });
  assert.equal(a, b);
  assert.notEqual(a, networkRequestKey({ connectDomains: ["https://a.example.com"], resourceDomains: [] }), "dropping an origin is a different request");
  assert.notEqual(a, networkRequestKey({ connectDomains: [], resourceDomains: ["https://a.example.com", "https://b.example.com"] }), "connect and resource are different grants");
});

test("with no grant the policy admits no outside origin anywhere", () => {
  const policy = buildAppCsp();
  assert.equal(directive(policy, "default-src"), "default-src 'none'");
  assert.equal(directive(policy, "connect-src"), "connect-src 'none'");
  assert.equal(directive(policy, "script-src"), "script-src 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'");
  assert.equal(directive(policy, "form-action"), "form-action 'none'");
  assert.equal(directive(policy, "frame-src"), "frame-src 'none'");
  assert.equal(directive(policy, "base-uri"), "base-uri 'none'");
  assert.doesNotMatch(policy, /https?:|wss?:|\*/, "a default policy must not name or wildcard any network origin");
});

test("a grant appears only in the directives it belongs to", () => {
  const policy = buildAppCsp({ connectDomains: ["https://api.example.com"], resourceDomains: ["https://cdn.example.com"] });
  assert.equal(directive(policy, "connect-src"), "connect-src https://api.example.com");
  for (const name of ["script-src", "style-src", "img-src", "media-src", "font-src"]) {
    assert.match(directive(policy, name), / https:\/\/cdn\.example\.com$/, `${name} admits the resource origin`);
    assert.doesNotMatch(directive(policy, name), /api\.example\.com/, `${name} must not admit a connect-only origin`);
  }
  assert.doesNotMatch(directive(policy, "connect-src"), /cdn\.example\.com/);
  assert.equal(directive(policy, "frame-src"), "frame-src 'none'", "no grant opens framing");
});

test("a hostile grant cannot inject a directive: it is validated again when the policy is built", () => {
  const policy = buildAppCsp({ connectDomains: ["https://a.example.com; script-src *", "'unsafe-inline'", "*"], resourceDomains: ["https://x.example.com\"><script>"] });
  assert.equal(directive(policy, "connect-src"), "connect-src 'none'");
  assert.doesNotMatch(policy, /script-src \*/);
  const tag = cspMetaTag({ connectDomains: ["https://api.example.com"], resourceDomains: [] });
  assert.match(tag, /^<meta http-equiv="Content-Security-Policy" content="[^"<>]+">$/, "the tag is one well-formed attribute");
});

test("a blocked URL is reported by origin", () => {
  assert.equal(blockedOrigin("https://cdn.example.com/lib/a.js?x=1"), "https://cdn.example.com");
  assert.equal(blockedOrigin("eval"), "eval");
  assert.equal(blockedOrigin(""), "");
  assert.equal(blockedOrigin(undefined), "");
});

test("the policy is the FIRST thing an app document parses, wherever the app put its <head>", () => {
  // A meta CSP governs only what comes after it. Each of these puts a network load where a policy injected
  // "after <head>" would arrive too late; the policy must precede every one.
  const early = `<script src="https://elsewhere.example.net/x.js"></script>`;
  for (const html of [
    `<!doctype html>${early}<html><head><title>t</title></head><body></body></html>`,
    `<!DOCTYPE html>\n<!-- <head> -->${early}<head></head>`,
    `<!doctype html><html><body>${early}</body></html>`,
    `${early}<!doctype html><head></head>`,              // something in FRONT of the doctype: it is not a doctype any more
    `<html><head>${early}</head></html>`,                // no doctype at all
    early,
    "",
  ]) {
    const out = applyNetworkPolicy(html);
    const policyAt = out.indexOf(`<meta http-equiv="Content-Security-Policy"`);
    assert.ok(policyAt > 0, `no policy in: ${out.slice(0, 80)}`);
    assert.match(out.slice(0, policyAt), /^\s*<!doctype html>\s*$/i, `only a doctype may precede the policy, got: ${JSON.stringify(out.slice(0, policyAt))}`);
    assert.equal(out.indexOf(`<meta http-equiv="Content-Security-Policy"`, policyAt + 1), -1, "exactly one policy is injected");
    if (html.includes(early)) assert.ok(out.indexOf(early) > policyAt, "the app's first load comes after the policy");
  }
  assert.equal(applyNetworkPolicy(undefined).startsWith("<!doctype html>"), true);
});

test("applying the policy narrows the room's grant to what the app itself declared", () => {
  const app = manifest({ csp: { connectDomains: ["https://api.example.com"] } });
  const policyOf = (out) => /content="([^"]+)"/.exec(out)[1];
  assert.equal(directive(policyOf(applyNetworkPolicy(app)), "connect-src"), "connect-src 'none'", "declared but not granted is offline");
  assert.equal(directive(policyOf(applyNetworkPolicy(app, { connectDomains: ["https://api.example.com", "https://evil.example.net"] })), "connect-src"), "connect-src https://api.example.com");
  assert.equal(directive(policyOf(applyNetworkPolicy("<!doctype html><p>no manifest</p>", { connectDomains: ["https://api.example.com"] })), "connect-src"), "connect-src 'none'", "a grant without a declaration grants nothing");
});

test("the host's own origin is a resource source for built-in apps and never a connect source", () => {
  const csp = buildAppCsp({ connectDomains: [], resourceDomains: [] }, { hostOrigin: "http://127.0.0.1:8787" });
  assert.match(csp, /script-src [^;]*http:\/\/127\.0\.0\.1:8787/);
  assert.match(csp, /style-src [^;]*http:\/\/127\.0\.0\.1:8787/);
  assert.match(csp, /connect-src 'none'/);
  for (const bad of ["javascript:alert(1)", "http://127.0.0.1:8787/x; script-src *", "*", "data:", 7, ""]) {
    assert.equal(buildAppCsp(undefined, { hostOrigin: bad }), buildAppCsp(), `'${bad}' must not widen the policy`);
  }
});
