// public/theme-boot.js — the pre-paint theme guard (voicebox-beads-xpwt).
//
// WHY THIS EXISTS. The theme is applied by public/theme.mjs, which fused.js imports — and a module
// script is ALWAYS deferred, so it runs after the first paint. Measured before this file existed: with
// dark stored, the page painted at FCP 76ms and turned dark at 78ms, so a person who chose dark saw
// light first, on every load. This file applies the STORED choice before anything is painted.
//
// WHAT IT IS NOT RESPONSIBLE FOR, since voicebox-beads-7xse. A browser with no scripting at all is no
// longer a broken case, and this guard is not what fixes it: style.css now sets `color-scheme: light
// dark` with every colour token written as a light-dark() pair, and neither page forces a scheme on
// <html>, so with no script the OS decides. This file's job is the narrower, older one — honour a stored
// choice ahead of the first paint. Its absence now costs a flash, not a permanently wrong scheme.
//
// WHY IT IS A CLASSIC (NOT MODULE) SCRIPT, AND WHY IT IS NOT INLINE. It must run before the first paint,
// so it is loaded WITHOUT type=module and WITHOUT defer/async: a classic script in <head> blocks parsing
// and executes before anything is painted. Modern Web Guidance's FOUC section prescribes an INLINE script
// for this, but this page sends `script-src 'self'` (the Content-Security-Policy meta in public/index.html)
// with no 'unsafe-inline', no nonce and no hash, so an inline script is blocked by the page's own policy.
// An external same-origin classic script is the CSP-compatible equivalent, and it keeps the policy strict
// rather than weakening the whole page to fix six lines. The tag deliberately sits BELOW that meta: a
// <meta> CSP governs only what is fetched after it is parsed, so a guard above it would not be governed
// by the policy at all.
//
// IT WORKS THROUGH color-scheme, WHICH IS WHY IT ONLY WRITES ATTRIBUTES. style.css gives `light` and
// `dark` their own color-scheme rules and every token resolves from that scheme through light-dark(), so
// setting data-theme is what re-themes the page — including the browser-drawn surfaces (scrollbars, the
// caret, text selection, form controls) that follow color-scheme rather than any token.
//
// ONE FACT, ONE PLACE — the trap this file is most likely to fall into. This guard cannot import
// public/theme.mjs (that is the deferred module being worked around), so it necessarily restates that
// module's decisions: the storage key, the light|dark|system whitelist with unknown falling back to
// light, the matchMedia resolution, and the two attribute names. scripts/single-owner.mjs exists to
// refuse a second computing site for one fact, so the restatement is not left as a promise:
// tests/theme-boot-parity.test.mjs drives this file and theme.mjs's initTheme through the SAME fake DOM
// over the same matrix of stored values and OS schemes and fails unless both produce identical
// attributes. Change one and the other test goes red.
//
// Deliberately NOT here, and each filed separately rather than smuggled in: a CSS
// `@media (prefers-color-scheme: dark)` degradation, and the cross-tab `storage` listener the guidance
// also asks for.
(function () {
  "use strict";
  // Same default initTheme uses when the read throws: NOT "system", so a person with site data blocked
  // gets exactly what they got before this file existed.
  var pref = "light";
  try {
    var saved = localStorage.getItem("voicebox:theme");
    if (saved === "dark" || saved === "light" || saved === "system") pref = saved;
  } catch (_) {
    // Storage blocked or unavailable (site data denied, private modes). The default stands; nothing here
    // may throw, because a throw at this point is a throw before the first paint.
  }
  var prefersDark = !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = pref === "system" ? (prefersDark ? "dark" : "light") : pref;
  document.documentElement.dataset.themeMode = pref;
})();
