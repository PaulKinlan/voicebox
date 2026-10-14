// tests/changelog-dialog-extraction.test.mjs — the Change log dialog is a module now
// (voicebox-beads-mvxl), and this file holds the ways that extraction can be wrong while the suite
// stays green.
//
// WHY THIS FILE EXISTS AT ALL. tests/changelog-links.test.mjs, tests/modal-panels.test.mjs and
// tests/ux-bubble-stage.test.mjs already drive this dialog's BEHAVIOUR end to end through the real
// page — the commit cards, the badge vocabulary, the status line, the modal geometry. What none of
// them covers is the SEAM, and the seam is where an extraction rots:
//
//   1. THE HANDLE THAT COMES BACK. `openChangelogDialog` is the one function this surface exports
//      because fused.js calls it from OUTSIDE it — the build stamp's "change log" link. A module that
//      forgot to return it, or a fused.js that kept its own copy, leaves that link dead while every
//      behaviour test above still passes (it clicks `#changelog-open`, the header button, not the
//      build link).
//
//   2. A LEFTOVER COPY OF A HANDLER. The old inline block in fused.js is 145 lines; leaving it behind
//      while also wiring the module is the classic extraction defect and it is nearly invisible:
//      `openChangelogDialog()` returns early when the dialog is already open, so a second copy of the
//      OPEN handler produces no second fetch. The REFRESH handler has no such guard — it fetches every
//      time — so one click on `#changelog-refresh` is the count that exposes a double wiring. The fetch
//      counter below is the whole instrument.
//
//   3. FOCUS RETURN, which is this module's only state. `lastChangelogTrigger` is what makes close
//      return focus to whatever opened the dialog — the build link, not the header button. A module
//      that dropped that state (or hardcoded `els.changelogOpen`) still closes the dialog, and only
//      this assertion notices. Note HOW it is asserted: the browser's own focus restore for a closed
//      modal can land after this handler and move focus again (measured on this page: the identical
//      sequence left focus on the anchor once and on `document.body` once), so asserting
//      `document.activeElement` would be a genuinely flaky test. What the module owns is WHICH element
//      it asks for, so the instrument counts script `focus()` calls on the two candidate triggers —
//      the same invocation-counting technique the sandboxed picker stub uses.
//
// WHAT THIS FILE PROVES, precisely, on the real page with fused.js's own wiring:
//   · opening from the BUILD STAMP LINK works (assertion 1: the returned handle is live);
//   · closing asks for focus on THAT link, not on the header button (assertion 3: the module's state,
//     counted rather than read off `document.activeElement`);
//   · one open = exactly one background `/api/changelog` fetch, and one refresh click = exactly one
//     more (assertion 2: no double wiring);
//   · the commit cards still render with their sha link, badge and subject (the moved bodies);
//   · NEGATIVE CONTROL — a listener-free clone of `#changelog-refresh` must fetch nothing, which is
//     what makes the counts above evidence about the module's wiring rather than about markup;
//   · and STATICALLY, the old copy is gone from `public/fused.js` while the module holds it — the dead
//     leftover that behaviour alone cannot see (this repo has no lint gate to catch an unused copy).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "./lib/server.mjs";
import { launch } from "./lib/cdp.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MODULE = "public/components/changelog-dialog.mjs";

test("changelog dialog extraction: the returned handle opens it from the build stamp, one click wires to one fetch, and a listener-free button fetches nothing", { timeout: 90000 }, async () => {
  const scratch = mkdtempSync(path.join(os.tmpdir(), "voicebox-changelog-dialog-extraction-"));
  let server;
  let page;
  try {
    server = await startServer({
      env: { VOICEBOX_WORKSPACE: undefined, VOICEBOX_INSTANCE: "changelog-dialog-extraction" },
      cwd: scratch,
    });
    page = await launch({ width: 1280, height: 900 });
    await page.goto(server.base);

    // The build stamp has to have painted before its "change log" link exists — that link is the
    // caller of the returned openChangelogDialog, and assertion 1 is about it.
    await page.waitFor(() => Boolean(document.querySelector('#build a[href="#changelog-dialog"]')), {
      label: "the build stamp's change log link to render",
      timeout: 15000,
    });

    // The instrument: count only the dialog's own background request, and record the priority option
    // it was asked for — the extraction must leave that call byte-for-byte as it was.
    await page.evaluate(() => {
      window.__changelogFetches = [];
      // ALSO counted: how many of them have SETTLED. "Exactly one fetch is issued per click" needs a
      // moment when no further request can still be issued, and the previous version of this test guessed
      // that moment with a 400ms sleep (voicebox-beads-zjpm.5): a slow server then made the count read 1 and
      // failed the gate, while a second listener slower than 400ms was missed. Two listeners on one click
      // dispatch in the SAME synchronous task, so waiting for the request to settle is a real bound rather
      // than a guess — see the assertion that uses it.
      window.__changelogSettled = 0;
      const realFetch = window.fetch.bind(window);
      window.fetch = (input, init) => {
        const url = typeof input === "string" ? input : input?.url ?? "";
        const counted = url.includes("/api/changelog");
        if (counted) {
          window.__changelogFetches.push({ url, priority: init?.priority ?? null });
        }
        const answer = realFetch(input, init);
        return counted ? answer.finally(() => { window.__changelogSettled += 1; }) : answer;
      };
    });

    const before = await page.evaluate(() => window.__changelogFetches.length);
    assert.equal(before, 0, "nothing may fetch the changelog before the dialog is opened");

    // The second instrument: count the script `focus()` calls this page makes on the two triggers that
    // could plausibly own the focus-return. The wrappers call through, so focus behaviour is unchanged;
    // the browser's own internal focus steps do not go through these properties, which is why this
    // counts the MODULE's intent and not the platform's restore.
    await page.evaluate(() => {
      window.__focusCalls = { buildLink: 0, headerButton: 0 };
      for (const [key, selector] of [
        ["buildLink", '#build a[href="#changelog-dialog"]'],
        ["headerButton", "#changelog-open"],
      ]) {
        const el = document.querySelector(selector);
        const realFocus = el.focus.bind(el);
        el.focus = () => {
          window.__focusCalls[key] += 1;
          return realFocus();
        };
      }
    });

    // 1. OPEN FROM THE BUILD STAMP LINK. This path goes through fused.js's `openChangelogDialog(clLink)`
    //    — the handle initChangelogDialog() returned. A dead handle never opens the dialog.
    await page.evaluate(() => document.querySelector('#build a[href="#changelog-dialog"]').click());
    await page.waitFor(() => document.getElementById("changelog-dialog")?.open === true, {
      label: "the changelog dialog to open from the build stamp link",
      timeout: 15000,
    });
    await page.waitFor(() => document.querySelectorAll("#changelog-commits li").length > 0, {
      label: "commit cards to render in the dialog",
      timeout: 15000,
    });

    const opened = await page.evaluate(() => ({
      fetches: window.__changelogFetches.slice(),
      expanded: document.getElementById("changelog-open")?.getAttribute("aria-expanded"),
      status: document.getElementById("changelog-status")?.textContent ?? "",
      cards: [...document.querySelectorAll("#changelog-commits li")].map((li) => ({
        cls: li.className,
        kind: li.dataset.commitKind ?? null,
        sha: li.querySelector(".commit-sha")?.getAttribute("href") ?? null,
        badge: li.querySelector(".commit-badge")?.textContent ?? null,
        subject: li.querySelector(".commit-subject")?.textContent ?? "",
      })),
    }));

    assert.equal(opened.expanded, "true", "opening must expand the trigger, as before the move");
    assert.match(opened.status, /^Showing \d+ recent commits:$/, `the dialog reports its own status line, got: ${opened.status}`);
    assert.ok(opened.cards.length > 0, "the moved renderer must produce commit cards");
    assert.equal(opened.cards[0].cls, "commit-card", "each entry is a .commit-card");
    assert.match(String(opened.cards[0].sha), /^https:\/\/github\.com\/PaulKinlan\/voicebox\/commit\/[0-9a-f]{7,40}$/);
    assert.ok(opened.cards[0].badge, "each entry carries a badge");
    assert.ok(opened.cards[0].subject.length > 0, "each entry carries a subject");

    // 2a. EXACTLY ONE FETCH for one open: the lazy first load. A leftover copy of the old OPEN handler
    //     would NOT show up here (openChangelogDialog returns early when already open) — which is why
    //     the refresh click below is the count that matters.
    assert.equal(opened.fetches.length, 1, `one open must fetch the changelog exactly once, got ${opened.fetches.length}`);
    assert.equal(opened.fetches[0].priority, "low", "the dialog's own background load asks for priority 'low', as it did in fused.js");

    // 2b. EXACTLY ONE MORE FETCH for one refresh click. Two means the old inline copy of the handler
    //     survived in fused.js alongside the module's.
    await page.click("#changelog-refresh");
    await page.waitFor(() => window.__changelogFetches.length >= 2, {
      label: "the refresh click to reach the server",
      timeout: 15000,
    });
    // WAIT FOR THE OBSERVABLE THE COUNT DEPENDS ON, not for a guessed delay (voicebox-beads-zjpm.5). Two
    // listeners on the same click run in the SAME synchronous dispatch, so once this request has SETTLED no
    // further request can be issued by that click — a real bound, where the 400ms sleep that used to sit
    // here was both a flake (a slow server made the count read 1) and a weaker mutant (a second listener
    // slower than 400ms escaped the count entirely).
    await page.waitFor(() => window.__changelogSettled >= 2, {
      label: "both the open and the refresh fetch to settle",
      timeout: 15000,
    });
    // THE CONTROL THAT GIVES THE COUNT ITS TEETH: with a SECOND listener on the same button, one click
    // must count TWO. Without this, a counter that had quietly stopped counting would still satisfy a
    // "exactly one" assertion, and the numbers below would prove nothing.
    const doubled = await page.evaluate(async () => {
      window.__changelogFetches.length = 0;
      window.__changelogSettled = 0;
      const button = document.getElementById("changelog-refresh");
      const extra = () => fetch("/api/changelog", { priority: "high" });
      button.addEventListener("click", extra);
      button.click();
      const deadline = Date.now() + 15000;
      while (window.__changelogSettled < 2 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      button.removeEventListener("click", extra);
      await new Promise((resolve) => setTimeout(resolve, 250)); // a removed listener must not fire late either
      return { count: window.__changelogFetches.length, settled: window.__changelogSettled };
    });
    assert.equal(doubled.count, 2, `the counter must see a second listener's request, or the count below proves nothing (it read ${doubled.count})`);
    assert.equal(doubled.settled, 2, "and the settled counter must see it too");

    // 2c. THE CLICK UNDER TEST, from a clean count: one click, one request, and it stays one after the
    //     request has settled — the wait is on the observable the count depends on, not on a guessed delay.
    await page.evaluate(() => { window.__changelogFetches.length = 0; window.__changelogSettled = 0; });
    await page.click("#changelog-refresh");
    await page.waitFor(() => window.__changelogFetches.length >= 1, {
      label: "the refresh click's request to be issued",
      timeout: 15000,
    });
    await page.waitFor(() => window.__changelogSettled >= 1, {
      label: "that request to settle",
      timeout: 15000,
    });
    // AN ABSENCE NEEDS A WINDOW — there is nothing to wait FOR when the claim is that NO further request is
    // issued — but this one now starts from a SETTLED state instead of from a guessed delay, which is the
    // real change here (voicebox-beads-zjpm.5). 250ms rather than the 400ms it replaces, because the mutant
    // it guards (a leftover second listener) fires either in the same dispatch or on a short timer, and the
    // control above proves the counter would see it when it does.
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 250)));
    const afterRefresh = await page.evaluate(() => window.__changelogFetches.slice());
    assert.equal(afterRefresh.length, 1, `one refresh click must fetch exactly once, got ${afterRefresh.length}`);
    assert.equal(afterRefresh[0].priority, "high", "the refresh click asks for priority 'high', as it did in fused.js");

    // 3. CLOSE ASKS FOR FOCUS ON THE TRIGGER THAT OPENED IT — the build link, not the header button.
    //    This is the module's `lastChangelogTrigger`, and it is measured as a call count, never as
    //    `document.activeElement`: the platform's own focus restore races this handler (see the header).
    //
    //    THE WAIT WATCHES THE OBSERVABLES THE ASSERTIONS BELOW DEPEND ON — dialog closed AND the trigger
    //    collapsed — because a native <dialog> fires `close` in a SEPARATE task from the one that flips `open`
    //    false: the house rule written up in tests/modal-panels.test.mjs and measured as voicebox-beads-tnxm,
    //    which the sibling tests/changelog-links.test.mjs follows the same way. This test did not, and that is
    //    the whole defect: it waited on `open === false` alone and then READ `aria-expanded`, which SAMPLES that
    //    window instead of waiting for it to end. Measured on the real page: sampling right after `close()` and
    //    again after a microtask both read `open=false, aria-expanded=true`, and only a macrotask later reads
    //    "false". On a quiet box the CDP round trip outlasted that task, so this always passed; in the merger's
    //    browser shard queue it did not, and line 175 failed with "expected false, got true"
    //    (voicebox-beads-ezu7, a recurrence of voicebox-beads-tnxm). `document.activeElement` is deliberately NOT
    //    part of this wait, unlike tests/modal-panels.test.mjs, because this test counts focus() calls rather
    //    than asserting where focus ended up.
    await page.click("#changelog-close");
    await page.waitFor(
      () => {
        const dialog = document.getElementById("changelog-dialog");
        const trigger = document.getElementById("changelog-open");
        return dialog?.open === false && trigger?.getAttribute("aria-expanded") === "false";
      },
      { label: "changelog dialog closed and its trigger collapsed", timeout: 15000 },
    );
    // THE FOCUS HALF SETTLES LATER THAN THE MODULE'S HANDLER, so waiting for the handler is not enough for the
    // focus assertions either (voicebox-beads-ezu7, second instance of the same defect). Measured on the real
    // page with focus starting inside the dialog: after `close()` a closed dialog still CONTAINED
    // document.activeElement in 3 of 4 timing samples — synchronously, after a microtask AND after a macrotask,
    // only settling later. Waiting on the close handler therefore does not imply the assertion below, and
    // sampling it would be the same race that failed the merger's full gate on tree a07a559d, one assertion
    // earlier. So wait for the exact observable this step asserts — focus no longer trapped inside — which is
    // the house rule (tests/modal-panels.test.mjs) and cannot resolve early. If the trap is ever real, the
    // label fails loudly instead of the test quietly sampling a moment before it would have escaped.
    await page.waitFor(
      () => !document.getElementById("changelog-dialog")?.contains(document.activeElement),
      { label: "focus to leave the closed dialog", timeout: 15000 },
    );
    const afterClose = await page.evaluate(() => ({
      dialogOpen: document.getElementById("changelog-dialog")?.open,
      expanded: document.getElementById("changelog-open")?.getAttribute("aria-expanded"),
      focusCalls: window.__focusCalls,
      focusInsideDialog: Boolean(document.getElementById("changelog-dialog")?.contains(document.activeElement)),
    }));
    assert.equal(afterClose.dialogOpen, false, "the dialog must actually be closed, not only collapsed");
    assert.equal(afterClose.expanded, "false", "closing must collapse the trigger again");
    assert.equal(
      afterClose.focusCalls.buildLink,
      1,
      "close must ask for focus on the build-stamp link that opened the dialog — 0 means the module lost its trigger state",
    );
    assert.equal(
      afterClose.focusCalls.headerButton,
      0,
      "and must not fall back to the header button, which is the mutant for a module that hardcoded els.changelogOpen",
    );
    assert.equal(afterClose.focusInsideDialog, false, "and a closed dialog must not keep focus trapped inside it");

    // 4. NEGATIVE CONTROL: drop the module's refresh listener by replacing the button with a clone
    //    (markup is copied, listeners are not). Nothing may be fetched — which is what makes the counts
    //    above evidence about the module's wiring rather than about the button's existence.
    const omitted = await page.evaluate(async () => {
      const button = document.getElementById("changelog-refresh");
      const clone = button.cloneNode(true);
      button.replaceWith(clone);
      const before = window.__changelogFetches.length;
      clone.click();
      await new Promise((resolve) => setTimeout(resolve, 400));
      return { before, after: window.__changelogFetches.length };
    });
    assert.equal(
      omitted.after,
      omitted.before,
      "with the module's listener absent the click must fetch nothing — if this fails the counts above are vacuous",
    );

    // 5. STATICALLY: moved, not copied. Behaviour above cannot see a DEAD leftover (an unused copy of
    //    these functions would never run), and this repo has no lint gate to catch one either.
    const fused = readFileSync(path.join(ROOT, "public", "fused.js"), "utf8");
    const mod = readFileSync(path.join(ROOT, MODULE), "utf8");
    for (const marker of ["lastChangelogTrigger", "formatCommitDescription", "commit-badge"]) {
      assert.equal(
        fused.includes(marker),
        false,
        `public/fused.js must not still carry "${marker}" — the dialog's copy lives in ${MODULE} now`,
      );
      assert.equal(mod.includes(marker), true, `${MODULE} must carry "${marker}"`);
    }
    assert.match(fused, /initChangelogDialog\(\{/, "and fused.js must be the one place this module is initialised");
  } finally {
    try {
      if (page) await page.close();
    } catch {}
    try {
      await server?.stop();
    } catch {}
    rmSync(scratch, { recursive: true, force: true });
  }
});
