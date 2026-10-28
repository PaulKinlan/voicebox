// public/relay-target.mjs — the ONE gate for the mini-app fetch relay (voicebox-beads-zus7).
//
// WHY THIS IS A RESOLVED-ORIGIN COMPARISON AND NOT A PREFIX TEST. The relay admitted a target when the string
// started with "/" and did not start with "//". The WHATWG URL parser strips ASCII tab/CR/LF from its input and
// treats a backslash as "/" for special schemes, so `"/\t//127.0.0.1:9999/leak"` satisfies both prefix tests and
// still resolves to a DIFFERENT origin: the sandboxed frame — opaque origin, `sandbox="allow-scripts"` without
// `allow-same-origin` — reached a foreign host through the bridge page's own fetch, and its POST body left the
// machine. "Starts with //" is not the same claim as "is the same origin"; resolving the URL and comparing
// origins is the property the relay actually needs.
//
// WHY THE BODY IS ES5-SHAPED AND CLOSURE-FREE. The frame's SDK is injected as source text, and it embeds this
// exact function with `String(relayTarget)` (see public/mini-app-bridge.js), so there is one implementation and
// the two realms cannot drift. That only works while the body reads nothing outside its own arguments.
//
// @param {unknown} url  the requested target, as the frame wrote it
// @param {string} base the only origin the caller may reach — the bridge passes its real `location.origin`,
//                       the frame passes a fixed placeholder because its own origin is opaque ("null")
// @returns {URL|null}   the resolved URL when it is same-origin with `base`, otherwise null
export function relayTarget(url, base) {
  if (typeof url !== "string" || !url) return null;
  // C0 controls — tab (0x09), LF (0x0A), CR (0x0D) and friends — are deleted by the URL parser before parsing,
  // so a URL carrying one is ambiguous by construction. Refuse it instead of guessing what the parser makes of
  // it; this is the belt-and-braces half, the origin comparison above is the boundary.
  if (/[\u0000-\u001f\u007f]/.test(url)) return null;
  var resolved;
  var only;
  try {
    resolved = new URL(url, base);
    only = new URL(base).origin;
  } catch (err) {
    return null;
  }
  if (resolved.origin !== only) return null;
  return resolved;
}
