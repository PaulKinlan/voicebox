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

// What each document reports today. Every remaining one is an inline block that would need extracting or
// hashing before the policy could ever be enforced — that list is the point of staging report-only first.
const EXPECTED = [
  ["/", [], "the room: its meta already enforces this exact policy, so the mirror must add NO noise"],
  ["/help.html", [], "CLEAN since voicebox-beads-xggy.1: its search filter is a same-origin file now, so this page reports NOTHING — which is exactly why the alias signal in section 4 is pinned to /environment.html instead"],
  ["/changelog.html", [], "no inline blocks"],
  ["/environment.html", ["style-src-attr", "style-src-elem"], "STYLE-ONLY since voicebox-beads-xggy.2: the declaration script is a same-origin file now, leaving the inline style block and one inline style attribute. It is the last page that reports anything, which is what keeps section 4's alias signal non-vacuous — a document reporting nothing cannot tell 'covered and clean' from 'not covered at all'"],
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

// A DEFERRED SCRIPT CAN MISS THE ONLY INPUT EVENT, and this is the deterministic acceptance for it
// (voicebox-beads-aenb). It is the sharpest question anyone asked about this extraction: an inline script at
// the end of <body> attached its listener while the document was still parsing, so it could not miss a
// keystroke. A DEFERRED script attaches later, and a person can type while it is still in flight — by the time
// the listener exists, the event that carried those keystrokes is gone and the query sits in the box unfiltered.
//
// The pause is what makes it deterministic. Fetch.enable holds help-search.js at the request stage, so the
// document reaches `interactive` with the filter guaranteed not to have run: no timeout, no racing a fast
// local server, no dependence on machine speed. Fetch.disable then resumes the held request — MEASURED, not
// assumed: the document goes on to complete and a later query filters — and that resume is the moment the
// query used to be lost.
test("a query typed before the deferred filter loads is applied when it arrives (voicebox-beads-aenb)", { timeout: 120000 }, async (t) => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "vb-csp-paused-"));
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

  await page.send("Fetch.enable", { patterns: [{ urlPattern: "*help-search.js*", requestStage: "Request" }] });
  await page.send("Page.navigate", { url: `${server.base}/help.html` });
  // `interactive` is the state this test is about: the document is usable and the filter has not loaded.
  await page.waitFor(() => document.readyState !== "loading", { label: "the document to become interactive", timeout: 20000 });

  const early = await page.evaluate(() => {
    const input = document.querySelector(".help-search-input");
    const secs = [...document.querySelectorAll(".help-section[data-help-section]")];
    input.value = "zzz-nothing-matches-this-xyzzy";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    return { ready: document.readyState, total: secs.length, visible: secs.filter((x) => !x.hidden).length };
  });
  assert.equal(early.ready, "interactive", "the document must be usable while the filter is still held — that is the situation this test exists for");
  assert.ok(early.total > 0, "the sections must already be rendered");
  assert.equal(
    early.visible,
    early.total,
    `before the filter loads NOTHING can have been filtered, so every section must still be visible (got ${early.visible} of ${early.total}) — if this is already 0 the filter ran early and the pause is not doing what this test needs`,
  );

  // Resumes the held request.
  await page.send("Fetch.disable");
  await page.waitFor(() => document.readyState === "complete", { label: "the document to finish loading", timeout: 20000 });

  const late = await page.evaluate(() => {
    const input = document.querySelector(".help-search-input");
    const secs = [...document.querySelectorAll(".help-section[data-help-section]")];
    // No further typing: the value was typed by a person before the listener existed, and that is the whole point.
    return { value: input.value, total: secs.length, visible: secs.filter((x) => !x.hidden).length };
  });
  assert.equal(
    late.value,
    "zzz-nothing-matches-this-xyzzy",
    "the query must still be in the box — this test is about the value that was typed before the listener existed, not about typing again",
  );
  assert.equal(
    late.visible,
    0,
    `the filter must apply the query already in the box when it attaches: a no-match query left in the box means every section is shown as though nothing had been typed, which is a person's search silently ignored (voicebox-beads-aenb). Got ${late.visible} of ${late.total} visible`,
  );
});

// ── 5. The declaration script must exist before anyone can click it, and that is a LOAD-ORDER property. ─────
// `voicebox-beads-xggy.2` moved this script out of the document, and the whole risk of doing that is the ORDER
// it loads in. Inline at the end of <body> it ran while the document was still parsing, so its click listener
// always existed before a person could click. A DEFERRED file attaches once the document is already
// interactive, and a click landing in that window is lost PERMANENTLY: a click leaves no state behind to
// re-apply, so the Help page's fix (apply the value already sitting in the box) does not generalise here.
//
// So the assertion is about the DOCUMENT, not about the file: hold the script at the request stage and the
// document must not have become interactive, because a parser-blocking script has not let the parser finish.
// The same technique applied to a file that IS deferred gives the opposite answer, and this test measures
// both — so it proves it can tell the difference instead of asserting the answer it wants.
test("the declaration script is parser-blocking, so no click can precede its listener (voicebox-beads-xggy.2)", { timeout: 180000 }, async (t) => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "vb-csp-declare-"));
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

  // THE CONTROL: /browser/ui/ui.ts is a `type="module"` script, which is deferred by definition. Holding it
  // must leave the document interactive — the state in which a click can be lost — and the declaration script,
  // which is not deferred, must meanwhile have already attached its listener. Both facts in one measurement.
  await page.send("Fetch.enable", { patterns: [{ urlPattern: "*ui.ts*", requestStage: "Request" }] });
  await page.send("Page.navigate", { url: `${server.base}/environment.html` });
  await page.waitFor(() => document.readyState === "interactive", { label: "a held deferred file to leave the document interactive", timeout: 20000 });
  const control = await page.evaluate(() => {
    const button = document.getElementById("declare-root");
    document.getElementById("root-path").value = "/nonexistent-xyzzy-abc";
    button.disabled = false;
    button.click();
    // The listener's FIRST synchronous act, so this is about whether it ran at all and not about a fetch.
    return { ready: document.readyState, listenerRan: button.disabled };
  });
  assert.equal(
    control.ready,
    "interactive",
    `a HELD DEFERRED file leaves the document interactive (got ${control.ready}) — this is the control that proves the assertion below can tell the two load strategies apart`,
  );
  assert.equal(
    control.listenerRan,
    true,
    "the declaration script, held by nothing, must already have attached its listener while the deferred module is still in flight",
  );

  // THE REAL THING: hold the declaration script itself. The parser cannot finish, so the document must not be
  // interactive yet — and that is precisely the property that makes a lost click impossible.
  await page.send("Fetch.disable");
  await page.send("Fetch.enable", { patterns: [{ urlPattern: "*environment-root.js*", requestStage: "Request" }] });
  await page.send("Page.navigate", { url: `${server.base}/environment.html` });
  await page.waitFor(() => !!document.getElementById("declare-root"), { label: "the button to be parsed before the held script", timeout: 20000 });
  const held = await page.evaluate(() => {
    const button = document.getElementById("declare-root");
    const result = document.getElementById("declare-result");
    document.getElementById("root-path").value = "/nonexistent-xyzzy-abc";
    button.disabled = false;
    result.hidden = true;
    button.click();
    return { ready: document.readyState, listenerRan: button.disabled, resultHidden: result.hidden };
  });
  assert.equal(
    held.ready,
    "loading",
    `the document must NOT have become interactive while the declaration script is still held — that is the whole reason this file is not deferred. Got "${held.ready}". If this ever reads "interactive", the tag has gained defer, async or type="module", and a click made in the window that opens would be lost with nothing able to recover it`,
  );
  assert.equal(held.listenerRan, false, "with the script held nothing has attached a listener yet, so the click cannot have been handled");
  assert.equal(
    held.resultHidden,
    true,
    "and the click is therefore dropped with no feedback — the exact failure the parser-blocking choice exists to prevent, demonstrated here rather than described",
  );

  await page.send("Fetch.disable");
  await page.waitFor(() => document.readyState === "complete", { label: "the document to finish loading", timeout: 20000 });

  // ── The page must speak the SERVER's vocabulary, so compare it against the server rather than against text
  // typed into this test. Same body, same seam, and the page is expected to pass the answer through unchanged.
  const fromServer = async (value, { token = server.hostToken } = {}) => {
    const headers = { "content-type": "application/json" };
    if (token) headers["x-voicebox-host-token"] = token;
    const response = await fetch(`${server.base}/api/root`, {
      method: "POST",
      headers,
      body: JSON.stringify({ project: value.split("/").filter(Boolean).pop() ?? "project", root: { kind: "machine", path: value } }),
    });
    return await response.json();
  };
  // Both helpers default to the fixture's host token, so the two sides of every comparison below send the
  // SAME request. They did not at first, and the failure read "the refusal travels unchanged" while the real
  // cause was this helper sending no token at all: one fact, one place — the same lesson as the alias
  // expectation above. Passing `null` deliberately asks for the no-token refusal.
  const declared = async (value, token = server.hostToken) => {
    await page.evaluate((v, tok) => {
      const result = document.getElementById("declare-result");
      document.getElementById("root-path").value = v;
      document.getElementById("machine-host-token").value = tok ?? "";
      result.textContent = "";
      result.hidden = true;
      document.getElementById("declare-root").click();
    }, value, token);
    const text = await page.waitFor(() => {
      const result = document.getElementById("declare-result");
      return result.hidden ? false : result.textContent;
    }, { label: `a declaration result for ${value}`, timeout: 20000 });
    return { text, ok: await page.evaluate(() => document.getElementById("declare-result").dataset.ok) };
  };

  // No token: the page legitimately cannot hold it, and the seam says so. Refusals first, so the only case
  // that mutates the fixture's root is the successful one at the end.
  const noToken = await declared("/nonexistent-xyzzy-abc", null);
  const noTokenSeam = await fromServer("/nonexistent-xyzzy-abc", { token: null });
  assert.equal(noTokenSeam.refused, "host-token-required", "the seam's own code, measured here so the comparison below means something");
  assert.equal(noToken.text, `${noTokenSeam.refused}: ${noTokenSeam.why}`, "the page must show the server's refusal unchanged — not a re-worded copy of it");
  assert.equal(noToken.ok, "false", "a refusal must be marked as not-ok");

  const missing = await declared("/nonexistent-xyzzy-abc");
  const missingSeam = await fromServer("/nonexistent-xyzzy-abc");
  assert.equal(missingSeam.refused, "path-missing", "the seam's own code");
  assert.equal(missing.text, `${missingSeam.refused}: ${missingSeam.why}`, "the refusal travels unchanged");
  assert.equal(missing.ok, "false");

  const aFile = path.join(scratch, "a-file-not-a-folder");
  fs.writeFileSync(aFile, "x", "utf8");
  const notDir = await declared(aFile);
  const notDirSeam = await fromServer(aFile);
  assert.equal(notDirSeam.refused, "not-a-directory", "the seam's own code");
  assert.equal(notDir.text, `${notDirSeam.refused}: ${notDirSeam.why}`, "the refusal travels unchanged");
  assert.equal(notDir.ok, "false");

  const aFolder = path.join(scratch, "a-real-folder");
  fs.mkdirSync(aFolder, { recursive: true });
  const success = await declared(aFolder);
  const successSeam = await fromServer(aFolder);
  assert.equal(success.ok, "true", "a real folder must declare successfully");
  assert.equal(success.text, `declared: ${successSeam.root.path} — the loop writes here now.`, "the success line names the path the seam recorded");
  const root = await (await fetch(`${server.base}/api/root`)).json();
  assert.equal(
    root.root?.path,
    aFolder,
    "the declaration must have actually moved the server's root, not merely printed a success line — this is the write the whole page exists to make",
  );
});

// The assertions above are only worth anything if they are driven by /environment-root.js, so this blocks it
// and requires the page to be as inert as the held case predicted.
test("with the declaration script blocked, the page declares nothing, so the assertions above are driven by it (voicebox-beads-xggy.2)", { timeout: 120000 }, async (t) => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "vb-csp-declare-mutant-"));
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

  await page.send("Network.enable");
  await page.send("Network.setBlockedURLs", { urls: ["*environment-root.js*"] });
  await page.goto(`${server.base}/environment.html`);
  await page.waitFor(() => document.readyState === "complete", { label: "the document to finish with the script blocked", timeout: 20000 });

  const blocked = await page.evaluate(() => {
    const button = document.getElementById("declare-root");
    const result = document.getElementById("declare-result");
    document.getElementById("root-path").value = "/nonexistent-xyzzy-abc";
    button.disabled = false;
    result.hidden = true;
    button.click();
    return { listenerRan: button.disabled, resultHidden: result.hidden, sections: !!document.getElementById("declare") };
  });
  assert.equal(blocked.sections, true, "the page must still render the declaration control with the script blocked");
  assert.equal(blocked.listenerRan, false, "with /environment-root.js blocked there is no listener, so the click cannot have been handled");
  assert.equal(
    blocked.resultHidden,
    true,
    "and nothing is declared: if this passed, the assertions above would be passing on a page whose script never ran",
  );
});

// ── 6. The create-project opener, which must exist before anyone can click it and is the one case where a ──
// late script cannot repair itself. Section 5 shows a settled search being re-applied when a deferred file
// finally attaches; a CLICK leaves nothing to re-apply, so an opener that arrives late leaves a button that
// silently does nothing. `browser/ui/ui.ts` is a module — deferred by definition — so the page is
// interactive with none of its handlers bound. Measured before the fix (voicebox-beads-5tv3): a mouse click
// and an Enter on the focused button both opened nothing and were never replayed when the module arrived,
// while a SECOND activation worked, which is what proved the module itself was healthy.
//
// The opener is now a parser-time classic script, and the module's own binding is gone: it is the ONLY
// owner, because a second listener would call showModal() on an already-open dialog and throw.
test("the create-project opener works while the deferred module is still in flight, by mouse and keyboard (voicebox-beads-5tv3)", { timeout: 180000 }, async (t) => {
  const evidence = process.env.VOICEBOX_OPENER_EVIDENCE;
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "vb-csp-opener-"));
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

  const page = await launch({ width: 1180, height: 980 });
  t.after(() => page.close());

  await page.send("Fetch.enable", { patterns: [{ urlPattern: "*ui.ts*", requestStage: "Request" }] });
  await page.send("Page.navigate", { url: `${server.base}/environment.html` });
  await page.waitFor(() => document.readyState === "interactive", { label: "the document to become interactive with the module held", timeout: 20000 });

  // The module really is absent, and this is the observable that says so: the close button is one of ITS
  // controls, so opening the dialog by hand and pressing it must leave the dialog open. Without this the test
  // could be measuring an ordinary page and proving nothing about the window it exists for.
  const absent = await page.evaluate(() => {
    const dialog = document.getElementById("create-project-dialog");
    dialog.showModal();
    document.getElementById("create-project-close").click();
    const stillOpen = dialog.open;
    dialog.close();
    return { moduleControlsBound: !stillOpen };
  });
  assert.equal(
    absent.moduleControlsBound,
    false,
    "the deferred module must not have bound its controls yet — otherwise this is not measuring the window this test exists for",
  );

  // MOUSE: the interaction that used to do nothing at all.
  await page.evaluate(() => document.getElementById("create-project").click());
  assert.equal(
    await page.evaluate(() => document.getElementById("create-project-dialog").open),
    true,
    "a mouse click must open the dialog the instant the page is interactive — this is the interaction that was lost while the module was in flight",
  );
  if (evidence) await page.screenshot(path.join(evidence, "opener-mouse.png"));

  // THE THREE OPENER EFFECTS, each asserted separately because each can be dropped on its own. A stale
  // refusal must not survive into a fresh dialog, and the dialog must open on the destination that is
  // actually chosen, so the dialog and its radios cannot disagree.
  await page.evaluate(() => {
    const dialog = document.getElementById("create-project-dialog");
    dialog.close();
    const status = document.getElementById("dest-status");
    status.hidden = false;
    status.textContent = "a refusal from an earlier attempt";
    status.dataset.ok = "false";
    document.querySelector('input[name="dest"][value="machine"]').checked = true;
    document.getElementById("create-project").click();
  });
  const opened = await page.evaluate(() => {
    const status = document.getElementById("dest-status");
    return {
      open: document.getElementById("create-project-dialog").open,
      statusHidden: status.hidden,
      statusText: status.textContent,
      statusOk: status.dataset.ok ?? null,
      panels: {
        opfs: document.getElementById("dest-opfs").hidden,
        picked: document.getElementById("dest-picked").hidden,
        machine: document.getElementById("dest-machine").hidden,
      },
    };
  });
  assert.equal(opened.open, true, "the dialog must be open");
  assert.equal(opened.statusHidden, true, "a stale refusal must be cleared when the dialog opens — otherwise it describes an act nobody just made");
  assert.equal(opened.statusText, "", "the stale refusal's text must be gone, not merely hidden");
  assert.equal(opened.statusOk, null, "the stale refusal's ok/failed marking must be gone too, or the next message inherits it");
  assert.deepEqual(
    opened.panels,
    { opfs: true, picked: true, machine: false },
    "the dialog must open on the destination that is actually chosen — if this is wrong the visible panel and the checked radio disagree",
  );
  if (evidence) await page.screenshot(path.join(evidence, "opener-panel-and-status.png"));

  // KEYBOARD: the same interaction, and the one an accessibility pass names — a working control that does
  // nothing when activated from the keyboard. Driven with real input, not a synthetic event.
  //
  // `text` is NOT optional here. Without it Chrome dispatches no keypress, so the button is never activated
  // and a broken dispatch is indistinguishable from a lost click — which is exactly the mistake I made when
  // first measuring this defect: the dialog stayed shut, and I read that as "the keyboard path is lost too"
  // when it only proved the key had not arrived. The control for it is below: once the module is loaded, the
  // SAME dispatch presses the close button and must shut the dialog.
  const focusCreate = async () => await page.evaluate(() => {
    // The dialog must be CLOSED first: while a modal is open the rest of the page is inert, so focusing the
    // button behind it silently does nothing and the keystroke would go nowhere.
    const dialog = document.getElementById("create-project-dialog");
    if (dialog.open) dialog.close();
    document.getElementById("create-project").focus();
    return document.activeElement?.id ?? null;
  });
  const pressEnter = async () => {
    await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", text: "\r", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
    await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  };
  const focusWasOn = await focusCreate();
  assert.equal(focusWasOn, "create-project", `the button must actually hold focus before the keystroke, or this measures the wrong thing (focus was on ${focusWasOn})`);
  await pressEnter();
  assert.equal(
    await page.evaluate(() => document.getElementById("create-project-dialog").open),
    true,
    "Enter on the focused button must open the dialog exactly as the mouse does — the same loss by another route, and the one the craft floor names as 'working controls ... keyboard focus'",
  );
  if (evidence) await page.screenshot(path.join(evidence, "opener-keyboard.png"));

  // THE MODULE ARRIVES. Its radio handler is bound now and reads the destination sync from the seam the
  // classic opener published, so this both proves the module's own controls came alive and exercises the
  // seam rather than trusting it.
  await page.send("Fetch.disable");
  await page.waitFor(() => document.readyState === "complete", { label: "the document to finish loading", timeout: 20000 });
  // WAIT FOR THE MODULE'S OWN BEHAVIOUR, never for a document lifecycle flag (`voicebox-beads-fl3g`, found by
  // review). `document.readyState === "complete"` is satisfied BEFORE the resumed module has finished
  // evaluating — an independent reviewer reproduced it deterministically — so a single `change` dispatched
  // here lands before `ui.ts` has bound anything, goes into the void, and the wait times out. The poll below
  // therefore DISPATCHES AND CHECKS THE EFFECT: it re-fires the change until the panel actually syncs, which
  // is the module's own observable work, so it cannot pass unless a listener is genuinely bound. A separate
  // test drives the control for "never bound" — with the module blocked for good, no number of change events
  // ever syncs the panel.
  //
  // That wait also acts as this test's ready signal: once the panel has synced, the module has provably
  // evaluated, so every later module-owned control here (the close button, the dispatch control below) is
  // bound too.
  await page.evaluate(() => document.getElementById("create-project-dialog").close());
  await page.waitFor(
    () => {
      const radio = document.querySelector('input[name="dest"][value="picked"]');
      radio.checked = true;
      radio.dispatchEvent(new Event("change", { bubbles: true }));
      return !document.getElementById("dest-picked").hidden;
    },
    {
      label:
        "the module's radio handler to sync the panel through the seam (re-dispatching the change each poll, so this waits for the module's EFFECT rather than for a lifecycle flag)",
      timeout: 20000,
    },
  );
  const closedByModule = await page.evaluate(() => {
    document.getElementById("create-project").click();
    return { opened: document.getElementById("create-project-dialog").open };
  });
  assert.equal(closedByModule.opened, true, "the opener must keep working after the module has loaded");

  // THE DISPATCH CONTROL, and the reason the keyboard assertion above can be trusted: this is the same
  // keystroke sent to a control the MODULE owns. It must close the dialog. If it does not, the problem is
  // the synthetic input rather than the page, and the assertion above would be measuring nothing.
  await page.evaluate(() => {
    document.getElementById("create-project-close").focus();
  });
  await pressEnter();
  const afterCloseKey = await page.evaluate(() => ({
    open: document.getElementById("create-project-dialog").open,
    focused: document.activeElement?.id ?? null,
  }));
  assert.equal(
    afterCloseKey.open,
    false,
    `Enter sent to the close button must close the dialog, which proves this dispatch really activates buttons on this page (focused: ${afterCloseKey.focused}). If this fails, the keyboard assertion above is not evidence about the opener`,
  );
  if (evidence) await page.screenshot(path.join(evidence, "opener-module-loaded.png"));
});

// ONE OWNER, proved by COUNTING the opener's effect rather than by expecting a crash (voicebox-beads-r3xp).
// I first wrote this test to assert that opening raises no uncaught error, on the belief that a duplicate
// listener's second `showModal()` would throw `InvalidStateError` on an already-open dialog. A reviewer
// falsified that with a live CDP run and I reproduced it: in this Chromium the second call is a silent
// NO-OP, so a duplicate owner is invisible to an error listener and this test stayed green with the deleted
// binding restored. What a duplicate actually produces is a SECOND pass of the opener — a second status
// reset, a second panel sync, a second open — so the assertions below count `showModal` invocations and
// require exactly one per activation. The mutant at the end proves that count can see a duplicate at all.
test("the opener is the only owner: opening and closing captures no exception (voicebox-beads-5tv3)", { timeout: 120000 }, async (t) => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "vb-csp-owner-"));
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

  const page = await launch({ width: 1180, height: 980 });
  t.after(() => page.close());

  await page.send("Page.addScriptToEvaluateOnNewDocument", {
    source:
      `window.__pageErrors = []; window.addEventListener("error", (e) => window.__pageErrors.push(String(e.message || e.error || e)));` +
      // Installed before any page script runs, so the count covers the opener itself and not just later code.
      `window.__showModalCalls = 0;` +
      `(() => { const original = HTMLDialogElement.prototype.showModal; HTMLDialogElement.prototype.showModal = function (...args) { window.__showModalCalls += 1; return original.apply(this, args); }; })();`,
  });
  await page.goto(`${server.base}/environment.html`);
  await page.waitFor(() => document.readyState === "complete", { label: "the document to finish loading", timeout: 20000 });

  // The canary: a detector that cannot see a real uncaught error would make the assertion below meaningless.
  const canary = await page.evaluate(async () => {
    window.__pageErrors.length = 0;
    setTimeout(() => {
      throw new Error("canary: this error is expected and must be captured");
    }, 0);
    await new Promise((r) => setTimeout(r, 200));
    return window.__pageErrors.slice();
  });
  assert.equal(canary.length, 1, `the error detector must see a genuine uncaught error before its silence means anything (saw ${JSON.stringify(canary)})`);

  const cycles = await page.evaluate(async () => {
    window.__pageErrors.length = 0;
    window.__showModalCalls = 0;
    const dialog = document.getElementById("create-project-dialog");
    const close = document.getElementById("create-project-close");
    const opened = [];
    const opensPerActivation = [];
    for (let i = 0; i < 3; i++) {
      const before = window.__showModalCalls;
      document.getElementById("create-project").click();
      opened.push(dialog.open);
      opensPerActivation.push(window.__showModalCalls - before);
      // The close button is the MODULE's control, and `complete` is not proof that the module has bound it
      // (voicebox-beads-fl3g), so this waits for the effect instead of assuming it. Bounded rather than
      // open-ended: if the close never takes, the recorded `false` below is what fails the test, and the
      // bound stops the page from spinning.
      let waited = 0;
      while (dialog.open && waited < 5000) {
        close.click();
        await new Promise((resolve) => setTimeout(resolve, 25));
        waited += 25;
      }
      opened.push(dialog.open);
    }
    return { opened, opensPerActivation, errors: window.__pageErrors.slice() };
  });
  assert.deepEqual(
    cycles.opened,
    [true, false, true, false, true, false],
    "each click must open the dialog and each close must shut it — three cycles, so a second owner that only misbehaves on a later pass would still show up",
  );
  assert.deepEqual(
    cycles.opensPerActivation,
    [1, 1, 1],
    `each activation must invoke showModal EXACTLY ONCE, because a second owner would run the whole opener again — a second status reset, a second panel sync, and a second open that is silently ignored — rather than throwing. Got ${JSON.stringify(cycles.opensPerActivation)}`,
  );
  assert.deepEqual(
    cycles.errors,
    [],
    `opening the dialog must raise nothing. This is the WEAKER half of the proof: a duplicate owner raises nothing either, so it is the invocation count above that detects one (voicebox-beads-r3xp). Got ${JSON.stringify(cycles.errors)}`,
  );

  // THE MUTANT THAT MAKES THAT COUNT MEANINGFUL, and the finding's own instruction: restoring the deleted
  // binding must MOVE the count, or a counter that counted nothing would look exactly like one owner. This is
  // also the run that proves the assertion above would have caught the regression the finding describes.
  const mutant = await page.evaluate(async () => {
    window.__pageErrors.length = 0;
    const dialog = document.getElementById("create-project-dialog");
    const button = document.getElementById("create-project");
    if (dialog.open) dialog.close();
    const before = window.__showModalCalls;
    button.addEventListener("click", () => dialog.showModal());
    button.click();
    const callsForTwoOwners = window.__showModalCalls - before;
    const raisedNothing = window.__pageErrors.length === 0;
    if (dialog.open) dialog.close();
    return { callsForTwoOwners, raisedNothing };
  });
  assert.equal(
    mutant.callsForTwoOwners,
    2,
    `with the second binding restored, one activation must invoke showModal TWICE — otherwise the count above proves nothing (saw ${mutant.callsForTwoOwners})`,
  );
  assert.equal(
    mutant.raisedNothing,
    true,
    "and the duplicate raises nothing at all, which is exactly why this needed a count rather than an error listener (voicebox-beads-r3xp)",
  );
});

// And the opener script must be load-bearing, not decoration: with it blocked the button does nothing at
// all. That is also the strongest statement of "one owner" — the module does NOT quietly take over.
test("with the opener script blocked the button does nothing, so the module is not a second owner (voicebox-beads-5tv3)", { timeout: 120000 }, async (t) => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "vb-csp-opener-blocked-"));
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

  const page = await launch({ width: 1180, height: 980 });
  t.after(() => page.close());

  await page.send("Network.enable");
  await page.send("Network.setBlockedURLs", { urls: ["*environment-dialogs.js*"] });
  await page.goto(`${server.base}/environment.html`);
  await page.waitFor(() => document.readyState === "complete", { label: "the document to finish with the opener blocked", timeout: 20000 });

  const blocked = await page.evaluate(() => {
    document.getElementById("create-project").click();
    return {
      open: document.getElementById("create-project-dialog").open,
      seam: typeof window.__voiceboxCreateProject,
    };
  });
  assert.equal(blocked.seam, "undefined", "the blocked opener must not have published its seam");
  assert.equal(
    blocked.open,
    false,
    "with the opener script blocked, clicking the button must do NOTHING. If the dialog opens, some other file is opening it — which is precisely the second owner this change removes, and it would also mean the opener assertions above are not driven by the file they name",
  );
});

// THE CONTROL FOR THAT RETRY (voicebox-beads-fl3g). The test above re-dispatches the radio change until the
// panel syncs, which is only meaningful if the sync really waits for a listener: if anything else could make
// the panel visible, the retry would pass with no module loaded at all. So with the deferred module blocked
// for good, NO number of change events may ever sync the panel — while the classic opener must keep working,
// because a separate file serving the button is the entire point of this change.
test("with the module blocked, no number of radio changes ever syncs the panel (voicebox-beads-fl3g)", { timeout: 120000 }, async (t) => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "vb-csp-sync-control-"));
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

  const page = await launch({ width: 1180, height: 980 });
  t.after(() => page.close());

  await page.send("Network.enable");
  await page.send("Network.setBlockedURLs", { urls: ["*ui.ts*"] });
  await page.goto(`${server.base}/environment.html`);
  await page.waitFor(() => document.readyState === "complete", { label: "the document to finish with the module blocked", timeout: 20000 });

  const result = await page.evaluate(async () => {
    const dialog = document.getElementById("create-project-dialog");
    const radio = document.querySelector('input[name="dest"][value="picked"]');
    const panel = document.getElementById("dest-picked");
    // The classic opener is a different file and must be unaffected by this.
    document.getElementById("create-project").click();
    const openedByClassicOpener = dialog.open;
    dialog.close();
    // Generous: a full second of re-dispatches, far more than the retry needs once a listener exists.
    for (let i = 0; i < 25; i++) {
      radio.checked = true;
      radio.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    return { openedByClassicOpener, panelHidden: panel.hidden, seam: typeof window.__voiceboxCreateProject };
  });
  assert.equal(
    result.openedByClassicOpener,
    true,
    "the classic opener must still open the dialog with the module blocked — it is a separate file, and serving this button without the module is the whole point of the change",
  );
  assert.equal(result.seam, "object", "the classic opener must still have published its seam");
  assert.equal(
    result.panelHidden,
    true,
    "with the module blocked the panel must NEVER sync, however many change events fire — this is the control that makes the retry above a wait for a real listener rather than a loop something else could satisfy",
  );
});
