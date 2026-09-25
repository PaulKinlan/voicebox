// lib/logger.mjs — Color-coded server logging (voicebox-beads-t97).
//
// Highlights bracketed context tags (e.g. [server], [audit], [channel], [live], [error])
// using distinct ANSI colors to improve readability while keeping the main log text clear.
//
// Complies with the NO_COLOR specification (https://no-color.org) and respects non-TTY
// outputs so piped logs and test runners receive clean plain text without ANSI escape codes.

export const TAG_COLORS = {
  // Red family: errors, failures, unhandled exceptions
  error: "\x1b[1;31m",
  uncaught: "\x1b[1;31m",
  unhandledrejection: "\x1b[1;31m",
  route: "\x1b[1;31m",
  fail: "\x1b[1;31m",
  refused: "\x1b[1;31m",
  refuse: "\x1b[1;31m",

  // Green family: tasks, audit events, successful confirmations
  task: "\x1b[1;32m",
  audit: "\x1b[1;32m",
  turn: "\x1b[1;32m",
  ok: "\x1b[1;32m",

  // Cyan family: server lifecycle, connections, roots, and transports
  server: "\x1b[1;36m",
  live: "\x1b[1;36m",
  "live-session": "\x1b[1;36m",
  channel: "\x1b[1;36m",
  root: "\x1b[1;36m",
  ws: "\x1b[1;36m",

  // Magenta family: extensions
  extension: "\x1b[1;35m",
  extensions: "\x1b[1;35m",
  "extension:exec": "\x1b[1;35m",
  "extension:wasm": "\x1b[1;35m",
  "extension:network": "\x1b[1;36m",
  "extension:refused": "\x1b[1;31m",

  // Yellow family: auth, warnings, approval prompts
  "extension approval": "\x1b[1;33m",
  auth: "\x1b[1;33m",
  pair: "\x1b[1;33m",
  pairing: "\x1b[1;33m",
  bearer: "\x1b[1;33m",
  warn: "\x1b[1;33m",
  warning: "\x1b[1;33m",
};

export const DEFAULT_TAG_COLOR = "\x1b[1;34m"; // Bold blue for other tags
export const RESET_COLOR = "\x1b[0m";

/**
 * Determine if colors should be enabled for a given output stream.
 * Disabled if NO_COLOR is set, NODE_DISABLE_COLORS=1, or stream is non-TTY (unless FORCE_COLOR=1).
 */
export function shouldColorize(stream = process.stderr) {
  if (process.env.NO_COLOR != null && process.env.NO_COLOR !== "") return false;
  if (process.env.NODE_DISABLE_COLORS === "1") return false;
  if (process.env.FORCE_COLOR === "1" || process.env.FORCE_COLOR === "true") return true;
  return Boolean(stream?.isTTY);
}

/**
 * Colorize bracketed tags like [server], [audit], [live] in a string.
 */
export function colorizeTags(text, enabled = null) {
  if (typeof text !== "string") return text;
  const useColors = enabled !== null ? enabled : shouldColorize();
  if (!useColors) return text;

  return text.replace(/\[([a-zA-Z0-9 _:.-]+)\]/g, (match, tag) => {
    const key = tag.toLowerCase().trim();
    let color = TAG_COLORS[key];
    if (!color) {
      if (key.includes("refused") || key.includes("error") || key.includes("fail")) {
        color = TAG_COLORS.error;
      } else if (key.includes("network") || key.includes("fetch")) {
        color = TAG_COLORS["extension:network"];
      } else if (key.startsWith("extension")) {
        color = TAG_COLORS.extension;
      } else {
        color = DEFAULT_TAG_COLOR;
      }
    }
    return `${color}[${tag}]${RESET_COLOR}`;
  });
}

/**
 * Format a console log argument, applying colorization if it is a string.
 */
export function formatLogArg(arg, useColors) {
  if (typeof arg === "string") {
    return colorizeTags(arg, useColors);
  }
  return arg;
}

/**
 * Install console.log and console.error hooks to automatically color-code bracketed tags.
 * Returns an uninstaller function.
 */
export function installColorConsole(options = {}) {
  const origLog = console.log;
  const origError = console.error;

  console.log = function (...args) {
    const useColors = options.force != null ? options.force : shouldColorize(process.stdout);
    if (!useColors) return origLog.apply(console, args);
    const colored = args.map((a) => formatLogArg(a, true));
    return origLog.apply(console, colored);
  };

  console.error = function (...args) {
    const useColors = options.force != null ? options.force : shouldColorize(process.stderr);
    if (!useColors) return origError.apply(console, args);
    const colored = args.map((a) => formatLogArg(a, true));
    return origError.apply(console, colored);
  };

  return () => {
    console.log = origLog;
    console.error = origError;
  };
}
