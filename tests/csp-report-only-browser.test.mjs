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
  ["/help.html", [], "CLEAN since voicebox-beads-xggy.1: its search filter is a same-origin file now, so this page reports NOTHING — which is exactly why the alias signal in section 4 is pinned to /environment.html instead"],
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

  // ── 3. NOT ENFORCED, and the Help page is now CLEAN. ────────────────────────────────────────────
  // Two things changed here when the filter moved to /help-search.js (voicebox-beads-xggy.1): the page
  // reports ZERO instead of one, and the drive is the full accepted sequence rather than a single snapshot.
  // The baseline is DERIVED from the page, and so is the partial-match term: Help's section count is exactly
  // the kind of number that moves with content, and a hardcoded 7 — or a hand-picked word — would one day
  // fail for a reason that has nothing to do with the filter.
  await page.goto(`${server.base}/help.html`);
  await settle();
  assert.equal(
    await page.evaluate(() => window.__cspv.length),
    0,
    "help.html must be CLEAN under the staged policy now that its one inline block is a same-origin file — a non-zero count here means something inline came back, which is the regression this extraction exists to prevent",
  );
  const drive = await page.evaluate(() => {
    const secs = [...document.querySelectorAll(".help-section[data-help-section]")];
    const input = document.querySelector(".help-search-input");
    const visible = () => secs.filter((s) => !s.hidden).length;
    const type = (v) => {
      input.value = v;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    };
    // A term that appears in SOME sections but not all, chosen by measurement and nearest the middle of the
    // corpus, so the partial case is neither the whole page nor a single section.
    const words = new Map();
    for (const sec of secs) {
      for (const w of new Set((sec.textContent || "").toLowerCase().match(/[a-z]{5,}/g) || [])) words.set(w, (words.get(w) || 0) + 1);
    }
    const partial = [...words.entries()]
      .filter(([, n]) => n > 0 && n < secs.length)
      .sort((a, b) => Math.abs(a[1] - secs.length / 2) - Math.abs(b[1] - secs.length / 2))[0]?.[0] ?? "";
    const baseline = visible();
    type(partial);
    const afterPartial = visible();
    type("zzz-nothing-matches-this-xyzzy");
    const afterNone = visible();
    type(partial);
    const partialAgain = visible();
    type("");
    const afterClear = visible();
    return { total: secs.length, baseline, partial, afterPartial, afterNone, partialAgain, afterClear };
  });
  assert.ok(drive.baseline > 0, `the help search must start with visible sections — got ${JSON.stringify(drive)}`);
  assert.ok(
    drive.partial.length > 0 && drive.afterPartial > 0 && drive.afterPartial < drive.baseline,
    `a query that some sections contain and others do not must leave a PROPER subset visible — got ${drive.afterPartial} of a baseline of ${drive.baseline} for the term ${JSON.stringify(drive.partial)}. If every section matched or none did, the term is not discriminating and this assertion proves nothing`,
  );
  assert.equal(drive.afterNone, 0, "a query nothing matches must hide EVERY section");
  assert.equal(
    drive.partialAgain,
    drive.afterPartial,
    `the filter must be idempotent: the same query twice must give the same answer (${drive.partialAgain} vs ${drive.afterPartial})`,
  );
  assert.equal(
    drive.afterClear,
    drive.baseline,
    `clearing the query must restore exactly what was visible before it (${drive.afterClear} vs a baseline of ${drive.baseline}) — this is the reversibility half of the accepted sequence`,
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
  // A document reached by another spelling is the SAME document, and a policy that an alias steps around is
  // not a policy: staging it would undercount what enforcement would break, and enforcement would leave the
  // alias blind. Measured before the fix: three spellings answered 200 with the same Help markup and NO
  // header, the trailing slash among them without any encoding at all.
  //
  // PINNED TO /environment.html, and that matters more than it looks. /help.html reports ZERO now, and a
  // document that reports nothing cannot distinguish "covered and clean" from "not covered at all" — both
  // are the empty list, so an alias assertion on it would keep passing even if the header disappeared. The
  // environment page still carries inline blocks, so it still discriminates. The durable spelling-coverage
  // proof is the header assertion in tests/csp-report-only.test.mjs, which asks over HTTP and does not depend
  // on a page having anything to report.
  // Pinned TO /environment.html's OWN entry in the table above rather than to a second hand-typed list, which
  // is how this assertion first went red: I retyped the expected set and wrote `script-src-attr` where the
  // page reports `style-src-attr`. One fact, one place.
  const environmentExpected = [...EXPECTED.find(([doc]) => doc === "/environment.html")[1]].sort();
  for (const alias of [
    "/environment.html",
    "/%65nvironment.html",
    "/environment%2Ehtml",
    "/environment.html/",
    "/./environment.html",
  ]) {
    await page.goto(`${server.base}${alias}`);
    await settle();
    assert.deepEqual(
      (await violations()).map((v) => v.effective).sort(),
      environmentExpected,
      `${alias} is the same environment document as /environment.html and must report identically — a spelling the policy does not reach is a document the policy does not cover`,
    );
  }
});

// The external file is LOAD-BEARING, and that is proved by taking it away rather than by asserting it is
// referenced. Without this, every assertion above could pass on a page whose filter never ran at all: the
// sections start visible, so "every section is visible" is also exactly what a broken script produces.
// Blocking the file and requiring the filter to STOP working is what tells those two apart, and it is the
// mutant coord asked for.
test("the filter stops working when /help-search.js cannot load, so the assertions above are driven by it (voicebox-beads-xggy.1)", { timeout: 120000 }, async (t) => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "vb-csp-mutant-"));
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
  // NOTE: no t.after() to lift the block. `after` hooks run in REGISTRATION ORDER, so a tidy-up hook would run
  // after page.close() has already shut the socket and would hang the whole file rather than clean up after it.
  t.after(() => page.close());

  await page.send("Network.enable");
  await page.send("Network.setBlockedURLs", { urls: ["*help-search.js*"] });
  await page.goto(`${server.base}/help.html`);
  await new Promise((r) => setTimeout(r, 600));

  const result = await page.evaluate(() => {
    const secs = [...document.querySelectorAll(".help-section[data-help-section]")];
    const input = document.querySelector(".help-search-input");
    input.value = "zzz-nothing-matches-this-xyzzy";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    return { total: secs.length, visibleAfterNoMatchQuery: secs.filter((s) => !s.hidden).length };
  });

  assert.ok(result.total > 0, "the page must still render its sections with the script blocked");
  assert.equal(
    result.visibleAfterNoMatchQuery,
    result.total,
    `with /help-search.js blocked the filter must NOT run, leaving every section visible — got ${result.visibleAfterNoMatchQuery} of ${result.total}. If this is 0, the filter ran anyway and the main test's assertions are not driven by the external file`,
  );
});
