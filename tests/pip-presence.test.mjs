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

let server;
test.before(async () => { server = await startServer({ env: { VOICEBOX_INSTANCE: "pip-presence" } }); });
test.after(async () => { await server?.stop?.(); });

// THE PAINTER HAS PAINTED IT (voicebox-beads-g667). Every read here used to follow a 500ms sleep — "two ticks,
// never zero" of the PiP painter's 200ms timer. Each read now waits, bounded, for the painted state it is
// about to assert, which is what the two ticks stood in for, and a miss names the state it waited for.

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

test("the PiP presence indicator mirrors the page's real voice states, and the transcript carries turn structure", { timeout: 120000 }, async () => {
  const page = await launch({ width: 1280, height: 900, fakeMedia: true });
  try {
    await page.goto(`${server.base}/`);
    await page.waitFor(() => Boolean(window.__voiceboxPipOpen), { label: "the PiP module" });
    await keepOnTopIsStill(page);

    await page.click("#pip-open");
    // Where a 1500ms settle was (voicebox-beads-g667): the window exists — and it has been painted, because
    // openPipWindow paints once in the same synchronous run that publishes window.__voiceboxPip.
    await page.waitFor(() => Boolean(window.__voiceboxPip), { label: "the PiP window to open" });
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
    await page.waitFor(() => {
      const dot = window.__voiceboxPip.document.getElementById("pip-presence")?.dataset.state;
      return Boolean(window.__voiceboxLiveClient?.state?.capture) && (dot === "listening" || dot === "waiting");
    }, { label: "the capture to start and the dot to paint it live" });
    st = await page.evaluate(() => ({
      dot: window.__voiceboxPip.document.getElementById("pip-presence")?.dataset.state,
      capture: Boolean(window.__voiceboxLiveClient?.state?.capture),
    }));
    assert.equal(st.capture, true, "one click on the PiP mic started the capture (the page's own button was clicked)");
    assert.ok(st.dot === "listening" || st.dot === "waiting", `the dot reads live (listening or waiting), got ${st.dot}`);

    // THE SESSION HAS SETTLED before the page's machine is driven by hand (voicebox-beads-g667). Every emit of
    // the real client re-writes #voice-ring-wrap's data-voice, and a fresh session's last one is `ready`
    // (measured ~200ms after capture starts): the old 500ms sleeps happened to outlast it, and a "speaking"
    // set before it lands is overwritten on the spot. The steps below need it anyway — "ready flips waiting
    // to listening" reads the real client's ready. And "Listening through …" in the device row is the last
    // thing live-voice.js's start handler does before it sets its own `capturing` flag; until then the
    // "OFF again" click below would START a second capture instead of stopping this one.
    await page.waitFor(() =>
      window.__voiceboxLiveClient?.state?.ready === true &&
      window.__voiceboxPip.document.getElementById("pip-presence")?.dataset.state === "listening" &&
      (document.getElementById("mic-device-state")?.textContent ?? "").startsWith("Listening through"),
    { label: "the live session to report ready, and live-voice's start to finish" });

    // SPEAKING: when the page's machine says agent-speaking, the dot follows on the next paint.
    await page.evaluate(() => { document.getElementById("voice-ring-wrap").dataset.voice = "speaking"; });
    await page.waitFor(() => window.__voiceboxPip.document.getElementById("pip-presence")?.dataset.state === "speaking",
      { label: "the dot to paint speaking" });
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
    await page.waitFor(() => window.__voiceboxPip.document.getElementById("pip-presence")?.dataset.state === "waiting",
      { label: "the dot to paint waiting" });
    st = await page.evaluate(() => window.__voiceboxPip.document.getElementById("pip-presence")?.dataset.state);
    assert.equal(st, "waiting", "capture live + model not ready reads as waiting (the bead's 'thinking')");
    await page.evaluate(() => { window.__voiceboxLiveClient = window.__voiceboxLiveClientReal; });
    await page.waitFor(() => window.__voiceboxPip.document.getElementById("pip-presence")?.dataset.state === "listening",
      { label: "the dot to paint listening again" });
    st = await page.evaluate(() => window.__voiceboxPip.document.getElementById("pip-presence")?.dataset.state);
    assert.equal(st, "listening", "ready flips waiting to listening");

    // OFF again via the same one control.
    await page.evaluate(() => window.__voiceboxPip.document.getElementById("pip-mic").click());
    await page.waitFor(() =>
      !window.__voiceboxLiveClient?.state?.capture &&
      window.__voiceboxPip.document.getElementById("pip-presence")?.dataset.state === "off",
    { label: "the capture to stop and the dot to paint off" });
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
    // The mirror is a MutationObserver on the session log, not the painter — wait for the row itself.
    await page.waitFor(() => (window.__voiceboxPip.document.querySelector("#pip-log .turn .said")?.textContent ?? "").includes("list nothing in particular"),
      { label: "the turn to mirror into the PiP transcript" });
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
