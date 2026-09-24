// tests/pip-window-styling.test.mjs — voicebox-beads-9d3: the Document-PiP window is STYLED.
//
//   node --test tests/pip-window-styling.test.mjs
//
// Paul: "I asked about the picture in picture ui to be improved, its completely unstyled when opened. I
// expect it to work when I click keep in top." The window opened as bare HTML with the browser's default
// font, and driving it found TWO independent causes — either one alone leaves it looking unstyled:
//
//   1. RELATIVE URLS HAD NO ORIGIN. The window's document is `about:blank`, and it copied the opener's
//      `<link rel="stylesheet" href="style.css">` verbatim: a relative URL in a document with no base
//      resolves to nothing, so the sheet (and the @font-face inside it) never loaded.
//   2. AN INLINE `<style>` IS INERT THERE. Measured: a `<style>` appended to this document's head — even
//      a brand-new one carrying a marker rule — reports `sheet === null` and applies NOTHING, while a
//      copied `<link>` applies and an adopted `CSSStyleSheet` applies. The window's own rules therefore
//      never ran, which no amount of selector work would have fixed.
//
// And a third, which the first fix would have hidden: the HMR re-copy deleted every `style` in the head,
// including the window's own, and it fired on the very append that installed them.
//
// So this test drives the real window (real click = real transient activation) and reads the REAL PiP
// document: the base, the absolute href, a resolved token, a painted background, the real font, the sprite
// and an icon that actually draws (a bounding box, not an element that merely exists), the pulse while
// capture is live, the meters as the painter writes them, and the composer submitting the PAGE's form.
import { test } from "node:test";
import assert from "node:assert/strict";
import { startServer } from "./lib/server.mjs";
import { launch } from "./lib/cdp.mjs";
import { setTimeout as sleep } from "node:timers/promises";

let server;
test.before(async () => { server = await startServer({ env: { VOICEBOX_INSTANCE: "pip-styling" } }); });
test.after(async () => { await server?.stop?.(); });

test("the PiP window opens styled: tokens, base, real icon, pulse, meters, composer", { timeout: 120000 }, async () => {
  const page = await launch({ width: 1280, height: 900, fakeMedia: true });
  try {
    await page.goto(`${server.base}/`);
    await page.waitFor(() => Boolean(window.__voiceboxPipOpen), { label: "the PiP module" });
    await sleep(1200);

    // A REAL CLICK: documentPictureInPicture.requestWindow needs transient activation, and a dispatch
    // would not have it — the window must open the way a person opens it.
    await page.click("#pip-open");
    await sleep(1500);
    const pip = await page.evaluate(() => Boolean(window.__voiceboxPip));
    assert.equal(pip, true, "the PiP window did not open from the room's own Keep on top button");

    const opened = await page.evaluate(() => {
      const d = window.__voiceboxPip.document;
      const mic = d.getElementById("pip-mic");
      const use = mic?.querySelector("svg.icon use");
      const body = getComputedStyle(d.body);
      return {
        base: d.head.querySelector("base")?.href ?? null,
        openerBase: document.baseURI,
        sheetHrefs: [...d.querySelectorAll('link[rel="stylesheet"]')].map((l) => l.getAttribute("href")),
        tokenGround: getComputedStyle(d.documentElement).getPropertyValue("--ground").trim(),
        bodyBg: body.backgroundColor,
        font: body.fontFamily,
        themeMatches: (d.documentElement.dataset.theme ?? null) === (document.documentElement.dataset.theme ?? null),
        sprite: Boolean(d.querySelector(".icon-definitions #i-mic")),
        micUse: use?.getAttribute("href") ?? null,
        micInk: (() => { try { const b = use?.getBBox(); return b ? { w: b.width, h: b.height } : null; } catch { return null; } })(),
        micRadius: mic ? getComputedStyle(mic).borderTopLeftRadius : null,
        logBg: getComputedStyle(d.getElementById("pip-log")).backgroundColor,
        closeIcon: d.getElementById("pip-close")?.querySelector("use")?.getAttribute("href") ?? null,
      };
    });
    assert.equal(opened.base, opened.openerBase, "the PiP document has no base pointing at the opener, so relative URLs cannot resolve");
    assert.ok(opened.sheetHrefs.length > 0 && opened.sheetHrefs.every((h) => /^https?:\/\//.test(h ?? "")), `the copied stylesheet href is not absolute: ${JSON.stringify(opened.sheetHrefs)}`);
    assert.match(opened.tokenGround, /light-dark|#|rgb/, "the design tokens do not resolve in the PiP document");
    assert.notEqual(opened.bodyBg, "rgba(0, 0, 0, 0)", "the body has no background — the copied sheet is not applying");
    assert.match(opened.font, /Inter/, `the Voicebox font did not reach the window: ${opened.font}`);
    assert.equal(opened.themeMatches, true, "an explicit theme on the opener must travel with the window");
    assert.ok(opened.sprite, "the icon sprite is not in the PiP document, so every <use> draws nothing");
    assert.equal(opened.micUse, "#i-mic", "the mic button is not the real icon");
    assert.ok(opened.micInk && opened.micInk.w > 0 && opened.micInk.h > 0, `the mic icon draws nothing (ink box ${JSON.stringify(opened.micInk)})`);
    assert.equal(opened.micRadius, "50%", "the mic button is not the round control the design asks for — the window's own rules are not applying");
    assert.notEqual(opened.logBg, "rgba(0, 0, 0, 0)", "the log is not a card: the window's own rules are not applying");
    assert.equal(opened.closeIcon, "#i-close", "the close control does not carry the close icon");

    // ── the live state: a real capture, so the pulse and the painter are the product's own ──
    await page.click("#mic");
    await sleep(2000);
    const live = await page.evaluate(() => {
      const d = window.__voiceboxPip.document;
      const mic = d.getElementById("pip-mic");
      const fill = d.querySelector(".meter > i");
      return { listening: mic?.dataset.listening ?? null, animation: mic ? getComputedStyle(mic).animationName : null, written: fill?.style.width ?? null };
    });
    assert.equal(live.listening, "true", "the PiP window does not know the mic is live");
    assert.equal(live.animation, "pip-breathe", `the listening mic does not pulse (animation: ${live.animation})`);
    // A headless fake device may deliver no energy at all, so the VALUE may be 0 — what must be true is
    // that the painter wrote one. An empty style is a frozen meter, which is the defect this file avoids.
    assert.notEqual(live.written, "", "the level painter never wrote a width — the meter is frozen");

    await page.click("#mic");
    await sleep(1000);
    const off = await page.evaluate(() => {
      const mic = window.__voiceboxPip.document.getElementById("pip-mic");
      return { listening: mic?.dataset.listening ?? null, animation: getComputedStyle(mic).animationName };
    });
    assert.equal(off.listening, "false", "the PiP window still claims to be listening after capture stopped");
    assert.notEqual(off.animation, "pip-breathe", "the mic is still pulsing after capture stopped");

    // ── the composer routes to the PAGE's own form, not a second one ──
    const composed = await page.evaluate(() => {
      const d = window.__voiceboxPip.document;
      const input = d.querySelector('form input[type="text"]');
      const form = d.querySelector("form");
      const utter = document.getElementById("utterance");
      let reached = null;
      // Capture on the DOCUMENT: the room's own submit handler is registered on the form already and it
      // consumes the utterance, so a listener there would read the box after the room emptied it.
      document.addEventListener("submit", () => { reached = utter.value; }, { once: true, capture: true });
      input.value = "a turn typed in the picture-in-picture window";
      form.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
      return { reached, cleared: input.value === "" };
    });
    assert.equal(composed.reached, "a turn typed in the picture-in-picture window", "the PiP composer did not submit the page's own form with its text");
    assert.equal(composed.cleared, true, "the PiP composer does not clear its own box");
  } finally { await page.close(); }
});
