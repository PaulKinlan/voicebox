// lib/browser-binaries.mjs — THE ONE OWNER of "which browser binary does this box have".
//
// WHY THIS EXISTS (voicebox-beads-phs9, from the 80vw review). The candidate list —
// `VOICEBOX_CHROME` first, then the usual system paths — was written out three times: here in the
// test driver, in `tools/page-acceptance.mjs`, and inline in `tests/voicebox.test.mjs`. Three
// places deciding one fact is the same shape as the path-authorization duplication consolidated in
// voicebox-beads-q0a3, and it has the same failure mode: a divergence does not announce itself as a
// divergence, it announces itself as something else. Measured (voicebox-beads-80vw): a box with no
// browser on the PATH made a pre-push case die at 'spawn /usr/bin/chromium ENOENT' BEFORE the
// network path it asserted — so a missing browser read as a network failure, for as long as nobody
// looked at the actual output.
//
// WHAT IT OWNS: the candidate list and the `VOICEBOX_CHROME` read. Callers ask; they do not keep a
// second copy. `tests/browser-binaries-owner.test.mjs` refuses a reappearing second list (or a
// second `VOICEBOX_CHROME` read) anywhere in the tree, and the reason it is a test rather than a
// line in `scripts/single-owner.mjs` is that the standing check deliberately does not scan `tests/`
// — which is exactly where one of the three copies lived, so nothing else could see it.
//
// WHAT IT DELIBERATELY DOES NOT OWN: `public/verify.mjs` reads `CHROME` (a different variable, no
// candidate list, a standalone evidence utility run by hand) — a different question, not a copy of
// this one. It is named rather than silently ignored.
import { existsSync } from "node:fs";

/**
 * The candidate paths, in precedence order: an explicit `VOICEBOX_CHROME` wins, then the usual
 * system locations, then the two macOS bundle paths. A FUNCTION, not a constant, so the variable is
 * read when asked — a caller that captures the list at import has taken a copy of the fact.
 */
export function browserCandidates(env = process.env) {
  return [
    env.VOICEBOX_CHROME,
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ].filter(Boolean);
}

/**
 * The first candidate that EXISTS, or null. `null` is the answer "this box has no browser", which a
 * caller must say out loud — by name, before it spawns anything — rather than discovering inside a
 * spawn with a message about something else (80vw).
 *
 * `exists` is injectable so the PRECEDENCE and the null answer can be driven deterministically: a
 * test that asserted `findBrowserBinary({}) === null` would pass on a box with no system browser and
 * fail on one that has chromium installed — the guard's own verdict depending on the box, which is
 * the class of bug this module exists to end (review finding, voicebox-beads-phs9).
 */
export function findBrowserBinary(env = process.env, { exists = existsSync } = {}) {
  return browserCandidates(env).find((b) => exists(b)) ?? null;
}
