// voicebox-beads-cwx5.7 / cwx5.8: the default room shows no developer diagnostics, and fits a phone.
//
// The build line is still WRITTEN on every load (other tests and bug reports read it); it is SHOWN only when
// debugging is on or the page and server disagree. At phone width the deck's four tabs must all be inside
// the deck, and the status chip must not strand a single icon button on its row.
import test from "node:test";
import assert from "node:assert/strict";
import { startServer } from "./lib/server.mjs";
import { launch } from "./lib/cdp.mjs";

const stamped = () => document.querySelector("#build")?.textContent?.includes("server");
const buildFacts = () => {
  const line = document.getElementById("build");
  const detail = line.querySelector(".build-detail");
  return {
    detailFlag: line.dataset.detail,
    detailShown: getComputedStyle(detail).display !== "none",
    written: detail.textContent.includes("server"),
    linkShown: line.querySelector('a[href="#changelog-dialog"]').getBoundingClientRect().width > 0,
  };
};

test("browser: the build line is quiet by default and shown with debugging on", async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const page = await launch();
  t.after(() => page.close());

  await page.goto(server.base);
  await page.waitFor(stamped, { label: "build stamp written", timeout: 15000 });
  const quiet = await page.evaluate(buildFacts);
  assert.equal(quiet.written, true, "the revisions are still in the document");
  assert.equal(quiet.detailShown, false, "and not shown to a person who did not ask");
  assert.equal(quiet.linkShown, true, "the change log link stays visible");

  await page.goto(`${server.base}/?debug=1`);
  await page.waitFor(stamped, { label: "build stamp written with debugging on", timeout: 15000 });
  const debug = await page.evaluate(buildFacts);
  assert.equal(debug.detailFlag, "true");
  assert.equal(debug.detailShown, true, "debugging shows the revisions");
});

test("browser: at phone width the deck tabs fit and the top bar is two tidy rows", async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const page = await launch();
  t.after(() => page.close());

  await page.emulateViewport({ width: 390, height: 844, mobile: true });
  await page.goto(server.base);
  await page.waitFor(stamped, { label: "room painted", timeout: 15000 });
  const facts = await page.evaluate(() => {
    const deck = document.getElementById("sqeh-deck").getBoundingClientRect();
    const tabs = [...document.querySelectorAll(".sqeh-toggle-btn")].filter((b) => b.getBoundingClientRect().width > 0);
    const buttons = [...document.querySelectorAll(".head > .icon-button")].filter((b) => b.getBoundingClientRect().width > 0);
    const where = document.querySelector(".head > .where").getBoundingClientRect();
    return {
      tabs: tabs.length,
      tabsInside: tabs.every((b) => b.getBoundingClientRect().right <= deck.right + 0.5),
      buttonRows: new Set(buttons.map((b) => Math.round(b.getBoundingClientRect().top))).size,
      chipBelowButtons: buttons.every((b) => b.getBoundingClientRect().bottom <= where.top + 0.5),
      overflow: document.documentElement.scrollWidth > window.innerWidth,
    };
  });
  assert.ok(facts.tabs >= 4, "the deck has its tabs");
  assert.equal(facts.tabsInside, true, "every deck tab is inside the deck");
  assert.equal(facts.buttonRows, 1, "the icon buttons share one row");
  assert.equal(facts.chipBelowButtons, true, "the status chip has its own row below them");
  assert.equal(facts.overflow, false, "no horizontal page scroll");
});
