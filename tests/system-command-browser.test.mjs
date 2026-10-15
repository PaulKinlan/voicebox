// tests/system-command-browser.test.mjs — every advertised system command, driven the way a person
// drives it: typed into the composer, resolved by the script resolver, executed, and applied by the
// browser. (voicebox-beads-ucak)
//
// WHY THIS FILE EXISTS. The unit tests in tests/system-commands.test.mjs assert that the PARSER
// produces the documented shape — and it always did. Nothing drove the other end, so nothing noticed
// that the client guarded on `cmd.theme` and `cmd.panel` while the parser, the server broadcast and
// the turn response all carried `mode` and `target`. Both sides were green against themselves and
// every navigation and appearance command silently did nothing. A parser-level assertion cannot catch
// that class; only a drive from the turn to the observable UI can.
//
// THE DRIVE IS PROVED NON-VACUOUS. #session-log gains a node per turn, so every command here waits for
// the turn count to rise before reading the effect. Without that, a broken submit would look exactly
// like a dead command — which is how the first version of this investigation fooled itself.
//
//   node --test tests/system-command-browser.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startServer } from "./lib/server.mjs";
import { launch } from "./lib/cdp.mjs";

test("system commands: a typed command reaches the browser and changes the UI (voicebox-beads-ucak)", { timeout: 120000 }, async (t) => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "vb-syscmd-"));
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

  const rootRes = await fetch(`${server.base}/api/root`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-voicebox-host-token": server.hostToken },
    body: JSON.stringify({ project: "syscmd-browser", root: { kind: "machine", path: workspace } }),
  });
  assert.equal(rootRes.ok, true, "declared workspace root");

  const page = await launch({ width: 1180, height: 820 });
  t.after(() => page.close());

  await page.goto(`${server.base}/`);
  await page.waitFor(() => document.getElementById("text-form") !== null && document.getElementById("session-log") !== null, {
    label: "the composer and the transcript are on the page",
  });

  const read = () =>
    page.evaluate(() => ({
      turns: document.getElementById("session-log")?.children.length ?? -1,
      theme: document.documentElement.dataset.theme,
      themeMode: document.documentElement.dataset.themeMode,
      stored: localStorage.getItem("voicebox:theme"),
      settingsOpen: Boolean(document.getElementById("settings")?.open),
      sqehState: document.body.dataset.sqehState ?? null,
      trackerTitle: document.getElementById("mini-app-outer-frame")?.getAttribute("title") ?? null,
    }));

  /** Type a command into the real composer, and do not return until the turn itself has landed. */
  const say = async (text) => {
    const before = (await read()).turns;
    await page.evaluate((t) => {
      const u = document.getElementById("utterance");
      u.value = t;
      u.dispatchEvent(new Event("input", { bubbles: true }));
      document.getElementById("text-form").requestSubmit();
    }, text);
    await page.waitFor((n) => (document.getElementById("session-log")?.children.length ?? -1) > n, {
      args: [before],
      label: `the turn "${text}" reached the transcript`,
    });
  };

  // ── Appearance: switch_theme reads `mode` ────────────────────────────────────────────────────
  assert.equal((await read()).theme, "light", "the page starts light");
  await say("dark mode");
  const dark = await read();
  assert.equal(dark.theme, "dark", "'dark mode' switches the page to dark — this is the whole point of the bead");
  assert.equal(dark.themeMode, "dark", "'dark mode' records the preference, not just the scheme");
  assert.equal(dark.stored, "dark", "'dark mode' persists the choice, which is what survives a reload");

  await say("light mode");
  const light = await read();
  assert.equal(light.theme, "light", "'light mode' switches back");
  assert.equal(light.stored, "light", "'light mode' persists");

  await say("system theme");
  const system = await read();
  assert.equal(system.themeMode, "system", "'system theme' records the system preference");
  assert.equal(system.stored, "system", "'system theme' persists");

  // ── Navigation: open_panel reads `target` ────────────────────────────────────────────────────
  await say("open settings");
  const settings = await read();
  assert.equal(settings.settingsOpen, true, "'open settings' really opens the settings dialog");

  // "close panel" must close what is actually open, including the modal sheet above — the plain
  // reading of the command. Deck windows and the sheet are different mechanisms, so both are asserted.
  await say("close panel");
  const closed = await read();
  assert.equal(closed.settingsOpen, false, "'close panel' closes the settings sheet that is open in front of you");
  assert.equal(closed.sqehState, "deck", "'close panel' also returns the deck home");

  await say("open files");
  assert.equal((await read()).sqehState, "files", "'open files' moves the deck to the files panel");

  await say("open history");
  assert.equal((await read()).sqehState, "history", "'open history' moves the deck to the history panel");

  await say("open activity log");
  assert.equal((await read()).sqehState, "activity", "'open activity log' moves the deck to the activity panel");

  // ── The target that had NO branch at all: the built-in tracker mini-app ──────────────────────
  assert.equal((await read()).trackerTitle, null, "the tracker is not mounted before it is asked for");
  await say("open agent tracker");
  // THIS EFFECT IS ASYNCHRONOUS, UNLIKE EVERY OTHER COMMAND IN THIS FILE, SO IT IS WAITED FOR
  // RATHER THAN READ. openAgentProgressTracker() (public/fused.js:4576) awaits a fetch of
  // /apps/agent-monitor.html and only then calls mount(), which creates the outer frame and sets its
  // title — while `say()` above returns as soon as the TURN lands. Reading straight after the turn
  // therefore raced that fetch: it passed whenever it resolved inside the CDP round trip, and failed
  // the merger's union gate once with "expected 'Agent Progress Tracker', got null" under a
  // four-worker browser lane (2026-10-11). This bound makes it deterministic without weakening it: a
  // handler that never mounts still fails here, by timing out with this label.
  await page.waitFor(
    () => document.getElementById("mini-app-outer-frame")?.getAttribute("title") === "Agent Progress Tracker",
    { label: "the Agent Progress Tracker mini-app mounted" },
  );
  const tracker = await read();
  assert.equal(
    tracker.trackerTitle,
    "Agent Progress Tracker",
    "'open agent tracker' mounts the Agent Progress Tracker mini-app — it had no handler before ucak",
  );

  // ── And `close`, which also had no branch ───────────────────────────────────────────────────
  await say("open files");
  assert.equal((await read()).sqehState, "files", "the deck moved away before we close it");
  await say("close panel");
  assert.equal((await read()).sqehState, "deck", "'close panel' returns to the deck");

  // ── Audio session: stop_speaking (interrupt, mute, unmute) ───────────────────
  // Drive the real consumer paths for stop_speaking: audio client stopReply/stopPlayback,
  // provider generation cancellation via interruptSpeech, offline speech cancellation,
  // browser speech synthesis, and interrupt button trigger.
  await page.evaluate(() => {
    window.__flushedLivePlayback = false;
    window.__providerInterruptCount = 0;
    window.__offlineSpeechStopped = false;
    window.__speechCancelled = false;
    window.__interruptClicked = false;
    window.__playbackStoppedOnMute = 0;

    window.__voiceboxLiveClient = {
      stopReply: () => { window.__flushedLivePlayback = true; return { flushed: true }; },
      stopPlayback: () => { window.__flushedLivePlayback = true; return { flushed: true }; },
      interruptSpeech: (source) => {
        window.__flushedLivePlayback = true;
        if (source === "page") window.__providerInterruptCount++;
        return { flushed: true };
      },
    };
    window.__voiceboxOfflineSpeech = {
      stopSpeaking: () => { window.__offlineSpeechStopped = true; return { ok: true }; },
    };
    try {
      if (window.speechSynthesis) {
        window.speechSynthesis.cancel = () => { window.__speechCancelled = true; };
      } else {
        Object.defineProperty(window, "speechSynthesis", {
          configurable: true,
          value: { cancel: () => { window.__speechCancelled = true; } },
        });
      }
    } catch {
      Object.defineProperty(window, "speechSynthesis", {
        configurable: true,
        value: { cancel: () => { window.__speechCancelled = true; } },
      });
    }
    const interrupt = document.getElementById("interrupt");
    interrupt?.addEventListener("click", () => {
      window.__interruptClicked = true;
    });
  });

  await say("stop speaking");
  const stopObs = await page.evaluate(() => ({
    flushedLive: window.__flushedLivePlayback,
    providerInterruptCount: window.__providerInterruptCount,
    offlineStopped: window.__offlineSpeechStopped,
    speechCancelled: window.__speechCancelled,
    interruptClicked: window.__interruptClicked,
  }));
  assert.equal(stopObs.flushedLive, true, "'stop speaking' flushes active live audio playback");
  assert.equal(stopObs.providerInterruptCount, 1, "'stop speaking' sends exactly one interrupt control to provider (voicebox-beads-5fh0, voicebox-beads-iicm)");
  assert.equal(stopObs.offlineStopped, true, "'stop speaking' stops offline speech synthesis");
  assert.equal(stopObs.speechCancelled, true, "'stop speaking' cancels browser speech synthesis");
  assert.equal(stopObs.interruptClicked, true, "'stop speaking' triggers interrupt button");

  // Reset and test "quiet"
  await page.evaluate(() => {
    window.__flushedLivePlayback = false;
    window.__providerInterruptCount = 0;
    window.__offlineSpeechStopped = false;
    window.__speechCancelled = false;
    window.__interruptClicked = false;
  });
  await say("quiet");
  const quietObs = await page.evaluate(() => ({
    flushedLive: window.__flushedLivePlayback,
    providerInterruptCount: window.__providerInterruptCount,
    offlineStopped: window.__offlineSpeechStopped,
    speechCancelled: window.__speechCancelled,
    interruptClicked: window.__interruptClicked,
  }));
  assert.equal(quietObs.flushedLive, true, "'quiet' flushes active live audio playback");
  assert.equal(quietObs.providerInterruptCount, 1, "'quiet' sends exactly one interrupt control to provider");
  assert.equal(quietObs.interruptClicked, true, "'quiet' triggers interrupt");

  // Reset and test "be quiet"
  await page.evaluate(() => {
    window.__flushedLivePlayback = false;
    window.__providerInterruptCount = 0;
    window.__offlineSpeechStopped = false;
    window.__speechCancelled = false;
    window.__interruptClicked = false;
  });
  await say("be quiet");
  const beQuietObs = await page.evaluate(() => ({
    flushedLive: window.__flushedLivePlayback,
    providerInterruptCount: window.__providerInterruptCount,
    offlineStopped: window.__offlineSpeechStopped,
    speechCancelled: window.__speechCancelled,
    interruptClicked: window.__interruptClicked,
  }));
  assert.equal(beQuietObs.flushedLive, true, "'be quiet' flushes active live audio playback");
  assert.equal(beQuietObs.providerInterruptCount, 1, "'be quiet' sends exactly one interrupt control to provider");
  assert.equal(beQuietObs.interruptClicked, true, "'be quiet' triggers interrupt");

  // Mute: when mic is pressed, muting triggers mic click to turn off WITHOUT stopping playback (voicebox-beads-cafm)
  await page.evaluate(() => {
    const mic = document.getElementById("mic");
    window.__micClicks = 0;
    window.__playbackStoppedOnMute = 0;
    const client = window.__voiceboxLiveClient;
    client.stopReply = () => { window.__playbackStoppedOnMute++; };
    client.stopPlayback = () => { window.__playbackStoppedOnMute++; };
    client.interruptSpeech = () => { window.__playbackStoppedOnMute++; };
    mic.setAttribute("aria-pressed", "true");
    mic.addEventListener("click", (e) => {
      window.__micClicks++;
      const current = mic.getAttribute("aria-pressed") === "true";
      mic.setAttribute("aria-pressed", String(!current));
      e.stopImmediatePropagation();
    }, true);
  });
  await say("mute");
  const muteObs = await page.evaluate(() => ({
    clicks: window.__micClicks,
    pressed: document.getElementById("mic")?.getAttribute("aria-pressed"),
    playbackStopped: window.__playbackStoppedOnMute,
  }));
  assert.equal(muteObs.clicks, 1, "'mute' clicked the mic button to toggle off");
  assert.equal(muteObs.pressed, "false", "'mute' turned off active mic");
  assert.equal(muteObs.playbackStopped, 0, "'mute' does not stop assistant playback (voicebox-beads-cafm)");

  // Unmute: when mic is unpressed, unmuting triggers mic click to turn on WITHOUT stopping playback
  await page.evaluate(() => {
    window.__playbackStoppedOnMute = 0;
  });
  await say("unmute");
  const unmuteObs = await page.evaluate(() => ({
    clicks: window.__micClicks,
    pressed: document.getElementById("mic")?.getAttribute("aria-pressed"),
    playbackStopped: window.__playbackStoppedOnMute,
  }));
  assert.equal(unmuteObs.clicks, 2, "'unmute' clicked the mic button to toggle on");
  assert.equal(unmuteObs.pressed, "true", "'unmute' turned the microphone back on");
  assert.equal(unmuteObs.playbackStopped, 0, "'unmute' does not stop assistant playback (voicebox-beads-cafm)");
});
