// tests/os-companion.test.mjs — Unit tests for Native OS Companion / Global Hotkey & System Tray Bridge (voicebox-beads-osba).

import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_GLOBAL_HOTKEY,
  buildTrayMenuModel,
  captureOsContext,
  createCompanionBridge,
  generateMacOsLaunchAgentPlist,
  normalizeHotkeySpec,
} from "../lib/os-companion.mjs";

test("normalizeHotkeySpec parses valid macOS and Linux/Windows accelerators and refuses invalid specs", () => {
  const macDefault = normalizeHotkeySpec(DEFAULT_GLOBAL_HOTKEY, { platform: "darwin" });
  assert.equal(macDefault.ok, true);
  assert.equal(macDefault.accelerator, "CommandOrControl+Shift+Space");
  assert.deepEqual(macDefault.modifiers, ["CommandOrControl", "Shift"]);
  assert.equal(macDefault.key, "Space");
  assert.equal(macDefault.displayLabel, "⌘⇧Space");

  const linuxDefault = normalizeHotkeySpec("CmdOrCtrl+Shift+Space", { platform: "linux" });
  assert.equal(linuxDefault.ok, true);
  assert.equal(linuxDefault.displayLabel, "Ctrl+Shift+Space");

  const optionM = normalizeHotkeySpec("Option+m", { platform: "darwin" });
  assert.equal(optionM.ok, true);
  assert.equal(optionM.accelerator, "Alt+M");
  assert.equal(optionM.displayLabel, "⌥M");

  const empty = normalizeHotkeySpec("", { platform: "darwin" });
  assert.equal(empty.ok, false);
  assert.equal(empty.refused, "invalid-hotkey");

  const noModifier = normalizeHotkeySpec("Space", { platform: "darwin" });
  assert.equal(noModifier.ok, false);
  assert.equal(noModifier.refused, "invalid-hotkey");

  const onlyModifier = normalizeHotkeySpec("Command+Shift", { platform: "darwin" });
  assert.equal(onlyModifier.ok, false);
  assert.equal(onlyModifier.refused, "invalid-hotkey");
});

test("captureOsContext and buildTrayMenuModel cover idle, listening, and offline states", () => {
  const ctx = captureOsContext({
    platform: "darwin",
    maxClipChars: 12,
    execSyncImpl: (cmd) => {
      if (cmd === "pbpaste") return "0123456789abcdef";
      if (cmd === "__meta__") return { activeApp: "Terminal", windowTitle: "zsh" };
      return "";
    },
  });
  assert.equal(ctx.ok, true);
  assert.equal(ctx.platform, "darwin");
  assert.equal(ctx.clipboardText, "0123456789ab");
  assert.equal(ctx.activeApp, "Terminal");
  assert.equal(ctx.windowTitle, "zsh");

  const idleTray = buildTrayMenuModel({ micActive: false, connected: true, hotkeyLabel: "⌘⇧Space" });
  assert.equal(idleTray.iconState, "idle");
  assert.equal(idleTray.tooltip, "Voicebox — Ready (⌘⇧Space)");
  assert.equal(idleTray.items[0].id, "toggle-mic");
  assert.equal(idleTray.items[0].label, "Start Listening (Push-to-Talk)");
  assert.equal(idleTray.items[0].enabled, true);

  const listeningTray = buildTrayMenuModel({ micActive: true, connected: true, hotkeyLabel: "⌘⇧Space" });
  assert.equal(listeningTray.iconState, "listening");
  assert.equal(listeningTray.tooltip, "Voicebox — Listening (⌘⇧Space)");
  assert.equal(listeningTray.items[0].label, "Stop Listening");

  const offlineTray = buildTrayMenuModel({ micActive: false, connected: false, hotkeyLabel: "⌘⇧Space" });
  assert.equal(offlineTray.iconState, "offline");
  assert.equal(offlineTray.items[0].enabled, false);
  assert.equal(offlineTray.items.find((i) => i.id === "open-room")?.enabled, true);
  assert.equal(offlineTray.items.find((i) => i.id === "quit")?.enabled, true);
});

test("createCompanionBridge toggles push-to-talk and forwards clipboard turns to the host", async () => {
  const posted = [];
  const bridge = createCompanionBridge({
    hostUrl: "http://127.0.0.1:8787",
    hotkey: "CommandOrControl+Shift+Space",
    platform: "darwin",
    execSyncImpl: (cmd) => (cmd === "pbpaste" ? "selected error trace" : ""),
    fetchImpl: async (url, init) => {
      posted.push({ url, body: JSON.parse(init.body) });
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true }),
      };
    },
  });

  const initial = bridge.getStatus();
  assert.equal(initial.micActive, false);
  assert.equal(initial.tray.iconState, "idle");

  const firstToggle = await bridge.togglePushToTalk();
  assert.equal(firstToggle.ok, true);
  assert.equal(firstToggle.micActive, true);
  assert.equal(firstToggle.command, "unmute");
  assert.equal(firstToggle.tray.iconState, "listening");
  assert.equal(posted.length, 1);
  assert.equal(posted[0].url, "http://127.0.0.1:8787/api/turn");
  assert.equal(posted[0].body.command, "unmute");

  const clipTurn = await bridge.sendClipboardTurn();
  assert.equal(clipTurn.ok, true);
  assert.match(clipTurn.utterance, /selected error trace/);
  assert.equal(posted.length, 2);

  const secondToggle = await bridge.togglePushToTalk();
  assert.equal(secondToggle.micActive, false);
  assert.equal(secondToggle.command, "mute");
  assert.equal(secondToggle.tray.iconState, "idle");
});

test("generateMacOsLaunchAgentPlist produces valid LaunchAgent XML with label and hostUrl", () => {
  const plist = generateMacOsLaunchAgentPlist({
    label: "dev.voicebox.companion",
    scriptPath: "/usr/local/bin/voicebox-companion",
    hostUrl: "http://127.0.0.1:8787",
    hotkey: "CommandOrControl+Shift+Space",
  });
  assert.match(plist, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
  assert.match(plist, /<string>dev\.voicebox\.companion<\/string>/);
  assert.match(plist, /<string>http:\/\/127\.0\.0\.1:8787<\/string>/);
  assert.match(plist, /<string>CommandOrControl\+Shift\+Space<\/string>/);
});
