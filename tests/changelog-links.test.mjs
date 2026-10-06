// tests/changelog-links.test.mjs — Commit links in build stamp and changelog surface (voicebox-beads-6g5, 7va)
//
// 6g5: Page and server commit references in the room link to https://github.com/PaulKinlan/voicebox/commit/<sha>
// 7va: Quick link to a change log integrated with commits reachable from the room.

import test from "node:test";
import assert from "node:assert/strict";
import { startServer } from "./lib/server.mjs";
import { launch } from "./lib/cdp.mjs";

test("server API: GET /api/changelog returns recent commits formatted with GitHub commit URLs", async (t) => {
  const server = await startServer();
  t.after(() => server.stop());

  const res = await fetch(`${server.base}/api/changelog`);
  assert.equal(res.status, 200);
  const data = await res.json();

  assert.equal(data.ok, true);
  assert.equal(data.repo, "https://github.com/PaulKinlan/voicebox");
  assert.ok(Array.isArray(data.commits), "commits must be an array");
  assert.ok(data.commits.length > 0, "commits array must not be empty");

  const first = data.commits[0];
  assert.match(first.sha, /^[0-9a-f]{40}$/, "full sha must be 40-character hex");
  assert.match(first.shortSha, /^[0-9a-f]{7,}$/, "shortSha must be short hex");
  assert.ok(typeof first.subject === "string" && first.subject.length > 0, "subject must exist");
  assert.ok(typeof first.author === "string" && first.author.length > 0, "author must exist");
  assert.match(first.date, /^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD");
  assert.equal(first.url, `https://github.com/PaulKinlan/voicebox/commit/${first.sha}`);
});

test("static assets: changelog.html, css and js serve with correct mime types", async (t) => {
  const server = await startServer();
  t.after(() => server.stop());

  const htmlRes = await fetch(`${server.base}/changelog.html`);
  assert.equal(htmlRes.status, 200);
  assert.match(htmlRes.headers.get("content-type"), /text\/html/);
  const html = await htmlRes.text();
  assert.match(html, /<title>Change log — Voicebox<\/title>/);
  assert.match(html, /href="\.\/">Back to Voicebox<\/a>/);

  const cssRes = await fetch(`${server.base}/changelog.css`);
  assert.equal(cssRes.status, 200);
  assert.match(cssRes.headers.get("content-type"), /text\/css/);

  const jsRes = await fetch(`${server.base}/changelog.js`);
  assert.equal(jsRes.status, 200);
  assert.match(jsRes.headers.get("content-type"), /text\/javascript/);
});

test("browser: room build stamp links commits to GitHub and opens changelog as a modal dialog without navigating away", async (t) => {
  const server = await startServer();
  t.after(() => server.stop());

  const page = await launch();
  t.after(() => page.close());

  await page.goto(server.base);
  await page.waitFor(() => document.querySelector("#build")?.textContent?.includes("server"), {
    label: "build stamp rendered with server facts",
    timeout: 15000,
  });

  const initialUrl = await page.evaluate(() => location.href);

  // Verify header has Change log modal button (not a page navigation link)
  const headBtn = await page.evaluate(() => {
    const btn = document.getElementById("changelog-open");
    const dialog = document.getElementById("changelog-dialog");
    const navLink = document.querySelector('header a[href="changelog.html"]');
    return btn ? {
      tag: btn.tagName,
      text: btn.textContent.trim(),
      haspopup: btn.getAttribute("aria-haspopup"),
      controls: btn.getAttribute("aria-controls"),
      expanded: btn.getAttribute("aria-expanded"),
      isDialog: dialog instanceof HTMLDialogElement,
      dialogOpen: dialog?.open,
      hasPageNavLink: Boolean(navLink),
    } : null;
  });
  assert.ok(headBtn, "header must contain #changelog-open button");
  assert.equal(headBtn.tag, "BUTTON");
  assert.equal(headBtn.text, "Change log");
  assert.equal(headBtn.haspopup, "dialog");
  assert.equal(headBtn.controls, "changelog-dialog");
  assert.equal(headBtn.expanded, "false");
  assert.equal(headBtn.isDialog, true, "#changelog-dialog must be a native <dialog>");
  assert.equal(headBtn.dialogOpen, false);
  assert.equal(headBtn.hasPageNavLink, false, "header must not navigate away via a[href='changelog.html']");

  // Verify build line contains commit links to GitHub and modal changelog trigger
  const buildLinks = await page.evaluate(() => {
    const buildEl = document.getElementById("build");
    if (!buildEl) return null;
    const anchors = [...buildEl.querySelectorAll("a")].map((a) => ({
      text: a.textContent.trim(),
      href: a.getAttribute("href"),
      target: a.getAttribute("target"),
      haspopup: a.getAttribute("aria-haspopup"),
      controls: a.getAttribute("aria-controls"),
    }));
    return {
      text: buildEl.textContent.trim(),
      anchors,
    };
  });

  assert.ok(buildLinks, "#build must exist");
  assert.ok(buildLinks.anchors.length >= 2, "build stamp must contain commit link(s) and changelog trigger");

  // Verify commit link to GitHub
  const commitLink = buildLinks.anchors.find((a) => a.href.includes("github.com/PaulKinlan/voicebox/commit/"));
  assert.ok(commitLink, "must link commit to GitHub repo");
  assert.match(commitLink.href, /^https:\/\/github\.com\/PaulKinlan\/voicebox\/commit\/[0-9a-f]{7,40}$/);
  assert.equal(commitLink.target, "_blank");

  // Verify changelog trigger in build stamp targets #changelog-dialog
  const changelogTrigger = buildLinks.anchors.find((a) => a.text === "change log");
  assert.ok(changelogTrigger, "must include change log trigger in build stamp");
  assert.equal(changelogTrigger.href, "#changelog-dialog");
  assert.equal(changelogTrigger.haspopup, "dialog");
  assert.equal(changelogTrigger.controls, "changelog-dialog");

  // Click header #changelog-open button and verify modal opens in-room with commits loaded
  await page.click("#changelog-open");
  await page.waitFor(() => document.getElementById("changelog-dialog")?.open === true, {
    label: "changelog dialog open",
  });
  await page.waitFor(() => document.querySelectorAll("#changelog-commits li").length > 0, {
    label: "changelog commits rendered in dialog",
    timeout: 15000,
  });

  const afterOpenUrl = await page.evaluate(() => location.href);
  assert.equal(afterOpenUrl, initialUrl, "opening changelog dialog must not navigate away from the room");

  const changelogData = await page.evaluate(() => {
    const items = [...document.querySelectorAll("#changelog-commits li")].map((li) => {
      const shaLink = li.querySelector(".commit-sha");
      const subject = li.querySelector(".commit-subject");
      const meta = li.querySelector(".commit-meta");
      return {
        shaText: shaLink?.textContent?.trim(),
        shaHref: shaLink?.getAttribute("href"),
        subject: subject?.textContent?.trim(),
        meta: meta?.textContent?.trim(),
      };
    });
    return items;
  });

  assert.ok(changelogData.length > 0, "changelog modal must display commits");
  const first = changelogData[0];
  assert.match(first.shaText, /^[0-9a-f]{7,}$/);
  assert.match(first.shaHref, /^https:\/\/github\.com\/PaulKinlan\/voicebox\/commit\/[0-9a-f]{40}$/);
  assert.ok(first.subject.length > 0);
  assert.ok(first.meta.length > 0);

  // Close via close button and verify aria-expanded clears and focus returns to #changelog-open.
  // Focus restoration is synchronous in the dialog close() algorithm (platform-owned), but
  // `aria-expanded` is set by the app's close handler in a SEPARATE task, so wait for BOTH before
  // asserting (voicebox-beads-tnxm / voicebox-beads-xep4).
  await page.click("#changelog-close");
  await page.waitFor(
    () => {
      const dialog = document.getElementById("changelog-dialog");
      const trigger = document.getElementById("changelog-open");
      return dialog?.open === false && trigger?.getAttribute("aria-expanded") === "false" && document.activeElement === trigger;
    },
    { label: "changelog dialog closed (aria-expanded false, focus back on #changelog-open)" },
  );
  const afterClose = await page.evaluate(() => ({
    expanded: document.getElementById("changelog-open")?.getAttribute("aria-expanded"),
    activeId: document.activeElement?.id ?? document.activeElement?.tagName,
  }));
  assert.equal(afterClose.expanded, "false", "the changelog trigger still says expanded after close");
  assert.equal(afterClose.activeId, "changelog-open", `closing the changelog must return focus to its trigger, got '${afterClose.activeId}'`);

  // Also verify clicking the #build "change log" link opens the same modal without navigating
  await page.click('#build a[href="#changelog-dialog"]');
  await page.waitFor(() => document.getElementById("changelog-dialog")?.open === true, {
    label: "changelog dialog opened from #build link",
  });
  const afterBuildClickUrl = await page.evaluate(() => location.href);
  assert.equal(afterBuildClickUrl, initialUrl, "#build change log link must open dialog without changing URL");
  await page.click("#changelog-close");
  await page.waitFor(() => document.getElementById("changelog-dialog")?.open === false);
});

