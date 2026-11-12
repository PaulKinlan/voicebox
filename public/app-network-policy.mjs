/**
 * @summary Mini-App network policy: reads an app's declared domains and builds the default-deny CSP its frame runs under.
 */
// THE MINI-APP NETWORK POLICY (voicebox-beads-cwx5.16).
//
// A Mini-App's inner frame is a `srcdoc` document in an opaque-origin sandbox. Until this module it ran with NO
// content security policy, so app code — written by a model, or brought in from elsewhere — could load a script
// from, or send a tool call's arguments to, any origin on the internet. The sandbox kept the app away from the
// host; nothing kept the user's data away from the network.
//
// Now every app document starts with a CSP that denies the network by default. An app that needs an outside
// origin DECLARES it, using the field names MCP Apps uses for the same idea (`_meta.ui.csp`):
//
//   <script type="application/voicebox-app+json">
//   { "csp": { "connectDomains": ["https://api.example.com"], "resourceDomains": ["https://cdn.jsdelivr.net"] } }
//   </script>
//
//   connectDomains   where the app may fetch / XHR / WebSocket / EventSource to
//   resourceDomains  where the app may load scripts, styles, images, fonts and media from
//
// A declaration is a REQUEST, not a grant: the room decides which declared origins the frame actually gets
// (public/components/mini-app-surface.mjs) and passes that grant to the bridge, which builds the policy here.
//
// This file is pure: no DOM, no network, no storage. The bridge, the room and the tests import the same code.

/** At most this many origins per list: a policy is a short, readable thing or it is not reviewable. */
export const MAX_DOMAINS_PER_LIST = 16;
/** The longest manifest block that is parsed at all. */
export const MAX_MANIFEST_BYTES = 8192;

const MANIFEST_BLOCK = /<script\b[^>]*\btype\s*=\s*(["'])application\/voicebox-app\+json\1[^>]*>([\s\S]*?)<\/script\s*>/i;
/** A DNS label, and a host made of them. No IP-literal brackets, no userinfo, no underscores. */
const HOST = /^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * One declared origin, normalised, or the reason it is refused.
 *
 * Accepted: `https://host`, `https://host:port`, `wss://host`, and a single leading wildcard label
 * (`https://*.example.com`). Refused: every other scheme (http and ws are cleartext; `data:` and `blob:` are
 * granted by the policy itself where they are safe), a bare `*`, a wildcard that would cover a whole public
 * suffix (`https://*.com`), and anything carrying a path, query, fragment or credentials — an origin is the
 * unit CSP enforces, and an entry that looks narrower than what it grants is a lie in the review.
 */
export function normalizeDomain(value) {
  if (typeof value !== "string") return { ok: false, why: "a domain must be a string" };
  const text = value.trim().toLowerCase();
  if (!text || text.length > 255) return { ok: false, why: "a domain must be 1-255 characters" };
  const match = text.match(/^(https|wss):\/\/([^/?#@\s]+)\/?$/);
  if (!match) return { ok: false, why: `'${value}' must be an https:// or wss:// origin with no path, query or credentials` };
  const [, scheme, authority] = match;
  const portAt = authority.lastIndexOf(":");
  const host = portAt === -1 ? authority : authority.slice(0, portAt);
  const port = portAt === -1 ? "" : authority.slice(portAt + 1);
  if (port && (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535)) return { ok: false, why: `'${value}' has an invalid port` };
  if (!HOST.test(host)) return { ok: false, why: `'${value}' is not a valid host name` };
  if (/^\d+(?:\.\d+){3}$/.test(host)) return { ok: false, why: `'${value}' is an IP address; declare a host name` };
  if (host === "localhost" || host.endsWith(".localhost")) return { ok: false, why: `'${value}' is this machine; a Mini-App reaches the host through its tools, not the network` };
  if (host.startsWith("*.") && host.slice(2).split(".").length < 2) return { ok: false, why: `'${value}' would cover a whole top-level domain` };
  return { ok: true, origin: `${scheme}://${host}${port ? `:${port}` : ""}` };
}

/** A declared list as validated, de-duplicated, sorted origins plus the entries that were refused. */
export function normalizeDomainList(list) {
  const origins = new Set();
  const refused = [];
  if (list === undefined || list === null) return { origins: [], refused };
  if (!Array.isArray(list)) return { origins: [], refused: ["the list must be an array of origins"] };
  for (const entry of list.slice(0, MAX_DOMAINS_PER_LIST)) {
    const checked = normalizeDomain(entry);
    if (checked.ok) origins.add(checked.origin);
    else refused.push(checked.why);
  }
  if (list.length > MAX_DOMAINS_PER_LIST) refused.push(`only the first ${MAX_DOMAINS_PER_LIST} entries of a list are read`);
  return { origins: [...origins].sort(), refused };
}

/** The empty request: an app that declares nothing asks for nothing. */
const NOTHING = Object.freeze({ connectDomains: Object.freeze([]), resourceDomains: Object.freeze([]) });

/**
 * What an app's HTML asks for. Never throws: a missing, oversized or malformed manifest asks for nothing and
 * says why in `problems`, so the room can show the author what was ignored.
 */
export function readAppNetworkRequest(html) {
  const problems = [];
  const none = (why) => ({ declared: false, ...NOTHING, problems: why ? [why] : problems });
  if (typeof html !== "string") return none();
  const block = html.match(MANIFEST_BLOCK);
  if (!block) return none();
  const raw = block[2];
  if (raw.length > MAX_MANIFEST_BYTES) return none(`the app manifest is larger than ${MAX_MANIFEST_BYTES} bytes and was ignored`);
  let manifest;
  try { manifest = JSON.parse(raw); } catch { return none("the app manifest is not valid JSON and was ignored"); }
  const csp = manifest && typeof manifest === "object" && !Array.isArray(manifest) ? manifest.csp : undefined;
  if (csp === undefined) return none();
  if (!csp || typeof csp !== "object" || Array.isArray(csp)) return none("the app manifest's csp must be an object and was ignored");
  const connect = normalizeDomainList(csp.connectDomains);
  const resource = normalizeDomainList(csp.resourceDomains);
  problems.push(...connect.refused, ...resource.refused);
  return {
    declared: connect.origins.length > 0 || resource.origins.length > 0,
    connectDomains: connect.origins,
    resourceDomains: resource.origins,
    problems,
  };
}

/**
 * The part of a request that a grant actually covers. A grant can only NARROW: an origin the app did not
 * declare is never added, whatever the caller passes, and every origin is validated again on the way through.
 */
export function grantWithin(request, grant) {
  const allowed = (wanted, given) => {
    const ok = new Set(normalizeDomainList(given).origins);
    return normalizeDomainList(wanted).origins.filter((origin) => ok.has(origin));
  };
  return {
    connectDomains: allowed(request?.connectDomains, grant?.connectDomains),
    resourceDomains: allowed(request?.resourceDomains, grant?.resourceDomains),
  };
}

/** A stable name for "this exact set of origins", so an approval is for what was shown and nothing wider. */
export function networkRequestKey(request) {
  const connect = normalizeDomainList(request?.connectDomains).origins;
  const resource = normalizeDomainList(request?.resourceDomains).origins;
  return `connect=${connect.join(",")};resource=${resource.join(",")}`;
}

/**
 * The CSP a Mini-App document runs under, given the origins it was granted.
 *
 * `'unsafe-inline'` and `'unsafe-eval'` are present on purpose. A Mini-App IS one HTML file of inline script
 * and style, and the SDK is injected inline; the boundary this policy draws is the NETWORK, and the host is
 * already kept out by the opaque-origin sandbox. `data:` and `blob:` are allowed only where they carry content
 * the app already holds (images, media, fonts, workers), never for script loads from elsewhere.
 */
export function buildAppCsp(grant = NOTHING, { hostOrigin } = {}) {
  const connect = normalizeDomainList(grant?.connectDomains).origins;
  // The host's own origin is a resource source for every app: the built-in apps are a page plus the modules it
  // imports (`/apps/landing-inspector.js`), all served by Voicebox itself. It is never a connect source — an
  // app's fetch to the host goes through the bridge's relay and the room's consent, not the network.
  const resource = [...hostSource(hostOrigin), ...normalizeDomainList(grant?.resourceDomains).origins];
  const list = (...parts) => parts.flat().filter(Boolean).join(" ");
  return [
    "default-src 'none'",
    `script-src ${list("'unsafe-inline'", "'unsafe-eval'", "'wasm-unsafe-eval'", resource)}`,
    `style-src ${list("'unsafe-inline'", resource)}`,
    `img-src ${list("data:", "blob:", resource)}`,
    `media-src ${list("data:", "blob:", resource)}`,
    `font-src ${list("data:", resource)}`,
    `connect-src ${list(connect.length ? connect : "'none'")}`,
    "worker-src blob:",
    "child-src blob:",
    "frame-src 'none'",
    "object-src 'none'",
    "manifest-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    "webrtc 'block'",
  ].join("; ");
}

/**
 * The Voicebox server's origin as a CSP source, or nothing. It is the page's own `location.origin`, handed in by
 * the bridge, so it may be `http://127.0.0.1:8787` — a form `normalizeDomain` rightly refuses from an app.
 */
function hostSource(hostOrigin) {
  if (typeof hostOrigin !== "string" || !hostOrigin) return [];
  try {
    const url = new URL(hostOrigin);
    return (url.protocol === "http:" || url.protocol === "https:") && url.origin === hostOrigin ? [url.origin] : [];
  } catch { return []; }
}

/** The policy as the first element an app document parses. The content is attribute-escaped. */
export function cspMetaTag(grant, options) {
  const policy = buildAppCsp(grant, options).replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  return `<meta http-equiv="Content-Security-Policy" content="${policy}">`;
}

/**
 * An app document with its policy in place: what the app declares, narrowed by `grant`, as the FIRST thing the
 * document parses.
 *
 * FIRST means immediately after the doctype, never "after <head>". A meta CSP governs only what is parsed after
 * it, and where an app's `<head>` tag appears is the app's choice: one that opened with
 * `<script src="https://elsewhere/x.js"></script><head>` would load that script before a policy placed in its
 * head existed. A meta before `<html>` lands in the implied head, and the app's own `<head>` tag is then merged
 * into it.
 *
 * The app's own doctype is kept ONLY when it is exactly the standard one preceded by nothing but HTML
 * whitespace (PR #40 review). What JavaScript's `\s` calls whitespace the HTML parser may call content: a
 * document that starts with a no-break space or a BOM-then-text has already opened `<body>` by the time its
 * doctype is seen, and a policy placed after that doctype would sit in the body, where a meta CSP is ignored.
 * Every other opening (no doctype, a legacy doctype, anything in front) is given a standard doctype and the
 * policy ahead of all of it; the app's own doctype then arrives late and the parser discards it.
 */
const STANDARD_DOCTYPE = /^[\t\n\f\r ]*<!doctype[\t\n\f\r ]+html[\t\n\f\r ]*>/i;

export function applyNetworkPolicy(html, grant, options) {
  const src = typeof html === "string" ? html : "";
  const tag = cspMetaTag(grantWithin(readAppNetworkRequest(src), grant), options);
  const doctype = src.match(STANDARD_DOCTYPE);
  return doctype
    ? `${doctype[0]}\n${tag}${src.slice(doctype[0].length)}`
    : `<!doctype html>\n${tag}\n${src}`;
}

/** The host of a blocked URL as a person would recognise it; a scheme-only block (`data`, `eval`) is returned as is. */
export function blockedOrigin(blockedUri) {
  if (typeof blockedUri !== "string" || !blockedUri) return "";
  try { return new URL(blockedUri).origin; } catch { return blockedUri.slice(0, 80); }
}
