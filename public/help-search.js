// The Help page's search filter (voicebox-beads-xggy.1).
//
// It lives in a file rather than inline for exactly one reason: public/index.html's policy is
// `script-src 'self'` with no nonce, hash or 'unsafe-inline', so an inline script is the single thing that
// policy would block if it were ever enforced. Extracting the bytes is the refactoring option the Modern Web
// Guidance security guide names for inline scripts, alongside nonces and hashes, and it is what makes the
// staged Report-Only policy clean on this page instead of reporting a violation forever.
//
// WHAT IT DOES IS UNCHANGED. Hide each `.help-section[data-help-section]` whose text does not contain the
// query; show all of them again when the query is empty. Measured on the page as it stood before this move:
// 7 sections, 7 visible with no query, 6 for "voice", 0 for a query nothing matches, 7 again when cleared —
// reversible and idempotent, which is what the test for this file asserts.
//
// The theme history is kept here because it explains why there is no theme code in this file. The theme used
// to be applied at the end of <body> in the very position this block occupied, as an inline script. It is now
// the shared pre-paint guard (`/theme-boot.js`) and the shared module (`/help-theme.mjs`) in <head>
// (voicebox-beads-uj16), and removing that copy is why what remained was only the search filter.
(() => {
  const search = document.querySelector(".help-search-input");
  const sections = document.querySelectorAll(".help-section[data-help-section]");
  search?.addEventListener("input", () => {
    const q = (search.value || "").trim().toLowerCase();
    for (const sec of sections) {
      sec.hidden = Boolean(q) && !(sec.textContent || "").toLowerCase().includes(q);
    }
  });
})();
