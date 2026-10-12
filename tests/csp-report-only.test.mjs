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
