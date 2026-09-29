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

let server;
test.before(async () => { server = await startServer({ env: { VOICEBOX_INSTANCE: "pip-styling" } }); });
test.after(async () => { await server?.stop?.(); });

// KEEP ON TOP IS LIVE AND STILL — where a 1200ms settle was (voicebox-beads-g667). A real click lands at the
// coordinates measured a moment before it, so what it needs is: every module has run (live-voice.js is the
// last, and it owns #mic and the client the PiP painter reads), the button is enabled, the fonts are in (a
// font swap reflows), and the button has not moved since the previous look. Measured 2026-09-28: all of it
// holds ~60ms after navigation starts, before page.goto has even returned.
async function keepOnTopIsStill(page) {
  await page.evaluate(async () => {
    const deadline = Date.now() + 10000;
    let last = "";
    for (;;) {
      const b = document.getElementById("pip-open");
      const r = b?.getBoundingClientRect();
      const now = b && !b.disabled && window.__voiceboxLiveClient && document.fonts.status === "loaded"
        ? `${Math.round(r.left + scrollX)},${Math.round(r.top + scrollY)} ${Math.round(r.width)}x${Math.round(r.height)}`
        : "";
      if (now && now === last) return;
      if (Date.now() > deadline) throw new Error(`timed out after 10000ms waiting for Keep on top to be live and still (last: ${now || "not live yet"})`);
      last = now;
      await new Promise((res) => setTimeout(res, 100));
    }
  });
}

test("the PiP window opens styled: tokens, base, real icon, pulse, meters, composer", { timeout: 120000 }, async () => {
  const page = await launch({ width: 1280, height: 900, fakeMedia: true });
  try {
    await page.goto(`${server.base}/`);
    await page.waitFor(() => Boolean(window.__voiceboxPipOpen), { label: "the PiP module" });
    await keepOnTopIsStill(page);

    // A REAL CLICK: documentPictureInPicture.requestWindow needs transient activation, and a dispatch
    // would not have it — the window must open the way a person opens it.
    await page.click("#pip-open");
    // Where a 1500ms settle was (voicebox-beads-g667): the window exists, and every stylesheet it copied from
    // the opener has LOADED (`link.sheet`) — the token, background and font facts below are computed from it.
    await page.waitFor(() => Boolean(window.__voiceboxPip), { label: "the PiP window to open from the room's own Keep on top button" });
    await page.waitFor(() => {
      const links = [...window.__voiceboxPip.document.querySelectorAll('link[rel="stylesheet"]')];
      return links.length > 0 && links.every((l) => l.sheet);
    }, { label: "the PiP window's copied stylesheets to load" });
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
    // Where a 2000ms settle was (voicebox-beads-g667): the painter (a 200ms timer) has painted the capture as
    // live, AND live-voice.js's start handler has finished — its own `capturing` flag is set only after the
    // device rows re-render ("Listening through …", the last step of startLive), and until then the next
    // click on #mic would START a second capture instead of stopping this one.
    await page.waitFor(() =>
      window.__voiceboxPip.document.getElementById("pip-mic")?.dataset.listening === "true" &&
      (document.getElementById("mic-device-state")?.textContent ?? "").startsWith("Listening through"),
    { label: "the PiP window to paint the live capture, and live-voice's start to finish" });
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
    // Where a 1000ms settle was (voicebox-beads-g667): the painter has repainted the stopped capture.
    await page.waitFor(() => window.__voiceboxPip.document.getElementById("pip-mic")?.dataset.listening === "false",
      { label: "the PiP window to paint the stopped capture" });
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
