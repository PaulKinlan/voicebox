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
  await page.evaluate(() => document.getElementById("settings")?.close());

  await say("open files");
  assert.equal((await read()).sqehState, "files", "'open files' moves the deck to the files panel");

  await say("open history");
  assert.equal((await read()).sqehState, "history", "'open history' moves the deck to the history panel");

  await say("open activity log");
  assert.equal((await read()).sqehState, "activity", "'open activity log' moves the deck to the activity panel");

  // ── The target that had NO branch at all: the built-in tracker mini-app ──────────────────────
  assert.equal((await read()).trackerTitle, null, "the tracker is not mounted before it is asked for");
  await say("open agent tracker");
  const tracker = await read();
  assert.equal(
    tracker.trackerTitle,
    "Agent Progress Tracker",
    "'open agent tracker' mounts the Agent Progress Tracker mini-app — it had no handler before ucak",
  );

  // ── And `close`, which also had no branch ───────────────────────────────────────────────────
  await say("close panel");
  assert.equal((await read()).sqehState, "deck", "'close panel' returns to the deck");
});
