// tests/system-command-bus.test.mjs — declarative system command bus tests (voicebox-beads-1c9d)
// Unit tests for public/components/system-command-bus.mjs:
// - registration, unregistration, duplicate prevention, discovery
// - safe dispatch, argument validation, error containment
// - core command handlers with DOM/clipboard stubs

import test from "node:test";
import assert from "node:assert/strict";
import {
  createSystemCommandBus,
  registerCoreSystemCommands,
  createClipboardCopyHandler,
  createClipboardPasteHandler,
  createSwitchThemeHandler,
  createOpenPanelHandler,
  createStopSpeakingHandler,
} from "../public/components/system-command-bus.mjs";

test("system-command-bus: registration, listing, and duplicate prevention", () => {
  const bus = createSystemCommandBus();

  // Valid registration
  const unregister = bus.registerSystemCommand("test_cmd", async () => ({ ok: true, done: 1 }), {
    description: "A test command",
    category: "test",
  });
  assert.equal(bus.hasSystemCommand("test_cmd"), true, "command exists");
  assert.equal(bus.hasSystemCommand("TEST_CMD"), true, "command lookup is case-insensitive");

  const list = bus.listRegisteredSystemCommands();
  assert.equal(list.length, 1);
  assert.deepEqual(list[0], {
    name: "test_cmd",
    metadata: { description: "A test command", category: "test" },
  });

  // Duplicate registration refusal
  assert.throws(
    () => bus.registerSystemCommand("test_cmd", () => {}),
    /Duplicate registration for system command "test_cmd"/,
    "refuses duplicate registration",
  );
  assert.throws(
    () => bus.registerSystemCommand("TEST_CMD", () => {}),
    /Duplicate registration for system command "test_cmd"/,
    "refuses duplicate registration case-insensitively",
  );

  // Unregister via disposer
  unregister();
  assert.equal(bus.hasSystemCommand("test_cmd"), false, "disposer unregisters command");
  assert.equal(bus.listRegisteredSystemCommands().length, 0);

  // Invalid registrations
  assert.throws(() => bus.registerSystemCommand("", () => {}), TypeError);
  assert.throws(() => bus.registerSystemCommand(null, () => {}), TypeError);
  assert.throws(() => bus.registerSystemCommand("valid", null), TypeError);
  assert.throws(() => bus.registerSystemCommand("valid", "not_a_func"), TypeError);
});

test("system-command-bus: executeSystemCommand returns structured status", async () => {
  const bus = createSystemCommandBus();

  bus.registerSystemCommand("greet", async (cmd, ctx) => ({
    ok: true,
    message: `Hello, ${cmd.name || "world"}!`,
    ctxUser: ctx.user,
  }));

  bus.registerSystemCommand("boom", async () => {
    throw new Error("handler explosion");
  });

  bus.registerSystemCommand("primitive", async () => "raw_value");

  // Happy path
  const res1 = await bus.executeSystemCommand({ command: "greet", name: "Alice" }, { user: "bob" });
  assert.deepEqual(res1, { ok: true, message: "Hello, Alice!", ctxUser: "bob" });

  // Case insensitive execution
  const resCase = await bus.executeSystemCommand({ command: "GREET", name: "Carol" });
  assert.equal(resCase.ok, true);
  assert.equal(resCase.message, "Hello, Carol!");

  // Primitive return wrapped
  const resPrim = await bus.executeSystemCommand({ command: "primitive" });
  assert.deepEqual(resPrim, { ok: true, result: "raw_value" });

  // Unknown command
  const resUnknown = await bus.executeSystemCommand({ command: "non_existent" });
  assert.equal(resUnknown.ok, false);
  assert.match(resUnknown.error, /Unknown system command: "non_existent"/);

  // Invalid command objects
  assert.equal((await bus.executeSystemCommand(null)).ok, false);
  assert.equal((await bus.executeSystemCommand("not-an-obj")).ok, false);
  assert.equal((await bus.executeSystemCommand({})).ok, false);
  assert.equal((await bus.executeSystemCommand({ command: "" })).ok, false);

  // Handler exception caught and reported
  const resBoom = await bus.executeSystemCommand({ command: "boom" });
  assert.equal(resBoom.ok, false);
  assert.match(resBoom.error, /handler explosion/);
});

test("system-command-bus: clipboard handlers (copy and paste)", async () => {
  let clipboardText = "";
  const mockNavigator = {
    clipboard: {
      writeText: async (t) => { clipboardText = t; },
      readText: async () => clipboardText,
    },
  };
  const utteranceInput = { value: "", focus: () => {} };
  const mockEls = {
    utterance: utteranceInput,
    readerBody: { textContent: "reader content" },
    send: { disabled: true },
  };

  const copyHandler = createClipboardCopyHandler({ els: mockEls, navigator: mockNavigator });
  const pasteHandler = createClipboardPasteHandler({ els: mockEls, navigator: mockNavigator });

  // Copy explicit text
  const copyRes1 = await copyHandler({ command: "copy", text: "custom string" });
  assert.equal(copyRes1.ok, true);
  assert.equal(copyRes1.copied, "custom string");
  assert.equal(clipboardText, "custom string");

  // Paste into utterance
  const pasteRes1 = await pasteHandler({ command: "paste" });
  assert.equal(pasteRes1.ok, true);
  assert.equal(pasteRes1.pasted, "custom string");
  assert.equal(utteranceInput.value, "custom string");
  assert.equal(mockEls.send.disabled, false);

  // Copy fallback from reader body
  const copyRes2 = await copyHandler({ command: "copy" });
  assert.equal(copyRes2.ok, true);
  assert.equal(copyRes2.copied, "reader content");
  assert.equal(clipboardText, "reader content");
});

test("system-command-bus: switch_theme handler", async () => {
  let appliedMode = null;
  let appliedOptions = null;
  const mockApplyTheme = (mode, opts) => {
    appliedMode = mode;
    appliedOptions = opts;
  };

  const themeHandler = createSwitchThemeHandler({ applyTheme: mockApplyTheme });

  const res = await themeHandler({ command: "switch_theme", mode: "dark" });
  assert.equal(res.ok, true);
  assert.equal(res.theme, "dark");
  assert.equal(appliedMode, "dark");
  assert.equal(appliedOptions?.persist, true);

  const resMissing = await themeHandler({ command: "switch_theme" });
  assert.equal(resMissing.ok, false);
});

test("system-command-bus: open_panel handler", async () => {
  let branchInspectorOpened = false;
  let agentTrackerOpened = false;
  let sqehState = null;
  const dialogs = [{ open: true, close: () => { dialogs[0].open = false; } }];

  const mockEls = {
    settingsOpen: { click: () => { sqehState = "settings-modal"; } },
    harnessesOpen: { click: () => { sqehState = "harnesses-modal"; } },
  };
  const mockDoc = {
    querySelectorAll: (selector) => (selector === "dialog[open]" ? dialogs.filter((d) => d.open) : []),
  };

  const panelHandler = createOpenPanelHandler({
    els: mockEls,
    openBranchLandingInspector: () => { branchInspectorOpened = true; },
    openAgentProgressTracker: () => { agentTrackerOpened = true; },
    sqehSetState: (s) => { sqehState = s; },
    document: mockDoc,
  });

  // Settings
  const resSettings = await panelHandler({ command: "open_panel", target: "settings" });
  assert.equal(resSettings.ok, true);
  assert.equal(resSettings.panel, "settings");
  assert.equal(sqehState, "settings-modal");

  // Branches
  const resBranches = await panelHandler({ command: "open_panel", target: "waiting-branches" });
  assert.equal(resBranches.ok, true);
  assert.equal(branchInspectorOpened, true);

  // Agent tracker
  const resTracker = await panelHandler({ command: "open_panel", target: "agent-tracker" });
  assert.equal(resTracker.ok, true);
  assert.equal(agentTrackerOpened, true);

  // SQEH state navigation
  const resFiles = await panelHandler({ command: "open_panel", target: "files" });
  assert.equal(resFiles.ok, true);
  assert.equal(sqehState, "files");

  // Close panel
  const resClose = await panelHandler({ command: "open_panel", target: "close" });
  assert.equal(resClose.ok, true);
  assert.equal(sqehState, "deck");
  assert.equal(dialogs[0].open, false, "closed open dialog");
});

test("system-command-bus: stop_speaking handler", async () => {
  let micClicks = 0;
  let micPressed = false;
  let speechCancelled = false;
  let interruptClicks = 0;
  let providerInterrupted = false;

  const mockEls = {
    mic: {
      getAttribute: () => String(micPressed),
      click: () => {
        micClicks++;
        micPressed = !micPressed;
      },
    },
    interrupt: {
      disabled: false,
      click: () => { interruptClicks++; },
    },
  };

  const mockWin = {
    speechSynthesis: {
      cancel: () => { speechCancelled = true; },
    },
    __voiceboxLiveClient: {
      interruptSpeech: (src) => { if (src === "page") providerInterrupted = true; },
    },
  };

  const stopHandler = createStopSpeakingHandler({ els: mockEls, window: mockWin });

  // Interrupt
  const resInterrupt = await stopHandler({ command: "stop_speaking" });
  assert.equal(resInterrupt.ok, true);
  assert.equal(resInterrupt.action, "interrupt");
  assert.equal(speechCancelled, true);
  assert.equal(interruptClicks, 1);

  // Mute when unpressed: no click
  micPressed = false;
  const resMute1 = await stopHandler({ command: "stop_speaking", mode: "mute" });
  assert.equal(resMute1.ok, true);
  assert.equal(micClicks, 0, "already unmuted, no click needed");

  // Mute when pressed: click to toggle off
  micPressed = true;
  const resMute2 = await stopHandler({ command: "stop_speaking", mode: "mute" });
  assert.equal(resMute2.ok, true);
  assert.equal(micClicks, 1, "clicked mic to mute");

  // Unmute when pressed: no click
  micPressed = true;
  const resUnmute1 = await stopHandler({ command: "stop_speaking", mode: "unmute" });
  assert.equal(resUnmute1.ok, true);

  // Unmute when unpressed: click to toggle on
  micPressed = false;
  const resUnmute2 = await stopHandler({ command: "stop_speaking", mode: "unmute" });
  assert.equal(resUnmute2.ok, true);
  assert.equal(micClicks, 2, "clicked mic to unmute");
});

test("system-command-bus: registerCoreSystemCommands registers all core commands", async () => {
  const bus = createSystemCommandBus();
  registerCoreSystemCommands(bus);

  const registered = bus.listRegisteredSystemCommands().map((c) => c.name);
  assert.ok(registered.includes("copy"));
  assert.ok(registered.includes("paste"));
  assert.ok(registered.includes("switch_theme"));
  assert.ok(registered.includes("open_panel"));
  assert.ok(registered.includes("stop_speaking"));
  assert.ok(registered.includes("show_waiting_branches"));
  assert.ok(registered.includes("land_branch"));
  assert.ok(registered.includes("keep_branch_separate"));
  assert.ok(registered.includes("compare_harnesses"));
  assert.equal(registered.length, 9);
});
