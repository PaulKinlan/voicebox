// tests/cdp-click-diagnostics.test.mjs — a lost click must say what it hit (voicebox-beads-joxy).
//
//   node --test tests/cdp-click-diagnostics.test.mjs
//
// `page.click` dispatches a REAL mouse event at coordinates computed from the element's box. The hit-test that
// picks those coordinates happens BEFORE the dispatch, so under load the page can move in between and the event
// lands where the element no longer is: the 18lh root cause, where the page's own hit-test and the dispatched
// event disagree and the click is simply lost.
//
// Before this change that failure surfaced only as a bare `timed out waiting for <label>` — which cannot tell a
// broken handler apart from a pointer in the wrong place, and cost a lane a reproduction cycle. `page.click` now
// records where its event actually went, `page.lastClick` exposes the record, and the wait timeout carries it.
//
// NO ASSERTION CHANGES: the record is diagnostic only, which is why this file is the only place that depends on
// it, and why the message change is a suffix (the two existing controls that match that message do so by regex).
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "./lib/server.mjs";
import { launch } from "./lib/cdp.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let server;
let page;

test.before(async () => {
  server = await startServer({ cwd: ROOT, env: { VOICEBOX_INSTANCE: "cdp-click-diagnostics-test" } });
  page = await launch();
  await page.goto(`${server.base}/`);
});

test.after(async () => {
  await page?.close();
  await server?.stop();
});

/** One button nested inside another, and one that removes itself on mouse DOWN (so the click is lost). */
async function buildProbes() {
  await page.evaluate(() => {
    document.getElementById("probe-wrap")?.remove();
    const wrap = document.createElement("div");
    wrap.id = "probe-wrap";
    wrap.style.cssText = "position:fixed;left:30px;top:30px;z-index:2147483647;background:#fff;padding:10px";
    const nested = document.createElement("button");
    nested.id = "probe-nested";
    nested.style.cssText = "width:200px;height:60px;display:block";
    nested.appendChild(Object.assign(document.createElement("span"), { textContent: "nested label" }));
    const vanishing = document.createElement("button");
    vanishing.id = "probe-vanishing";
    vanishing.style.cssText = "width:200px;height:60px;display:block;margin-top:8px";
    vanishing.textContent = "vanish on press";
    vanishing.addEventListener("mousedown", () => vanishing.remove(), { once: true });
    // A button that becomes non-interactive between press and release: it is still in the document, so the release
    // lands on its container and the browser puts the click there.
    const hiding = document.createElement("button");
    hiding.id = "probe-hiding";
    hiding.style.cssText = "width:200px;height:60px;display:block;margin-top:8px";
    hiding.textContent = "hide on press";
    hiding.addEventListener("mousedown", () => hiding.style.visibility = "hidden", { once: true });
    wrap.append(nested, vanishing, hiding);
    document.body.appendChild(wrap);
  });
}

test("a click that reaches the target records that it did — and a click on the target's child counts as reaching it", async () => {
  await buildProbes();
  await page.click("#probe-nested");
  assert.ok(page.lastClick, "every click records a record");
  assert.equal(page.lastClick.selector, "#probe-nested");
  assert.match(
    page.lastClick.line,
    /did reach the target/,
    `a delivered click must say so, not stay silent: ${page.lastClick.line}`,
  );
  assert.match(page.lastClick.line, /received by \w+/, "and it names what received it");
  assert.match(page.lastClick.line, /at \(\d+, \d+\)/, "and where the event was dispatched");

  // A second click is recorded on its own, and the probe does not pile up listeners: the record is a fact about
  // THIS click, so a stale one would be worse than none.
  await page.click("#probe-nested");
  assert.equal(
    await page.evaluate(() => window.__voiceboxClickProbe === undefined),
    true,
    "the per-click recorder must be removed after each click, not left behind",
  );
  assert.match(page.lastClick.line, /did reach the target/);
});

test("a click that lands where the element no longer is names the element that ACTUALLY received it", async () => {
  await buildProbes();
  // The button becomes non-interactive between press and release, so the release — and therefore the click, which
  // needs both to share a target — lands on the container. Exactly the 18lh shape: the pointer is dispatched at
  // coordinates where the element no longer is.
  await page.click("#probe-hiding");

  assert.ok(page.lastClick, "the click still records a record");
  assert.match(
    page.lastClick.line,
    /was received by div#probe-wrap/,
    `the failure must NAME the element that got the click: ${page.lastClick.line}`,
  );
  assert.match(page.lastClick.line, /instead of the target/, "and say plainly that it was not the target");
  assert.match(
    page.lastClick.line,
    /the target is now at \(\d+, \d+\) but is hidden or no longer interactive/,
    `and where the target is, and that it cannot take a click — where cheap: ${page.lastClick.line}`,
  );

  // THE POINT OF THE WHOLE CHANGE: the wait that follows a lost click now carries the record, so a timeout reads
  // as "the pointer landed elsewhere" rather than as a broken handler.
  await assert.rejects(
    () => page.waitFor(() => false, { label: "the effect of the hidden button", timeout: 600 }),
    /timed out waiting for the effect of the hidden button; last value false; the last click was .*s before this wait began — the click on #probe-hiding .* was received by div#probe-wrap/s,
    "the timeout must carry what the click hit, with the click's age",
  );
});

test("a click whose target is REMOVED between press and release records that no click event was dispatched at all", async () => {
  await buildProbes();
  // Measured while writing this: a click needs press and release to share a target, so removing the element on
  // mouse down produces NO click event anywhere — not a click on the parent. That is the other half of the 18lh
  // shape, and the reason a lost click looked like a broken handler: there was no event to trace at all.
  await page.click("#probe-vanishing");

  assert.match(
    page.lastClick.line,
    /never reached the document/,
    `a click with no event must say exactly that, not blame the handler: ${page.lastClick.line}`,
  );
  assert.match(page.lastClick.line, /the target has since left the document/, "and note that the target is gone");

  await assert.rejects(
    () => page.waitFor(() => false, { label: "the effect of the vanishing button", timeout: 600 }),
    /never reached the document/,
    "and the timeout carries it too",
  );
});
