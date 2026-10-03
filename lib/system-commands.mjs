// System-level voice commands for Voicebox (voicebox-beads-2vza, voicebox-beads-von8).
// Bridges natural spoken utterances to immediate browser/room actions:
//   1. clipboard      — copy (selection, open file, last reply, or literal text) & paste (into active input or file)
//   2. navigation     — hands-free popover/drawer switching (files, history, settings, harnesses, activity, agent-tracker)
//   3. appearance     — color theme switching (dark, light, system)
//   4. audio_session  — interrupt TTS / mute / unmute & clear activity log

export const SYSTEM_COMMAND_CATALOGUE = [
  {
    category: "clipboard",
    command: "copy",
    phrases: [
      "copy",
      "copy that",
      "copy to clipboard",
      "copy <text> to clipboard",
      "copy the file",
      "copy last reply",
    ],
    description:
      "Copies the current text selection, open file content, last assistant reply, or specified literal text to the browser/system clipboard.",
  },
  {
    category: "clipboard",
    command: "paste",
    phrases: [
      "paste",
      "paste that",
      "paste from clipboard",
      "paste into <file>",
      "paste from clipboard into <file>",
    ],
    description:
      "Reads text from the browser/system clipboard and inserts it into the active input/editor or writes/appends it to the named workspace file.",
  },
  {
    category: "navigation",
    command: "open_panel",
    phrases: [
      "open files",
      "open history",
      "open settings",
      "open harnesses",
      "open activity log",
      "open agent tracker",
      "close panel",
    ],
    description:
      "Switches room popovers, drawers, and tracking panels hands-free without touching the mouse or keyboard.",
  },
  {
    category: "appearance",
    command: "switch_theme",
    phrases: [
      "dark mode",
      "light mode",
      "system theme",
      "switch to dark mode",
      "switch to light mode",
    ],
    description: "Changes the room color theme between dark, light, and system preference.",
  },
  {
    category: "audio_session",
    command: "stop_speaking",
    phrases: ["stop speaking", "quiet", "mute", "unmute"],
    description: "Interrupts active TTS playback or toggles microphone mute.",
  },
  {
    category: "audio_session",
    command: "clear_activity",
    phrases: ["clear activity log", "clear work log"],
    description: "Clears the in-memory work activity log and refreshes the activity drawer.",
  },
];

/**
 * Parse a natural voice/text utterance into a structured system command action:
 *   { verb: "system", command, target?, text?, file?, mode? }
 * Returns null when the utterance is not a system command so file/git/tool resolvers handle it.
 */
export function parseSystemCommand(rawText) {
  if (typeof rawText !== "string") return null;
  const trimmed = rawText.trim().replace(/[.!?]+$/, "").trim();
  if (!trimmed) return null;

  // ── 1. Clipboard: copy ────────────────────────────────────────────────────
  // Literal copy: "copy <text> to clipboard" / "copy <text> to the clipboard"
  const copyLiteralMatch = trimmed.match(/^copy\s+(.+?)\s+to\s+(?:the\s+)?clipboard$/i);
  if (copyLiteralMatch) {
    const candidate = copyLiteralMatch[1].trim().replace(/^["']|["']$/g, "");
    if (
      candidate &&
      !/^(?:that|this|it|selection|the\s+selection|the\s+file|file|file\s+content|file\s+contents|last\s+reply|last\s+response|last\s+turn|reply|response)$/i.test(
        candidate,
      )
    ) {
      return {
        verb: "system",
        command: "copy",
        target: "literal",
        text: candidate,
      };
    }
  }

  if (
    /^(?:(?:please|can\s+you|could\s+you)\s+)?copy(?:\s+(?:that|this|it|selection|the\s+selection|to\s+(?:the\s+)?clipboard|the\s+file|file|file\s+contents?|last\s+(?:reply|response|turn)|(?:the\s+)?(?:reply|response)))?(?:\s+to\s+(?:the\s+)?clipboard)?$/i.test(
      trimmed,
    )
  ) {
    const target = /\bfile\b/i.test(trimmed)
      ? "file"
      : /\b(?:reply|response|turn)\b/i.test(trimmed)
        ? "reply"
        : "selection";
    return {
      verb: "system",
      command: "copy",
      target,
    };
  }

  // ── 2. Clipboard: paste ───────────────────────────────────────────────────
  const pasteFileMatch = trimmed.match(
    /^(?:(?:please|can\s+you|could\s+you)\s+)?paste(?:\s+(?:that|this|it|(?:from\s+)?(?:the\s+)?clipboard))?\s+(?:into|to|in)\s+(?:(?:the\s+)?file\s+)?["']?([\w./-]+)["']?$/i,
  );
  if (pasteFileMatch && !/^(?:clipboard|here|editor|input)$/i.test(pasteFileMatch[1])) {
    return {
      verb: "system",
      command: "paste",
      target: "file",
      file: pasteFileMatch[1],
    };
  }

  if (
    /^(?:(?:please|can\s+you|could\s+you)\s+)?paste(?:\s+(?:that|this|it|clipboard|from\s+(?:the\s+)?clipboard|here))?$/i.test(
      trimmed,
    )
  ) {
    return {
      verb: "system",
      command: "paste",
      target: "active",
    };
  }

  // ── 3. Appearance: switch_theme ───────────────────────────────────────────
  if (
    /^(?:(?:switch|change|set)\s+to\s+|enable\s+|use\s+)?dark\s+(?:mode|theme)$/i.test(trimmed)
  ) {
    return {
      verb: "system",
      command: "switch_theme",
      mode: "dark",
    };
  }
  if (
    /^(?:(?:switch|change|set)\s+to\s+|enable\s+|use\s+)?light\s+(?:mode|theme)$/i.test(trimmed)
  ) {
    return {
      verb: "system",
      command: "switch_theme",
      mode: "light",
    };
  }
  if (
    /^(?:(?:switch|change|set)\s+to\s+|enable\s+|use\s+)?(?:system|auto|automatic)\s+(?:mode|theme)$/i.test(
      trimmed,
    )
  ) {
    return {
      verb: "system",
      command: "switch_theme",
      mode: "system",
    };
  }

  // ── 4. Panel navigation: open_panel ───────────────────────────────────────
  if (
    /^(?:open|show|view|toggle)\s+(?:the\s+)?(?:activity\s+log|work\s+log|activity\s+panel|activity\s+drawer)$/i.test(
      trimmed,
    )
  ) {
    return {
      verb: "system",
      command: "open_panel",
      target: "activity",
    };
  }
  if (
    /^(?:open|show|view|toggle)\s+(?:the\s+)?(?:agent\s+tracker|agent\s+progress|sub[- ]?agent\s+tracker|task\s+tracker)$/i.test(
      trimmed,
    )
  ) {
    return {
      verb: "system",
      command: "open_panel",
      target: "agent-tracker",
    };
  }
  if (/^(?:open|show|toggle)\s+(?:the\s+)?(?:files|file\s+drawer|files\s+panel)$/i.test(trimmed)) {
    return {
      verb: "system",
      command: "open_panel",
      target: "files",
    };
  }
  if (/^(?:open|show|toggle)\s+(?:the\s+)?(?:history|history\s+panel|conversation\s+history)$/i.test(trimmed)) {
    return {
      verb: "system",
      command: "open_panel",
      target: "history",
    };
  }
  if (/^(?:open|show|toggle)\s+(?:the\s+)?(?:settings|settings\s+panel|agent\s+settings)$/i.test(trimmed)) {
    return {
      verb: "system",
      command: "open_panel",
      target: "settings",
    };
  }
  if (/^(?:open|show|toggle)\s+(?:the\s+)?(?:harnesses|harnesses\s+panel|coding\s+harnesses)$/i.test(trimmed)) {
    return {
      verb: "system",
      command: "open_panel",
      target: "harnesses",
    };
  }
  if (/^(?:close|dismiss|hide)\s+(?:the\s+)?(?:panel|modal|drawer|dialog|popover)$/i.test(trimmed)) {
    return {
      verb: "system",
      command: "open_panel",
      target: "close",
    };
  }

  // ── 5. Audio & session controls ───────────────────────────────────────────
  if (/^clear\s+(?:the\s+)?(?:activity|work)(?:\s+log)?$/i.test(trimmed)) {
    return {
      verb: "system",
      command: "clear_activity",
    };
  }
  if (/^(?:stop\s+speaking|be\s+quiet|quiet|mute|unmute)$/i.test(trimmed)) {
    const mode = /^unmute$/i.test(trimmed)
      ? "unmute"
      : /^mute$/i.test(trimmed)
        ? "mute"
        : "interrupt";
    return {
      verb: "system",
      command: "stop_speaking",
      mode,
    };
  }

  return null;
}
