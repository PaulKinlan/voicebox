// tests/csp-report-only.test.mjs — where the Report-Only CSP header is, where it is not, and that it is
// still exactly the policy the room already enforces. (voicebox-beads-ul1m.1)
//
// WHY THIS FILE EXISTS. The policy is staged, not enforced, so the interesting questions are all about
// SCOPE and PARITY rather than about blocking:
//
//   · SCOPE. The allowlist is six documents, listed explicitly, and a content-type rule was rejected on
//     purpose: "any text/html response" would silently cover the mini-app pages under /apps, the iframe
//     bridge that hosts user HTML, and any document added later by someone who never read the server code.
//     So the excluded paths are asserted here as carefully as the included ones — an over-broad header is
//     as much a defect as a missing one, and only the excluded side catches it.
//   · PARITY. The header must be the SAME policy index.html enforces through its meta tag. If they drift,
//     the reports stop describing the policy the room actually runs, which is the entire value of staging.
//     This compares the two strings character for character, from the files themselves.
//   · NOT ENFORCEMENT. There must be no enforcing `Content-Security-Policy` header anywhere: this change
//     adds reports, not restrictions, and that is asserted rather than assumed.
//
//   node --test tests/csp-report-only.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "./lib/server.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const HEADER = "content-security-policy-report-only";

const ALLOWLISTED = ["/", "/index.html", "/help.html", "/changelog.html", "/environment.html", "/harnesses.html"];
const EXCLUDED = [
  "/apps/agent-monitor.html",
  "/apps/landing-inspector.html",
  "/apps/live-vision-studio.html",
  "/mini-app-bridge.html",
  "/fused.js",
  "/style.css",
  "/sw.js",
  "/icon.svg",
  "/api/health",
];

test("the Report-Only CSP header covers its documents and nothing else, however they are spelled (voicebox-beads-ul1m.1)", { timeout: 120000 }, async (t) => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "vb-csp-ro-"));
  const workspace = path.join(scratch, "project");
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, "notes.md"), "# Notes\n", "utf8");

  const server = await startServer({
    env: {
      VOICEBOX_WORKSPACE: workspace,
      VOICEBOX_RESOLVER: "script",
      VOICEBOX_SANDBOX_HOMES: path.join(scratch, "sandbox-homes"),
    },
  });
  t.after(async () => {
    await server.stop();
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  const get = (p) => fetch(`${server.base}${p}`, { redirect: "manual" });

  // The policy index.html enforces, read from the document rather than restated here.
  const indexHtml = fs.readFileSync(path.join(here, "..", "public", "index.html"), "utf8");
  const metaPolicy = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(indexHtml)[1];

  for (const p of ALLOWLISTED) {
    const res = await get(p);
    assert.equal(res.status, 200, `${p} must be served`);
    assert.equal(
      res.headers.get(HEADER),
      metaPolicy,
      `${p} must carry the Report-Only policy CHARACTER FOR CHARACTER as index.html's meta enforces it — if these drift, the reports stop describing the policy the room actually runs`,
    );
    assert.equal(
      res.headers.get("content-security-policy"),
      null,
      `${p} must NOT carry an enforcing policy header: this change stages reports, it does not enforce`,
    );
  }

  for (const p of EXCLUDED) {
    const res = await get(p);
    assert.equal(
      res.headers.get(HEADER),
      null,
      `${p} must NOT carry the header — the allowlist is a list of documents, never a content type, and an over-broad header is as much a defect as a missing one`,
    );
  }

  // A document nobody listed, served by the same catch-all handler: the fourth check that the rule is a
  // path list and not "anything under public/ that ends in .html".
  const stray = path.join(here, "..", "public", "zz-csp-scope-probe.html");
  fs.writeFileSync(stray, "<!doctype html><html><body>probe</body></html>", "utf8");
  try {
    const res = await get("/zz-csp-scope-probe.html");
    assert.equal(res.status, 200, "the probe document must be served by the catch-all");
    assert.equal(
      res.headers.get(HEADER),
      null,
      "a NEW html document must not be covered by accident — being covered is a deliberate edit to the allowlist",
    );
  } finally {
    fs.rmSync(stray, { force: true });
  }

  // ── The alias class. ──────────────────────────────────────────────────────────────────────────
  // This section exists because a REVIEWER FOUND A HOLE HERE, and it is the most important part of this
  // file. Keyed on the raw request path, the allowlist was bypassable: the resolver decodes percent
  // escapes and normalises, so several spellings reach the very same document. `/%68elp.html`, 
  // `/help%2Ehtml` and `/help.html/` all served Help with no header, and the trailing-slash spelling
  // needs no encoding at all to be typed. These are asserted on BOTH sides of the fix — the header must
  // be present, AND the bytes must be the ones the allowlisted spelling serves, because "same bytes" is
  // what makes it the same document rather than a lookalike that happens to be covered.
  const canonicalBytes = await (await get("/help.html")).text();
  for (const alias of ["/%68elp.html", "/help%2Ehtml", "/help.html/", "/./help.html", "/x/../help.html", "/%2E/help.html"]) {
    const res = await get(alias);
    assert.equal(res.status, 200, `${alias} must serve the Help document`);
    assert.equal(
      res.headers.get(HEADER),
      metaPolicy,
      `${alias} reaches the SAME document as /help.html, so it must carry the same policy — an alias a policy can be stepped around is not a policy`,
    );
    assert.equal(await res.text(), canonicalBytes, `${alias} must serve the same bytes as /help.html`);
  }

  // The negative controls for that class: spellings that do NOT resolve to an allowlisted document stay
  // uncovered, and spellings that try to leave public/ must not resolve at all. Without these, "every
  // alias has the header" could be satisfied by covering everything.
  for (const [p, why] of [
    ["/%2e%2e/%2e%2e/etc/passwd", "escapes public/"],
    ["/../server.mjs", "escapes public/"],
    ["/HELP.HTML", "no such file on a case-sensitive filesystem"],
  ]) {
    const res = await get(p);
    assert.notEqual(res.status, 200, `${p} must not resolve (${why})`);
    assert.equal(res.headers.get(HEADER), null, `${p} must not carry the header (${why})`);
  }
});

// A STRUCTURAL guard, and it is here because the hole it guards was real rather than hypothetical.
// Selecting the policy from `url.pathname` is exactly what let `/%68elp.html` be served with no header,
// and the containment check inside `canonicalPublicPath` cannot be reached by any request — the resolver
// refuses traversal spellings before the header is ever considered. So the protection that IS reachable,
// and therefore the one worth pinning, is that the single decision point is fed a RESOLVED FILE and never
// a client-supplied string. Source is the only place that can be asserted; it is asserted deliberately,
// not as a substitute for the behavioural tests above.
test("the policy decision is fed a resolved file, never a client-supplied path (voicebox-beads-onvu)", () => {
  const source = fs.readFileSync(path.join(here, "..", "server.mjs"), "utf8");

  assert.ok(
    !/cspReportOnlyHeaders\(\s*url\.pathname/.test(source),
    "the header must never be selected from url.pathname — that is the onvu regression, where an encoded or trailing-slash spelling of /help.html was served with no policy at all",
  );

  // The definition matches the same pattern as a call, so it is removed first: counting it would have made
  // this assertion pass for a file with only one call site, which is the opposite of what it is for.
  const withoutDefinition = source.replace(/function cspReportOnlyHeaders\([^)]*\)\s*\{/, "");
  const args = [...withoutDefinition.matchAll(/cspReportOnlyHeaders\(([^)]*)/g)].map((m) => m[1].trim());
  assert.equal(
    args.length,
    2,
    `exactly two write points are expected, the room and the catch-all static branch; found ${args.length}: ${JSON.stringify(args)}`,
  );
  for (const arg of args) {
    assert.ok(
      /^file\b/.test(arg) || /index\.html/.test(arg),
      `every call site must pass a resolved file (or the literal room file), never a request string — got ${JSON.stringify(arg)}`,
    );
  }

  assert.ok(
    /path\.relative\(PUBLIC, file\)/.test(source),
    "the canonical path must be derived with path.relative from PUBLIC, so encodings, dot segments and trailing slashes have all collapsed before the comparison",
  );
  assert.ok(
    /if \(!containedIn\(PUBLIC, file\)\) return null;/.test(source),
    "canonicalPublicPath must FAIL CLOSED for a path outside public/, and it must ask the OWNER of that fact (containedIn from lib/path-auth.mjs) rather than answering with a local compare — a private copy of the primitive is what scripts/single-owner.mjs refuses, and it refused this guard on the first attempt (voicebox-beads-y5k)",
  );
  // Comments are stripped before this next check, and that is not a detail: the prose above
  // `canonicalPublicPath` NAMES the pattern it is refusing, so an assertion over raw text fails on the
  // comment that explains why the code is right. This is the same class of mistake as splitting a CSS
  // declaration block on ";" without stripping comments first.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.ok(
    !/startsWith\("\.\."\)/.test(code),
    "this file must not reintroduce a private lexical containment compare — that is exactly the copy scripts/single-owner.mjs refuses; the question belongs to lib/path-auth.mjs",
  );
});

// STRUCTURAL, and it is the point of the extraction rather than a side note: the staged policy's worklist is
// the set of inline blocks, so the set is asserted directly. Adding an inline script to any of these pages
// should fail HERE, with a message that says which page and why, rather than silently reappearing as an extra
// report in the browser test's expected set.
test("the extracted documents carry no inline script, and the declaration script cannot become deferred (voicebox-beads-xggy.1 + xggy.2)", () => {
  const publicDir = path.join(here, "..", "public");
  const inlineScripts = (file) => {
    const src = fs.readFileSync(path.join(publicDir, file), "utf8");
    return [...src.matchAll(/<script(?![^>]*\bsrc=)[^>]*>/g)].length;
  };
  // EVERY allowlisted page is now free of inline scripts. What is left is style-only, and it is deliberately
  // out of scope here: environment.html's inline <style> block and one inline style attribute, for the CSS
  // slice. Named rather than skipped so that this file records what remains instead of implying the page is
  // clean.
  const clean = {
    "index.html": "the room",
    "help.html": "extracted to /help-search.js (voicebox-beads-xggy.1)",
    "changelog.html": "never had one",
    "harnesses.html": "never had one",
    "environment.html": "extracted to /environment-root.js (voicebox-beads-xggy.2); its inline <style> block and one inline style attribute remain, for the CSS slice",
  };
  for (const [file, why] of Object.entries(clean)) {
    assert.equal(
      inlineScripts(file),
      0,
      `public/${file} must carry NO inline script (${why}) — an inline block is the one thing script-src 'self' would block, so one reappearing here re-opens the policy gap this change closes`,
    );
  }

  // AND THE LOAD STRATEGY IS PART OF THE CONTRACT, not a detail of the tag. Deferring this file would let the
  // document reach `interactive` with no listener attached, and a click landing in that window is lost
  // permanently — a click leaves no state to re-apply, so unlike the Help page's search value it cannot be
  // recovered in code (voicebox-beads-aenb records that window; this one cannot be closed the same way).
  // The browser test asserts the same property behaviourally by holding the file; this is the cheap,
  // deterministic guard that names the cause.
  const environment = fs.readFileSync(path.join(publicDir, "environment.html"), "utf8");
  const tag = environment.match(/<script\s+src="\/environment-root\.js"[^>]*>/);
  assert.ok(tag, 'public/environment.html must load its declaration script from /environment-root.js as a classic script tag');
  assert.ok(
    !/\b(defer|async)\b/.test(tag[0]) && !/\btype\s*=\s*["']module["']/.test(tag[0]),
    `the declaration script must stay CLASSIC and parser-blocking — defer, async or type="module" all attach the listener after the document is interactive, where a click is lost with nothing able to recover it. Got ${tag[0]}`,
  );
});
