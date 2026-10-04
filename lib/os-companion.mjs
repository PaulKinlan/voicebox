// lib/os-companion.mjs — Native OS Companion, Global Hotkey & System Tray Bridge (voicebox-beads-osba).
//
// Provides a lightweight host-side bridge for:
//   1. Global push-to-talk hotkey normalization & registration descriptors
//   2. Foreground OS context & clipboard capture (macOS / Linux / Windows)
//   3. System tray menu & icon state model
//   4. macOS LaunchAgent .plist generation for auto-start at login

import { execFileSync } from "node:child_process";

export const DEFAULT_GLOBAL_HOTKEY = "CommandOrControl+Shift+Space";

const MODIFIER_ALIASES = new Map([
  ["commandorcontrol", "CommandOrControl"],
  ["cmdorctrl", "CommandOrControl"],
  ["cmd", "Command"],
  ["command", "Command"],
  ["meta", "Super"],
  ["super", "Super"],
  ["ctrl", "Control"],
  ["control", "Control"],
  ["alt", "Alt"],
  ["opt", "Alt"],
  ["option", "Alt"],
  ["shift", "Shift"],
]);

const KEY_ALIASES = new Map([
  ["space", "Space"],
  ["spacebar", "Space"],
  ["esc", "Escape"],
  ["escape", "Escape"],
  ["enter", "Return"],
  ["return", "Return"],
  ["tab", "Tab"],
  ["up", "Up"],
  ["down", "Down"],
  ["left", "Left"],
  ["right", "Right"],
]);

function isValidKeyToken(token) {
  if (KEY_ALIASES.has(token.toLowerCase())) return true;
  if (/^[a-z0-9]$/i.test(token)) return true;
  if (/^f([1-9]|1[0-2])$/i.test(token)) return true;
  return false;
}

function canonicalizeKeyToken(token) {
  const lower = token.toLowerCase();
  if (KEY_ALIASES.has(lower)) return KEY_ALIASES.get(lower);
  if (/^f([1-9]|1[0-2])$/i.test(token)) return token.toUpperCase();
  return token.toUpperCase();
}

function formatDisplayLabel(modifiers, key, platform) {
  const isMac = platform === "darwin";
  if (isMac) {
    const symbols = modifiers.map((mod) => {
      if (mod === "CommandOrControl" || mod === "Command" || mod === "Super") return "⌘";
      if (mod === "Control") return "⌃";
      if (mod === "Alt") return "⌥";
      if (mod === "Shift") return "⇧";
      return mod;
    });
    return `${symbols.join("")}${key}`;
  }
  const labels = modifiers.map((mod) => {
    if (mod === "CommandOrControl" || mod === "Control") return "Ctrl";
    if (mod === "Command" || mod === "Super") return "Super";
    return mod;
  });
  return [...labels, key].join("+");
}

/**
 * Parse and validate a global hotkey accelerator string.
 */
export function normalizeHotkeySpec(raw = DEFAULT_GLOBAL_HOTKEY, { platform = process.platform } = {}) {
  const input = String(raw ?? "").trim();
  if (!input) {
    return {
      ok: false,
      refused: "invalid-hotkey",
      why: "Hotkey specification cannot be empty.",
    };
  }

  const parts = input.split("+").map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2) {
    return {
      ok: false,
      refused: "invalid-hotkey",
      why: "Global hotkey must include at least one modifier (e.g. CommandOrControl, Alt, Shift) and one key.",
    };
  }

  const modifiers = [];
  let key = null;

  for (const part of parts) {
    const lower = part.toLowerCase();
    if (MODIFIER_ALIASES.has(lower)) {
      const canonicalMod = MODIFIER_ALIASES.get(lower);
      if (!modifiers.includes(canonicalMod)) {
        modifiers.push(canonicalMod);
      }
      continue;
    }
    if (isValidKeyToken(part)) {
      if (key !== null) {
        return {
          ok: false,
          refused: "invalid-hotkey",
          why: `Global hotkey can only include one primary key token (found both '${key}' and '${part}').`,
        };
      }
      key = canonicalizeKeyToken(part);
      continue;
    }
    return {
      ok: false,
      refused: "invalid-hotkey",
      why: `Unrecognized hotkey token '${part}'.`,
    };
  }

  if (modifiers.length === 0) {
    return {
      ok: false,
      refused: "invalid-hotkey",
      why: "Global hotkey must include at least one modifier key.",
    };
  }
  if (!key) {
    return {
      ok: false,
      refused: "invalid-hotkey",
      why: "Global hotkey must include a primary key token (e.g. Space, M, V).",
    };
  }

  const accelerator = [...modifiers, key].join("+");
  const displayLabel = formatDisplayLabel(modifiers, key, platform);

  return {
    ok: true,
    accelerator,
    modifiers,
    key,
    displayLabel,
  };
}

function defaultExecRunner(cmd, args = []) {
  return execFileSync(cmd, args, {
    encoding: "utf8",
    timeout: 1200,
    stdio: ["ignore", "pipe", "ignore"],
  });
}

/**
 * Capture lightweight OS foreground context and clipboard text when triggered outside the browser.
 */
export function captureOsContext({
  platform = process.platform,
  execSyncImpl,
  maxClipChars = 2000,
} = {}) {
  const runner = typeof execSyncImpl === "function" ? execSyncImpl : defaultExecRunner;
  let activeApp = "";
  let windowTitle = "";
  let clipboardText = "";

  try {
    if (platform === "darwin") {
      const clipRaw = runner("pbpaste", []);
      if (typeof clipRaw === "string") {
        clipboardText = clipRaw.slice(0, maxClipChars);
      }
    } else if (platform === "linux") {
      const clipRaw = runner("xclip", ["-o", "-selection", "clipboard"]);
      if (typeof clipRaw === "string") {
        clipboardText = clipRaw.slice(0, maxClipChars);
      }
    }
  } catch {
    // Clipboard read is best-effort and never throws.
  }

  if (typeof execSyncImpl === "function") {
    try {
      const meta = execSyncImpl("__meta__", []);
      if (meta && typeof meta === "object") {
        if (typeof meta.activeApp === "string") activeApp = meta.activeApp;
        if (typeof meta.windowTitle === "string") windowTitle = meta.windowTitle;
        if (typeof meta.clipboardText === "string" && !clipboardText) {
          clipboardText = meta.clipboardText.slice(0, maxClipChars);
        }
      }
    } catch {
      // Ignore if custom runner only handles command strings.
    }
  }

  return {
    ok: true,
    platform,
    capturedAt: new Date().toISOString(),
    activeApp,
    windowTitle,
    clipboardText,
  };
}

/**
 * Build the native system tray icon state, tooltip, and menu items.
 */
export function buildTrayMenuModel({
  micActive = false,
  connected = true,
  hotkeyLabel = "⌘⇧Space",
  activeRoot = "",
} = {}) {
  const iconState = !connected ? "offline" : (micActive ? "listening" : "idle");
  const tooltip = micActive
    ? `Voicebox — Listening (${hotkeyLabel})`
    : `Voicebox — Ready (${hotkeyLabel})`;

  const items = [
    {
      id: "toggle-mic",
      label: micActive ? "Stop Listening" : "Start Listening (Push-to-Talk)",
      accelerator: hotkeyLabel,
      enabled: Boolean(connected),
    },
    {
      id: "send-clipboard",
      label: "Send Clipboard to Voicebox",
      enabled: Boolean(connected),
    },
    {
      id: "open-room",
      label: "Open Voicebox Room in Browser",
      enabled: true,
    },
    {
      id: "popout-mic",
      label: "Keep Floating Mic on Top",
      enabled: Boolean(connected),
    },
    {
      id: "quit",
      label: "Quit Voicebox Companion",
      enabled: true,
    },
  ];

  return {
    iconState,
    tooltip,
    activeRoot: String(activeRoot ?? ""),
    items,
  };
}

function escapeXml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Generate a macOS LaunchAgent .plist XML string for starting the companion at login.
 */
export function generateMacOsLaunchAgentPlist({
  label = "dev.voicebox.companion",
  scriptPath = "/usr/local/bin/voicebox-companion",
  hostUrl = "http://127.0.0.1:8787",
  hotkey = DEFAULT_GLOBAL_HOTKEY,
} = {}) {
  const safeLabel = escapeXml(label);
  const safeScript = escapeXml(scriptPath);
  const safeHost = escapeXml(hostUrl);
  const safeHotkey = escapeXml(hotkey);

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>Label</key>",
    `  <string>${safeLabel}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    `    <string>${safeScript}</string>`,
    "    <string>--hotkey</string>",
    `    <string>${safeHotkey}</string>`,
    "  </array>",
    "  <key>EnvironmentVariables</key>",
    "  <dict>",
    "    <key>VOICEBOX_HOST_URL</key>",
    `    <string>${safeHost}</string>`,
    "  </dict>",
    "  <key>RunAtLoad</key>",
    "  <true/>",
    "  <key>KeepAlive</key>",
    "  <false/>",
    "</dict>",
    "</plist>",
  ].join("\n");
}

/**
 * Create a stateful OS companion bridge controller.
 */
export function createCompanionBridge({
  hostUrl = "http://127.0.0.1:8787",
  hotkey = DEFAULT_GLOBAL_HOTKEY,
  platform = process.platform,
  fetchImpl = globalThis.fetch,
  execSyncImpl,
} = {}) {
  const normalized = normalizeHotkeySpec(hotkey, { platform });
  const hotkeySpec = normalized.ok
    ? normalized
    : normalizeHotkeySpec(DEFAULT_GLOBAL_HOTKEY, { platform });

  let micActive = false;
  let connected = true;
  let lastContext = null;
  const events = [];

  async function postToHost(pathName, payload) {
    if (typeof fetchImpl !== "function") return { ok: false, offline: true };
    const url = `${String(hostUrl).replace(/\/+$/, "")}${pathName}`;
    try {
      const res = await fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      connected = Boolean(res?.ok);
      let data = {};
      try {
        data = (await res.json()) ?? {};
      } catch {
        data = {};
      }
      return { ok: Boolean(res?.ok), status: res?.status ?? 200, data };
    } catch (err) {
      connected = false;
      return { ok: false, offline: true, error: err?.message ?? String(err) };
    }
  }

  async function togglePushToTalk() {
    micActive = !micActive;
    const context = captureOsContext({ platform, execSyncImpl });
    lastContext = context;
    const command = micActive ? "unmute" : "mute";
    const remote = await postToHost("/api/turn", {
      utterance: micActive ? "start listening" : "stop listening",
      verb: "system",
      command,
      osContext: context,
    });
    const tray = buildTrayMenuModel({
      micActive,
      connected,
      hotkeyLabel: hotkeySpec.displayLabel,
    });
    const entry = {
      type: "toggle-mic",
      micActive,
      command,
      at: context.capturedAt,
      remoteOk: remote.ok,
    };
    events.push(entry);
    return {
      ok: true,
      micActive,
      command,
      tray,
      context,
      remote,
    };
  }

  async function sendClipboardTurn({ prefix = "Use this clipboard snippet:" } = {}) {
    const context = captureOsContext({ platform, execSyncImpl });
    lastContext = context;
    const text = String(context.clipboardText ?? "").trim();
    if (!text) {
      return {
        ok: false,
        refused: "clipboard-empty",
        why: "OS clipboard is empty.",
        context,
      };
    }
    const utterance = `${prefix} ${text}`.trim();
    const remote = await postToHost("/api/turn", {
      utterance,
      osContext: context,
    });
    events.push({
      type: "send-clipboard",
      chars: text.length,
      at: context.capturedAt,
      remoteOk: remote.ok,
    });
    return {
      ok: remote.ok,
      utterance,
      clipboardText: text,
      context,
      remote,
    };
  }

  function getStatus() {
    return {
      ok: true,
      hostUrl,
      platform,
      micActive,
      connected,
      hotkey: hotkeySpec,
      lastContext,
      events: [...events],
      tray: buildTrayMenuModel({
        micActive,
        connected,
        hotkeyLabel: hotkeySpec.displayLabel,
      }),
    };
  }

  return {
    togglePushToTalk,
    sendClipboardTurn,
    getStatus,
  };
}
