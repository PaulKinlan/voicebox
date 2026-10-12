// tests/csp-report-only-browser.test.mjs — what the staged policy reports, and proof that staging it does
// not break the pages. (voicebox-beads-ul1m.1)
//
// WHY THIS FILE EXISTS, and why it is not the same as the header test. That one proves WHERE the header is;
// this one proves WHAT IT DOES, in a browser, on the real server. Two things can only be measured here:
//
//   · THE EXACT REPORTS. There is no report endpoint by design, so the only capture is the page's own
//     `securitypolicyviolation` event. The expected set is asserted per document, which turns "the policy
//     would block four inline blocks" from a claim into a regression test: add an inline script to one of
//     these documents and this file fails, instead of the new violation quietly joining the noise.
//     The directive names are the GRANULAR ones Chromium reports (`script-src-elem`, `style-src-elem`,
//     `style-src-attr`), not the bare `script-src`/`style-src` the policy text names. Asserting the bare
//     names would pass while proving nothing — measured, not read.
//
//   · THAT NOTHING IS ENFORCED. Report-Only is only worth staging if it cannot break the page, so the two
//     interactive things on the reporting documents are driven WITH the header present: the help search
//     filter, and the environment page's project-root control. help.html is the sharp case — its inline
//     script is reported AND still runs in the same load.
//
//   node --test tests/csp-report-only-browser.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startServer } from "./lib/server.mjs";
import { launch } from "./lib/cdp.mjs";

/** Violations are collected from document-start, before any page script can run. */
const CAPTURE = `
  window.__cspv = [];
  document.addEventListener("securitypolicyviolation", (e) => {
    window.__cspv.push({ directive: e.violatedDirective, effective: e.effectiveDirective, blockedURI: e.blockedURI, disposition: e.disposition });
  });
`;

// What each document reports today. Every one of these is an inline block that would need extracting or
// hashing before the policy could ever be enforced — that list is the point of staging report-only first.
const EXPECTED = [
  ["/", [], "the room: its meta already enforces this exact policy, so the mirror must add NO noise"],
  ["/help.html", ["script-src-elem"], "the help search script is the one inline block here"],
  ["/changelog.html", [], "no inline blocks"],
  ["/environment.html", ["script-src-elem", "style-src-attr", "style-src-elem"], "the root script plus an inline style block and one inline style attribute"],
  ["/harnesses.html", [], "no inline blocks"],
];

test("the staged policy reports exactly the known inline blocks, and blocks nothing (voicebox-beads-ul1m.1)", { timeout: 180000 }, async (t) => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "vb-csp-browser-"));
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

  const page = await launch({ width: 1180, height: 900 });
  t.after(() => page.close());
  const { identifier } = await page.send("Page.addScriptToEvaluateOnNewDocument", { source: CAPTURE });
  // NOTE: no t.after() to remove the sampler. `after` hooks run in REGISTRATION ORDER, so a remove-on-close
  // hook runs after page.close() has already shut the socket, and that promise never settles — it hangs the
  // whole file until the outer timeout (measured: 300s, with every assertion already passed). The page is
  // closing anyway, so the registration dies with it.
  void identifier;
  const settle = () => new Promise((r) => setTimeout(r, 600));
  const violations = () => page.evaluate(() => window.__cspv ?? []);

  // ── 1. The exact reports, per document. ─────────────────────────────────────────────────────────
  for (const [doc, expected, why] of EXPECTED) {
    await page.goto(`${server.base}${doc}`);
    await settle();
    const seen = await violations();
    assert.deepEqual(
      seen.map((v) => v.effective).sort(),
      expected,
      `${doc} reports: ${why}. Got ${JSON.stringify(seen)}`,
    );
    for (const v of seen) {
      assert.equal(
        v.disposition,
        "report",
        `${doc}: every violation must be disposition=report, i.e. reported and NOT enforced — a violation with any other disposition means something is being blocked`,
      );
    }
  }

  // ── 2. The excluded documents are untouched: no header, and therefore nothing to report. ────────
  for (const doc of ["/apps/agent-monitor.html", "/mini-app-bridge.html"]) {
    const res = await fetch(`${server.base}${doc}`);
    assert.equal(res.headers.get("content-security-policy-report-only"), null, `${doc} must not be covered`);
    await page.goto(`${server.base}${doc}`);
    await settle();
    assert.deepEqual(await violations(), [], `${doc} is excluded, so it must report nothing`);
  }

  // ── 3. NOT ENFORCED, driven rather than asserted: the two interactive things on the reporting pages. ──
  await page.goto(`${server.base}/help.html`);
  await settle();
  const reportedButRunning = await page.evaluate(() => window.__cspv.length);
  const search = await page.evaluate(() => {
    const input = document.querySelector(".help-search-input");
    const sections = () => [...document.querySelectorAll(".help-section[data-help-section]")];
    const before = sections().filter((s) => !s.hidden).length;
    input.value = "definitely-not-present-in-this-document-xyzzy";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    const hiddenAfter = sections().filter((s) => s.hidden).length;
    input.value = "";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    return { before, hiddenAfter, total: sections().length };
  });
  assert.ok(reportedButRunning > 0, "the help page must have reported its inline script — otherwise this section proves nothing");
  assert.ok(search.before > 0, "the help search must start with visible sections");
  assert.equal(
    search.hiddenAfter,
    search.total,
    `the help search filter must still WORK while its own script is being reported (${search.before} visible, ${search.hiddenAfter}/${search.total} hidden after a nonsense query) — that combination is what "report-only" means`,
  );

  await page.goto(`${server.base}/environment.html`);
  await settle();
  const envReports = await page.evaluate(() => window.__cspv.length);
  const control = await page.evaluate(() => {
    const button = document.getElementById("create-project");
    const dialog = document.getElementById("create-project-dialog");
    const before = dialog?.open ?? null;
    button?.click();
    const after = dialog?.open ?? null;
    return { hadButton: !!button, before, after, destinations: document.querySelectorAll('input[name="dest"]').length };
  });
  assert.ok(envReports > 0, "the environment page must have reported its inline blocks");
  assert.equal(control.hadButton, true, "the root control must exist");
  assert.equal(
    control.after,
    true,
    `the project-root control must still WORK while its inline script is reported (dialog open ${control.before} -> ${control.after}) — report-only blocks nothing`,
  );

  // ── 4. The alias class, in the browser, which is where the reviewer found it. ─────────────────────
  // `/help.html` by another spelling is the SAME document, and a policy that an alias steps around is
  // not a policy: staging it would undercount what enforcement would break, and enforcement would leave
  // the alias blind. So each spelling must produce the SAME report as the canonically-spelled document,
  // not merely "some" report. Measured before the fix: three of these answered 200 with the same Help
  // markup and NO header, the trailing slash among them without any encoding at all.
  for (const alias of ["/%68elp.html", "/help%2Ehtml", "/help.html/", "/./help.html", "/x/../help.html"]) {
    await page.goto(`${server.base}${alias}`);
    await settle();
    assert.deepEqual(
      (await violations()).map((v) => v.effective).sort(),
      ["script-src-elem"],
      `${alias} is the same Help document as /help.html and must report identically — a spelling the policy does not reach is a document the policy does not cover`,
    );
  }
});
