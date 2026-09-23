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

test("browser: room build stamp links commits to GitHub and provides quick link to changelog", async (t) => {
  const server = await startServer();
  t.after(() => server.stop());

  const page = await launch();
  t.after(() => page.close());

  await page.goto(server.base);
  await page.waitFor(() => document.querySelector("#build")?.textContent?.includes("server"), {
    label: "build stamp rendered with server facts",
    timeout: 15000,
  });

  // Verify header has Change log link
  const headLink = await page.evaluate(() => {
    const a = document.querySelector('header a[href="changelog.html"]');
    return a ? { text: a.textContent.trim(), href: a.getAttribute("href") } : null;
  });
  assert.ok(headLink, "header must contain a link to changelog.html");
  assert.equal(headLink.text, "Change log");
  assert.equal(headLink.href, "changelog.html");

  // Verify build line contains commit links to GitHub
  const buildLinks = await page.evaluate(() => {
    const buildEl = document.getElementById("build");
    if (!buildEl) return null;
    const anchors = [...buildEl.querySelectorAll("a")].map((a) => ({
      text: a.textContent.trim(),
      href: a.getAttribute("href"),
      target: a.getAttribute("target"),
    }));
    return {
      text: buildEl.textContent.trim(),
      anchors,
    };
  });

  assert.ok(buildLinks, "#build must exist");
  assert.ok(buildLinks.anchors.length >= 2, "build stamp must contain commit link(s) and changelog link");

  // Verify commit link to GitHub
  const commitLink = buildLinks.anchors.find((a) => a.href.includes("github.com/PaulKinlan/voicebox/commit/"));
  assert.ok(commitLink, "must link commit to GitHub repo");
  assert.match(commitLink.href, /^https:\/\/github\.com\/PaulKinlan\/voicebox\/commit\/[0-9a-f]{7,40}$/);
  assert.equal(commitLink.target, "_blank");

  // Verify changelog link in build stamp
  const changelogLink = buildLinks.anchors.find((a) => a.href === "changelog.html");
  assert.ok(changelogLink, "must link to changelog.html in build stamp");
  assert.equal(changelogLink.text, "change log");

  // Navigate to changelog.html and verify commit list loads
  await page.goto(`${server.base}/changelog.html`);
  await page.waitFor(() => document.querySelectorAll("#commits li").length > 0, {
    label: "changelog commits rendered",
    timeout: 15000,
  });

  const changelogData = await page.evaluate(() => {
    const items = [...document.querySelectorAll("#commits li")].map((li) => {
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

  assert.ok(changelogData.length > 0, "changelog must display commits");
  const first = changelogData[0];
  assert.match(first.shaText, /^[0-9a-f]{7,}$/);
  assert.match(first.shaHref, /^https:\/\/github\.com\/PaulKinlan\/voicebox\/commit\/[0-9a-f]{40}$/);
  assert.ok(first.subject.length > 0);
  assert.ok(first.meta.length > 0);
});
