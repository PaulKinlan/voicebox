// public/components/system-command-bus.mjs — declarative system command bus (voicebox-beads-1c9d)
// Decouples feature system command handlers from public/fused.js into a modular bus.
//
// Features:
// - Declarative registration: registerSystemCommand(name, handler, metadata)
// - Duplicate prevention: refuses duplicate registrations with an explicit Error
// - Safe execution: executeSystemCommand(cmd, context) returns structured { ok, ... }
// - Discovery: listRegisteredSystemCommands() returns registered command metadata

/**
 * Creates an isolated system command bus instance.
 */
export function createSystemCommandBus() {
  const registry = new Map();

  /**
   * Registers a system command handler.
   * @param {string} name - Case-insensitive command identifier (e.g. "copy", "open_panel")
   * @param {Function} handler - Async function (cmd, context) => { ok, ... }
   * @param {Object} [metadata={}] - Optional metadata (description, category, phrases)
   * @returns {Function} Unregister disposer function
   */
  function registerSystemCommand(name, handler, metadata = {}) {
    if (!name || typeof name !== "string") {
      throw new TypeError("System command name must be a non-empty string");
    }
    const normalized = name.trim().toLowerCase();
    if (!normalized) {
      throw new TypeError("System command name must be a non-empty string");
    }
    if (typeof handler !== "function") {
      throw new TypeError(`Handler for system command "${name}" must be a function`);
    }
    if (registry.has(normalized)) {
      throw new Error(`Duplicate registration for system command "${normalized}": command is already registered`);
    }
    registry.set(normalized, {
      name: normalized,
      handler,
      metadata: { ...metadata },
    });
    return () => unregisterSystemCommand(normalized);
  }

  /**
   * Unregisters a command by name.
   * @param {string} name
   * @returns {boolean} True if removed, false if not found
   */
  function unregisterSystemCommand(name) {
    if (!name || typeof name !== "string") return false;
    return registry.delete(name.trim().toLowerCase());
  }

  /**
   * Checks whether a command is registered.
   * @param {string} name
   * @returns {boolean}
   */
  function hasSystemCommand(name) {
    if (!name || typeof name !== "string") return false;
    return registry.has(name.trim().toLowerCase());
  }

  /**
   * Lists all registered system commands and their metadata.
   * @returns {Array<{ name: string, metadata: Object }>}
   */
  function listRegisteredSystemCommands() {
    return Array.from(registry.values()).map((entry) => ({
      name: entry.name,
      metadata: { ...entry.metadata },
    }));
  }

  /**
   * Executes a system command.
   * @param {Object} cmd - Command object with at least { command: string }
   * @param {Object} [context={}] - Optional ambient context (els, window, document, etc.)
   * @returns {Promise<{ ok: boolean, [key: string]: any }>}
   */
  async function executeSystemCommand(cmd, context = {}) {
    if (!cmd || typeof cmd !== "object") {
      return { ok: false, error: "Invalid command object" };
    }
    const name = typeof cmd.command === "string" ? cmd.command.trim().toLowerCase() : "";
    if (!name) {
      return { ok: false, error: "Missing or invalid command name" };
    }
    const entry = registry.get(name);
    if (!entry) {
      return { ok: false, error: `Unknown system command: "${name}"` };
    }
    try {
      const res = await entry.handler(cmd, context);
      if (res && typeof res === "object") {
        return res;
      }
      return { ok: true, result: res };
    } catch (err) {
      return {
        ok: false,
        error: err?.message || String(err),
      };
    }
  }

  /**
   * Clears all registered commands (primarily for tests).
   */
  function clearSystemCommands() {
    registry.clear();
  }

  return {
    registerSystemCommand,
    unregisterSystemCommand,
    hasSystemCommand,
    listRegisteredSystemCommands,
    executeSystemCommand,
    clearSystemCommands,
  };
}

// ── Default Bus Singleton ──────────────────────────────────────────────────
const defaultBus = createSystemCommandBus();

export const registerSystemCommand = (name, handler, metadata) =>
  defaultBus.registerSystemCommand(name, handler, metadata);
export const unregisterSystemCommand = (name) => defaultBus.unregisterSystemCommand(name);
export const hasSystemCommand = (name) => defaultBus.hasSystemCommand(name);
export const listRegisteredSystemCommands = () => defaultBus.listRegisteredSystemCommands();
export const executeSystemCommand = (cmd, context) => defaultBus.executeSystemCommand(cmd, context);
export const clearSystemCommands = () => defaultBus.clearSystemCommands();
export { defaultBus };

// ── Core Command Handlers ──────────────────────────────────────────────────

export function createClipboardCopyHandler({ els = {}, window = globalThis.window, navigator = globalThis.navigator } = {}) {
  return async (cmd, context = {}) => {
    const currentEls = context.els || els;
    const currentWin = context.window || window;
    const currentNav = context.navigator || navigator;
    const sel = currentWin?.getSelection?.()?.toString?.() ?? "";
    const textToCopy = cmd.text || sel || currentEls.readerBody?.textContent || currentEls.log?.firstElementChild?.textContent || "";
    if (textToCopy && currentNav?.clipboard?.writeText) {
      try {
        await currentNav.clipboard.writeText(textToCopy);
        return { ok: true, copied: textToCopy };
      } catch {
        return { ok: false, error: "Clipboard permission denied" };
      }
    }
    return { ok: false, error: "Nothing to copy" };
  };
}

export function createClipboardPasteHandler({ els = {}, navigator = globalThis.navigator } = {}) {
  return async (_cmd, context = {}) => {
    const currentEls = context.els || els;
    const currentNav = context.navigator || navigator;
    if (currentNav?.clipboard?.readText) {
      try {
        const text = await currentNav.clipboard.readText();
        if (currentEls.utterance) {
          if (currentEls.form?.hidden) currentEls.form.hidden = false;
          currentEls.utterance.value = (currentEls.utterance.value ? `${currentEls.utterance.value} ` : "") + text;
          if (currentEls.send) currentEls.send.disabled = !currentEls.utterance.value.trim();
          currentEls.utterance.focus();
        }
        return { ok: true, pasted: text };
      } catch {
        return { ok: false, error: "Clipboard read permission denied" };
      }
    }
    return { ok: false, error: "Clipboard unavailable" };
  };
}

export function createSwitchThemeHandler({ applyTheme = globalThis.applyTheme } = {}) {
  return async (cmd, context = {}) => {
    const fn = context.applyTheme || applyTheme;
    if (cmd.mode) {
      if (typeof fn === "function") {
        fn(cmd.mode, { persist: true });
        return { ok: true, theme: cmd.mode };
      }
      return { ok: false, error: "Theme applicator unavailable" };
    }
    return { ok: false, error: "Missing theme mode" };
  };
}

export function createOpenPanelHandler({
  els = {},
  openBranchLandingInspector = () => {},
  openAgentProgressTracker = () => {},
  sqehSetState = () => {},
  document = globalThis.document,
} = {}) {
  return async (cmd, context = {}) => {
    const currentEls = context.els || els;
    const openBranches = context.openBranchLandingInspector || openBranchLandingInspector;
    const openTracker = context.openAgentProgressTracker || openAgentProgressTracker;
    const setState = context.sqehSetState || sqehSetState;
    const doc = context.document || document;

    if (!cmd.target) return { ok: false, error: "Missing panel target" };
    const p = String(cmd.target).toLowerCase();
    if (p === "settings") currentEls.settingsOpen?.click();
    else if (p === "harnesses") currentEls.harnessesOpen?.click?.();
    else if (p === "extensions") currentEls.extsOpen?.click?.();
    else if (p === "environments") currentEls.envsOpen?.click?.();
    else if (p === "changelog") currentEls.changelogOpen?.click?.();
    else if (p === "branches" || p === "waiting-branches") {
      void openBranches();
    } else if (p === "agent-tracker") {
      void openTracker();
    } else if (p === "close") {
      if (doc?.querySelectorAll) {
        for (const dialog of doc.querySelectorAll("dialog[open]")) dialog.close();
      }
      setState("deck");
    } else if (p === "files" || p === "history" || p === "activity" || p === "deck") {
      setState(p);
    }
    return { ok: true, panel: p };
  };
}

export function createStopSpeakingHandler({ els = {}, window = globalThis.window, document = globalThis.document } = {}) {
  return async (cmd, context = {}) => {
    const currentEls = context.els || els;
    const win = context.window || window;
    const doc = context.document || document;

    const mode = cmd.mode || (/unmute/i.test(cmd.text || "") ? "unmute" : /mute/i.test(cmd.text || "") ? "mute" : "interrupt");
    const micPressed = currentEls.mic?.getAttribute("aria-pressed") === "true";
    if (mode === "unmute") {
      if (!micPressed) {
        currentEls.mic?.click();
      }
      return { ok: true, action: "unmute", message: "Microphone unmuted." };
    }
    if (mode === "mute") {
      if (micPressed) {
        currentEls.mic?.click();
      }
      return { ok: true, action: "mute", message: "Microphone muted." };
    }
    try {
      win?.speechSynthesis?.cancel?.();
    } catch {}
    const interruptBtn = currentEls.interrupt || doc?.getElementById?.("interrupt");
    if (interruptBtn) {
      const wasDisabled = interruptBtn.disabled;
      interruptBtn.disabled = false;
      interruptBtn.click();
      interruptBtn.disabled = wasDisabled;
    } else {
      try {
        win?.__voiceboxOfflineSpeech?.stopSpeaking?.();
      } catch {}
      try {
        const client = win?.__voiceboxLiveClient;
        if (typeof client?.interruptSpeech === "function") {
          client.interruptSpeech("page");
        } else {
          client?.stopReply?.();
          client?.stopPlayback?.();
        }
      } catch {}
    }
    return { ok: true, action: "interrupt", message: "Stopped speaking." };
  };
}

/**
 * Helper to register all standard core Voicebox system commands on a bus.
 */
export function registerCoreSystemCommands(bus = defaultBus, options = {}) {
  bus.registerSystemCommand("copy", createClipboardCopyHandler(options), {
    category: "clipboard",
    description: "Copies current selection, reply, or specified text to clipboard",
  });

  bus.registerSystemCommand("paste", createClipboardPasteHandler(options), {
    category: "clipboard",
    description: "Pastes text from clipboard into composer or target",
  });

  bus.registerSystemCommand("switch_theme", createSwitchThemeHandler(options), {
    category: "appearance",
    description: "Switches color theme between dark, light, and system",
  });

  bus.registerSystemCommand("open_panel", createOpenPanelHandler(options), {
    category: "navigation",
    description: "Switches between panels, drawers, or modal sheets",
  });

  bus.registerSystemCommand("stop_speaking", createStopSpeakingHandler(options), {
    category: "audio_session",
    description: "Interrupts speech synthesis or toggles microphone mute",
  });

  bus.registerSystemCommand("show_waiting_branches", async (_cmd, context = {}) => {
    const fn = context.openBranchLandingInspector || options.openBranchLandingInspector || (() => {});
    void fn();
    return { ok: true, action: "show_waiting_branches" };
  }, {
    category: "branch_landing",
    description: "Opens candidate branch landing inspector",
  });

  bus.registerSystemCommand("land_branch", async () => ({ ok: true, action: "land_branch" }), {
    category: "branch_landing",
    description: "Lands selected candidate branch",
  });

  bus.registerSystemCommand("keep_branch_separate", async () => ({ ok: true, action: "keep_branch_separate" }), {
    category: "branch_landing",
    description: "Marks candidate branch to stay separate",
  });

  bus.registerSystemCommand("compare_harnesses", async (_cmd, context = {}) => {
    const fn = context.openAgentProgressTracker || options.openAgentProgressTracker || (() => {});
    void fn();
    return { ok: true, action: "compare_harnesses" };
  }, {
    category: "harness_comparison",
    description: "Opens multi-harness tracker or comparison view",
  });

  return bus;
}
