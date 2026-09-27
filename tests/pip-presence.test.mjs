// tests/pip-presence.test.mjs — the PiP microphone's presence indicator and transcript
// (voicebox-beads-9i6u).
//
// The window is driven for real (real click = real transient activation, the real PiP document,
// a real fake-media capture) and every assertion reads the page's OWN painted truth — the PiP
// mirrors it, never invents it: the presence dot follows the page's voice machine (off / waiting /
// listening / speaking), the state sentence is the page's own voice-state text, and the transcript
// mirrors the session log's STRUCTURE (said + did per turn), not a flattened blob.
//
//   node --test tests/pip-presence.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { startServer } from "./lib/server.mjs";
import { launch } from "./lib/cdp.mjs";
import { setTimeout as sleep } from "node:timers/promises";

let server;
test.before(async () => { server = await startServer({ env: { VOICEBOX_INSTANCE: "pip-presence" } }); });
test.after(async () => { await server?.stop?.(); });

async function paint(page) {
  // The painter runs on a 200ms timer; wait two ticks, never zero.
  await sleep(500);
}

test("the PiP presence indicator mirrors the page's real voice states, and the transcript carries turn structure", { timeout: 120000 }, async () => {
  const page = await launch({ width: 1280, height: 900, fakeMedia: true });
  try {
    await page.goto(`${server.base}/`);
    await page.waitFor(() => Boolean(window.__voiceboxPipOpen), { label: "the PiP module" });
    await sleep(1200);

    await page.click("#pip-open");
    await sleep(1500);
    assert.equal(await page.evaluate(() => Boolean(window.__voiceboxPip)), true, "the PiP window opened");

    // OFF: the dot is present, named off, and the sentence is the page's own.
    let st = await page.evaluate(() => {
      const d = window.__voiceboxPip.document;
      return {
        dot: d.getElementById("pip-presence")?.dataset.state ?? null,
        text: d.getElementById("pip-state")?.textContent ?? "",
        pageText: document.getElementById("voice-state")?.textContent ?? "",
      };
    });
    assert.equal(st.dot, "off", "a fresh window starts off");
    assert.equal(st.text, st.pageText, "the PiP's sentence is the page's own voice-state text, never an invented one");

    // ONE CLICK on the PiP mic toggles capture (the mute/unmute is the same control).
    await page.evaluate(() => window.__voiceboxPip.document.getElementById("pip-mic").click());
    await paint(page);
    st = await page.evaluate(() => ({
      dot: window.__voiceboxPip.document.getElementById("pip-presence")?.dataset.state,
      capture: Boolean(window.__voiceboxLiveClient?.state?.capture),
    }));
    assert.equal(st.capture, true, "one click on the PiP mic started the capture (the page's own button was clicked)");
    assert.ok(st.dot === "listening" || st.dot === "waiting", `the dot reads live (listening or waiting), got ${st.dot}`);

    // SPEAKING: when the page's machine says agent-speaking, the dot follows on the next paint.
    await page.evaluate(() => { document.getElementById("voice-ring-wrap").dataset.voice = "speaking"; });
    await paint(page);
    st = await page.evaluate(() => ({
      dot: window.__voiceboxPip.document.getElementById("pip-presence")?.dataset.state,
      animation: getComputedStyle(window.__voiceboxPip.document.getElementById("pip-presence")).animationName,
    }));
    assert.equal(st.dot, "speaking", "the dot follows the page's speaking state");
    assert.equal(st.animation, "pip-speak", "the speaking state has its own motion");

    // WAITING: capture live but the model not ready — the 'thinking' the bead names, named honestly.
    // Driven at the SEAM the PiP reads: the page's live client (substituted, not mutated — the real
    // client re-emits its own state and would overwrite a hand-set field between paints).
    await page.evaluate(() => {
      document.getElementById("voice-ring-wrap").dataset.voice = "listening";
      window.__voiceboxLiveClientReal = window.__voiceboxLiveClient;
      window.__voiceboxLiveClient = { state: { capture: true, ready: false }, level: () => null };
    });
    await paint(page);
    st = await page.evaluate(() => window.__voiceboxPip.document.getElementById("pip-presence")?.dataset.state);
    assert.equal(st, "waiting", "capture live + model not ready reads as waiting (the bead's 'thinking')");
    await page.evaluate(() => { window.__voiceboxLiveClient = window.__voiceboxLiveClientReal; });
    await paint(page);
    st = await page.evaluate(() => window.__voiceboxPip.document.getElementById("pip-presence")?.dataset.state);
    assert.equal(st, "listening", "ready flips waiting to listening");

    // OFF again via the same one control.
    await page.evaluate(() => window.__voiceboxPip.document.getElementById("pip-mic").click());
    await paint(page);
    st = await page.evaluate(() => ({
      dot: window.__voiceboxPip.document.getElementById("pip-presence")?.dataset.state,
      capture: Boolean(window.__voiceboxLiveClient?.state?.capture),
    }));
    assert.equal(st.capture, false);
    assert.equal(st.dot, "off", "the same control muted it back off");

    // THE TRANSCRIPT: a typed turn through the PiP's own composer lands in the page's session log
    // and mirrors into the PiP WITH its structure (what you said / what it did), scrollable.
    await page.evaluate(() => {
      const d = window.__voiceboxPip.document;
      const input = d.querySelector('form input[type="text"]');
      input.value = "list nothing in particular";
      d.querySelector("form").requestSubmit();
    });
    await page.waitFor(() => document.querySelectorAll("#session-log li").length > 0, { label: "the page logged the turn" });
    await paint(page);
    const transcript = await page.evaluate(() => {
      const rows = [...window.__voiceboxPip.document.querySelectorAll("#pip-log .turn")];
      return {
        rows: rows.length,
        said: rows[0]?.querySelector(".said")?.textContent ?? null,
        did: rows[0]?.querySelector(".did")?.textContent ?? null,
        scrollable: getComputedStyle(window.__voiceboxPip.document.getElementById("pip-log")).overflowY,
      };
    });
    assert.ok(transcript.rows >= 1, "the turn mirrored into the PiP transcript");
    assert.match(transcript.said ?? "", /list nothing in particular/, "the row carries what I said");
    assert.ok((transcript.did ?? "").length > 0, "the row carries what it did (the outcome, refusal or act)");
    assert.match(transcript.scrollable ?? "", /auto|scroll/, "the transcript scrolls inside the window");
  } finally {
    await page.close();
  }
});
