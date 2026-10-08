// Voicebox — the working surface.
//
// Everything this page shows comes from the local server: the file list is
// read from the active project folder, a turn is posted to /api/turn, and a file is opened by
// reading its bytes back. There is no seeded content, no timer that fakes a
// state, and no claim the server has not made. Strings are rendered with
// textContent only.
import { debugEnabled, isDebugEnabled, setDebugEnabled, openTranscriptDialog, recordDebug, redact } from "./debug-transcript.js";
import { createRoomUndoStack, deleteHandleFile, diffHandleFile, editHandleFile, grepHandleFolder, miniAppSyncName, parseRoomFolderTurn } from "./room-folder-ops.js";
import { installWindowManager } from "./window-manager.mjs";

const $ = (id) => document.getElementById(id);
const SVG = "http://www.w3.org/2000/svg";

// An uncaught error at module load aborts the REST of this file, so a page and
// a script from different revisions used to leave a half-dead page and a stack
// trace. A missing element is named instead, and the parts that need it stay
// inert while everything else keeps working (Paul hit this on 2026-09-19 by
// reloading across a live edit).
const WANTED = {
  files: "files", made: "made-list", samples: "samples", samplesLabel: "samples-label", count: "file-count", empty: "empty",
  emptyHeadline: "empty-headline", emptyNext: "empty-next", emptyWhy: "empty-why", emptyAction: "empty-action",
  where: "where-note", dot: "server-dot", refresh: "refresh", report: "turn-report", newFile: "new-file", undoLast: "undo-last",
  rootKind: "root-kind", madeHeading: "made-heading", emptyLink: "empty-link", listingRoot: "listing-root",
  listTools: "list-tools", fileFilter: "file-filter", showAll: "show-all", listBound: "list-bound",
  openFolder: "open-folder", openOpfsFolder: "open-opfs-folder", closeFolder: "close-folder", roomFolderHint: "room-folder-hint",
  dropHint: "drop-hint",
  stage: "voice-ring-wrap", mic: "mic", state: "voice-state", micDock: "mic-dock",
  session: "session", log: "session-log", sessionCopy: "session-copy", sessionClose: "session-close", sessionEmpty: "session-empty", form: "text-form", utterance: "utterance", send: "send",
  reader: "reader", readerTitle: "reader-title", readerFacts: "file-facts", readerBody: "file-body",
  fileRefresh: "file-refresh",
  fileEdit: "file-edit", fileSave: "file-save", fileCancelEdit: "file-cancel-edit", fileEditor: "file-editor",
  copy: "file-copy", fileDownload: "file-download", close: "reader-close", about: "about-facts", readerDetails: "reader-details",
  settingsOpen: "settings-open", settings: "settings", settingsClose: "settings-close",
  micSelect: "mic-select", outSelect: "out-select",
  micDeviceState: "mic-device-state", outDeviceState: "out-device-state",
  micHotkey: "mic-hotkey", micHotkeyState: "mic-hotkey-state", micHotkeyBadge: "mic-hotkey-badge",
  envs: "envs", envsOpen: "envs-open", envsClose: "envs-close", envsHelp: "envs-help", envsHelpPanel: "envs-help-panel", envList: "env-list", envCount: "envs-count", envNote: "env-note",
  envAdd: "env-add", envAddLabel: "env-add-label", envAddOrigin: "env-add-origin", envAddBtn: "env-add-btn",
  envActiveRootVal: "env-active-root-val", envUseBrowserBtn: "env-use-browser-btn", envPickFolderBtn: "env-pick-folder-btn",
  envRootPathInput: "env-root-path-input", envDeclareRootBtn: "env-declare-root-btn", envRootStatus: "env-root-status",
  // Create a project by name from the main UI (voicebox-beads-6uzd), explained by #env-setup-guide (voicebox-beads-um5r).
  envCreateProjectName: "env-create-project-name", envCreateProjectBtn: "env-create-project-btn",
  envCreateProjectStatus: "env-create-project-status",
  // The extension surface (voicebox-beads-vwb): one source (/api/extensions + /api/extensions/catalogue),
  // five states in five sections, never mixed — a present-but-unreviewed extension is never green
  // and never described as running, and an admitted extension that failed to load is never silent
  // (voicebox-beads-qdo: named error + next action, its own section).
  exts: "exts", extsOpen: "exts-open", extsClose: "exts-close", extCount: "exts-count", extNote: "ext-note",
  extShelf: "ext-shelf", extRunning: "ext-running", extFailed: "ext-failed", extWaiting: "ext-waiting", extPresent: "ext-present",
  extRefused: "ext-refused", extCatalogue: "ext-catalogue",
  // Extension creation section (voicebox-beads-b1p)
  extCreateForm: "ext-create-form",
  extCreateId: "ext-create-id",
  extCreateName: "ext-create-name",
  extCreateDesc: "ext-create-desc",
  extCreatePrimitive: "ext-create-primitive",
  extCreateTarget: "ext-create-target",
  extCreateBtn: "ext-create-btn",
  // Extension reconfiguration and removal modal (voicebox-beads-ud5)
  extManageDialog: "ext-manage-dialog", extManageForm: "ext-manage-form",
  extManageTitle: "ext-manage-title", extManageClose: "ext-manage-close",
  extManageHint: "ext-manage-hint", extManageId: "ext-manage-id",
  extManageMode: "ext-manage-mode", extManageFields: "ext-manage-fields",
  extManageHosts: "ext-manage-hosts", extManageMaxRequests: "ext-manage-max-requests",
  extManageRemoveWarning: "ext-manage-remove-warning", extManageWarningText: "ext-manage-warning-text",
  extManageToken: "ext-manage-token", extManageStatus: "ext-manage-status",
  extManageSubmit: "ext-manage-submit", extManageDelete: "ext-manage-delete",
  // Deleting from the room (voicebox-beads-g8y): a real modal, the file and its root named, Keep as
  // the default answer. The control is only drawn where the act can actually land (render()).
  deleteConfirm: "delete-confirm", deleteConfirmWhat: "delete-confirm-what", deleteConfirmWhere: "delete-confirm-where",
  deleteConfirmYes: "delete-confirm-yes", deleteConfirmNo: "delete-confirm-no",
  taskCard: "task-card",
  miniAppContainer: "mini-app-container",
  miniAppSheetHandle: "mini-app-sheet-handle",
  miniAppDragHandle: "mini-app-drag-handle",
  miniAppTitle: "mini-app-title",
  miniAppSourceBadge: "mini-app-source-badge",
  miniAppViewport: "mini-app-viewport",
  miniAppEdit: "mini-app-edit",
  miniAppDelete: "mini-app-delete",
  miniAppReload: "mini-app-reload",
  miniAppExpand: "mini-app-expand",
  miniAppToggle: "mini-app-toggle",
  miniAppClose: "mini-app-close",
  miniAppDock: "mini-app-dock",
  miniAppBubble: "mini-app-bubble",
  miniAppBubbleTitle: "mini-app-bubble-title",
  roomFoldersBar: "room-folders-bar", roomFoldersList: "room-folders-list",
  harnessesOpen: "harnesses-open", harnessesDialog: "harnesses-dialog",
  harnessesClose: "harnesses-close", harnessesCheck: "harnesses-check",
  harnessesStatus: "harnesses-status", harnessesList: "harnesses-list",
  harnessesScope: "harnesses-scope",
  harnessesStateLegend: "harnesses-state-legend", harnessesOpenTracker: "harnesses-open-tracker",
  harnessAgentName: "harness-agent-name", harnessAgentSelect: "harness-agent-select",
  harnessAgentModel: "harness-agent-model", harnessConfigSave: "harness-config-save",
  harnessConfigNote: "harness-config-note",
  harnessProjectLoop: "harness-project-loop", harnessProjectContext: "harness-project-context",
  harnessTaskInput: "harness-task-input", harnessTaskSend: "harness-task-send",
  harnessSaveOutput: "harness-save-output", harnessLoopStatus: "harness-loop-status",
  harnessChangedFiles: "harness-changed-files",
  changelogOpen: "changelog-open", changelogDialog: "changelog-dialog",
  changelogClose: "changelog-close", changelogRefresh: "changelog-refresh",
  changelogStatus: "changelog-status", changelogCommits: "changelog-commits",
  folderPath: "folder-path",
  themeToggle: "theme-toggle",
  themeSelect: "theme-select",
  themeSelectState: "theme-select-state",
  fileRunApp: "file-run-app",
  madeClose: "made-close",
  readerBackFiles: "reader-back-files",
  readerMinimize: "reader-minimize",
  sqehReaderBubble: "sqeh-reader-bubble",
  sqehReaderBubbleName: "sqeh-reader-bubble-name",
  apiKeyGemini: "api-key-gemini", apiKeyOpenai: "api-key-openai", apiKeyAnthropic: "api-key-anthropic",
  apiKeyGeminiStatus: "api-key-gemini-status", apiKeyOpenaiStatus: "api-key-openai-status", apiKeyAnthropicStatus: "api-key-anthropic-status",
  apiKeysSave: "api-keys-save", apiKeysStatus: "api-keys-status",
  syncToast: "sync-toast", syncToastMessage: "sync-toast-message",
  syncToastReload: "sync-toast-reload", syncToastDismiss: "sync-toast-dismiss",
  statusHelpToggle: "status-help-toggle", statusHelpPopover: "status-help-popover",
  statusHelpBackdrop: "status-help-backdrop",
  statusHelpClose: "status-help-close", helpSearchInput: "help-search-input",
  helpOpenFullPage: "help-open-full-page", helpServerVal: "help-server-val",
  helpRootVal: "help-root-val", helpVoiceVal: "help-voice-val", helpSections: "help-sections",
  visionCameraBtn: "vision-camera-btn", visionScreenBtn: "vision-screen-btn", visionPttBtn: "vision-ptt-btn",
  visionCoreCard: "vision-core-card", visionCoreVideo: "vision-core-video", visionCoreCanvas: "vision-core-canvas",
  visionCoreMeta: "vision-core-meta", visionSnapshotBtn: "vision-snapshot-btn", visionStopBtn: "vision-stop-btn",
  settingPttEnabled: "setting-ptt-enabled", settingPttState: "setting-ptt-state",
  settingDebugEnabled: "setting-debug-enabled", settingDebugState: "setting-debug-state",
  settingVisionResolution: "setting-vision-resolution", settingVisionFps: "setting-vision-fps",
  settingThinkingLevel: "setting-thinking-level", settingThinkingLevelState: "setting-thinking-level-state",
  settingStartCamera: "setting-start-camera", settingStartScreen: "setting-start-screen",
  thinkingTrace: "thinking-trace", thinkingTraceBody: "thinking-trace-body", thinkingTraceLabel: "thinking-trace-label",
};
const els = {};
const missing = [];
for (const [key, id] of Object.entries(WANTED)) {
  const el = document.getElementById(id);
  els[key] = el;
  if (!el) missing.push(id);
}
if (missing.length) {
  console.warn(`[voicebox] this document has no ${missing.map((id) => `#${id}`).join(", ")} — the page and fused.js are not the same revision, so the features that need them stay inert. Reload the page.`);
}

/** Wire an event, or say which element is missing rather than throwing. */
function on(el, type, handler) {
  if (el) return el.addEventListener(type, handler);
  return null;
}

// ── Theme preference: tri-state (light / dark / system), light by default, persisted to localStorage ──
const THEME_KEY = "voicebox:theme";
function applyTheme(mode, { persist = false } = {}) {
  const pref = (mode === "dark" || mode === "light" || mode === "system") ? mode : "light";
  const effective = pref === "system"
    ? (window.matchMedia?.("(prefers-color-scheme: dark)")?.matches ? "dark" : "light")
    : pref;
  document.documentElement.dataset.theme = effective;
  document.documentElement.dataset.themeMode = pref;
  if (persist) {
    try { localStorage.setItem(THEME_KEY, pref); } catch { /* private mode */ }
  }
  if (els.themeSelect) {
    els.themeSelect.value = pref;
  }
  if (els.themeSelectState) {
    els.themeSelectState.textContent = pref === "system"
      ? `System (${effective})`
      : `${effective.charAt(0).toUpperCase() + effective.slice(1)} mode`;
  }
  if (els.themeToggle) {
    const isDark = effective === "dark";
    const label = isDark ? "Switch to light mode" : "Switch to dark mode";
    els.themeToggle.setAttribute("aria-label", label);
    els.themeToggle.setAttribute("title", label);
    els.themeToggle.setAttribute("aria-pressed", String(isDark));
    const use = els.themeToggle.querySelector("use");
    if (use) use.setAttribute("href", isDark ? "#i-sun" : "#i-moon");
  }
}
{
  let initialTheme = "light";
  try {
    const savedTheme = localStorage.getItem(THEME_KEY);
    if (savedTheme === "dark" || savedTheme === "light" || savedTheme === "system") initialTheme = savedTheme;
  } catch { /* ignore */ }
  applyTheme(initialTheme);
  on(els.themeToggle, "click", () => {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    applyTheme(next, { persist: true });
  });
  on(els.themeSelect, "change", () => {
    const next = els.themeSelect.value;
    applyTheme(next, { persist: true });
  });
  window.matchMedia?.("(prefers-color-scheme: dark)")?.addEventListener?.("change", () => {
    if (document.documentElement.dataset.themeMode === "system") applyTheme("system");
  });
}

// ── Progressive Web App Service Worker registration ──
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}

// ── Browser System Commands (copy / paste / theme / panel) ──
async function executeBrowserSystemCommand(cmd) {
  if (!cmd || typeof cmd !== "object") return { ok: false };
  if (cmd.command === "copy") {
    const sel = window.getSelection?.()?.toString?.() ?? "";
    const textToCopy = cmd.text || sel || els.readerBody?.textContent || els.log?.firstElementChild?.textContent || "";
    if (textToCopy && navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(textToCopy);
        return { ok: true, copied: textToCopy };
      } catch {
        return { ok: false, error: "Clipboard permission denied" };
      }
    }
    return { ok: false, error: "Nothing to copy" };
  }
  if (cmd.command === "paste") {
    if (navigator.clipboard?.readText) {
      try {
        const text = await navigator.clipboard.readText();
        if (els.utterance) {
          if (els.form?.hidden) els.form.hidden = false;
          els.utterance.value = (els.utterance.value ? `${els.utterance.value} ` : "") + text;
          if (els.send) els.send.disabled = !els.utterance.value.trim();
          els.utterance.focus();
        }
        return { ok: true, pasted: text };
      } catch {
        return { ok: false, error: "Clipboard read permission denied" };
      }
    }
    return { ok: false, error: "Clipboard unavailable" };
  }
  if (cmd.command === "switch_theme" && cmd.theme) {
    applyTheme(cmd.theme, { persist: true });
    return { ok: true, theme: cmd.theme };
  }
  if (cmd.command === "open_panel" && cmd.panel) {
    const p = String(cmd.panel).toLowerCase();
    if (p === "settings") els.settings?.showModal?.();
    else if (p === "harnesses") els.harnessesOpen?.click?.();
    else if (p === "extensions") els.extsOpen?.click?.();
    else if (p === "environments") els.envsOpen?.click?.();
    else if (p === "changelog") els.changelogOpen?.click?.();
    else if (p === "files" || p === "history" || p === "activity" || p === "deck") sqehSetState(p);
    return { ok: true, panel: p };
  }
  return { ok: false };
}
window.executeBrowserSystemCommand = executeBrowserSystemCommand;
window.__voiceboxOnSystemCommand = executeBrowserSystemCommand;
window.addEventListener("message", (e) => {
  if (e.origin && e.origin !== window.location.origin) return;
  if (e.data?.type === "system_command") {
    void executeBrowserSystemCommand(e.data.systemCommand ?? e.data);
  }
});

// ── Project / folder change flash & Work Activity Log ──
let projectFlashTimer = null;
let lastPaintedRootKey = null;
const workActivitySeenIds = new Set();
let workActivitySeq = 0;

function sanitizePlainActivityText(raw) {
  const sWord = new RegExp(`\\b${"sand"}${"box"}\\b`, "gi");
  const wWord = new RegExp(`\\b${"work"}${"tree"}\\b`, "gi");
  const oWord = new RegExp(`\\b${"op"}${"fs"}\\b`, "gi");
  const scrubbed = redact(String(raw ?? ""));
  return scrubbed
    .replace(sWord, "workspace")
    .replace(wWord, "workspace")
    .replace(oWord, "browser storage")
    .trim();
}

function updateActivityBadge() {
  const list = document.getElementById("activity-log-list");
  const badge = document.getElementById("sqeh-activity-badge");
  const empty = document.getElementById("activity-log-empty");
  const count = list ? list.children.length : 0;
  if (badge) {
    badge.textContent = String(count);
    badge.hidden = count === 0;
  }
  if (empty) {
    empty.hidden = count > 0;
  }
}

function appendWorkActivity(entry = {}) {
  const list = document.getElementById("activity-log-list");
  if (!list) return;
  const id = entry.id ? String(entry.id) : `act_${++workActivitySeq}_${Date.now()}`;
  if (entry.id && workActivitySeenIds.has(id)) return;
  workActivitySeenIds.add(id);

  const kindRaw = sanitizePlainActivityText(entry.label || entry.kind || entry.type || entry.verb || "work") || "work";
  const summaryRaw = sanitizePlainActivityText(
    entry.summary || entry.action || entry.title || entry.message || entry.command || "Workspace activity",
  );
  const detailParts = [];
  if (entry.command && entry.command !== summaryRaw) detailParts.push(`$ ${sanitizePlainActivityText(entry.command)}`);
  if (entry.stdout) detailParts.push(sanitizePlainActivityText(entry.stdout));
  if (entry.stderr) detailParts.push(sanitizePlainActivityText(entry.stderr));
  if (entry.why) detailParts.push(sanitizePlainActivityText(entry.why));
  if (entry.error && entry.error !== entry.why) detailParts.push(sanitizePlainActivityText(entry.error));
  if (entry.detail && !detailParts.length) detailParts.push(sanitizePlainActivityText(entry.detail));
  if (entry.output && !detailParts.length) detailParts.push(sanitizePlainActivityText(entry.output));
  if (entry.stack && isDebugEnabled()) detailParts.push(sanitizePlainActivityText(entry.stack));
  const detailText = detailParts.filter(Boolean).join("\n").trim();

  const ts = entry.at || entry.timestamp || Date.now();
  const date = new Date(ts);
  const timeLabel = Number.isNaN(date.getTime())
    ? "just now"
    : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

  const li = document.createElement("li");
  li.className = "activity-item";
  if (entry.status === "error" || entry.kind === "error") {
    li.classList.add("activity-item-error");
  }
  li.dataset.activityId = id;

  const head = document.createElement("div");
  head.className = "activity-item-head";

  const kindSpan = document.createElement("span");
  kindSpan.className = "activity-kind";
  kindSpan.textContent = kindRaw;

  const timeSpan = document.createElement("span");
  timeSpan.className = "activity-time";
  timeSpan.textContent = timeLabel;

  head.append(kindSpan, timeSpan);

  const summaryEl = document.createElement("div");
  summaryEl.className = "activity-summary";
  summaryEl.textContent = summaryRaw;

  li.append(head, summaryEl);

  if (detailText) {
    const pre = document.createElement("pre");
    pre.className = "activity-detail";
    pre.textContent = detailText;
    li.append(pre);
  }

  list.prepend(li);
  while (list.children.length > 60) {
    list.lastElementChild?.remove();
  }
  updateActivityBadge();
}

async function refreshActivityLog() {
  try {
    const res = await fetch("/api/activity", { cache: "no-store" });
    if (!res.ok) return;
    const data = await res.json().catch(() => null);
    const items = Array.isArray(data?.entries)
      ? data.entries
      : Array.isArray(data?.activity)
        ? data.activity
        : Array.isArray(data)
          ? data
          : [];
    for (const item of items) {
      if (item && typeof item === "object") appendWorkActivity(item);
    }
  } catch { /* optional endpoint */ }
}

function triggerProjectChangeFlash(label = "") {
  document.body.dataset.projectFlash = "true";
  if (label) document.body.dataset.projectFlashReason = String(label);
  const whereEl = document.querySelector(".where");
  if (whereEl) whereEl.dataset.flash = "true";
  if (projectFlashTimer) clearTimeout(projectFlashTimer);
  projectFlashTimer = setTimeout(() => {
    delete document.body.dataset.projectFlash;
    delete document.body.dataset.projectFlashReason;
    if (whereEl) delete whereEl.dataset.flash;
    projectFlashTimer = null;
  }, 650);
  if (label) {
    appendWorkActivity({
      kind: "workspace",
      summary: `Switched workspace to ${label}`,
      at: Date.now(),
    });
  }
}
window.__voiceboxFlashProjectChange = triggerProjectChangeFlash;
window.__voiceboxAppendActivity = appendWorkActivity;
window.__voiceboxOnActivity = appendWorkActivity;

let shownFile = null; // the file currently in the reader panel
let fileReadSeq = 0; // monotonic sequence token guarding in-flight reads against stale settlements
let listedRoot = null; // the root the CURRENT entries were read from — not assumed to be the active one
// WHICH FOLDER OF THE ROOT IS ON SCREEN (voicebox-beads-tee): "" is the root itself, and every listing
// request carries it. The server's answer gives it back normalised, and the page adopts THAT as the
// truth, so a path can never drift between what the button did and what the list shows.
let listingDir = "";

/**
 * THE FOLDER'S OWN INSTRUCTIONS (voicebox-beads-0zi4).
 *
 * A repository keeps an AGENTS.md at its root; a monorepo keeps one per package, and a room is often
 * opened ON a subfolder. The live session is told which folder is open so its prompt can carry the
 * nearest AGENT.md/AGENTS.md — the server reads it for a machine root, and for a room folder the page
 * (which holds the handle) reads it and sends the text, because the machine cannot see opfs/handles.
 *
 * The page does not decide what "applied" means: it reports and the server answers with a
 * `project-instruction` state, including when the answer is "next session" (Gemini's setup is sent
 * once). A page that assumed it had been applied would be the lie this feature exists to remove.
 */
let projectContextSender = null;
const PROJECT_INSTRUCTION_NAMES = ["AGENT.md", "AGENTS.md"];
const PROJECT_INSTRUCTION_MAX_BYTES = 32768;

/** The payload for the CURRENT folder: page-held rooms send the text, everything else sends the path. */
async function projectContextPayload() {
  const dir = listingDir || "";
  if (!roomFolder?.handle || roomFolder.permission !== "granted") {
    return { type: "folder", dir };
  }
  for (const name of PROJECT_INSTRUCTION_NAMES) {
    try {
      const found = await readRoomFile(dir ? `${dir}/${name}` : name);
      if (found?.text?.trim()) {
        return {
          type: "project_instruction",
          file: name,
          dir,
          text: found.text.slice(0, PROJECT_INSTRUCTION_MAX_BYTES),
        };
      }
    } catch { /* absent: try the next name, exactly as the server-side reader does */ }
  }
  return { type: "folder", dir };
}

/** Report the current folder. Safe to call when no live socket is attached (it is a no-op). */
async function reportProjectContext() {
  if (typeof projectContextSender !== "function") return null;
  let payload;
  try {
    payload = await projectContextPayload();
  } catch (error) {
    payload = { type: "folder", dir: listingDir || "", error: String(error?.message ?? error) };
  }
  try { projectContextSender(payload); } catch { /* a disconnected socket is not a page failure */ }
  return payload;
}

/** Called by the live-voice adapter when its socket is up (and again after a reconnect). */
function setProjectContextSender(sender) {
  projectContextSender = typeof sender === "function" ? sender : null;
  if (projectContextSender) void reportProjectContext();
}

// THE ADAPTER REACHES THIS THROUGH THE WINDOW, not an import (voicebox-beads-0zi4). The live adapters are
// loaded by proofs that serve a CLOSED file list (tests/live-rate-browser.test.mjs serves audio-client.js,
// live-voice.js, debug-transcript.js, pcm.js, pcm-worklet.js and answers everything else 404), so an
// `import "./fused.js"` from live-voice.js makes the whole module graph fail there and takes the rate
// fixture down with it — measured: every live-rate-browser test went red in ~4s. The window hook is the
// same seam the page already uses for `__voiceboxLiveClient`, `__voiceboxDevices` and
// `__voiceboxServerBuild`, and it lets the adapter work when this file is not on the page at all.
window.__voiceboxProjectContext = { report: reportProjectContext, setSender: setProjectContextSender };
const joinDir = (dir, name) => (dir ? `${dir}/${name}` : name);
let listingRefusal = null; // the server's refusal, when it could not list the active root at all
// A lot of files must stay usable: filter by name, and never render an unbounded
// list — but the bound is STATED, because an explorer showing the first 60 of 240
// silently is the same defect as a listing that will not name its root.
const MAX_CARDS = 60;
const FILTER_AT = 12;
let fileFilter = "";
let showAllFiles = false;

const matchesFilter = (entry) => !fileFilter || entry.name.toLowerCase().includes(fileFilter.toLowerCase());

// ── a folder you opened in THIS TAB, read-only, for this session ───────────
//
// The environment page owns the writable handle and its persistence. The room
// only LOOKS, so it asks for read and keeps the handle in memory: a narrower
// permission for a narrower purpose, and no second copy of a persisted handle to
// ── Room folders: readable AND writable, persisted across reloads, several directories (voicebox-beads-69d) ──
const ROOM_FOLDER_MAX = 200;
const ROOM_FILE_MAX_BYTES = 256 * 1024;
let roomFolders = new Map(); // name -> { name, handle, permission, mode }
let roomFolder = null; // active folder { name, handle, permission, mode }
let roomTruncated = false;

// IDB persistence helpers (using voicebox/roots store with room_folder: prefix)
async function idbStore() {
  if (!("indexedDB" in globalThis)) return null;
  try {
    return await import(/* @vite-ignore */ "/browser/idb.ts");
  } catch {
    return null;
  }
}

async function persistRoomFolder(name, handle) {
  const idb = await idbStore();
  if (idb?.putRoomFolder) {
    await idb.putRoomFolder(name, handle).catch(() => {});
  }
}

async function unpersistRoomFolder(name) {
  const idb = await idbStore();
  if (idb?.deleteRoomFolder) {
    await idb.deleteRoomFolder(name).catch(() => {});
  }
}

async function loadPersistedRoomFolders() {
  const idb = await idbStore();
  if (!idb?.listRoomFolders) return [];
  try {
    return await idb.listRoomFolders();
  } catch {
    return [];
  }
}

async function walkRoomFolder(dir = "") {
  const names = [];
  roomTruncated = false;
  if (!roomFolder?.handle) return names;
  // THE FOLDER ON SCREEN, not always the root (voicebox-beads-tee): the same relative path the server and
  // the page take, walked down the handle chain this tab holds.
  let handle;
  try {
    handle = await roomDirHandle(dir);
  } catch (error) {
    throw new Error(`'${dir}' could not be opened: ${error?.message ?? error}`);
  }
  for await (const [name, node] of handle.entries()) {
    if (names.length >= ROOM_FOLDER_MAX) { roomTruncated = true; break; }
    names.push({ name, isDir: node.kind === "directory" });
  }
  names.sort((a, b) => a.name.localeCompare(b.name));
  return names;
}

/** The directory handle for a relative path inside the room's own picked folder. */
async function roomDirHandle(dir) {
  let handle = roomFolder.handle;
  for (const part of (dir ? dir.split("/").filter(Boolean) : [])) {
    handle = await handle.getDirectoryHandle(part);
  }
  return handle;
}

async function openRoomFolder({ onError } = {}) {
  const picker = globalThis.showDirectoryPicker;
  if (typeof picker !== "function") {
    const msg = "This browser cannot open a folder — there is no folder picker here. Dropping one still works.";
    setReport(msg, "bad");
    if (typeof onError === "function") onError(msg);
    return null;
  }
  try {
    // 1. Ask for readwrite mode by default (readable AND writable)
    let handle;
    try {
      handle = await picker({ mode: "readwrite" });
    } catch (err) {
      if (err?.name === "AbortError") return null; // user cancelled picker
      // Fallback to read-only if readwrite not permitted
      handle = await picker({ mode: "read" });
    }
    if (handle) {
      await adoptRoomFolder(handle);
      return handle;
    }
  } catch (error) {
    if (error?.name !== "AbortError") {
      const msg = `Could not open that folder: ${error?.message ?? error}`;
      setReport(msg, "bad");
      if (typeof onError === "function") onError(msg);
    }
  }
  return null;
}

// THE BROWSER'S OWN FOLDER, BY NAME (voicebox-beads-vnos): the button opens it and a file-creation turn
// with no root to write into lands in it, so both go through this one function — the room cannot open one
// directory and write into another. It mirrors `browser/storage.ts`'s `opfsRoot()` contract (the same
// `navigator.storage.getDirectory()` root); the page cannot import the worker's module, so the contract is
// shared rather than the code.
const SCRATCHPAD_NAME = "scratchpad";

async function ensureScratchpadFolder(name = SCRATCHPAD_NAME) {
  if (!navigator.storage?.getDirectory) {
    throw new Error("this browser does not support Origin Private File System (OPFS) storage");
  }
  const opfsRoot = await navigator.storage.getDirectory();
  const handle = await opfsRoot.getDirectoryHandle(name, { create: true });
  // ADOPTED, NOT MERELY HELD: the drawer, the count and the reader all speak about the ACTIVE folder, and a
  // file written into a folder the page is not showing is a write the person cannot see.
  await adoptRoomFolder(handle, { makeActive: true, persist: true });
  return handle;
}

async function openOpfsScratchFolder(projectName = SCRATCHPAD_NAME, { onError } = {}) {
  try {
    const handle = await ensureScratchpadFolder(projectName);
    setReport(`Opened '${projectName}' in browser storage (OPFS) — browser files and edits save here.`, "good");
    return handle || true;
  } catch (error) {
    const msg = error?.message ?? String(error);
    setReport(`Could not open browser scratchpad: ${msg}`, "bad");
    if (typeof onError === "function") onError(msg);
    return false;
  }
}

async function adoptRoomFolder(handle, { makeActive = true, persist = true } = {}) {
  if (!handle || handle.kind !== "directory") return;
  const name = handle.name || "folder";

  // Check readwrite and read permissions (OPFS handles have implicit readwrite permission)
  let perm = typeof handle.queryPermission === "function" ? "prompt" : "granted";
  let mode = typeof handle.queryPermission === "function" ? "read" : "readwrite";
  if (typeof handle.queryPermission === "function") {
    try {
      perm = await handle.queryPermission({ mode: "readwrite" });
      if (perm === "granted") {
        mode = "readwrite";
      } else {
        const readPerm = await handle.queryPermission({ mode: "read" });
        if (readPerm === "granted") {
          perm = "granted";
          mode = "read";
        }
      }
    } catch {
      perm = "prompt";
    }
  }

  const folder = { name, handle, permission: perm, mode };
  roomFolders.set(name, folder);

  if (persist) {
    await persistRoomFolder(name, handle);
  }

  if (makeActive || !roomFolder) {
    setActiveRoomFolder(name);
  } else {
    renderRoomFoldersBar();
  }
}

function setActiveRoomFolder(name) {
  const folder = roomFolders.get(name);
  if (!folder) return;
  const changed = !roomFolder || roomFolder.name !== name;
  roomFolder = folder;
  listingDir = ""; // a path means nothing across folders — a new pick starts at its root
  fileFilter = "";
  if (els.fileFilter) els.fileFilter.value = "";
  idbStore().then((idb) => idb?.putActiveRoomFolderName?.(name)).catch(() => {});
  if (changed && lastPaintedRootKey !== null) {
    triggerProjectChangeFlash(name);
  }
  renderRoomFoldersBar();
  loadRoomFolder();
}

function renderRoomFoldersBar() {
  if (!els.roomFoldersBar || !els.roomFoldersList) return;
  const count = roomFolders.size;
  if (count === 0 && !roomFolder) {
    els.roomFoldersBar.hidden = true;
    els.roomFoldersList.replaceChildren();
    if (els.closeFolder) els.closeFolder.hidden = true;
    return;
  }

  els.roomFoldersBar.hidden = false;
  if (els.closeFolder) els.closeFolder.hidden = false;
  els.roomFoldersList.replaceChildren();

  for (const folder of roomFolders.values()) {
    const isActive = roomFolder && roomFolder.name === folder.name;
    const chip = document.createElement("div");
    chip.className = "folder-chip";
    chip.dataset.folder = folder.name;
    chip.dataset.active = String(isActive);
    chip.dataset.permission = folder.permission;

    // Folder select button
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "folder-select-btn";
    btn.textContent = folder.name;
    btn.setAttribute("aria-label", `Switch to folder ${folder.name}`);
    btn.addEventListener("click", () => setActiveRoomFolder(folder.name));
    chip.append(btn);

    // Permission / Mode badge
    const badge = document.createElement("span");
    badge.className = "folder-perm-badge";
    badge.textContent = folder.permission === "granted"
      ? (folder.mode === "readwrite" ? "read/write" : "read-only")
      : "needs access";
    chip.append(badge);

    // Restore access button (visible when permission is prompt or mode is read-only)
    const regrantBtn = document.createElement("button");
    regrantBtn.type = "button";
    regrantBtn.className = "quiet folder-regrant-btn";
    regrantBtn.textContent = "Restore access";
    regrantBtn.setAttribute("aria-label", `Restore access to ${folder.name}`);
    regrantBtn.hidden = folder.permission === "granted" && folder.mode === "readwrite";
    regrantBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      await requestFolderAccess(folder);
    });
    chip.append(regrantBtn);

    // Close button
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "folder-close-btn";
    closeBtn.textContent = "×";
    closeBtn.setAttribute("aria-label", `Close folder ${folder.name}`);
    closeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      closeOneRoomFolder(folder.name);
    });
    chip.append(closeBtn);

    els.roomFoldersList.append(chip);
  }
}

async function requestFolderAccess(folder) {
  try {
    let res = "prompt";
    let mode = "readwrite";
    try {
      res = await folder.handle.requestPermission({ mode: "readwrite" });
    } catch {
      mode = "read";
      res = await folder.handle.requestPermission({ mode: "read" }).catch(() => "denied");
    }
    folder.permission = res;
    folder.mode = res === "granted" ? mode : "read";
    renderRoomFoldersBar();
    if (res === "granted") {
      setReport(
        mode === "readwrite"
          ? `Restored access to '${folder.name}'.`
          : `Restored read-only access to '${folder.name}'.`,
        "good",
      );
      if (roomFolder && roomFolder.name === folder.name) {
        await loadRoomFolder();
      }
    } else {
      setReport(`Permission to access '${folder.name}' was ${res}.`, "bad");
    }
  } catch (err) {
    setReport(`Could not restore access to '${folder.name}': ${err?.message ?? err}`, "bad");
  }
}

async function closeOneRoomFolder(name) {
  roomFolders.delete(name);
  await unpersistRoomFolder(name);
  if (roomFolder && roomFolder.name === name) {
    const next = roomFolders.values().next().value;
    if (next) {
      setActiveRoomFolder(next.name);
    } else {
      closeRoomFolder();
    }
  } else {
    renderRoomFoldersBar();
  }
}

async function clearAllRoomFolders() {
  if (roomFoldersReadyPromise) await roomFoldersReadyPromise;
  for (const name of Array.from(roomFolders.keys())) {
    await closeOneRoomFolder(name);
  }
}

async function loadRoomFolder() {
  if (!roomFolder) return load();
  if (roomFolder.permission !== "granted") {
    if (els.files) {
      els.files.replaceChildren();
      const li = document.createElement("li");
      li.className = "file-placeholder";
      li.textContent = `Access to '${roomFolder.name}' needs to be restored after reload — click 'Restore access' above.`;
      els.files.append(li);
    }
    if (els.count) els.count.textContent = "needs access";
    renderListingRoot();
    renderEmptyState();
    return;
  }
  showSkeleton();
  try {
    const listed = await walkRoomFolder(listingDir);
    listedRoot = null;
    listingRefusal = null;
    entries = listed.map(({ name, isDir }) => ({ name, isDir, meta: isDir ? "folder" : "file" }));
    render();
    void reportProjectContext(); // a room folder carries its own AGENTS.md (voicebox-beads-0zi4)
  } catch (error) {
    listingRefusal = { refused: "folder-unreadable", why: `could not read '${listingDir || roomFolder.name}': ${error?.message ?? error}` };
    entries = [];
    render();
  }
}

async function closeRoomFolder() {
  roomFolder = null;
  listedRoot = null;
  try {
    const idb = await idbStore();
    await idb?.putActiveRoomFolderName?.("");
  } catch {}
  triggerProjectChangeFlash("server folder");
  renderRoomFoldersBar();
  load();
}

async function readRoomFile(name) {
  if (!roomFolder || !roomFolder.handle) throw new Error("No folder open");
  // A NAME MAY BE A PATH (voicebox-beads-tee): a file inside a folder is `proposals/drafts/x.txt`, so the
  // containing directory is resolved by walking, exactly as the listing does.
  const parts = (name ?? "").split("/").filter(Boolean);
  const fileName = parts.pop() ?? "";
  const dir = await roomDirHandle(parts.join("/"));
  const file = await (await dir.getFileHandle(fileName)).getFile();
  const truncated = file.size > ROOM_FILE_MAX_BYTES;
  const text = await (truncated ? file.slice(0, ROOM_FILE_MAX_BYTES) : file).text();
  return { text, bytes: file.size, truncated };
}

/**
 * IS THIS STORAGE DURABLE? Asked once, and only when it matters (voicebox-beads-s61). The browser persists
 * an origin only when it decides to, and best-effort storage can be evicted — which, from the outside, is
 * exactly "my data did not save". The room writes into a folder the person picked, so the fact belongs on
 * the line that says a write succeeded: "saved" and "saved durably" are different promises.
 */
let durableAnswer = null;
async function durableFact() {
  if (durableAnswer === null) {
    try {
      durableAnswer = (await navigator.storage.persisted()) || (await navigator.storage.persist());
    } catch {
      durableAnswer = false;
    }
  }
  return durableAnswer ? "" : " — this browser may evict it (storage here is best-effort)";
}

const roomUndoStacks = new Map();
function undoStackForRoomFolder(folderName = roomFolder?.name) {
  if (!folderName) return null;
  let stack = roomUndoStacks.get(folderName);
  if (!stack) {
    stack = createRoomUndoStack(20);
    roomUndoStacks.set(folderName, stack);
  }
  return stack;
}

async function writeRoomFile(name, content) {
  if (!roomFolder || !roomFolder.handle) throw new Error("No folder open");
  let perm = typeof roomFolder.handle.queryPermission === "function" ? "prompt" : "granted";
  if (typeof roomFolder.handle.queryPermission === "function") {
    try {
      perm = await roomFolder.handle.queryPermission({ mode: "readwrite" });
    } catch {
      perm = "prompt";
    }
  }
  if (perm !== "granted") {
    throw new Error(`needs-gesture: write permission for '${roomFolder.name}' is ${perm} — click Restore access first`);
  }
  // A NAME MAY BE A PATH (voicebox-beads-s61): with folders navigable, saving into a subfolder is an
  // ordinary thing to do — the READER already walked the path and the WRITER did not, so `nested/kept.txt`
  // could be read and never written. Both now resolve the containing directory the same way.
  const parts = (name ?? "").split("/").filter(Boolean);
  const fileName = parts.pop() ?? "";
  if (!fileName) throw new Error(`'${name}' names no file to write`);
  const dir = await roomDirHandle(parts.join("/"));
  let existed = false;
  let previousContent = null;
  try {
    const existingHandle = await dir.getFileHandle(fileName, { create: false });
    previousContent = await (await existingHandle.getFile()).text();
    existed = true;
  } catch {
    existed = false;
    previousContent = null;
  }
  const fileHandle = await dir.getFileHandle(fileName, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(content);
  await writable.close();
  // READ IT BACK, and report what was OBSERVED (voicebox-beads-s61). The complaint this bead exists for is
  // data that "does not seem to save", and a resolved close() is the API's promise, not the world's answer.
  // The size that comes back from the file is the answer — and if it disagrees, the caller must hear it
  // rather than a success line computed from what we THOUGHT we wrote.
  const expected = new TextEncoder().encode(content).length;
  const observed = (await fileHandle.getFile()).size;
  if (observed !== expected) {
    throw new Error(
      `the file did not read back what was written (wrote ${expected} bytes, read ${observed} back) — it is not saved`,
    );
  }
  undoStackForRoomFolder()?.push({ kind: "write", path: name, existed, previousContent });
  await loadRoomFolder();
  return { bytes: observed };
}

let roomFoldersReadyPromise = null;

async function initRoomFolders() {
  const saved = await loadPersistedRoomFolders();
  if (!saved || saved.length === 0) return;

  for (const { name, handle } of saved) {
    if (!handle || handle.kind !== "directory") continue;
    let perm = typeof handle.queryPermission === "function" ? "prompt" : "granted";
    let mode = typeof handle.queryPermission === "function" ? "read" : "readwrite";
    if (typeof handle.queryPermission === "function") {
      try {
        perm = await handle.queryPermission({ mode: "readwrite" }).catch(() => "prompt");
        mode = perm === "granted" ? "readwrite" : "read";
        if (perm !== "granted") {
          const readPerm = await handle.queryPermission({ mode: "read" }).catch(() => "prompt");
          if (readPerm === "granted") {
            perm = "granted";
            mode = "read";
          }
        }
      } catch {
        perm = "prompt";
      }
    }
    roomFolders.set(name, { name, handle, permission: perm, mode });
  }

  if (roomFolders.size > 0) {
    const idb = await idbStore();
    const storedActive = await idb?.getActiveRoomFolderName?.().catch(() => null);
    if (storedActive === "" || storedActive === "__server__") {
      roomFolder = null;
      renderRoomFoldersBar();
      return;
    }
    const active = (storedActive && roomFolders.get(storedActive)) || roomFolders.values().next().value;
    if (active) {
      roomFolder = active;
      listingDir = "";
      renderRoomFoldersBar();
      if (active.permission === "granted") {
        loadRoomFolder();
      } else {
        if (els.files) {
          els.files.replaceChildren();
          const li = document.createElement("li");
          li.className = "file-placeholder";
          li.textContent = `Access to '${active.name}' needs to be restored after reload — click 'Restore access' above.`;
          els.files.append(li);
        }
        if (els.count) els.count.textContent = "needs access";
      }
    }
  }
}

let entries = [];

// ── small helpers ──────────────────────────────────────────────────────────
// A refusal carries a LABEL (refused/error) and a REASON (why). The reason is
// what a person can act on, so it wins wherever both arrive — the opposite
// order showed a reader "refused: unreadable (EACCES)" and hid
// "EACCES: permission denied, open '/path'" (vb-e1m0, 2026-09-20).
const reasonFrom = (body, fallback) => body?.why ?? body?.error ?? body?.note ?? fallback;

const bytes = (text) => new TextEncoder().encode(text).length;
const size = (text) => {
  const n = typeof text === "string" ? bytes(text) : text;
  return `${n} ${n === 1 ? "byte" : "bytes"}`;
};

const REPORT_FADE_DELAY_MS = 8000;
const REPORT_CLEAR_DELAY_MS = 800;
let reportFadeTimer = null;
let reportClearTimer = null;

function setReport(outcome, tone, said) {
  if (!els.report) return;
  if (reportFadeTimer) {
    clearTimeout(reportFadeTimer);
    reportFadeTimer = null;
  }
  if (reportClearTimer) {
    clearTimeout(reportClearTimer);
    reportClearTimer = null;
  }
  delete els.report.dataset.fading;
  els.report.replaceChildren();
  if (said) {
    const quote = document.createElement("span");
    quote.textContent = `“${said}” `;
    els.report.append(quote);
  }
  const result = document.createElement("span");
  result.className = "report-outcome";
  result.textContent = outcome;
  els.report.append(result);
  els.report.dataset.tone = tone ?? "";
  if (outcome && tone !== "bad") {
    reportFadeTimer = setTimeout(() => {
      reportFadeTimer = null;
      if (!els.report) return;
      els.report.dataset.fading = "true";
      reportClearTimer = setTimeout(() => {
        reportClearTimer = null;
        if (!els.report || els.report.dataset.fading !== "true") return;
        els.report.replaceChildren();
        delete els.report.dataset.fading;
      }, REPORT_CLEAR_DELAY_MS);
      reportClearTimer?.unref?.();
    }, REPORT_FADE_DELAY_MS);
    reportFadeTimer?.unref?.();
  }
}

function setState(text, tone) {
  if (!els.state) return;
  els.state.textContent = text;
  els.state.dataset.tone = tone ?? "";
}

function icon(id) {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("class", "icon");
  // Decorative by convention (voicebox-beads-t3gq): every static sprite use in index.html carries
  // aria-hidden="true" — a JS-built glyph must say the same thing, or the accessibility tree
  // depends on WHERE a glyph was born instead of WHAT it is.
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS(SVG, "use");
  use.setAttribute("href", `#${id}`);
  svg.append(use);
  return svg;
}

async function request(path, options, traceId) {
  const sessionToken = document.querySelector('meta[name="voicebox-session-token"]')?.content;
  if (sessionToken && sessionToken !== "__VOICEBOX_SESSION_TOKEN__") {
    options = options ?? {};
    options.headers = { ...(options.headers ?? {}), "x-voicebox-session-token": sessionToken };
  }
  const response = await fetch(path, options);
  const body = await response.json().catch(() => null);
  if (traceId) recordDebug({ type: "turn.result", traceId, status: response.status, body,
    severity: !response.ok || body?.result?.ok === false || body?.error || body?.note ? "error" : "info",
    delivery: "HTTP response received by page; the typed resolver does not send execution results back to a model" });
  if (path === "/api/health") recordDebug({ type: "host.health", body });
  // A named refusal carries refused+why, not error — carry them onto the throw so the catch renders
  // the reason and the remedy, not "the server answered 500".
  if (!response.ok) {
    const err = new Error(reasonFrom(body, `the server answered ${response.status}`));
    if (body?.refused) err.refused = body.refused;
    if (body?.why) err.why = body.why;
    throw err;
  }
  if (!body) throw new Error("the server sent something that was not JSON");
  return body;
}

const turn = async (transcript) => {
  const traceId = isDebugEnabled() ? crypto.randomUUID() : null;
  recordDebug({ type: "turn.request", traceId, transcript });
  try {
    return await request("/api/turn", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ transcript, ...(listingDir ? { dir: listingDir } : {}) }),
    }, traceId);
  } catch (error) {
    recordDebug({ type: "turn.error", traceId, error: error.message, refused: error.refused, why: error.why });
    throw error;
  }
};

// ── what was made: a quiet name and its real size, nothing else ───────────
//
// A CARD THAT JUST ARRIVED IS MARKED, AND THE MARK IS BOUNDED (voicebox-beads-kcs, finding 2). The count
// and the turn report already say an arrival happened, in words, through role="status" — this is the
// visual half: the list itself did not say WHICH file just arrived, and aria-current answers a different
// question (which file the reader has OPEN). The attribute is removed after this window, because an
// attribute saying "new" that outlives the fact is the same defect this codebase keeps finding.
// The window matches the card's own animation (2.6 s in style.css) plus a margin, so the mark's life is
// the visible event rather than arbitrary — and it is swept from the DOM when it expires, because a
// re-render is not something to depend on: "6.5 s later, still marked" was the first version's result.
const ARRIVAL_MARK_MS = 3000;
let arrivalSweep = null;
function scheduleArrivalSweep() {
  if (arrivalSweep !== null || arrivedUntil.size === 0) return;
  const next = Math.min(...arrivedUntil.values());
  arrivalSweep = setTimeout(() => {
    arrivalSweep = null;
    const now = Date.now();
    for (const [name, until] of arrivedUntil) if (until <= now) arrivedUntil.delete(name);
    for (const el of document.querySelectorAll(".file-open[data-arrived]")) {
      if (!arrivedUntil.has(el.dataset.file)) delete el.dataset.arrived;
    }
    scheduleArrivalSweep();
  }, Math.max(0, next - Date.now()) + 20);
}
let previousFileNames = null; // the names the LAST render saw; null = no listing has been rendered yet
// A WINDOW, NOT A SINGLE RENDER. The first version marked a name for exactly one render, and the page
// renders twice around a write (the list, then the turn report) — so the second render created the card
// unmarked and the mark was lost. A name that arrives stays marked until this timestamp passes.
const arrivedUntil = new Map();

// ── deleting a file from the room (voicebox-beads-g8y) ────────────────────────────────────────
// Deletion is confirmed, names the file AND the root it leaves, and goes through the same route the
// loop writes through: `DELETE /api/file` → execute() → dispatch(). A page-owned root routes to the
// page that owns it, a machine root deletes on disk, and either way the root's own audit records the
// act. The control is only drawn where the room believes the act can land (`writable` in render(),
// never for a room-held folder, which the room only reads).
let pendingDelete = null;

/** Where this listing's files actually live, in words, for the confirmation. */
function deleteRootSentence() {
  const root = listedRoot ?? activeRoot?.root ?? null;
  const kind = root?.kind ?? "";
  const where = root?.path ?? root?.name ?? root?.label ?? "";
  if (kind === "opfs") return "It will be deleted from this browser's storage for this site; the page that owns the project performs the deletion.";
  if (kind === "handle") return `It will be deleted from the folder you picked${where ? ` (${where})` : ""}; the page that owns the folder performs the deletion.`;
  if (kind === "machine") return `It will be deleted from ${where || "the folder this server writes into"} on this machine.`;
  return where ? `It will be deleted from ${where}.` : "It will be deleted from the folder this list came from.";
}

function askDelete(relativePath, name) {
  if (!els.deleteConfirm) return;
  pendingDelete = { path: relativePath, name };
  if (els.deleteConfirmWhat) els.deleteConfirmWhat.textContent = name;
  if (els.deleteConfirmWhere) els.deleteConfirmWhere.textContent = deleteRootSentence();
  els.deleteConfirm.showModal();
}

async function confirmDelete() {
  const target = pendingDelete;
  pendingDelete = null; // the close listener must not read this as an unanswered close
  if (els.deleteConfirm?.open) els.deleteConfirm.close("delete");
  if (!target) return;
  let answer;
  try {
    answer = await request(`/api/file?name=${encodeURIComponent(target.path)}`, { method: "DELETE" });
  } catch (error) {
    setReport(`Could not delete ${target.name}: ${error?.message ?? error}`, "bad");
    return;
  }
  if (answer?.ok === false) {
    // The server's own name for the refusal, not a generic failure — not-found, outside-root,
    // root-vanished, no-page all mean different things and the person needs the one that applies.
    setReport(`Could not delete ${target.name}: ${answer.refused ?? "refused"}${answer.why ? ` — ${answer.why}` : ""}`, "bad");
    return;
  }
  setReport(`Deleted ${target.name}${answer?.logged != null ? " — recorded in the root's log" : ""}.`, "good");
  await load();
}

function card(entry, { arrived = false, canDelete = false } = {}) {
  const li = document.createElement("li");
  const open = document.createElement("button");
  open.type = "button";
  open.className = "file-open";
  open.dataset.file = entry.name;
  // The PATH is what navigation and the reader use; the bare NAME is what arrival marks key on, because
  // the listing inside a folder carries bare names (voicebox-beads-tee). Two facts, two attributes.
  open.dataset.path = joinDir(listingDir, entry.name);
  if (entry.isDir) open.dataset.kind = "directory";
  // A FOLDER IS NOT A FILE. The listing has carried `kind` all along and the page
  // threw it away, so a folder rendered as a nameless-size file and clicking it
  // produced "cannot read directory" — a failure dressed as a bad file.
  open.setAttribute("aria-label", entry.isDir ? `${entry.name}, folder` : `Read ${entry.name}`);
  if (arrived) open.dataset.arrived = "true";

  // FOLDERS LOOK LIKE FOLDERS (voicebox-beads-35eg). The icon sits INSIDE the name row, and the name
  // stays the DISK'S name verbatim — a page that renames things cannot be reconciled with the folder
  // it is showing — so the cue is an icon plus the [data-kind="directory"] style, never text.
  if (entry.isDir) open.append(icon("i-folder"));

  const name = document.createElement("span");
  name.className = "file-name";
  // The name is the DISK'S name, verbatim — a page that renames things cannot be
  // reconciled with the folder it is showing, and the acceptance harness checks
  // exactly that (api=[notes] vs page=[notes/] was the tell). The folder cue is
  // the meta line plus a style on [data-kind="directory"], neither of which
  // touches textContent.
  name.textContent = entry.name;
  const meta = document.createElement("span");
  meta.className = "file-meta";
  meta.textContent = entry.meta;
  open.append(name, meta);

  if (entry.isDir) {
    // A FOLDER IS A DOOR (voicebox-beads-tee). This used to refuse with a sentence saying folders could
    // not be opened yet; the refusal was honest and the thing it described was a gap. Opening it is the
    // listing: the same request, with the folder named, and the answer says which folder it listed.
    open.addEventListener("click", () => goToDir(joinDir(listingDir, entry.name)));
  } else {
    open.addEventListener("click", () => showFile(joinDir(listingDir, entry.name)));
  }
  li.append(open);
  // THE DELETE CONTROL (voicebox-beads-g8y), for files only: this bead does not do recursive folder
  // deletion, so a folder row simply has no such button. It is a SIBLING of the open button, so a
  // click here can never be a click on the file.
  if (canDelete && !entry.isDir) {
    const remove = document.createElement("button");
    remove.type = "button";
    // A COMPACT ICON, NOT A WIDE WORD (voicebox-beads-io3a): the page's own .icon-button, positioned
    // inside the file's card at the end of its name line — a button cannot nest inside .file-open (the
    // card IS a button), so the control is its sibling positioned into the card, and the card reserves
    // the lane with padding. The class and data-file stay: they are how the delete tests and the g8y
    // flow find it, and the aria-label carries the file's name for anyone not looking at an icon.
    remove.className = "icon-button danger file-delete";
    remove.dataset.file = entry.name;
    remove.setAttribute("aria-label", `Delete ${entry.name}`);
    remove.title = `Delete ${entry.name}`;
    remove.append(icon("i-trash"));
    remove.addEventListener("click", () => askDelete(open.dataset.path, entry.name));
    li.append(remove);
  }
  return li;
}

// An empty room still shows where the first file will land, so the promise has
// a place on screen instead of resting on copy alone.
function placeholder() {
  const li = document.createElement("li");
  li.className = "file-placeholder";
  li.textContent = "the first file appears here";
  return li;
}

// ── the empty room: the first sentence has to be what to DO next ───────────
//
// A first-time reader used to meet a wall of caveats plus three sample turns —
// and with a picked-folder or OPFS root the samples could not land at all: the
// room writes through the local server, and the server cannot act on a
// root the page owns. Measured on the served page with a picked folder open:
// the page invited "create a file called …" and the turn came back
// refused: root-not-reachable-from-here. A promise the system refuses is worse
// than a caveat, so the promise is now gated on the same fact the server uses,
// and every refusal keeps its named cause.
function renderEmptyState() {
  const headline = els.emptyHeadline;
  const next = els.emptyNext;
  if (!headline || !next) return;

  const sampleList = els.samples;
  // The label goes with the list it labels: a heading left behind over nothing is worse than none.
  // `only` narrows the list to the samples that can actually land here (voicebox-beads-vnos): with no
  // root declared the file-making samples work — the browser scratchpad takes them — while "list files"
  // does not. Teaching a command the room will refuse is worse than showing nothing.
  const showSamples = (allowed, only = null) => {
    if (sampleList) {
      sampleList.hidden = !allowed;
      for (const item of sampleList.children) item.hidden = Boolean(only) && item.dataset.kind !== only;
    }
    if (els.samplesLabel) els.samplesLabel.hidden = !allowed;
  };

  // 1. no answer from the server: nothing can be written, and saying so is the
  //    useful sentence.
  if (els.dot?.dataset.ok === "false") {
    headline.textContent = "Server disconnected.";
    next.textContent = "The Voicebox server is not responding. Ensure it is running and click Refresh.";
    if (els.emptyWhy) { els.emptyWhy.hidden = true; }
    if (els.emptyAction) els.emptyAction.hidden = true;
    if (els.emptyLink) els.emptyLink.textContent = "Configure workspace";
    showSamples(false);
    setComposerEnabled(false, "the local server is not answering, so a turn cannot be written");
    return;
  }

  // 1b. active browser folder needs write access restored:
  if (roomFolder && (roomFolder.permission !== "granted" || roomFolder.mode !== "readwrite")) {
    headline.textContent = `Access to '${roomFolder.name}' needed.`;
    next.textContent = `This tab needs permission to write files into '${roomFolder.name}'. Click 'Restore access' above or choose another folder in environments.`;
    if (els.emptyWhy) els.emptyWhy.hidden = true;
    if (els.emptyAction) els.emptyAction.hidden = false;
    if (els.emptyLink) els.emptyLink.textContent = "Configure workspace";
    showSamples(false);
    setComposerEnabled(false, `'${roomFolder.name}' needs write permission — click 'Restore access' first`);
    return;
  }

  // 2. no root declared: the next action is to open a project, and that is a
  //    different page, so the page points at it.
  if (!roomFolder && activeRoot === null) {
    headline.textContent = "Open a project.";
    next.textContent = "Open a folder above to save files locally, or speak to create files in the browser scratchpad.";
    if (els.emptyAction) els.emptyAction.hidden = false;
    if (els.emptyLink) els.emptyLink.textContent = "Configure workspace";
    if (els.emptyWhy) { els.emptyWhy.hidden = true; }
    showSamples(true, "file");
    // The composer is never disabled by capability, only titled by it — and here the honest title is not a
    // refusal: a file-making turn lands in the browser's scratchpad, and anything else has nowhere to write.
    setComposerEnabled(false, "a turn that makes a file lands in this browser's scratchpad; anything else needs a project folder", { lead: "" });
    return;
  }

  // 3. A ROOT THIS SERVER CANNOT ACT ON — which is NOT the same as a root nothing can act on.
  //    `reachableFromThisProcess` answers "can the SERVER act"; `actsVia` + `executor` answer
  //    "can ANYTHING act, and is it here right now". They are two questions, and the page used to
  //    answer the first with the second one's words: it told a person "Turns cannot save into this
  //    folder" about a folder the tab in front of them could write into perfectly well once routed
  //    (voicebox-beads-*, held until the router landed: actsVia/executor from vb-resolver).
  const serverCanAct = activeRoot === undefined || activeRoot?.reachableFromThisProcess === true;
  const pageOwnsRoot = activeRoot?.actsVia === "page";
  const pageIsHere = pageOwnsRoot && activeRoot?.executor?.connected === true;
  // The page owns this folder AND is connected: a turn is routed to it, so the room is usable and
  // says nothing about refusal. (The page may still refuse a turn it cannot serve — a picked folder
  // without a write grant answers the page's own `needs-gesture`, and that sentence arrives from the
  // side that knows rather than being guessed here.)
  if (!roomFolder && activeRoot !== undefined && activeRoot !== null && !serverCanAct && !pageIsHere) {
    const where = activeRoot.facts?.where ?? "this project's root";
    // Two causes, two sentences, and each names its own remedy. "The tab is not open" and "no part of
    // the system can save here" are different problems with different next steps.
    if (pageOwnsRoot) {
      headline.textContent = "The tab that holds this folder is not open.";
      next.textContent = `${where} belongs to a browser tab, and that tab is not connected to this server right now — so a typed turn has nothing to hand the work to. Open the tab that holds this folder, or configure a folder in the environments dialog.`;
    } else {
      headline.textContent = "Turns cannot save into this folder.";
      next.textContent = `This folder belongs to this browser tab, and turns run in the local server — so a typed turn is refused: ${where} is not somewhere the server can save. Configure a folder on this machine in the environments dialog, or do the work in the tab that holds this folder.`;
    }
    // The detail line: the CAUSE in plain words, with the seam's own sentence kept on the element's
    // title for anyone who asks for it. Its `why` for a page-owned root is written to explain the
    // router — "this placement is the machine", "the act belongs to that side, not to this one" — and
    // the owner's rule names "placement" as jargon that must not reach a person. (The same sentence
    // stays visible where the platform's own refusal text belongs: turn results, verbatim.)
    if (els.emptyWhy) {
      const detail = pageOwnsRoot
        ? "This folder is in the tab's own storage, so only that tab can write into it — and it is not connected to this server right now."
        : (activeRoot.why ?? "");
      els.emptyWhy.textContent = detail;
      els.emptyWhy.hidden = !detail;
      if (activeRoot.why) els.emptyWhy.title = activeRoot.why;
    }
    if (els.emptyAction) els.emptyAction.hidden = false;
    if (els.emptyLink) els.emptyLink.textContent = "Configure workspace";
    showSamples(false);
    // The composer's reason is written for the person reading it, not inherited from the seam: the
    // server's `why` for a page-owned root is written to explain the router ("this placement is the
    // machine", "the act belongs to that side") and a tooltip that says "placement" is jargon where a
    // plain cause belongs. The seam's sentence still appears in the empty state's detail line, which is
    // the place for the longer explanation.
    setComposerEnabled(false, pageOwnsRoot
      ? "the tab that holds this folder is not connected, so a turn has nothing to hand the work to"
      : (activeRoot.why ?? "the open root is one only the page can act on"));
    return;
  }

  // 4. a writable root and nothing made: NOW the promise is true, and the
  //    samples are the shortcut to keeping it.
  const base = roomFolder
    ? roomFolder.name
    : (activeRoot?.root?.path ?? activeRoot?.root?.name ?? activeRoot?.root?.label ?? "");
  headline.textContent = "Say or type something that names a file.";
  next.textContent = base
    ? `It lands in ${base.replace(/\/$/, "")}/ — or try one:`
    : "It lands here — or try one:";
  if (els.emptyWhy) els.emptyWhy.hidden = true;
  if (els.emptyAction) els.emptyAction.hidden = true;
  showSamples(true);
  setComposerEnabled(true);
}

// The input is where a person actually types, so it carries the same truth as
// the empty state: it must not say "Try: create a file…" while the page says
// nothing typed can land. (The cold read of the first version of this empty
// state caught exactly that: samples hidden, placeholder still inviting.)
/**
 * The composer is never disabled by capability — it is TITLED by it, so a person can still type and find
 * out. `lead` exists for the one state where the warning is not about refusal (voicebox-beads-vnos): with
 * no root declared a file-making turn lands in the browser's scratchpad, so a title that opened with "a
 * turn would be refused here" would be half false, and a half-false warning is the defect itself.
 */
function setComposerEnabled(canLand, why = "", { lead = "a turn would be refused here: " } = {}) {
  const input = els.utterance;
  if (!input) return;
  if (canLand) {
    input.placeholder = "Or type a turn…";
    input.removeAttribute("title");
    return;
  }
  input.placeholder = "Or type a turn…";
  if (why) input.title = `${lead}${why}`;
}

// WHERE IS THIS LIST FROM? The header chip names the ACTIVE root; this names the
// root these cards were read from. Usually the same sentence with a different
// subject; when they differ it is the only place the difference can be seen.
function renderListingRoot() {
  const line = els.listingRoot;
  if (!line) return;
  // A refused listing is stated in the server's own words, because the reasons
  // differ in kind (a picked folder this process cannot act on / a vanished root)
  // and the person needs the one that applies. "No root declared" is left to the
  // empty state, which already says what to do about it.
  if (roomFolder) {
    line.hidden = false;
    line.dataset.tone = "";
    // WHETHER THIS VIEW CAN WRITE IS A FACT, NOT AN ASSUMPTION (voicebox-beads-vnos). The line said
    // "read-only view" over every room folder, so the scratchpad a create command had just written into
    // was called read-only by the line directly beneath the write. The folder's own mode is the answer.
    const writable = roomFolder.permission === "granted" && roomFolder.mode === "readwrite";
    line.textContent = writable
      ? `In “${roomFolder.name}”${roomTruncated ? ` (first ${ROOM_FOLDER_MAX})` : ""} — turns save here.`
      : `Read-only view of “${roomFolder.name}”${roomTruncated ? ` (first ${ROOM_FOLDER_MAX})` : ""} — turns need write access to save here.`;
    return;
  }
  if (listingRefusal) {
    if (listingRefusal.refused === "root-not-declared") { line.hidden = true; return; }
    line.hidden = false;
    line.dataset.tone = "warn";
    // A refusal with no explanation must still read as a sentence: the identifier is the server's word
    // for it, not the person's, so it goes in the title rather than into this line.
    line.textContent = `This list could not be read: ${listingRefusal.why || "the folder did not answer"} `;
    line.title = [listingRefusal.refused, listingRefusal.why].filter(Boolean).join(" — ");
    // …and the way out, in the same sentence, because the empty state that
    // normally carries the route is hidden while the listing is refused.
    const link = document.createElement("a");
    link.href = "/environment.html";
    link.textContent = "Open the environment page";
    line.append(link, " to choose a folder this list can read.");
    return;
  }
  if (!listedRoot) { line.hidden = true; return; }
  const where = listedRoot.path ?? listedRoot.name ?? listedRoot.label ?? "an unnamed root";
  const active = activeRoot?.root;
  const activeWhere = active?.path ?? active?.name ?? active?.label ?? "";
  const stale = Boolean(activeWhere && where && activeWhere !== where);
  line.hidden = false;
  line.dataset.tone = stale ? "warn" : "";
  // Symmetric wording: this says the two disagree, and does not assert which of
  // them is the one that moved.
  line.textContent = stale
    ? `This listing is older than the header's folder — press Refresh.`
    : `listed from ${where}`;
}

let lastRenderedFilesSig = null;

function render() {
  const count = entries.length;
  if (!els.files || !els.made || !els.count) return;
  renderCrumbs();
  // Usable when the SERVER acts, or when the page that owns the root is connected and will act.
  const writable = activeRoot === undefined
    || activeRoot?.reachableFromThisProcess === true
    || (activeRoot?.actsVia === "page" && activeRoot?.executor?.connected === true);
  const matched = entries.filter(matchesFilter);
  const shown = showAllFiles ? matched : matched.slice(0, MAX_CARDS);

  if (els.listTools) els.listTools.hidden = count <= FILTER_AT;
  if (els.showAll) els.showAll.hidden = matched.length <= MAX_CARDS || showAllFiles;
  if (els.listBound) {
    const bounded = matched.length > MAX_CARDS && !showAllFiles;
    els.listBound.hidden = !(bounded || (fileFilter && matched.length === 0));
    els.listBound.textContent = fileFilter && matched.length === 0
      ? `No file here matches “${fileFilter}”.`
      : bounded
        ? `Showing the first ${MAX_CARDS} of ${matched.length} matches${fileFilter ? ` for “${fileFilter}”` : ""} — type to narrow, or Show all.`
        : "";
  }

  // WHICH NAMES ARRIVED? A name is new when the PREVIOUS LISTING HAD FILES and this one did not have that
  // name. Two things that would otherwise lie are excluded on purpose:
  //   · a first listing (previous names null or EMPTY) is a page loading, not an arrival — the first
  //     version marked every existing file on load, because the page's first render is an empty list;
  //   · a name whose window has passed is no longer new.
  const namesNow = new Set(entries.map((e) => e.name));
  if (previousFileNames && previousFileNames.size > 0) {
    for (const name of namesNow) if (!previousFileNames.has(name)) arrivedUntil.set(name, Date.now() + ARRIVAL_MARK_MS);
  }
  previousFileNames = namesNow;
  const nowMs = Date.now();
  for (const [name, until] of arrivedUntil) if (until <= nowMs || !namesNow.has(name)) arrivedUntil.delete(name);
  scheduleArrivalSweep();
  const canDelete = writable && !roomFolder;
  const filesSig = `${count}:${writable}:${canDelete}:${listingDir}:${shown.map((e) => `${e.name}\0${e.isDir ? 1 : 0}\0${e.meta}\0${arrivedUntil.has(e.name) ? 1 : 0}`).join("\n")}`;
  if (filesSig !== lastRenderedFilesSig) {
    lastRenderedFilesSig = filesSig;
    els.files.replaceChildren(...(count === 0 ? (writable ? [placeholder()] : []) : shown.map((e) => card(e, { arrived: arrivedUntil.has(e.name), canDelete }))));
  }
  els.made.dataset.state = count === 0 ? "empty" : "ready";
  els.files.setAttribute("aria-busy", "false");
  els.count.textContent = count === 0 ? "" : `${count} ${count === 1 ? "file" : "files"}`;
  const nothingMatched = count > 0 && matched.length === 0;
  els.made.dataset.state = listingRefusal && count === 0 ? "failed" : count === 0 ? "empty" : "ready";
  if (nothingMatched && els.listBound) { els.listBound.hidden = false; }
  if (els.newFile) els.newFile.hidden = Boolean(listingRefusal);
  if (els.closeFolder) els.closeFolder.hidden = roomFolders.size === 0 && !roomFolder;
  if (els.openFolder) els.openFolder.hidden = typeof globalThis.showDirectoryPicker !== "function";
  if (els.roomFolderHint) els.roomFolderHint.hidden = roomFolders.size > 0 || Boolean(roomFolder);
  renderListingRoot();
  renderEmptyState();
  if (shownFile && !entries.some((entry) => entry.name === shownFile)) shownFile = null;
  if (shownFile) showFileSelection(shownFile);
}

function showFileSelection(name) {
  for (const card of document.querySelectorAll(".file-open")) {
    card.setAttribute("aria-current", String(card.dataset.path === name));
  }
}

/**
 * GO INTO A FOLDER (voicebox-beads-tee). Navigation IS the listing: the same request, carrying the
 * folder. Nothing is fetched twice and no second view is invented — the answer says which folder it
 * listed, and the crumbs are drawn from that, so the bar cannot disagree with the list under it.
 */
function goToDir(dir) {
  const nextDir = dir ?? "";
  if (nextDir !== listingDir) {
    triggerProjectChangeFlash(nextDir || "root");
  }
  listingDir = nextDir;
  void reportProjectContext(); // the voice learns which folder it is in (voicebox-beads-0zi4)
  // WHICH LISTING AM I NAVIGATING? A room folder picked in THIS tab is listed from its own handle, not
  // from the server; everything else goes through the server, which asks the page when the root is the
  // page's (voicebox-beads-tee). One path for the person, one request per source.
  if (roomFolder) void loadRoomFolder();
  else void load();
}

/** The way back up: root / folder / folder, each step a button, with a parent control in front. */
function renderCrumbs() {
  const nav = els.folderPath;
  if (!nav) return;
  const parts = listingDir ? listingDir.split("/").filter(Boolean) : [];
  const kind = listedRoot?.kind ?? activeRoot?.root?.kind ?? null;
  // A folder picked in this tab is its own root, and its name is the only honest label for the top crumb.
  const rootLabel = roomFolder?.name
    ?? { machine: "this machine", opfs: "browser storage", handle: "picked folder" }[kind]
    ?? "the root";
  nav.replaceChildren();
  // At the root there is nowhere to go back to, and the line above already names it.
  nav.hidden = parts.length === 0;
  if (!parts.length) return;

  const up = document.createElement("button");
  up.type = "button";
  up.className = "crumb crumb-up";
  up.textContent = "↑";
  up.setAttribute("aria-label", `Go up to ${parts.length === 1 ? rootLabel : parts[parts.length - 2]}`);
  up.addEventListener("click", () => goToDir(parts.slice(0, -1).join("/")));
  nav.append(up);

  const steps = [{ label: rootLabel, dir: "" }, ...parts.map((part, i) => ({ label: part, dir: parts.slice(0, i + 1).join("/") }))];
  for (const [i, step] of steps.entries()) {
    if (i > 0) {
      const sep = document.createElement("span");
      sep.className = "crumb-sep";
      sep.setAttribute("aria-hidden", "true");
      sep.textContent = "/";
      nav.append(sep);
    }
    const current = i === steps.length - 1;
    if (current) {
      const here = document.createElement("span");
      here.className = "crumb";
      here.setAttribute("aria-current", "page");
      here.textContent = step.label;
      nav.append(here);
    } else {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "crumb";
      button.textContent = step.label;
      button.addEventListener("click", () => goToDir(step.dir));
      nav.append(button);
    }
  }
}

// The first paint is a skeleton of the real thing — a quiet name, arriving.
function showSkeleton() {
  lastRenderedFilesSig = null;
  els.made.dataset.state = "loading";
  els.files.setAttribute("aria-busy", "true");
  els.count.textContent = "reading…";
  const item = document.createElement("li");
  item.className = "skeleton skeleton-visible";
  item.setAttribute("aria-hidden", "true");
  const bar = document.createElement("span");
  bar.className = "bar";
  item.append(bar);
  els.files.replaceChildren(item);
}

// ── which root the loop writes into, and who acts on it ────────────────────
//
// Two different facts, always in this order: WHAT KIND of root it is (opfs, a
// picked folder, a folder on the machine) and only then whether anything can
// act on it from here. "There is no picked folder here" is not "permission
// denied", and a page that answers the second question with the first one's
// words is lying about the system it is looking at.
let activeRoot = undefined; // undefined = not asked yet, null = none declared

async function loadRoot() {
  const before = rootIdentity();
  try {
    const answer = await request("/api/root");
    activeRoot = answer?.declared ? answer : null;
  } catch {
    activeRoot = undefined; // an older server with no root seam: say so, do not invent one
  }
  // A PATH MEANS NOTHING ACROSS ROOTS (voicebox-beads-tee): `proposals` in one root is a different folder
  // — or no folder — in the next, so a root change puts the view back at the root. Only a CHANGE resets;
  // pressing Refresh while inside a folder must leave you inside it.
  const now = rootIdentity();
  if (before !== null && before !== now) listingDir = "";
  renderRoot();
  // The list's placeholder chip is a promise too ("the first file appears
  // here"), so it is decided with the root facts in hand rather than before
  // they arrive.
  render();
}

/** What root is this, as a string — the identity a folder path is relative to. */
function rootIdentity() {
  if (activeRoot === undefined) return null;
  if (activeRoot === null) return "none";
  const root = activeRoot.root ?? {};
  return `${activeRoot.project ?? ""}:${root.kind ?? ""}:${root.path ?? root.id ?? root.name ?? ""}`;
}

// The settings dialog's facts drawer: only facts this page actually holds, and
// only the ones a person configuring audio or a root would want. Two lines, no
// adjectives.
function renderAbout() {
  const box = els.about;
  if (!box) return;
  const lines = [];
  if (activeRoot === undefined) lines.push("This server does not say which folder it saves into.");
  // The drawer's sentence must match the room's behaviour (voicebox-beads-vnos): a file-making turn HAS a
  // place to save when nothing is declared — the browser scratchpad — and the old line denied it.
  else if (activeRoot === null) lines.push("No folder has been chosen yet — a typed turn that makes a file goes to the browser scratchpad, and anything else has nowhere to save.");
  else {
    const root = activeRoot.root ?? {};
    const where = activeRoot.facts?.where ?? root.kind ?? "a root";
    const name = root.path ?? root.name ?? root.label ?? "";
    // WHO WRITES is part of where the work goes (the drawer is the one place allowed a second fact).
    // A folder in this tab's storage and a folder on this machine read identically in a path, and they
    // behave differently the moment the tab closes.
    const writer = activeRoot.actsVia === "page"
      ? (activeRoot.executor?.connected ? ", written by the tab that holds it" : ", and the tab that holds it is not open, so turns cannot save there yet")
      : "";
    lines.push(`Turns save into ${where}${name ? ` · ${name}` : ""}${writer}.`);
  }
  const page = pageBuild();
  const server = window.__voiceboxServerBuild;
  if (page && server?.commit) lines.push(`Page ${page} · server ${server.branch} @ ${server.commit}.`);
  else if (page) lines.push(`Page ${page}.`);
  box.textContent = lines.join("\n");
}

// THE HEADER STATES THE STATE, ONCE, and explains nothing. "no root declared"
// is a status; the explanation and the remedy live in the empty state, where a
// person is about to act. The server's full description stays in the chip's
// title for anyone who asks for it, because a tooltip is not a second voice on
// the screen (coord, 2026-09-20: one fact was on screen three times).
function renderRoot() {
  const kindEl = els.rootKind;
  if (!kindEl) return;

  if (roomFolder) {
    const isOpfs = roomFolder.name === SCRATCHPAD_NAME;
    const kindPlain = isOpfs ? "browser storage" : "picked folder";
    kindEl.textContent = `${kindPlain} · ${roomFolder.name}`;
    kindEl.title = isOpfs
      ? `${kindPlain} · ${roomFolder.name} — saved in this browser`
      : `${kindPlain} · ${roomFolder.name} — saved in this local directory`;
    if (els.envActiveRootVal) {
      els.envActiveRootVal.textContent = `${kindPlain} · ${roomFolder.name}`;
    }
    renderAbout();
    return;
  }

  if (activeRoot === undefined) {
    kindEl.textContent = "folder not reported";
    kindEl.title = "this server does not say which folder it saves into";
    renderAbout();
    return;
  }
  const currentKey = rootIdentity();
  if (activeRoot === null) {
    kindEl.textContent = "no folder chosen yet";
    kindEl.removeAttribute("title");
    if (lastPaintedRootKey === null) {
      lastPaintedRootKey = currentKey;
    } else if (currentKey !== lastPaintedRootKey) {
      lastPaintedRootKey = currentKey;
      triggerProjectChangeFlash("no folder chosen yet");
    }
    renderAbout();
    return;
  }
  const kind = activeRoot.root?.kind ?? "";
  const kindPlain = { machine: "machine folder", opfs: "browser storage", handle: "picked folder" }[kind]
    ?? activeRoot.facts?.where ?? activeRoot.root?.kind ?? "a root";
  const fullPath = activeRoot.root?.path ?? activeRoot.root?.name ?? activeRoot.root?.label ?? "";
  // Plain words + the folder's NAME only. The full path is one hover away, not one glance away —
  // a long /tmp/... path in the header line was the clutter Paul pointed at.
  kindEl.textContent = fullPath ? `${kindPlain} · ${fullPath.split("/").filter(Boolean).pop()}` : kindPlain;
  kindEl.title = [activeRoot.description, fullPath].filter(Boolean).join(" — ");
  if (lastPaintedRootKey === null) {
    lastPaintedRootKey = currentKey;
  } else if (currentKey !== lastPaintedRootKey) {
    lastPaintedRootKey = currentKey;
    triggerProjectChangeFlash(kindEl.textContent);
  }
  if (els.envActiveRootVal) {
    if (activeRoot === null) {
      els.envActiveRootVal.textContent = "no folder chosen yet";
    } else if (activeRoot) {
      els.envActiveRootVal.textContent = fullPath ? `${kindPlain} · ${fullPath}` : kindPlain;
    }
  }
  renderAbout();
}

// ── the environment list (core/environment.ts is the seam; server.mjs owns the store) ──────────
// One source: the header chip, the settings surface and the "+" all read /api/environments. A host
// that is listed but not running is named unreachable, never shown as ready; a registry the server
// cannot read is a different named refusal from an empty list.
// ── THE EXTENSION SURFACE (voicebox-beads-vwb) ──────────────────────────────────────────
// One source: the server's registry and ledger, read fresh on every render. The page keeps no
// copy, so it cannot drift from what the host enforces. Four states, four sections, never mixed:
//   Running            the host allowed it — green, and the plain words say what it may do
//   Waiting for review proposed from the conversation or the catalogue — amber, not running
//   Found here         in the extensions folder, never reviewed — grey, NEVER green, NEVER running
//   Refused            decided, with the human sentence saying why
// The page can stage and disclose, but cannot approve alone: a person must copy a one-use
// code from the host console. The long-lived host token never enters the page.
// PLAIN LANGUAGE RULE: internal rule ids never reach this panel. Where the API gives a human
// sentence (the `why`), that is what the person reads; where it gives a state name, the page
// renders the state's meaning instead.

function plainCaps(declared, bounds) {
  const words = [];
  const caps = declared ?? [];
  if (caps.includes("read")) words.push("read files in this project");
  if (caps.includes("write")) words.push("write files in this project");
  if (caps.includes("delete")) words.push("delete files");
  if (caps.includes("network")) {
    const hosts = (bounds?.hosts ?? []).join(", ") || "no host";
    words.push(`fetch from ${hosts}${bounds?.maxRequests ? ` (at most ${bounds.maxRequests} requests)` : ""}`);
  }
  return words.length ? `It may ${words.join(", and ")}.` : "It needs no special ability.";
}

function extRow({ name, dotState, stateText, detail, disclose }) {
  const li = document.createElement("li");
  li.className = "env-item";
  const head = document.createElement("div");
  head.className = "env-head";
  const dot = document.createElement("span");
  dot.className = "env-dot";
  dot.dataset.ok = dotState; // "present" is its own state — never green, never red
  head.appendChild(dot);
  const label = document.createElement("span");
  label.className = "env-label";
  label.textContent = name;
  head.appendChild(label);
  const state = document.createElement("span");
  state.className = "env-state";
  state.textContent = stateText;
  head.appendChild(state);
  li.appendChild(head);
  if (detail) {
    const d = document.createElement("p");
    d.className = "ext-detail";
    d.textContent = detail;
    li.appendChild(d);
  }
  if (disclose) li.appendChild(disclose);
  return li;
}

function extSection(listEl, rows, emptyText) {
  listEl.replaceChildren();
  if (rows.length === 0) {
    const li = document.createElement("li");
    li.className = "env-item env-empty";
    li.textContent = emptyText;
    listEl.appendChild(li);
    return;
  }
  for (const row of rows) listEl.appendChild(row);
}

// The review panels the person has opened, by proposal id. Kept OUTSIDE the render because a
// background refresh rebuilds the list and must not discard what the person was reading
// (voicebox-beads-ujay).
const openPlanIds = new Set();

// The last plan text fetched per proposal id, so a rebuild restores what the person is reading
// instead of blanking the panel and re-asking the server on every background refresh.
const planCache = new Map();

function extensionApproval(id) {
  const wrap = document.createElement("div");
  wrap.className = "ext-review-controls";

  const actions = document.createElement("div");
  actions.className = "ext-actions";

  const approve = document.createElement("button");
  approve.type = "button";
  approve.className = "quiet ext-approve-btn";
  approve.textContent = "Approve & run";

  const refuse = document.createElement("button");
  refuse.type = "button";
  refuse.className = "quiet danger ext-refuse-btn";
  refuse.textContent = "Refuse";

  actions.append(approve, refuse);

  const details = document.createElement("details");
  details.className = "ext-plan";
  const summary = document.createElement("summary");
  summary.textContent = "Review permissions & plan";
  const note = document.createElement("p");
  note.setAttribute("role", "status");
  note.textContent = "Click 'Approve & run' to allow this extension in your workspace, or 'Refuse' to decline it.";
  const plan = document.createElement("pre");
  details.append(summary, note, plan);

  // READINESS IS NAMED, NOT INFERRED: "loading" -> "ready" | "error". A caller (and the test that
  // drives this panel) waits for a state instead of polling for text and calling the wait a timeout,
  // and an error keeps its own name so a refusal is reported as a refusal, not as slowness.
  // The last plan fetched per proposal is kept, so a rebuild RESTORES what the person is reading
  // instead of blanking the panel and re-asking the server on every 20s poll (the text blinked and
  // went "loading" under the reader's eyes). A silent revalidation still runs in the background, so
  // a plan that changed on the server is not shown stale for long; the authority is the server's own
  // plan digest at approve time anyway, which refuses a plan that moved (approval-plan-changed).
  const loadPlan = async ({ silent = false } = {}) => {
    if (details.dataset.planState === "loading") return;
    if (!silent) details.dataset.planState = "loading";
    try {
      const p = await request(`/api/extensions/proposals/${encodeURIComponent(id)}/plan`);
      const text = JSON.stringify(p, null, 2);
      plan.textContent = text;
      planCache.set(id, text);
      details.dataset.planState = "ready";
    } catch (err) {
      // A silent revalidation that failed must not erase the plan already on screen; a first load
      // that failed is the person's to see, named.
      if (silent) return;
      note.textContent = err.message;
      details.dataset.planState = "error";
    }
  };

  const post = (route, body) => request(`/api/extensions/${route}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });

  const showPlanForOpenPanel = () => {
    const cached = planCache.get(id);
    if (cached) {
      plan.textContent = cached;
      details.dataset.planState = "ready";
      void loadPlan({ silent: true });
      return;
    }
    void loadPlan();
  };

  details.addEventListener("toggle", () => {
    if (details.open) { openPlanIds.add(id); showPlanForOpenPanel(); }
    else openPlanIds.delete(id);
  });

  // A REFRESH MUST NOT CLOSE THE PANEL THE PERSON OPENED (voicebox-beads-ujay). renderExtensions()
  // rebuilds this list with replaceChildren(), and health() (a 20s poll) and a landing tool call both
  // call it — so a background refresh used to replace an open review panel with a fresh closed row
  // and its already-fetched plan vanished. The plan only ever loaded from the `toggle` event, and a
  // row that was never toggled never fires one: under load the plan simply never appeared, which is
  // the flake. The panel's open state belongs to the person, not to the render, so restore it here
  // and show its plan directly rather than waiting for an event this element will not get.
  if (openPlanIds.has(id)) {
    details.open = true;
    showPlanForOpenPanel();
  }

  approve.addEventListener("click", async () => {
    approve.disabled = true;
    try {
      await post("approve", { id, confirm: true });
      if (els.extNote) els.extNote.textContent = "Approved extension — it is now running.";
      await renderExtensions();
    } catch (err) {
      note.textContent = err.message;
      details.open = true;
    } finally {
      approve.disabled = false;
    }
  });

  refuse.addEventListener("click", async () => {
    refuse.disabled = true;
    try {
      await post("refuse", { id, why: "The host declined this extension from the room." });
      if (els.extNote) els.extNote.textContent = "You declined this proposal. It has been moved to Refused.";
      await renderExtensions();
    } catch (err) {
      note.textContent = err.message;
      details.open = true;
    } finally {
      refuse.disabled = false;
    }
  });

  wrap.append(actions, details);
  return wrap;
}

let lastRunningExtensions = [];

function openManageExt(ext, mode = "reconfigure") {
  if (!els.extManageDialog) return;
  if (els.extManageId) els.extManageId.value = ext.id;
  if (els.extManageMode) els.extManageMode.value = mode;
  if (els.extManageToken) els.extManageToken.value = "";
  if (els.extManageStatus) els.extManageStatus.textContent = "";

  if (mode === "reconfigure") {
    if (els.extManageTitle) els.extManageTitle.textContent = `Reconfigure ${ext.name ?? ext.id}`;
    if (els.extManageHint) els.extManageHint.textContent = "Update bounds to restore tool access or resolve configuration loops.";
    if (els.extManageFields) els.extManageFields.hidden = false;
    if (els.extManageRemoveWarning) els.extManageRemoveWarning.hidden = true;
    if (els.extManageHosts) els.extManageHosts.value = (ext.bounds?.hosts ?? []).join(", ");
    if (els.extManageMaxRequests) els.extManageMaxRequests.value = ext.bounds?.maxRequests ?? "";
    if (els.extManageSubmit) {
      els.extManageSubmit.textContent = "Save configuration";
      els.extManageSubmit.hidden = false;
    }
    if (els.extManageDelete) els.extManageDelete.hidden = false;
  } else {
    if (els.extManageTitle) els.extManageTitle.textContent = `Remove ${ext.name ?? ext.id}`;
    if (els.extManageHint) els.extManageHint.textContent = "Withdrawing an extension revokes its tools immediately.";
    if (els.extManageFields) els.extManageFields.hidden = true;
    if (els.extManageRemoveWarning) els.extManageRemoveWarning.hidden = false;
    const toolNames = (ext.tools ?? []).map((t) => (typeof t === "string" ? t : t.name)).join(", ");
    if (els.extManageWarningText) {
      els.extManageWarningText.textContent = `The extension's tools (${toolNames || "all tools"}) will stop being callable immediately.`;
    }
    if (els.extManageSubmit) {
      els.extManageSubmit.textContent = "Confirm removal";
      els.extManageSubmit.hidden = false;
    }
    if (els.extManageDelete) els.extManageDelete.hidden = true;
  }

  els.extManageDialog.showModal();
}

// Execution status for the tools view (voicebox-beads-ri4k): the live socket's {type:"tool"}
// frames land here via window.__voiceboxOnToolCalls, and the wasm shelf rows read it.
const lastToolStatus = new Map();

/** ARTIFACT CHIP (voicebox-beads-2meg, voicebox-beads-np3f): a file a turn or tool wrote/edited
 *  becomes a rich inline chip on the newest turn with action badge, byte size, and content preview. */
function sqehArtifactChip(name, details = {}) {
  const turn = els.log?.firstElementChild ?? els.log?.lastElementChild;
  if (!turn || !name) return;
  const existing = [...turn.querySelectorAll(".sqeh-artifact-chip")].find((el) => el.dataset.file === name);
  if (existing) existing.remove();
  const chip = document.createElement("button");
  chip.type = "button";
  chip.className = "sqeh-chip sqeh-artifact-chip";
  chip.dataset.file = name;
  chip.setAttribute("aria-label", `Open ${name}`);

  const metaRow = document.createElement("span");
  metaRow.className = "sqeh-artifact-meta";

  const glyph = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  glyph.setAttribute("class", "icon");
  glyph.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", "#i-folder");
  glyph.append(use);

  const badge = document.createElement("span");
  badge.className = "sqeh-artifact-badge";
  badge.textContent = details.verb === "edit" ? "Edited" : "Wrote";

  const label = document.createElement("span");
  label.className = "sqeh-chip-name sqeh-artifact-name";
  label.textContent = name;

  const open = document.createElement("span");
  open.className = "sqeh-chip-open sqeh-artifact-open";
  open.textContent = "Open";

  metaRow.append(glyph, badge, label);
  if (details.bytes !== undefined || typeof details.content === "string") {
    const sizeSpan = document.createElement("span");
    sizeSpan.className = "sqeh-artifact-size";
    const byteLen = typeof details.bytes === "number"
      ? details.bytes
      : new TextEncoder().encode(String(details.content ?? "")).length;
    sizeSpan.textContent = `${byteLen} ${byteLen === 1 ? "byte" : "bytes"}`;
    metaRow.append(sizeSpan);
  }
  metaRow.append(open);
  chip.append(metaRow);

  const rawPreview = String(details.content ?? details.preview ?? "").trim();
  if (rawPreview) {
    const previewEl = document.createElement("pre");
    previewEl.className = "sqeh-artifact-preview";
    const codeEl = document.createElement("code");
    const lines = rawPreview.split(/\r?\n/).slice(0, 3);
    const snippet = lines.join("\n").slice(0, 180);
    codeEl.textContent = snippet + (rawPreview.length > snippet.length ? "…" : "");
    previewEl.append(codeEl);
    chip.append(previewEl);
  }

  chip.addEventListener("click", () => {
    void showFile(name);
  });
  turn.append(chip);
}

async function renderExtensions() {
  if (!els.extRunning) return;
  try {
    const [inv, cat] = await Promise.all([request("/api/extensions"), request("/api/extensions/catalogue")]);
    // WASM SHELF ROWS LIVE IN THEIR OWN SECTION (voicebox-beads-ri4k, coord ruling): the shelf's
    // digest-pinned tools are callable NOW — reconfig/remove and the running count are about
    // admitted-descriptor extensions, so shelf entries are excluded from both.
    const runningAll = inv.extensions ?? [];
    const running = runningAll.filter((e) => e.source !== "wasm-shelf");
    const shelfRunning = runningAll.filter((e) => e.source === "wasm-shelf");
    lastRunningExtensions = running;
    const waiting = (inv.proposals ?? []).filter((p) => p.state === "pending");
    // An id that is no longer reviewable leaves both pieces of panel state with it: otherwise an id a
    // later proposal reuses would come back unexpectedly open, and its old plan text with it. A
    // PRESENT file is reviewable too — it gets the same review panel — so it counts as still here.
    const reviewableIds = new Set([...waiting, ...(inv.present ?? [])].map((p) => p.id));
    for (const id of [...openPlanIds]) if (!reviewableIds.has(id)) { openPlanIds.delete(id); planCache.delete(id); }
    const refused = (inv.proposals ?? []).filter((p) => p.state === "refused");
    const present = inv.present ?? [];
    const catalogue = cat.catalogue ?? [];

    extSection(els.extRunning, running.map((e) => {
      const row = extRow({ name: e.name, dotState: "true", stateText: "Running", detail: plainCaps(e.declared, e.bounds) });
      const actions = document.createElement("div");
      actions.className = "ext-actions";

      const reconfigBtn = document.createElement("button");
      reconfigBtn.className = "quiet ext-reconfigure-btn";
      reconfigBtn.type = "button";
      reconfigBtn.textContent = "Reconfigure";
      reconfigBtn.setAttribute("data-id", e.id);
      reconfigBtn.addEventListener("click", () => openManageExt(e, "reconfigure"));
      actions.appendChild(reconfigBtn);

      const removeBtn = document.createElement("button");
      removeBtn.className = "quiet danger ext-remove-btn";
      removeBtn.type = "button";
      removeBtn.textContent = "Remove";
      removeBtn.setAttribute("data-id", e.id);
      removeBtn.addEventListener("click", () => openManageExt(e, "remove"));
      actions.appendChild(removeBtn);

      row.appendChild(actions);
      return row;
    }), "Nothing running yet.");

    // APPROVED, NOT RUNNING (voicebox-beads-qdo): an approved extension that failed to load is
    // named HERE, never silent — the row says what happened and what to do next, in the person's
    // words. Never green, never mixed into Running: half-loaded is a state the person must SEE.
    extSection(els.extFailed, (inv.failedLoads ?? []).map((f) =>
      extRow({ name: f.name ?? f.id, dotState: "false", stateText: "Approved · not running",
               detail: `${f.why} Next: ${f.next}` })
    ), "No approved extension is failing to load.");

    extSection(els.extWaiting, waiting.map((p) =>
      extRow({ name: p.name, dotState: "pending", stateText: "Waiting for the host's review", disclose: extensionApproval(p.id) })
    ), "Nothing is waiting for review.");

    // PRESENT, NOT RUNNING: visible, honest, and never green. A file the host has never
    // reviewed is not a running tool, and this panel must never blur that difference.
    extSection(els.extPresent, present.map((p) =>
      extRow({ name: p.name ?? p.id, dotState: "present", stateText: "Found here · never reviewed · not running",
               detail: "Found in the extensions folder. It has never run — approve it below to allow it, or refuse it.",
               disclose: extensionApproval(p.id) })), "No unreviewed files here.");

    extSection(els.extRefused, refused.map((p) =>
      extRow({ name: p.name, dotState: "false", stateText: "Refused", detail: p.refusal?.why ?? "The host declined this extension." })), "Nothing was refused.");

    // WASM SHELF (voicebox-beads-ri4k): these are NOT catalogue strangers awaiting review —
    // they are digest-pinned, admitted and callable right now, so they render in their own
    // section with their description and their last execution status (from the live tool
    // frames), never as a "would run after review" maybe.
    const shelfRows = shelfRunning.flatMap((e) => {
      const toolNames = e.tools ?? [];
      return toolNames.map((toolName) => {
        const last = lastToolStatus.get(toolName);
        const ago = last ? ` · ${Math.max(1, Math.round((Date.now() - last.at) / 1000))}s ago` : "";
        // THE EXECUTION LATENCY (voicebox-beads-rgvi): how long the host executor ran the tool,
        // shown beside the ok/failed fact — a number measured at the executor, not a guess.
        const latency = Number.isFinite(last?.durationMs) ? ` · ${last.durationMs}ms` : "";
        const stateText = `Callable now · ${toolName}${last ? ` · last run ${last.ok ? "ok" : "failed"}${latency}${ago}` : " · not yet run in this session"}`;
        const detail = (e.toolDetails ?? []).find((td) => td.name === toolName)?.description ?? e.description ?? "";
        return extRow({ name: e.name, dotState: "true", stateText, detail });
      });
    });
    extSection(els.extShelf, shelfRows, "No wasm shelf tools are allowed yet. A digest-pinned manifest in the wasm shelf directory adds them here.");

    const isShelf = (c) => String(c.id ?? "").startsWith("wasm-shelf-");
    extSection(els.extCatalogue, catalogue.filter((c) => !isShelf(c)).map((c) => {
      // The preview's ENFORCEMENT MAP is what separates "would run here" from "cannot": an
      // admitted preview names the mechanisms it would get; a refusal names why it would not.
      const wouldRun = c.preview != null && c.preview.enforced !== undefined;
      const verdict = wouldRun
        ? "Would run here after review."
        : `Cannot run here — ${c.preview?.why ?? "this machine cannot give it what it asks for"}`;
      const row = extRow({ name: c.name ?? c.id, dotState: "pending", stateText: verdict, detail: c.description });
      if (wouldRun) {
        const add = document.createElement("button");
        add.className = "quiet";
        add.type = "button";
        add.textContent = "Add to review";
        add.addEventListener("click", async () => {
          try {
            const staged = await request("/api/extensions/sideload", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ id: c.id, confirm: true }),
            });
            if (els.extNote) els.extNote.textContent = `${staged.id ?? "It"} was added to the review list.`;
          } catch (err) {
            if (els.extNote) els.extNote.textContent = String(err?.message ?? "it could not be added");
          }
          await renderExtensions();
        });
        row.appendChild(add);
      }
      return row;
    }), "The catalogue is empty.");

    if (els.extCount) {
      const up = running.length;
      els.extCount.textContent = `Extensions · ${up} running · ${waiting.length} waiting`;
    }
    if (els.extNote && !els.extNote.textContent) els.extNote.textContent = "";
  } catch (err) {
    if (els.extCount) els.extCount.textContent = "Extensions";
    if (els.extNote) els.extNote.textContent = String(err?.message ?? "the extension list could not be read");
  }
}

async function renderEnvironments() {
  if (els.envActiveRootVal) {
    if (roomFolder) {
      const isOpfs = roomFolder.name === SCRATCHPAD_NAME;
      const kindPlain = isOpfs ? "browser storage" : "picked folder";
      els.envActiveRootVal.textContent = `${kindPlain} · ${roomFolder.name}`;
    } else if (activeRoot === null) {
      els.envActiveRootVal.textContent = "no folder chosen yet";
    } else if (activeRoot) {
      const fullPath = activeRoot.root?.path ?? activeRoot.root?.name ?? activeRoot.root?.label ?? "";
      const kind = activeRoot.root?.kind ?? "";
      const kindPlain = { machine: "machine folder", opfs: "browser storage", handle: "picked folder" }[kind]
        ?? activeRoot.facts?.where ?? kind ?? "a root";
      els.envActiveRootVal.textContent = fullPath ? `${kindPlain} · ${fullPath}` : kindPlain;
    }
  }
  if (!els.envList) return;
  try {
    const answer = await request("/api/environments");
    const list = answer.environments ?? [];
    els.envList.replaceChildren();
    // The BROWSER environment is a host too — the page worker — and it is the one you are standing
    // in: reachable by construction, always listed first. Its tools are a different set from a
    // machine's, which is exactly what the capability report exists to show.
    const browserRow = document.createElement("li");
    browserRow.className = "env-item";
    const bHead = document.createElement("div");
    bHead.className = "env-head";
    const bDot = document.createElement("span");
    bDot.className = "env-dot";
    bDot.dataset.ok = "true";
    bHead.appendChild(bDot);
    const bName = document.createElement("span");
    bName.className = "env-label";
    bName.textContent = "this browser";
    bHead.appendChild(bName);
    const bState = document.createElement("span");
    bState.className = "env-state";
    bState.textContent = "this page";
    bHead.appendChild(bState);
    browserRow.appendChild(bHead);
    const bCap = document.createElement("span");
    bCap.className = "env-cap-none";
    bCap.textContent = "OPFS + picked folders";
    browserRow.appendChild(bCap);
    els.envList.appendChild(browserRow);
    for (const env of list) {
      const li = document.createElement("li");
      li.className = "env-item";
      // The ROW'S HEAD: name, reachability, and the controls — always visible, never pushed by a report.
      const head = document.createElement("div");
      head.className = "env-head";
      const dot = document.createElement("span");
      dot.className = "env-dot";
      dot.dataset.ok = env.reachable === true ? "true" : env.reachable === false ? "false" : "pending";
      head.appendChild(dot);
      const name = document.createElement("span");
      name.className = "env-label";
      name.textContent = env.label ?? "an environment";
      head.appendChild(name);
      const state = document.createElement("span");
      state.className = "env-state";
      if (env.reachable === true) state.textContent = "reachable";
      else if (env.reachable === false) {
        // "not reachable" is what a person needs; WHICH refusal it was is a diagnostic, and the row
        // already carries one as its title (voicebox-beads-0ye: the identifier was the visible label).
        state.textContent = "not reachable";
        state.title = [env.refused, env.why].filter(Boolean).join(" — ");
      } else state.textContent = env.why ?? "always here";
      head.appendChild(state);
      if (env.key === "local") {
        const reprobeBtn = document.createElement("button");
        reprobeBtn.type = "button";
        reprobeBtn.className = "quiet env-reprobe-btn";
        reprobeBtn.textContent = "Re-probe";
        reprobeBtn.addEventListener("click", async () => {
          reprobeBtn.disabled = true;
          reprobeBtn.textContent = "Probing…";
          try {
            await request("/api/probe", { method: "POST" });
            if (els.envNote) els.envNote.textContent = `Re-probed ${env.label ?? "this machine"}.`;
            await renderEnvironments();
          } catch (err) {
            if (els.envNote) els.envNote.textContent = String(err?.message ?? "could not re-probe this machine");
          } finally {
            reprobeBtn.disabled = false;
            reprobeBtn.textContent = "Re-probe";
          }
        });
        head.appendChild(reprobeBtn);
      } else if (env.key) {
        const removeBtn = document.createElement("button");
        removeBtn.type = "button";
        removeBtn.className = "quiet danger env-remove-btn";
        removeBtn.textContent = "Remove";
        removeBtn.addEventListener("click", async () => {
          removeBtn.disabled = true;
          try {
            await request(`/api/environments/${encodeURIComponent(env.key)}`, { method: "DELETE" });
            if (els.envNote) els.envNote.textContent = `Removed '${env.label ?? env.key}'.`;
            await renderEnvironments();
          } catch (err) {
            if (els.envNote) els.envNote.textContent = String(err?.message ?? "could not remove environment");
          } finally {
            removeBtn.disabled = false;
          }
        });
        head.appendChild(removeBtn);
      }
      li.appendChild(head);
      // WHERE the row points, in plain sight (voicebox-beads-mrr7): two "Worker Alpha" rows on two
      // different hosts are legitimate declarations, and indistinguishable without the origin.
      if (env.key !== "local" && env.origin) {
        const origin = document.createElement("p");
        origin.className = "env-origin";
        origin.textContent = env.origin;
        li.appendChild(origin);
      }
      // The capability report is CONTAINED and SCROLLABLE, and it SUMMARISES: a long probe is a count
      // with the full list behind an expansion, so it never overwrites the name or the actions.
      // voicebox-beads-1jk: presence is not capability. The probe measured what the HOST has; the
      // executor has no program-execution verb, so the row must not read as "my agent can use these".
      const tools = env.capability?.tools;
      if (tools && typeof tools === "object") {
        const present = Object.entries(tools).filter(([, v]) => v && v.value).map(([k]) => k);
        const cap = document.createElement("details");
        cap.className = "env-cap";
        const summary = document.createElement("summary");
        summary.textContent = present.length ? `${present.length} host programs — present, not invocable` : "no programs found on this host";
        cap.appendChild(summary);
        if (present.length) {
          const note = document.createElement("p");
          note.className = "env-cap-note";
          note.textContent = "Present on this host when probed. Voicebox tasks act on files — read, write, list, grep, edit, diff, delete — they cannot run these programs. A delegated harness runs its own tools under its own grants.";
          const full = document.createElement("div");
          full.className = "env-cap-list";
          full.textContent = present.join(", ");
          cap.append(note, full);
        }
        cap.title = `probed ${env.capability.when ?? "at an unknown time"}`;
        li.appendChild(cap);
      } else if (env.reachable !== false) {
        // "not probed" is only worth saying about a host that COULD answer (voicebox-beads-mrr7):
        // a host that is not running cannot be probed, so under an unreachable row the line was
        // noise on top of the state that already says so.
        const cap = document.createElement("span");
        cap.className = "env-cap-none";
        cap.textContent = "not probed";
        li.appendChild(cap);
      }
      els.envList.appendChild(li);
    }
    if (els.envCount) {
      const up = list.filter((e) => e.reachable === true).length;
      els.envCount.textContent = `${list.length + 1} environments · ${up + 1} reachable`;
    }
    if (els.envNote) els.envNote.textContent = "";
    // AUTO-PROBE: a reachable environment that has never been probed is asked to probe itself, on
    // first reach (Paul: automatically, not a button). The act is recorded in the environment's own
    // audit by the host; here we only re-render once the report exists. This loop is the local
    // server today; a remote environment's report rides its own /api/probe the same way.
    const unprobed = list.filter((e) => e.reachable === true && !e.capability);
    if (unprobed.some((e) => e.key === "local")) {
      request("/api/probe").then(() => renderEnvironments()).catch(() => {});
    }
  } catch (err) {
    // The registry could not be read, or the server is not answering: the refusal is named, not blank.
    if (els.envCount) els.envCount.textContent = "Environments";
    if (els.envNote) els.envNote.textContent = String(err?.message ?? "the environment list could not be read");
    throw err;
  }
}

async function health() {
  try {
    const answer = await request("/api/health");
    if (els.dot) els.dot.dataset.ok = "true";
    // State is derived from GET /api/health's provider and build fields:
    // the indicator names the agent provider so it is visible whether the
    // provider side is configured and ready.
    const provider = answer.provider || "agent";
    if (els.where) {
      els.where.textContent = `agent: ${provider}`;
      els.where.title = `source: GET /api/health · provider: ${provider}, build: ${answer.build?.commit || "dev"}`;
    }
    window.__voiceboxServerBuild = answer.build ?? null;
    stampBuild(answer.build ?? null);
    renderAbout();
    await loadRoot();
    await renderEnvironments();
    await renderExtensions();
  } catch (err) {
    if (els.dot) els.dot.dataset.ok = "false";
    if (els.where) {
      // The VISIBLE line says what happened, in words; the identifier the server used lives in the
      // title, where somebody diagnosing can find it and nobody else has to read it (voicebox-beads-0ye:
      // `environment-list-unreadable (fix the file)` was on screen, and `machine-unreachable (fix the
      // host)` was a hard-coded identifier that no source-literal check was even looking for).
      if (err?.refused) {
        els.where.textContent = "the environment list could not be read — fix the file";
        els.where.title = `source: GET /api/environments · ${err.refused}: ${err.why || "fix the file"}`;
      } else {
        els.where.textContent = "the machine is not answering — fix the host";
        els.where.title = "source: GET /api/health · machine-unreachable — the local server is not answering, fix the host";
      }
    }
    stampBuild(null);
    if (els.rootKind) els.rootKind.textContent = "folder unknown";
    if (els.dot) els.dot.dataset.ok = "false";
    renderEmptyState();
    if (els.rootNote) {
      els.rootNote.textContent = err?.refused
        ? `The local server reported ${err.refused}: ${err.why || "fix the file"}.`
        : "The local server is not answering (machine-unreachable), so which folder it saves into cannot be checked.";
      els.rootNote.dataset.tone = "warn";
      els.rootNote.hidden = false;
    }
  }
}

async function load() {
  if (entries.length === 0) showSkeleton();
  try {
    // One request for names AND sizes. Before the server had a read route this
    // read every file back through `POST /api/turn`, so a loaded page quietly
    // POSTed turns nobody typed — an independent verifier saw eight of them and
    // a `read alpha.txt` that was never spoken. Reading is not a turn.
    const answer = await request(`/api/files${listingDir ? `?dir=${encodeURIComponent(listingDir)}` : ""}`);
    // A LISTING CAN BE REFUSED, and then there is no listing to attribute. This
    // used to fall through and render "listed from an unnamed root" — a claim
    // about a listing that never happened, in front of an empty list.
    if (answer.ok === false) {
      listingRefusal = { refused: answer.refused ?? "listing-refused", why: answer.why ?? "", root: answer.root ?? null };
      listedRoot = null;
      entries = [];
      render();
      return;
    }
    listingRefusal = null;
    showAllFiles = false;
    // THE ANSWER SAYS WHICH FOLDER IT LISTED, and the page adopts that rather than trusting the path it
    // asked for: the server normalises it, so `proposals//drafts/` and `proposals/drafts` cannot leave the
    // crumb bar and the list describing different folders (voicebox-beads-tee).
    if (typeof answer.dir === "string") listingDir = answer.dir;
    void reportProjectContext();
    // The server says which root it listed, so the page records it rather than
    // assuming it is the active one. When they differ, the cards are a listing of
    // somewhere else and the panel says so (acceptance 7cd.1: an explorer must
    // state WHICH ROOT it is showing).
    listedRoot = answer.root ?? null;
    // The server's listing is authoritative about WHICH root it listed, so when
    // the header has not caught up (the environment page re-declared the project
    // while this page sat open) the page syncs to the listing rather than showing
    // a header that disagrees with the cards under it.
    const activeWhere = activeRoot?.root?.path ?? activeRoot?.root?.name ?? activeRoot?.root?.label ?? "";
    const listedWhere = listedRoot?.path ?? listedRoot?.name ?? listedRoot?.label ?? "";
    if (listedWhere && activeWhere !== listedWhere) await loadRoot();
    const kinds = new Map((answer.entries ?? []).map((entry) => [entry.name, entry]));
    entries = (answer.files ?? []).map((name) => {
      const entry = kinds.get(name) ?? {};
      const isDir = entry.kind === "directory";
      return {
        name,
        isDir,
        meta: isDir ? "folder" : `${entry.bytes ?? 0} ${(entry.bytes ?? 0) === 1 ? "byte" : "bytes"}`,
      };
    });
    render();
    void refreshCatalogMiniApps();
  } catch (error) {
    entries = [];
    lastRenderedFilesSig = null;
    els.made.dataset.state = "failed";
    els.files.replaceChildren();
    els.files.setAttribute("aria-busy", "false");
    els.count.textContent = "could not read the folder";
  }
}

/**
 * WHOSE BYTES THESE ARE. `via` says which side performed the read: the server's own disk, or the page
 * that holds a picked folder. "read from disk" was already a lie once, for a source that was not the
 * server's — so the line names the side rather than assuming it.
 */
function readProvenance(via) {
  return via === "page" ? "read by the tab that holds this folder" : "read from disk";
}

/** How to name a file's home in one string, whatever kind of root it is. */
// The same reader, reading from the folder this tab opened: the facts say which
// source and that it is read-only, because "read from disk" was already a lie
// once for a source that was not the server's.
function isCurrentFileEditable() {
  if (!shownFile || els.reader?.dataset.error === "true") return false;
  if (roomFolder) {
    return roomFolder.permission === "granted" && roomFolder.mode === "readwrite";
  }
  return activeRoot === undefined
    || activeRoot?.reachableFromThisProcess === true
    || (activeRoot?.actsVia === "page" && activeRoot?.executor?.connected === true);
}

const isHtmlFileName = (name) => /\.html?$/i.test(String(name ?? "").trim());

function normalizeMiniAppKey(raw) {
  const cleaned = String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/\.html?$/i, "")
    .replace(/^(?:app_|file_)/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned ? `app_${cleaned}` : "";
}

let catalogMiniApps = [];

async function refreshCatalogMiniApps() {
  try {
    const res = await fetch("/api/mini-apps", { signal: AbortSignal.timeout(6000) });
    if (!res.ok) return;
    const data = await res.json().catch(() => null);
    if (data && Array.isArray(data.miniApps)) {
      catalogMiniApps = data.miniApps;
      if (typeof sqehSyncMiniApps === "function") sqehSyncMiniApps();
    }
  } catch {
    // Optional endpoint; ignore when unavailable
  }
}

function syncMiniAppAfterFileSave(fileName, content) {
  // ASK FOR THE NAME THE SAVE API TAKES: ONE name inside the root (voicebox-beads-m4no). The
  // caller hands the SHOWN path, which is the folder-joined 'proposals/draft.html' whenever the
  // reader was inside a folder; posting that used to make the server basename-rewrite it into a
  // misnamed duplicate at the root, and after owit's tightening it is refused 400 — with the old
  // fire-and-forget catch swallowing the status, a file saved inside a folder silently lost its
  // shelf/workspace sync. The leaf IS the file the user just saved; the folder is placement,
  // which the save API refuses by design.
  const name = miniAppSyncName(fileName);
  if (!isHtmlFileName(name)) return;
  const norm = normalizeMiniAppKey(name);
  void fetch("/api/mini-apps", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ fileName: name, title: name, html: content }),
  }).then((r) => {
    // A REFUSED SYNC IS NAMED, NOT SWALLOWED (the old .catch(() => {}) is how a 400 hid): the
    // file itself was already saved — this is the shelf/workspace copy that did not land.
    if (!r.ok) console.warn(`[mini-app-sync] shelf sync for '${name}' was refused (${r.status}) — the file itself was saved`);
  }).catch(() => {});
  let matchedDesc = null;
  for (const [k, v] of launchedMiniApps.entries()) {
    const vNorm = normalizeMiniAppKey(v.fileName || v.title || k);
    if (v.fileName === name || v.title === name || (norm && vNorm === norm)) {
      v.html = content;
      matchedDesc = v;
    }
  }
  const current = miniAppController?.getDescriptor?.();
  if (current) {
    const curNorm = normalizeMiniAppKey(current.fileName || current.title || current.appId);
    if (current.fileName === name || current.title === name || (norm && curNorm === norm)) {
      miniAppController.mount({ ...current, fileName: name, html: content });
      return;
    }
  }
  if (matchedDesc && typeof sqehSyncMiniApps === "function") {
    sqehSyncMiniApps();
  }
}

function syncReaderBubble() {
  if (!els.sqehReaderBubble) return;
  const ready = els.reader?.dataset.state === "ready";
  if (!ready) {
    els.sqehReaderBubble.hidden = true;
    els.sqehReaderBubble.setAttribute("aria-expanded", "false");
    els.sqehReaderBubble.setAttribute("aria-selected", "false");
    return;
  }
  const label = shownFile || els.readerTitle?.textContent || "File";
  if (els.sqehReaderBubbleName) els.sqehReaderBubbleName.textContent = label;
  els.sqehReaderBubble.hidden = false;
  const expanded = els.reader?.dataset.collapsed !== "true";
  els.sqehReaderBubble.setAttribute("aria-expanded", String(expanded));
  els.sqehReaderBubble.setAttribute("aria-selected", String(expanded));
}

function syncFileRunAppButton() {
  syncReaderBubble();
  if (!els.fileRunApp) return;
  const canRun = Boolean(shownFile && isHtmlFileName(shownFile) && els.reader?.dataset.state === "ready" && els.reader?.dataset.error !== "true");
  els.fileRunApp.hidden = !canRun;
  els.fileRunApp.disabled = !canRun;
}

async function launchWorkspaceHtmlMiniApp(name) {
  if (!name || !miniAppController) return;
  try {
    let html = "";
    if (roomFolder) {
      const read = await readRoomFile(name);
      html = read?.text ?? "";
    } else {
      const answer = await request(`/api/file?name=${encodeURIComponent(name)}`);
      if (!answer?.ok) {
        setReport(reasonFrom(answer, `could not open mini-app '${name}'`), "bad");
        return;
      }
      html = answer.content ?? "";
    }
    miniAppController.mount({
      appId: `file_${name.replace(/[^a-zA-Z0-9_-]/g, "_")}`,
      title: name,
      fileName: name,
      source: "workspace",
      html,
    });
  } catch (error) {
    setReport(`Could not launch mini-app '${name}': ${error?.message ?? error}`, "bad");
  }
}

function exitEditMode() {
  if (els.reader) els.reader.dataset.editing = "false";
  if (els.fileEditor) els.fileEditor.hidden = true;
  if (els.readerBody) els.readerBody.hidden = false;
  if (els.fileSave) els.fileSave.hidden = true;
  if (els.fileCancelEdit) els.fileCancelEdit.hidden = true;
  if (els.fileEdit) {
    els.fileEdit.hidden = false;
    els.fileEdit.disabled = !isCurrentFileEditable();
  }
}

async function showRoomFile(name, { reloading = false } = {}) {
  const seq = ++fileReadSeq;
  shownFile = name;
  exitEditMode();
  if (els.reader) delete els.reader.dataset.collapsed;
  els.copy.disabled = true;
  if (els.fileDownload) els.fileDownload.disabled = true;
  if (els.fileEdit) els.fileEdit.disabled = true;
  if (els.fileRefresh) {
    els.fileRefresh.disabled = true;
    if (reloading) {
      els.fileRefresh.setAttribute("aria-busy", "true");
      els.fileRefresh.textContent = "Reloading…";
    }
  }
  if (reloading && els.reader) els.reader.dataset.loading = "true";
  if (!reloading) els.reader.dataset.state = "empty";
  els.reader.dataset.error = "false";
  els.readerTitle.textContent = name;
  els.readerFacts.textContent = reloading ? "Reloading…" : "Reading…";
  if (!reloading) els.readerBody.textContent = "";
  syncFileRunAppButton();
  showFileSelection(name);
  try {
    const { text, bytes, truncated } = await readRoomFile(name);
    if (seq !== fileReadSeq || shownFile !== name) return;
    const modeLabel = roomFolder.mode === "readwrite" ? "read/write" : "read-only";
    els.readerFacts.textContent = `${bytes} ${bytes === 1 ? "byte" : "bytes"}${truncated ? ` (showing the first ${Math.round(ROOM_FILE_MAX_BYTES / 1024)} KB)` : ""} · read from '${roomFolder.name}' in this tab (${modeLabel})`;
    els.readerFacts.title = "";
    els.readerBody.textContent = text;
    els.reader.dataset.state = "ready";
    els.reader.dataset.error = "false";
    els.copy.disabled = text.length === 0;
    if (els.fileDownload) els.fileDownload.disabled = text.length === 0;
    if (els.fileEdit) els.fileEdit.disabled = !isCurrentFileEditable();
    if (els.readerDetails) els.readerDetails.open = true;
  } catch (error) {
    if (seq !== fileReadSeq || shownFile !== name) return;
    const sentence = `Could not read '${name}' in '${roomFolder.name}': ${error?.message ?? error}`;
    els.readerFacts.textContent = sentence;
    els.readerBody.textContent = sentence;
    els.reader.dataset.state = "ready";
    els.reader.dataset.error = "true";
    els.copy.disabled = true;
    if (els.fileDownload) els.fileDownload.disabled = true;
    if (els.fileEdit) els.fileEdit.disabled = true;
    if (els.readerDetails) els.readerDetails.open = true;
  } finally {
    if (seq === fileReadSeq && shownFile === name) {
      if (els.fileRefresh) {
        els.fileRefresh.disabled = false;
        els.fileRefresh.removeAttribute("aria-busy");
        els.fileRefresh.textContent = "Reload";
      }
      if (els.reader) els.reader.dataset.loading = "false";
      syncFileRunAppButton();
    }
  }
}

function rootLabel() {
  const root = activeRoot?.root;
  if (!root) return "";
  const base = root.path ?? root.name ?? root.label ?? "";
  if (!base) return "";
  return `${base.replace(/\/$/, "")}/`;
}

async function showFile(name, { reloading = false } = {}) {
  const seq = ++fileReadSeq;
  shownFile = name;
  exitEditMode();
  if (els.reader) delete els.reader.dataset.collapsed;
  if (roomFolder) return showRoomFile(name, { reloading });
  els.copy.disabled = true;
  if (els.fileDownload) els.fileDownload.disabled = true;
  if (els.fileEdit) els.fileEdit.disabled = true;
  if (els.fileRefresh) {
    els.fileRefresh.disabled = true;
    if (reloading) {
      els.fileRefresh.setAttribute("aria-busy", "true");
      els.fileRefresh.textContent = "Reloading…";
    }
  }
  if (reloading && els.reader) els.reader.dataset.loading = "true";
  if (!reloading) els.reader.dataset.state = "empty";
  els.reader.dataset.error = "false";
  els.readerTitle.textContent = name;
  els.readerFacts.textContent = reloading ? "Reloading…" : "Reading…";
  if (!reloading) els.readerBody.textContent = "";
  syncFileRunAppButton();
  showFileSelection(name);
  try {
    const answer = await request(`/api/file?name=${encodeURIComponent(name)}`);
    if (seq !== fileReadSeq || shownFile !== name) return;
    if (answer.ok) {
      const content = answer.content ?? "";
      // One short line: on a phone the old facts wrapped to five lines above a
      // two-line note (astra's landing review). The path is the title.
      els.readerFacts.textContent = `${size(content)} · ${readProvenance(answer.via)}`;
      els.readerFacts.title = `${rootLabel()}${name}, read just now`;
      els.readerBody.textContent = content;
      els.reader.dataset.state = "ready";
      els.reader.dataset.error = "false";
      els.copy.disabled = content.length === 0;
      if (els.fileDownload) els.fileDownload.disabled = content.length === 0;
      if (els.fileEdit) els.fileEdit.disabled = !isCurrentFileEditable();
    } else {
      // A FAILED read puts the reason where the file's text would have been.
      // The facts line lives behind the Details disclosure (right for a
      // successful read — the bytes are the content), so a failure that only
      // wrote there was invisible until a person opened a disclosure to find
      // out why the panel was empty. The reason IS the content of a failure.
      const reason = reasonFrom(answer, "the server would not read this file");
      els.readerFacts.textContent = reason;
      els.readerBody.textContent = reason;
      els.reader.dataset.state = "ready";
      els.reader.dataset.error = "true";
      els.copy.disabled = true;
      if (els.fileDownload) els.fileDownload.disabled = true;
      if (els.fileEdit) els.fileEdit.disabled = true;
      if (els.readerDetails) els.readerDetails.open = true;
    }
  } catch (error) {
    if (seq !== fileReadSeq || shownFile !== name) return;
    // Name the place the file is actually supposed to be. This said
    // "workspace/" long after the loop stopped having a root of its own —
    // driven to it by vb-e1m0 on 2026-09-20: with the root at /tmp/prose2 the
    // reader said "Could not read workspace/gone.txt", which sends a person to
    // look in a folder the project does not live in.
    const where = rootLabel();
    const sentence = `Could not read ${where}${name}${where ? "" : " in the project folder"}: ${error.message}`;
    els.readerFacts.textContent = sentence;
    els.readerBody.textContent = sentence;
    els.reader.dataset.state = "ready";
    els.reader.dataset.error = "true";
    els.copy.disabled = true;
    if (els.fileDownload) els.fileDownload.disabled = true;
    if (els.fileEdit) els.fileEdit.disabled = true;
    if (els.readerDetails) els.readerDetails.open = true;
  } finally {
    if (seq === fileReadSeq && shownFile === name) {
      if (els.fileRefresh) {
        els.fileRefresh.disabled = false;
        els.fileRefresh.removeAttribute("aria-busy");
        els.fileRefresh.textContent = "Reload";
      }
      if (els.reader) els.reader.dataset.loading = "false";
      syncFileRunAppButton();
    }
  }
}

async function refreshCurrentFile() {
  if (!shownFile) return;
  if (roomFolder) {
    await showRoomFile(shownFile, { reloading: true });
  } else {
    await showFile(shownFile, { reloading: true });
  }
}

on(els.fileRefresh, "click", refreshCurrentFile);

on(els.fileRunApp, "click", () => {
  if (!shownFile || !miniAppController) return;
  const html = els.reader?.dataset.editing === "true" && els.fileEditor
    ? els.fileEditor.value
    : (els.readerBody?.textContent ?? "");
  if (!html.trim()) return;
  miniAppController.mount({
    appId: `file_${shownFile.replace(/[^a-zA-Z0-9_-]/g, "_")}`,
    title: shownFile,
    fileName: shownFile,
    source: "workspace",
    html,
  });
});

on(els.fileEdit, "click", () => {
  if (!isCurrentFileEditable() || !els.fileEditor) return;
  els.fileEditor.value = els.readerBody?.textContent ?? "";
  if (els.reader) els.reader.dataset.editing = "true";
  if (els.readerBody) els.readerBody.hidden = true;
  els.fileEditor.hidden = false;
  if (els.fileEdit) els.fileEdit.hidden = true;
  if (els.fileSave) {
    els.fileSave.hidden = false;
    els.fileSave.disabled = false;
  }
  if (els.fileCancelEdit) els.fileCancelEdit.hidden = false;
  els.fileEditor.focus();
});

on(els.fileCancelEdit, "click", () => {
  exitEditMode();
});

async function saveEditedFile() {
  if (!shownFile || !els.fileEditor || els.reader?.dataset.editing !== "true") return;
  const content = els.fileEditor.value;
  if (els.fileSave) {
    els.fileSave.disabled = true;
    els.fileSave.textContent = "Saving…";
  }
  try {
    if (roomFolder) {
      const written = await writeRoomFile(shownFile, content);
      const durable = await durableFact();
      els.readerBody.textContent = content;
      els.copy.disabled = content.length === 0;
      if (els.fileDownload) els.fileDownload.disabled = content.length === 0;
      const modeLabel = roomFolder.mode === "readwrite" ? "read/write" : "read-only";
      els.readerFacts.textContent = `${written.bytes} ${written.bytes === 1 ? "byte" : "bytes"} · saved to '${roomFolder.name}' in this tab (${modeLabel})`;
      exitEditMode();
      finish(`save ${shownFile}`, `wrote ${shownFile} (${size(written.bytes)} observed) in ${roomFolder.name}${durable}`, "good");
      sqehArtifactChip(shownFile, { verb: "edit", content, bytes: written.bytes });
      syncMiniAppAfterFileSave(shownFile, content);
      await loadRoomFolder();
      return;
    }
    const answer = await request("/api/file", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: shownFile, content }),
    });
    if (!answer.ok) {
      const reason = reasonFrom(answer, answer.error ?? "the server refused the save");
      els.readerFacts.textContent = reason;
      if (els.readerDetails) els.readerDetails.open = true;
      setReport(reason, "bad");
      return;
    }
    els.readerBody.textContent = content;
    els.copy.disabled = content.length === 0;
    if (els.fileDownload) els.fileDownload.disabled = content.length === 0;
    els.readerFacts.textContent = `${size(content)} · saved just now`;
    exitEditMode();
    const landed = answer.root?.path ?? answer.root?.name ?? answer.root?.label ?? "";
    finish(`save ${shownFile}`, `${answer.action || `wrote ${shownFile}`}${landed ? ` in ${landed}` : ""}`, "good");
    sqehArtifactChip(shownFile, { verb: "edit", content });
    syncMiniAppAfterFileSave(shownFile, content);
    await load();
  } catch (error) {
    const reason = `Could not save ${shownFile}: ${error?.message ?? error}`;
    els.readerFacts.textContent = reason;
    if (els.readerDetails) els.readerDetails.open = true;
    setReport(reason, "bad");
  } finally {
    if (els.fileSave) {
      els.fileSave.disabled = false;
      els.fileSave.textContent = "Save";
    }
  }
}

on(els.fileSave, "click", () => void saveEditedFile());

on(els.fileEditor, "keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
    e.preventDefault();
    void saveEditedFile();
  } else if (e.key === "Escape") {
    e.preventDefault();
    exitEditMode();
  }
});

on(els.copy, "click", async () => {
  try {
    const text = els.reader?.dataset.editing === "true" && els.fileEditor
      ? els.fileEditor.value
      : (els.readerBody.textContent ?? "");
    await navigator.clipboard.writeText(text);
    els.readerFacts.textContent = `Copied ${shownFile || els.readerTitle?.textContent || "contents"} to the clipboard.`;
  } catch (error) {
    els.readerFacts.textContent = `The clipboard refused: ${error.message}`;
  }
});

on(els.fileDownload, "click", () => {
  const text = els.reader?.dataset.editing === "true" && els.fileEditor
    ? els.fileEditor.value
    : (els.readerBody?.textContent ?? "");
  if (!text) return;
  const rawName = shownFile || els.readerTitle?.textContent || "voicebox-output.txt";
  const fileName = String(rawName).split("/").pop()?.replace(/[^\w.-]+/g, "-") || "voicebox-output.txt";
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  if (els.readerFacts) els.readerFacts.textContent = `Downloaded ${fileName}.`;
});

on(els.sessionCopy, "click", () => {
  openTranscriptDialog({ logElement: els.log });
});

on(els.close, "click", () => {
  ++fileReadSeq;
  shownFile = null;
  exitEditMode();
  delete els.reader.dataset.collapsed;
  els.reader.dataset.state = "empty";
  els.reader.dataset.error = "false";
  els.reader.dataset.loading = "false";
  els.readerBody.textContent = "";
  els.readerFacts.textContent = "";
  els.copy.disabled = true;
  if (els.fileDownload) els.fileDownload.disabled = true;
  if (els.fileEdit) els.fileEdit.disabled = true;
  if (els.fileRefresh) {
    els.fileRefresh.disabled = true;
    els.fileRefresh.removeAttribute("aria-busy");
    els.fileRefresh.textContent = "Reload";
  }
  syncFileRunAppButton();
  showFileSelection(null);
  document.querySelector(".file-open")?.focus();
});

function presentInspectionInReader(verb, result, action) {
  let title = "";
  let facts = "";
  let body = "";
  if (verb === "grep") {
    const q = result.query ?? action?.query ?? "";
    const matches = Array.isArray(result.matches) ? result.matches : [];
    const count = result.count ?? matches.length;
    title = `Search for “${q}”`;
    facts = `${count} ${count === 1 ? "match" : "matches"}${result.truncated ? " · showing the first 100" : ""}`;
    body = matches.length === 0
      ? `No matches for “${q}”.`
      : matches.map((m) => `${m.file}:${m.line}: ${m.text}`).join("\n");
  } else if (verb === "diff") {
    const file = result.file ?? action?.name ?? "file";
    title = `Diff of ${file}`;
    facts = `${result.changed ? "Changes found" : "No changes"} · ${readProvenance(result.via)}`;
    body = result.diff || (result.changed ? "" : "No differences.");
  } else if (verb === "git_status") {
    const files = Array.isArray(result.files) ? result.files : [];
    title = `Git status (${result.branch || "current branch"})`;
    const parts = [
      result.dirty ? `${files.length} changed ${files.length === 1 ? "file" : "files"}` : "Clean working tree",
      ...(result.upstream ? [`tracking ${result.upstream}`] : []),
      ...(result.ahead ? [`${result.ahead} ahead`] : []),
      ...(result.behind ? [`${result.behind} behind`] : []),
    ];
    facts = parts.join(" · ");
    body = files.length === 0
      ? "Working tree clean."
      : files.map((f) => `${String(f.status || "?").padEnd(3, " ")}${f.path}${f.staged ? " (staged)" : ""}`).join("\n");
  } else if (verb === "git_diff") {
    title = `Git diff${result.staged ? " (staged)" : ""}${result.file ? ` — ${result.file}` : ""}`;
    facts = result.empty ? "No differences" : size(result.diff ?? "");
    body = result.empty ? "No differences." : (result.diff ?? "");
  } else if (verb === "git_log") {
    const commits = Array.isArray(result.commits) ? result.commits : [];
    const count = result.count ?? commits.length;
    title = "Git history";
    facts = `${count} ${count === 1 ? "commit" : "commits"}`;
    body = commits.length === 0
      ? "No commits found."
      : commits.map((c) => `${String(c.hash ?? "").slice(0, 7)}  ${c.date ? String(c.date).slice(0, 10) : ""}  ${c.author ?? ""} — ${c.message ?? ""}`).join("\n");
  } else if (verb === "list_agents") {
    const agents = Array.isArray(result.agents) ? result.agents : [];
    const count = result.count ?? agents.length;
    title = "Available agents";
    facts = `${count} ${count === 1 ? "agent" : "agents"}`;
    body = agents.length === 0
      ? "No agents listed."
      : agents.map((a) => `${a.name || a.id || a.targetKey || "agent"}${a.environmentKey ? ` (${a.environmentKey})` : ""}${a.status ? ` — ${a.status}` : ""}${a.description ? `\n  ${a.description}` : ""}`).join("\n");
  } else if (verb === "inspect_environment" && result.environment) {
    const env = result.environment;
    title = "Environment details";
    facts = env.platform || "current environment";
    const toolLines = Object.entries(env.tools ?? {})
      .filter(([, v]) => v)
      .map(([k, v]) => `  ${k}: ${v}`);
    body = [
      `Platform: ${env.platform ?? "unknown"}`,
      `Node: ${env.nodeVersion ?? "unknown"}`,
      `Folder: ${env.cwd ?? "unknown"}`,
      ...(env.limits?.cpuCount ? [`CPUs: ${env.limits.cpuCount}`] : []),
      ...(toolLines.length ? ["Tools:", ...toolLines] : []),
    ].join("\n");
  } else if (verb === "exec") {
    const cmd = result.command ?? action?.command ?? action?.name ?? "command";
    const out = [result.stdout ?? result.output ?? "", result.stderr ?? ""].filter(Boolean).join("\n").trimEnd();
    if (!out) return false;
    title = `Output of ${cmd}`;
    const code = result.exitCode ?? result.code ?? 0;
    facts = `Exit ${code}${result.durationMs != null ? ` · ${result.durationMs} ms` : ""} · ${size(out)}`;
    body = out;
  } else if (verb === "list_tools" || verb === "search_tools") {
    const tools = Array.isArray(result.tools) ? result.tools : (Array.isArray(result.matches) ? result.matches : []);
    const count = result.count ?? tools.length;
    const q = result.query ?? action?.query ?? action?.name ?? "";
    title = verb === "search_tools" && q ? `Tools matching “${q}”` : "Available tools";
    facts = `${count} ${count === 1 ? "tool" : "tools"}`;
    body = tools.length === 0
      ? (q ? `No tools matching “${q}”.` : "No tools available.")
      : tools.map((t) => `${t.name || t.verb || t.id || "tool"}${t.category || t.kind ? ` [${t.category || t.kind}]` : ""}${t.description || t.summary ? ` — ${t.description || t.summary}` : ""}`).join("\n");
  } else {
    return false;
  }
  ++fileReadSeq;
  shownFile = null;
  exitEditMode();
  delete els.reader.dataset.collapsed;
  els.readerTitle.textContent = title;
  els.readerFacts.textContent = facts;
  els.readerFacts.title = "";
  els.readerBody.textContent = body;
  els.reader.dataset.state = "ready";
  els.reader.dataset.error = "false";
  els.reader.dataset.loading = "false";
  els.copy.disabled = body.length === 0;
  if (els.fileDownload) els.fileDownload.disabled = body.length === 0;
  if (els.fileRefresh) {
    els.fileRefresh.disabled = true;
    els.fileRefresh.removeAttribute("aria-busy");
    els.fileRefresh.textContent = "Reload";
  }
  if (els.fileEdit) els.fileEdit.disabled = true;
  syncFileRunAppButton();
  showFileSelection(null);
  return true;
}

function renderRead(fileName, content, via) {
  ++fileReadSeq;
  shownFile = fileName;
  exitEditMode();
  if (els.reader) delete els.reader.dataset.collapsed;
  els.readerTitle.textContent = fileName;
  els.readerFacts.textContent = `${size(content)} · ${readProvenance(via)}`;
  els.readerFacts.title = `${rootLabel()}${fileName}, read just now`;
  els.readerBody.textContent = content;
  els.reader.dataset.state = "ready";
  els.reader.dataset.error = "false";
  els.reader.dataset.loading = "false";
  els.copy.disabled = content.length === 0;
  if (els.fileDownload) els.fileDownload.disabled = content.length === 0;
  if (els.fileRefresh) {
    els.fileRefresh.disabled = false;
    els.fileRefresh.removeAttribute("aria-busy");
    els.fileRefresh.textContent = "Reload";
  }
  if (els.fileEdit) els.fileEdit.disabled = !isCurrentFileEditable();
  syncFileRunAppButton();
  showFileSelection(fileName);
}

// ── the turns ──────────────────────────────────────────────────────────────
function logTurn(said, outcome) {
  const li = document.createElement("li");
  const quote = document.createElement("span");
  quote.className = "said";
  quote.textContent = `“${said}”`;
  const did = document.createElement("span");
  did.className = "did";
  did.textContent = outcome;
  li.append(quote, did);
  if (!els.log || !els.session) return;
  els.log.prepend(li);
  while (els.log.children.length > 50) els.log.lastElementChild.remove();
}

function finish(said, outcome, tone) {
  recordDebug({ type: "turn.presented", transcript: said, outcome, severity: tone === "bad" ? "error" : "info" });
  setReport(outcome, tone, said);
  logTurn(said, outcome);
  appendWorkActivity({
    kind: tone === "bad" ? "error" : "turn",
    label: tone === "bad" ? "Refusal" : "Turn",
    summary: said ? `“${said}” → ${outcome}` : outcome,
  });
}

/**
 * WHAT A FILE-CREATION COMMAND LOOKS LIKE — one regex, two callers (voicebox-beads-vnos): the room-folder
 * branch reads it when a folder is open, and the scratchpad fallback reads it when nothing can take a
 * write. It is the same shape `lib/resolver.mjs`'s script resolver parses, deliberately: the page and the
 * loop must not disagree about what "create a file called X with Y" means.
 */
const FILE_WRITE_COMMAND = /(?:create|write|make)\s+(?:a\s+)?(?:file\s+)?(?:called\s+)?["']?([\w./-]+)["']?\s*(?:with|containing)?\s*(.*)/i;

/** The name and content a file-creation command carries, stripped of its framing words and its quotes. */
function readWriteCommand(match) {
  const [, name, rest] = match;
  return { name, content: rest.replace(/^(with|containing)\s+/i, "").replace(/^["']|["']$/g, "") };
}

/**
 * IS THERE A DECLARED ROOT THAT CAN TAKE A WRITE FROM HERE? The page reads `/api/root` (`loadRoot`), so this
 * is knowledge rather than a guess: `null` is "nobody has declared one", and a listing the server refused
 * with `root-not-declared` is the same fact arriving by another route. `undefined` — the question has not
 * been answered yet — is NOT a no: a turn in that window goes to the server exactly as before, which is the
 * only answer that cannot be wrong about a root this page has not heard about yet.
 *
 * A root that EXISTS but cannot act is deliberately not a fallback case: the room keeps its named refusal
 * ("the tab that holds this folder is not open"), because quietly writing the file into different storage
 * would answer a question nobody asked, with a folder nobody chose.
 */
function noRootToWriteInto() {
  return activeRoot === null || listingRefusal?.refused === "root-not-declared";
}

async function send(said) {
  const transcript = said.trim();
  if (!transcript) return;

  // Non-speech status / cancel commands work from input without speech (voicebox-beads-snp)
  const statusMatch = transcript.match(/^(?:task\s+status|status)\s+(task_[a-zA-Z0-9_.-]+)$/i);
  if (statusMatch && taskCardController) {
    const address = statusMatch[1];
    setReport("Checking task status…");
    await taskCardController.status(address);
    finish(transcript, "checked task status", "good");
    return;
  }
  const cancelMatch = transcript.match(/^(?:cancel\s+task|cancel)\s+(task_[a-zA-Z0-9_.-]+)$/i);
  if (cancelMatch && taskCardController) {
    const address = cancelMatch[1];
    setReport("Cancelling task…");
    await taskCardController.cancel(address);
    finish(transcript, "cancel requested", "good");
    return;
  }

  if (els.send) { els.send.disabled = true; els.send.textContent = "Sending…"; }
  setReport("Sending…");

  // ONE READ OF WHAT WAS ASKED FOR (voicebox-beads-vnos): the room's own file command, parsed once for the
  // folder branch and for the scratchpad fallback below, so the two cannot drift. Tool and extension creation
  // phrasings ("create a tool...", "create an extension...") always belong to the server turn route.
  const isToolOrExtensionTurn = /^(?:create|write|make|propose|build|install|load|enable|stage|add)\s+(?:an?\s+|the\s+)?(?:catalogue\s+)?(?:tool|extension)\b/i.test(transcript);
  const writeMatch = isToolOrExtensionTurn ? null : transcript.match(FILE_WRITE_COMMAND);

  // If a room folder is currently active, turns act on that folder directly (voicebox-beads-69d, voicebox-beads-0eza)
  if (roomFolder) {
    if (writeMatch) {
      const { name: fileName, content } = readWriteCommand(writeMatch);
      if (roomFolder.permission !== "granted" || roomFolder.mode !== "readwrite") {
        if (els.send) { els.send.textContent = "Send"; els.send.disabled = !els.utterance.value.trim(); }
        return finish(transcript, `needs-gesture: '${roomFolder.name}' needs write permission — click 'Restore access' first`, "bad");
      }
      // WHERE DOES IT GO? Into the folder you are LOOKING AT (voicebox-beads-s61). The command names a
      // file, not a folder, so a write made while standing in `proposals` landing at the root was the
      // room quietly ignoring where the person was — the same class of lie as a listing that will not
      // name its root. A name that already carries a path is honoured as itself.
      const target = fileName.includes("/") ? fileName : joinDir(listingDir, fileName);
      try {
        const written = await writeRoomFile(target, content);
        // THE OBSERVED SIZE, not the intended one: the number in this line is what the file system said.
        const durable = await durableFact();
        // `size()` takes a NUMBER as a number and a string as text; `bytes()` counts a STRING, and handing it
        // the number 12 counted the two characters of "12" — a line reporting "2 observed" for a 12-byte
        // write, which is worse than no line (found by reading the file back and comparing).
        finish(transcript, `wrote ${target} (${size(written.bytes)} observed) in ${roomFolder.name}${durable}`, "good");
        sqehArtifactChip(target, { verb: "write", content, bytes: written.bytes });
        await loadRoomFolder();
      } catch (err) {
        finish(transcript, `could not write '${target}': ${err?.message ?? err}`, "bad");
      } finally {
        if (els.send) { els.send.textContent = "Send"; els.send.disabled = !els.utterance.value.trim(); }
      }
      return;
    }
    const readMatch = transcript.match(/^read\s+["']?([\w./-]+)["']?$/i);
    if (readMatch) {
      const named = readMatch[1];
      // Same rule as the write: a bare name means "here, where I am standing".
      const fileName = named.includes("/") ? named : joinDir(listingDir, named);
      try {
        await showFile(fileName);
        finish(transcript, `read ${fileName} in ${roomFolder.name}`, "good");
      } catch (err) {
        finish(transcript, `could not read '${fileName}': ${err?.message ?? err}`, "bad");
      } finally {
        if (els.send) { els.send.textContent = "Send"; els.send.disabled = !els.utterance.value.trim(); }
      }
      return;
    }
    const localOp = parseRoomFolderTurn(transcript);
    if (localOp) {
      const needsWrite = localOp.verb === "delete" || localOp.verb === "edit" || localOp.verb === "undo";
      if (needsWrite && (roomFolder.permission !== "granted" || roomFolder.mode !== "readwrite")) {
        if (els.send) { els.send.textContent = "Send"; els.send.disabled = !els.utterance.value.trim(); }
        return finish(transcript, `needs-gesture: '${roomFolder.name}' needs write permission — click 'Restore access' first`, "bad");
      }
      try {
        if (localOp.verb === "delete") {
          const target = localOp.name.includes("/") ? localOp.name : joinDir(listingDir, localOp.name);
          const delRes = await deleteHandleFile(roomFolder.handle, target);
          if (!delRes.ok) {
            finish(transcript, reasonFrom(delRes, delRes.why ?? `could not delete '${target}'`), "bad");
          } else {
            undoStackForRoomFolder()?.push({ kind: "delete", path: delRes.deleted, existed: true, previousContent: delRes.previousContent });
            if (shownFile === delRes.deleted) shownFile = null;
            finish(transcript, `deleted ${delRes.deleted} in ${roomFolder.name}`, "good");
            await loadRoomFolder();
          }
        } else if (localOp.verb === "edit") {
          const target = localOp.name.includes("/") ? localOp.name : joinDir(listingDir, localOp.name);
          const editRes = await editHandleFile(roomFolder.handle, target, localOp.oldText, localOp.newText);
          if (!editRes.ok) {
            finish(transcript, reasonFrom(editRes, editRes.why ?? `could not edit '${target}'`), "bad");
          } else {
            undoStackForRoomFolder()?.push({ kind: "edit", path: editRes.file, existed: true, previousContent: editRes.previousContent });
            finish(transcript, `edited ${editRes.file} (${size(editRes.bytes)} observed) in ${roomFolder.name}`, "good");
            sqehArtifactChip(editRes.file, { verb: "edit", content: localOp.newText, bytes: editRes.bytes });
            if (shownFile === editRes.file) await showFile(shownFile, { reloading: true });
            await loadRoomFolder();
          }
        } else if (localOp.verb === "diff") {
          const target = localOp.name.includes("/") ? localOp.name : joinDir(listingDir, localOp.name);
          const diffRes = await diffHandleFile(roomFolder.handle, target, localOp.content);
          if (!diffRes.ok) {
            finish(transcript, reasonFrom(diffRes, diffRes.why ?? `could not diff '${target}'`), "bad");
          } else {
            presentInspectionInReader("diff", diffRes, localOp);
            finish(transcript, `diff ${diffRes.file} in ${roomFolder.name}`, "good");
          }
        } else if (localOp.verb === "grep") {
          const grepRes = await grepHandleFolder(roomFolder.handle, localOp.query);
          if (!grepRes.ok) {
            finish(transcript, reasonFrom(grepRes, grepRes.why ?? "could not search folder"), "bad");
          } else {
            presentInspectionInReader("grep", grepRes, localOp);
            finish(transcript, `grep "${grepRes.query}" (${grepRes.count} matches) in ${roomFolder.name}`, "good");
          }
        } else if (localOp.verb === "undo") {
          const stack = undoStackForRoomFolder();
          const undoRes = stack
            ? await stack.undo(roomFolder.handle)
            : { ok: false, refused: "nothing-to-undo", why: "no mutating file action has been recorded in this folder yet" };
          if (!undoRes.ok) {
            finish(transcript, reasonFrom(undoRes, undoRes.why ?? "nothing to undo"), "bad");
          } else {
            finish(transcript, `${undoRes.action} in ${roomFolder.name}`, "good");
            if (shownFile && shownFile === undoRes.file) await showFile(shownFile, { reloading: true });
            await loadRoomFolder();
          }
        }
      } catch (err) {
        finish(transcript, `could not run ${localOp.verb} in '${roomFolder.name}': ${err?.message ?? err}`, "bad");
      } finally {
        if (els.send) { els.send.textContent = "Send"; els.send.disabled = !els.utterance.value.trim(); }
      }
      return;
    }
    if (/\blist\b/i.test(transcript)) {
      await loadRoomFolder();
      finish(transcript, `listed ${roomFolder.name}`, "good");
      if (els.send) { els.send.textContent = "Send"; els.send.disabled = !els.utterance.value.trim(); }
      return;
    }
  }

  // NO FOLDER, NOTHING THAT CAN TAKE A WRITE, AND A FILE WAS ASKED FOR (voicebox-beads-vnos). This used to
  // fall through to the server, which has no folder to write into and refuses by name — so the one
  // affordance this page can always honour, the browser's own storage that the scratchpad button already
  // opens, was not where "create a file called X" reached. It is the default target now, and the same
  // `writeRoomFile` path does the work: it resolves the name, writes, reads the bytes back and re-lists, so
  // the drawer and the count beside it update and the report quotes the size the file system answered with.
  if (!roomFolder && writeMatch && noRootToWriteInto()) {
    const { name: fileName, content } = readWriteCommand(writeMatch);
    try {
      await ensureScratchpadFolder();
      const written = await writeRoomFile(fileName, content);
      const durable = await durableFact();
      finish(transcript, `wrote ${fileName} (${size(written.bytes)} observed) in Browser Scratchpad (OPFS)${durable}`, "good");
      sqehArtifactChip(fileName, { verb: "write", content, bytes: written.bytes });
    } catch (error) {
      finish(transcript, `could not write '${fileName}': ${error?.message ?? error}`, "bad");
    } finally {
      if (els.send) { els.send.textContent = "Send"; els.send.disabled = !els.utterance.value.trim(); }
    }
    return;
  }
  try {
    const answer = await turn(transcript);
    if (answer.error) return finish(transcript, reasonFrom(answer, answer.error), "bad");
    if (answer.note) return finish(transcript, answer.note, "bad");
    const result = answer.result ?? {};
    if (!result.ok) return finish(transcript, reasonFrom(result, result.error ?? "the turn was refused"), "bad");
    const delegatedTask = answer.task ?? result.task;
    if (delegatedTask && taskCardController) {
      taskCardController.setTask(delegatedTask);
      if (delegatedTask.address && (delegatedTask.state === "running" || delegatedTask.state === "queued")) {
        const addr = delegatedTask.address;
        let pollCount = 0;
        const maxPolls = 120; // 2 minutes at 1000ms
        const pollTimer = setInterval(async () => {
          pollCount += 1;
          try {
            const res = await taskCardController.status(addr);
            const curState = res?.task?.state;
            if (curState === "completed" || curState === "failed" || curState === "interrupted" || curState === "cancelled" || pollCount >= maxPolls) {
              clearInterval(pollTimer);
              if (res?.task) window.__voiceboxOnTask?.(res.task);
            }
          } catch {
            clearInterval(pollTimer);
          }
        }, 1000);
      }
    }
    const miniApp = answer.miniApp ?? result.miniApp;
    if (miniApp && miniAppController) {
      miniAppController.mount(miniApp);
    }
    const miniAppDeleted = answer.miniAppDeleted ?? result.miniAppDeleted;
    if (miniAppDeleted) {
      window.__voiceboxOnMiniAppDeleted?.(miniAppDeleted);
    }
    const sysCmd = answer.systemCommand ?? result.systemCommand;
    if (sysCmd) {
      await executeBrowserSystemCommand(sysCmd);
    }
    if (result.miniAppToolCall && miniAppController?.callTool) {
      const { name: toolName, args: toolArgs } = result.miniAppToolCall;
      const appRes = await miniAppController.callTool(toolName, toolArgs);
      if (!appRes?.ok) {
        return finish(transcript, `mini-app tool '${toolName}' failed: ${appRes?.error ?? "unknown error"}`, "bad");
      }
      const preview = appRes.result !== undefined ? ` → ${JSON.stringify(appRes.result).slice(0, 120)}` : "";
      finish(transcript, `called mini-app tool '${toolName}'${preview}`, "good");
      await load();
      return;
    }
    const landed = result.root?.path ?? result.root?.name ?? result.root?.label ?? "";
    finish(transcript, result.action ? `${result.action}${landed ? ` in ${landed}` : ""}` : "done", "good");
    const verb = answer.action?.verb;
    if (verb === "exec") {
      appendWorkActivity({
        kind: "command",
        label: "Command",
        summary: answer.action?.command ? `Ran: ${answer.action.command}` : (result.action || "Ran command"),
        detail: [result.stdout, result.stderr].filter(Boolean).join("\n").slice(0, 600),
      });
    }
    if (verb === "write" || verb === "edit") {
      const writtenName = result.file || answer.action?.name || String(result.action ?? "").replace(/^(?:wrote|edited)\s+/i, "").split(/\s+/)[0];
      const previewContent = result.content ?? answer.action?.content ?? answer.action?.newText ?? "";
      if (writtenName) {
        sqehArtifactChip(writtenName, { verb, content: previewContent, bytes: result.bytes });
      }
    }
    if (verb === "open_workspace") {
      if (roomFolder) roomFolder = null;
      listingDir = "";
      await loadRoot();
    } else if (verb === "propose_extension") {
      await renderExtensions();
      if (els.exts && !els.exts.open && typeof els.exts.showModal === "function") {
        els.exts.showModal();
        els.extsOpen?.setAttribute("aria-expanded", "true");
      }
    } else if (verb === "read") {
      const readTarget = result.file || answer.action?.name || result.action;
      if (typeof result.content === "string") {
        renderRead(readTarget, result.content, result.via);
      } else if (readTarget) {
        await showFile(readTarget);
      }
    } else if (verb && presentInspectionInReader(verb, result, answer.action)) {
      // Rich inspection output rendered in #reader (voicebox-beads-k7cz)
    } else if ((verb === "edit" || verb === "write" || verb === "undo") && shownFile && (result.file === shownFile || answer.action?.name === shownFile)) {
      await showFile(shownFile, { reloading: true });
    }
    await load();
  } catch (error) {
    finish(transcript, `the turn did not reach the server: ${error.message}`, "bad");
  } finally {
    if (els.send) { els.send.textContent = "Send"; els.send.disabled = !els.utterance.value.trim(); }
    health();
  }
}

// ── the microphone: the browser's dictation, and nothing more ─────────────
let recognition = null;

function listening(on) {
  if (els.stage) els.stage.dataset.voice = on ? "listening" : "off";
  els.mic?.setAttribute("aria-pressed", String(on));
}

function startListening() {
  // live-voice.js owns the microphone when it is on the page: dictation and a
  // live session must never both answer one click (module order is not a
  // guarantee, so this is checked at click time, not at attach time).
  if (window.__voiceboxLive) return;
  const Recognition = window.SpeechRecognition ?? window.webkitSpeechRecognition;
  if (!Recognition) {
    setState("No speech recognition in this browser — type your turn below.", "warn");
    return;
  }
  if (recognition) { recognition.stop(); return; }
  const rec = new Recognition();
  let stopped = "";
  recognition = rec;
  rec.lang = document.documentElement.lang || "en-GB";
  rec.interimResults = false;
  rec.maxAlternatives = 1;
  rec.onresult = (event) => {
    const said = event.results[0][0].transcript;
    setState("Heard it — sending your turn…");
    send(said);
  };
  rec.onerror = (event) => {
    stopped = `Speech recognition stopped: ${event.error}.`;
    setState(stopped, "warn");
  };
  rec.onend = () => {
    recognition = null;
    listening(false);
    if (!stopped) setState("Microphone off — press the circle to speak");
  };
  try {
    rec.start();
    listening(true);
    setState("Listening — speak your turn, then pause.");
  } catch (error) {
    recognition = null;
    listening(false);
    setState(`Could not start the microphone: ${error.message}`, "warn");
  }
}

on(els.mic, "click", startListening);

// ── the docked mic (voicebox-beads-dzd): the ring's delegate, not a rival ──
// The ring scrolls with the page; the microphone must not. While the ring is on
// screen the dock stays hidden (the ring button is the one mic, in the page and
// in the tab order); the moment scrolling takes the button away the dock
// appears and its click is els.mic's click — same handler, same verbs, the
// pip-mic rule. Its
// pressed/coloured state is painted by watching the same data-voice attribute
// the ring's meters watch: one writer, two viewers, no drift.
if (els.micDock && els.stage && els.mic) {
  on(els.micDock, "click", () => els.mic?.click());
  // ONE mic in the page and in the tab order — now enforced, not just claimed:
  // while the ring button is off screen the dock stands in for it, and the real
  // button steps out of the tab order and the a11y tree (tabIndex -1 +
  // aria-hidden). The handback is exact: scrolling the ring into view restores
  // both and retires the dock.
  //
  // Synced from the LIVE rect on scroll/resize, not from IntersectionObserver
  // entries: the harness's headless window delivered a stale initial entry (the
  // dock came up "docked" while the ring was on screen and never handed back),
  // and a pin that depends on when an async callback lands is a pin that lies
  // sometimes. The throttle is TIME-based, not rAF-based, on purpose — a
  // headless page produces no frames unless watched, and a gated rAF then
  // never runs; this handler always does.
  let lastDockSync = 0;
  const syncDock = (force) => {
    const now = performance.now();
    if (!force && now - lastDockSync < 66) return;
    lastDockSync = now;
    const r = els.mic.getBoundingClientRect();
    const docked = r.bottom <= 0 || r.top >= innerHeight || r.width === 0;
    els.micDock.hidden = !docked;
    els.mic.tabIndex = docked ? -1 : 0;
    if (docked) els.mic.setAttribute("aria-hidden", "true");
    else els.mic.removeAttribute("aria-hidden");
  };
  addEventListener("scroll", () => syncDock(), { passive: true });
  addEventListener("resize", () => syncDock(true));
  syncDock(true);
  // The dock shows the button's OWN pressed state, not a phase guessed from
  // data-voice: live-voice.js writes aria-pressed=true while a live session
  // captures even when the ring phase reads "speaking", so painting from
  // data-voice alone showed a not-pressed dock for a mic that WAS live. Both
  // writers the ring answers to are watched; the dock repaints from the same
  // attributes the ring shows — one writer, mirrored viewers, no drift.
  const paintDock = () => {
    const pressed = els.mic.getAttribute("aria-pressed") === "true";
    els.micDock.setAttribute("aria-pressed", String(pressed));
    els.micDock.dataset.voice = pressed ? "listening"
      : (els.stage.dataset.voice === "speaking" ? "speaking" : "off");
  };
  paintDock();
  new MutationObserver(paintDock).observe(els.mic, { attributes: true, attributeFilter: ["aria-pressed"] });
  new MutationObserver(paintDock).observe(els.stage, { attributes: true, attributeFilter: ["data-voice"] });
}
on(els.refresh, "click", load);
on(els.undoLast, "click", () => void send("undo"));
on(els.deleteConfirmYes, "click", () => void confirmDelete());
// CLOSING WITHOUT AN ANSWER KEEPS THE FILE. Keep, Esc, the X, and a click outside all arrive here;
// confirmDelete() clears pendingDelete before it closes the dialog, so a confirmed delete does not
// pass through this branch.
els.deleteConfirm?.addEventListener("close", () => {
  if (els.deleteConfirm?.open) return;
  if (!pendingDelete) return;
  const kept = pendingDelete.name;
  pendingDelete = null;
  setReport(`Kept ${kept} — nothing was deleted.`, "note");
});
on(els.fileFilter, "input", () => { fileFilter = els.fileFilter.value.trim(); showAllFiles = false; render(); });
on(els.openFolder, "click", openRoomFolder);
on(els.openOpfsFolder, "click", () => void openOpfsScratchFolder());
on(els.closeFolder, "click", closeRoomFolder);

// DROP TO READ: the same handle a picker would give, and the path a headless
// browser can drive (tests/lib/cdp.mjs dispatches a real drag event with a
// directory). Nothing here writes, so a dropped folder is read-only in fact.
if (els.made) {
  const stop = (event) => { event.preventDefault(); };
  // THE DRAG IS COUNTED, NOT GUESSED (voicebox-beads-n4kw). `dragleave` fires as the pointer crosses onto a
  // CHILD of the panel, so the old one-line handler removed `dropping` — and the whole drop cue with it —
  // while the folder was still over the page, then re-added it on the next `dragover`: a cue that flickered
  // and a target that looked like it could not make up its mind. `enter`/`leave` are balanced per element,
  // so the depth reaches zero only when the drag has really left the panel. `dragover` still marks the
  // panel (it is the event that says a drop is allowed here), the drop resets the count because a drop
  // delivers no matching leave, and `dragend` catches a drag abandoned outside the window.
  let dragDepth = 0;
  const paintDrop = () => {
    const dropping = dragDepth > 0;
    els.made.classList.toggle("dropping", dropping);
    if (els.dropHint) els.dropHint.hidden = !dropping;
  };
  els.made.addEventListener("dragenter", (event) => { stop(event); dragDepth++; paintDrop(); });
  els.made.addEventListener("dragover", (event) => { stop(event); dragDepth = Math.max(dragDepth, 1); paintDrop(); });
  els.made.addEventListener("dragleave", (event) => {
    stop(event);
    // A LEAVE WITH NOWHERE TO GO IS A LEAVE FROM THE PANEL: `relatedTarget` is the element the pointer
    // entered, and null means it left the document (or the drag ended). That fact does not need the
    // count's opinion, so it resets — which is what makes the cue leave with the drag instead of waiting
    // for the enters and leaves to balance exactly.
    dragDepth = event.relatedTarget && els.made.contains(event.relatedTarget) ? Math.max(0, dragDepth - 1) : 0;
    paintDrop();
  });
  els.made.addEventListener("dragend", () => { dragDepth = 0; paintDrop(); });
  els.made.addEventListener("drop", async (event) => {
    stop(event);
    dragDepth = 0;
    paintDrop();
    const item = [...(event.dataTransfer?.items ?? [])].find((i) => i.kind === "file");
    const handle = await item?.getAsFileSystemHandle?.();
    if (handle?.kind === "directory") adoptRoomFolder(handle);
    else setReport("That was not a folder — drop a folder to read it.", "bad");
  });
}
on(els.showAll, "click", () => { showAllFiles = true; render(); });
on(els.newFile, "click", () => {
  els.utterance.value = "create a file called ";
  els.utterance.focus();
  els.utterance.setSelectionRange(els.utterance.value.length, els.utterance.value.length);
  // The prefill is not a turn: Send stays off until a person adds the name, so
  // "create a file called " alone can never be sent (the script resolver would
  // read "called" as the filename and write a file by that name).
  els.send.disabled = true;
});
on(els.utterance, "input", (event) => {
  if (event?.isComposing) return;
  if (els.send) els.send.disabled = !els.utterance.value.trim();
});

on(els.form, "submit", (event) => {
  event.preventDefault();
  if (event?.isComposing) return;
  const said = els.utterance.value.trim();
  if (!said) return;
  els.utterance.value = "";
  send(said);
});

// ── devices: what was chosen, what is available, what is happening ────────
//
// Three separate facts per row, because conflating them is how a page ends up
// naming a device it is not using. The preference is stored as an id AND a
// name: the id is what getUserMedia and setSinkId take, the name is the only
// thing that can still name a device that has left the machine (isocan's
// lesson, kept). Device choice is a preference, never a grant.
const DEVICE_KEY = "voicebox.devices";

const devices = {
  prefs: { mic: { id: "", name: "" }, out: { id: "", name: "" } },
  inputs: [],
  outputs: [],
  namesVisible: false,
  canChooseOutput: true,
  // The routing decision, made explicitly rather than inherited: when the
  // chosen output disappears mid-reply this page STOPS playback and says so. It
  // does not silently move a private reply to the system speakers, because a
  // name change that implies a stop while sound keeps coming out somewhere else
  // is the audible version of a lying label.
  policy: "stop",
};

function loadPrefs() {
  try {
    const saved = JSON.parse(localStorage.getItem(DEVICE_KEY) ?? "null");
    if (saved?.mic) devices.prefs.mic = { id: String(saved.mic.id ?? ""), name: String(saved.mic.name ?? "") };
    if (saved?.out) devices.prefs.out = { id: String(saved.out.id ?? ""), name: String(saved.out.name ?? "") };
  } catch { /* no storage, or someone else's shape: start from the default */ }
}

function savePrefs() {
  try { localStorage.setItem(DEVICE_KEY, JSON.stringify(devices.prefs)); } catch { /* private mode */ }
}

async function listDevices() {
  if (!navigator.mediaDevices?.enumerateDevices) return { inputs: [], outputs: [], names: false };
  const all = await navigator.mediaDevices.enumerateDevices();
  const named = all.some((d) => d.label);
  return {
    inputs: all.filter((d) => d.kind === "audioinput").map((d) => ({ id: d.deviceId, name: d.label })),
    outputs: all.filter((d) => d.kind === "audiooutput").map((d) => ({ id: d.deviceId, name: d.label })),
    names: named,
  };
}

function fillPicker(select, list, pref, what, namesVisible) {
  if (!select) return;
  const options = [{ id: "", name: "System default" }, ...list.filter((d) => d.id !== "")];
  // An absent choice stays visible by its saved name rather than being replaced
  // by "System default": the preference is what the person set.
  if (pref.id && !options.some((option) => option.id === pref.id)) {
    // "not connected" is a CLAIM, and it is only sayable when the device list
    // can actually name devices. With names hidden the honest suffix is that
    // this is the name the person saved.
    options.push({ id: pref.id, name: `${pref.name || "chosen device"} · ${namesVisible ? "not connected" : "saved"}` });
  }
  const wanted = options.map((option) => `${option.id}\u0000${option.name}`).join("|");
  if (select.dataset.shape === wanted) return; // no rebuild of an unchanged picker
  select.dataset.shape = wanted;
  select.replaceChildren(...options.map((option) => {
    const el = document.createElement("option");
    el.value = option.id;
    el.textContent = option.name || `unnamed ${what}`;
    return el;
  }));
  select.value = pref.id ?? "";
}

function renderDevices() {
  const { prefs, inputs, outputs, canChooseOutput, namesVisible } = devices;
  fillPicker(els.micSelect, inputs, prefs.mic, "microphone", namesVisible);
  fillPicker(els.outSelect, outputs, prefs.out, "output", namesVisible);

  const micNamesHidden = !namesVisible;
  // A picker with one option and no explanation is a picker that looks broken.
  // Chrome hands out no ids or labels until the origin has microphone access,
  // so the honest row says WHY the list is short rather than showing a dead
  // control. Same for outputs, where the browser may not route at all.
  const inputIdsUsable = inputs.some((d) => d.id);
  const outputIdsUsable = outputs.some((d) => d.id);
  const micPresent = inputs.some((d) => d.id === prefs.mic.id);
  const outPresent = outputs.some((d) => d.id === prefs.out.id);

  const listening = els.stage?.dataset.voice === "listening";
  const speaking = els.stage?.dataset.voice === "speaking";
  const capture = Boolean(window.__voiceboxLiveClient?.state?.capture);

  const micName = prefs.mic.name || "System default";
  let mic = "";
  if (!prefs.mic.id && !inputIdsUsable) mic = listening ? "Listening through System default" : "Mic off · this browser lists no named microphones until you allow access";
  else if (!prefs.mic.id) mic = listening ? "Listening through System default" : "Mic off";
  else if (micNamesHidden && !micPresent) mic = `${micName} · not checked yet — device names can be hidden until microphone access is allowed`;
  else if (listening) mic = `Listening through ${micName}`;
  else if (micPresent) mic = `${micName} · mic off`;
  else mic = `${micName} is not connected. Mic off.`;
  if (els.micDeviceState) els.micDeviceState.textContent = mic;

  let out = "";
  if (canChooseOutput && !outputIdsUsable && !prefs.out.id) out = speaking
    ? "Reply playing through the system output · this browser lists no named outputs until you allow access"
    : "No reply playing · this browser lists no named outputs until you allow access";
  else if (!canChooseOutput) out = "This browser uses system output. Change the output in your device's sound settings.";
  else if (!prefs.out.id) out = speaking ? "Reply playing through System default" : "No reply playing";
  else if (speaking && outPresent) out = `Reply playing through ${prefs.out.name || "the chosen output"}`;
  else if (!outPresent) {
    out = `${prefs.out.name || "The chosen output"} is not connected. `;
    out += speaking ? "Reply playback stopped." : "No reply playing.";
  } else out = "No reply playing";

  if (els.outDeviceState) els.outDeviceState.textContent = out;
  if (els.outSelect) els.outSelect.disabled = !canChooseOutput;

  // The client owns the voice-state line (it is derived from real capture and
  // playback); this page owns DEVICE facts, which the client cannot know. Each
  // fact now sits in the row it belongs to, inside the settings dialog, where a
  // person is when they wonder what they have — not in a second voice under the
  // microphone repeating what the rows already say (coord, 2026-09-20).
}

async function refreshDevices() {
  const before = { mic: devices.prefs.mic.id, out: devices.prefs.out.id };
  const listed = await listDevices();
  devices.inputs = listed.inputs;
  devices.outputs = listed.outputs;
  devices.canChooseOutput = window.__voiceboxLiveClient?.canChooseOutput?.() ?? false;
  devices.namesVisible = listed.names === true;

  // INPUT: a chosen microphone that has left is named; capture is never moved to
  // another device silently, and the output row is untouched.
  if (before.mic && !listed.inputs.some((d) => d.id === before.mic)) {
    if (els.stage?.dataset.voice === "listening" || window.__voiceboxLiveClient?.state?.capture) {
      await window.__voiceboxLiveClient?.stopCapture?.();
    }
  }

  // OUTPUT: the decided policy is to STOP rather than fall back. Name where the
  // audio actually is, and keep Stop reply working.
  if (before.out && !listed.outputs.some((d) => d.id === before.out)) {
    if (devices.policy === "stop" && window.__voiceboxLiveClient?.state?.playbackActive) {
      window.__voiceboxLiveClient.stopPlayback?.();
    }
  }
  renderDevices();
}

on(els.micSelect, "change", async () => {
  const choice = devices.inputs.find((d) => d.id === els.micSelect.value);
  devices.prefs.mic = { id: els.micSelect.value, name: choice?.name ?? "" };
  savePrefs();
  if (window.__voiceboxLiveClient?.state?.capture) {
    try {
      await window.__voiceboxLiveClient.stopCapture?.();
      await window.__voiceboxLiveClient.startCapture?.({ deviceId: devices.prefs.mic.id || null });
    } catch { /* startCapture surfaces any error via onError */ }
  }
  renderDevices();
});

on(els.outSelect, "change", async () => {
  const choice = devices.outputs.find((d) => d.id === els.outSelect.value);
  const previous = { ...devices.prefs.out };
  devices.prefs.out = { id: els.outSelect.value, name: choice?.name ?? "" };
  savePrefs();
  if (els.outDeviceState) els.outDeviceState.textContent = `Switching output to ${devices.prefs.out.name || "System default"}…`;
  const applied = await window.__voiceboxLiveClient?.setOutputDevice?.(devices.prefs.out.id || "");
  if (applied && !applied.ok) {
    devices.prefs.out = previous;
    savePrefs();
    if (els.outDeviceState) els.outDeviceState.textContent = `Could not use ${choice?.name || "that output"}. ${applied.reason}.`;
    renderDevices();
    return;
  }
  renderDevices();
});

// ── Configurable microphone hotkey (voicebox-beads-ebu) ───────────────────
const HOTKEY_KEY = "voicebox-mic-hotkey";
let micHotkey = "M";

function updateHotkeyUI() {
  if (els.micHotkey && els.micHotkey.value !== micHotkey) {
    els.micHotkey.value = micHotkey;
  }
  if (els.micHotkeyState) {
    els.micHotkeyState.textContent = `Press '${micHotkey}' to toggle mic`;
  }
  if (els.micHotkeyBadge) {
    els.micHotkeyBadge.textContent = micHotkey;
  }
  if (els.mic) {
    els.mic.setAttribute("aria-keyshortcuts", micHotkey);
    els.mic.title = `Speak a turn (hotkey: ${micHotkey})`;
  }
}

function loadHotkey() {
  try {
    const saved = localStorage.getItem(HOTKEY_KEY);
    if (saved && typeof saved === "string" && saved.trim()) {
      micHotkey = saved.trim().charAt(0).toUpperCase();
    }
  } catch {}
  updateHotkeyUI();
}

function setHotkey(key) {
  const clean = (key || "M").trim().charAt(0).toUpperCase() || "M";
  micHotkey = clean;
  try { localStorage.setItem(HOTKEY_KEY, micHotkey); } catch {}
  updateHotkeyUI();
}

on(els.micHotkey, "input", () => {
  const val = (els.micHotkey?.value ?? "").trim();
  if (val) {
    setHotkey(val);
  }
});

on(els.micHotkey, "keydown", (e) => {
  if (e.key === "Escape" || e.key === "Tab") return;
  if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
    e.preventDefault();
    setHotkey(e.key);
  }
});

window.addEventListener("keydown", (e) => {
  if (e.defaultPrevented) return;
  // Cmd/Ctrl+K focuses the composer input; Cmd/Ctrl+, opens Settings (voicebox-beads-r0sg)
  if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey) {
    if (e.key.toLowerCase() === "k") {
      e.preventDefault();
      els.utterance?.focus();
      els.utterance?.select?.();
      return;
    }
    if (e.key === ",") {
      e.preventDefault();
      els.settingsOpen?.click();
      return;
    }
  }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const active = document.activeElement;
  if (active) {
    const tag = active.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || active.isContentEditable) {
      return;
    }
  }
  if (document.querySelector("dialog[open]")) {
    return;
  }
  if (e.key === "/") {
    e.preventDefault();
    els.utterance?.focus();
    return;
  }
  if (e.key && e.key.toUpperCase() === micHotkey.toUpperCase()) {
    e.preventDefault();
    if (els.mic) {
      els.mic.classList.add("hotkey-active");
      setTimeout(() => els.mic?.classList.remove("hotkey-active"), 300);
      els.mic.click();
    }
  }
});

// The "Add environment" control declares a server environment. It writes a descriptor to the
// server-owned list; it never starts a service, and a host that is not running will say so by name
// on the next read. (A button, not a form submit: the dialog's method="dialog" form would otherwise
// swallow it and close the dialog.)
on(els.envAddBtn, "click", async () => {
  const label = (els.envAddLabel?.value ?? "").trim();
  const origin = (els.envAddOrigin?.value ?? "").trim();
  if (!label || !origin) {
    if (els.envNote) els.envNote.textContent = "an environment needs a name and an origin";
    return;
  }
  try {
    await request("/api/environments", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label, kind: "server", origin }),
    });
    if (els.envAddLabel) els.envAddLabel.value = "";
    if (els.envAddOrigin) els.envAddOrigin.value = "";
    await renderEnvironments();
  } catch (err) {
    if (els.envNote) els.envNote.textContent = String(err?.why ?? err?.message ?? "the environment was not added");
  }
});

// The dialogs open like settings: showModal() for modality, focus trapping, an inert
// background and Esc, with focus returned to the trigger on close. The platform provides all of it.
on(els.extsOpen, "click", () => {
  if (!els.exts || els.exts.open) return;
  els.exts.showModal();
  els.extsOpen?.setAttribute("aria-expanded", "true");
  void renderExtensions();
});
on(els.extsClose, "click", () => els.exts?.close());
on(els.exts, "close", () => {
  els.extsOpen?.setAttribute("aria-expanded", "false");
  els.extsOpen?.focus();
});

on(els.extCreateForm, "submit", async (event) => {
  event.preventDefault();
  const id = els.extCreateId?.value?.trim();
  const name = els.extCreateName?.value?.trim();
  const description = els.extCreateDesc?.value?.trim();
  const primitive = els.extCreatePrimitive?.value ?? "http-get";
  const target = els.extCreateTarget?.value?.trim() ?? "";
  if (!id || !name || !description) return;

  const capabilities = [];
  const bounds = {};
  const params = {};
  if (primitive === "http-get") {
    capabilities.push("network");
    const host = target || "127.0.0.1";
    bounds.hosts = [host];
    bounds.maxRequests = 50;
  } else if (primitive === "read-file" || primitive === "list-files") {
    capabilities.push("read");
  } else if (primitive === "write-file") {
    capabilities.push("write");
    bounds.maxBytes = 65536;
  }

  const descriptor = {
    id,
    name,
    description,
    source: "local",
    runsIn: "host",
    capabilities,
    bounds,
    tools: [
      {
        name: id.replace(/-/g, "_"),
        description,
        primitive,
        params,
      },
    ],
  };

  if (els.extCreateBtn) els.extCreateBtn.disabled = true;
  try {
    const resp = await request("/api/extensions/local", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ descriptor }),
    });
    if (resp.ok) {
      if (els.extNote) els.extNote.textContent = `Local extension '${id}' staged as pending proposal. Review and approve below.`;
      els.extCreateForm.reset();
      await renderExtensions();
    } else {
      if (els.extNote) els.extNote.textContent = resp.why ?? resp.error ?? "Failed to stage local extension";
    }
  } catch (err) {
    if (els.extNote) els.extNote.textContent = err.message;
  } finally {
    if (els.extCreateBtn) els.extCreateBtn.disabled = false;
  }
});

on(els.extManageClose, "click", () => els.extManageDialog?.close());
installLightDismissFallback(els.extManageDialog);

on(els.extManageDelete, "click", () => {
  const id = els.extManageId?.value;
  const current = lastRunningExtensions.find((e) => e.id === id);
  if (current) openManageExt(current, "remove");
});

on(els.extManageForm, "submit", async (event) => {
  event.preventDefault();
  const id = els.extManageId?.value;
  const mode = els.extManageMode?.value;
  const token = els.extManageToken?.value.trim();

  if (els.extManageSubmit) els.extManageSubmit.disabled = true;
  if (els.extManageStatus) els.extManageStatus.textContent = "Applying...";

  const headers = { "content-type": "application/json" };
  const roomSessionToken = document.querySelector('meta[name="voicebox-session-token"]')?.content;
  if (roomSessionToken && roomSessionToken !== "__VOICEBOX_SESSION_TOKEN__") {
    headers["x-voicebox-session-token"] = roomSessionToken;
  }
  if (token) {
    headers["x-voicebox-host-token"] = token;
  }

  try {
    if (mode === "remove") {
      const resp = await request(`/api/extensions/${encodeURIComponent(id)}`, {
        method: "DELETE",
        headers,
      });
      if (resp.ok) {
        els.extManageDialog?.close();
        if (els.extNote) els.extNote.textContent = `'${id}' was removed. Tools are no longer callable.`;
        await renderExtensions();
      } else {
        if (els.extManageStatus) els.extManageStatus.textContent = resp.why ?? resp.refused ?? "Could not remove extension.";
      }
    } else {
      const hosts = els.extManageHosts?.value.split(",").map((h) => h.trim()).filter(Boolean) ?? [];
      const maxReqVal = els.extManageMaxRequests?.value.trim() ?? "";
      const bounds = {};
      if (hosts.length > 0) bounds.hosts = hosts;
      if (maxReqVal) {
        bounds.maxRequests = Number(maxReqVal);
      }

      const resp = await request("/api/extensions/reconfigure", {
        method: "POST",
        headers,
        body: JSON.stringify({ id, bounds, confirm: true }),
      });
      if (resp.ok) {
        els.extManageDialog?.close();
        if (els.extNote) els.extNote.textContent = `'${id}' was reconfigured with updated bounds.`;
        await renderExtensions();
      } else {
        if (els.extManageStatus) els.extManageStatus.textContent = resp.why ?? resp.refused ?? "Could not reconfigure extension.";
      }
    }
  } catch (err) {
    if (els.extManageStatus) els.extManageStatus.textContent = err?.why ?? err?.refused ?? err?.message ?? "An error occurred.";
  } finally {
    if (els.extManageSubmit) els.extManageSubmit.disabled = false;
  }
});
// The heading's explanation, set as the button's tooltip FROM the one paragraph that carries it —
// so the hover text and the screen-reader text cannot drift into two different sentences.
// Clicking the ? button toggles the inline Environments guide & instructions panel.
{
  const help = document.getElementById("envs-help");
  const text = document.getElementById("envs-help-text");
  const panel = document.getElementById("envs-help-panel");
  if (help && text) help.title = text.textContent.trim();
  if (help && panel) {
    help.addEventListener("click", () => {
      panel.hidden = !panel.hidden;
      help.setAttribute("aria-expanded", String(!panel.hidden));
    });
  }
}

let envsTriggerEl = null;
on(els.envsOpen, "click", () => {
  if (!els.envs || els.envs.open) return;
  envsTriggerEl = els.envsOpen;
  els.envs.showModal();
  els.envsOpen.setAttribute("aria-expanded", "true");
  void renderEnvironments();
});
on(els.emptyLink, "click", () => {
  if (!els.envs || els.envs.open) return;
  envsTriggerEl = els.emptyLink;
  els.envs.showModal();
  els.envsOpen?.setAttribute("aria-expanded", "true");
  void renderEnvironments();
});
on(els.envs, "close", () => {
  els.envsOpen?.setAttribute("aria-expanded", "false");
  (envsTriggerEl || els.envsOpen)?.focus?.();
});

on(els.envUseBrowserBtn, "click", async () => {
  try {
    if (els.envUseBrowserBtn) els.envUseBrowserBtn.disabled = true;
    let failureMsg = null;
    const ok = await openOpfsScratchFolder(SCRATCHPAD_NAME, {
      onError: (msg) => { failureMsg = msg; },
    });
    if (ok) {
      if (els.envRootStatus) {
        els.envRootStatus.dataset.ok = "true";
        els.envRootStatus.textContent = "Switched to browser storage (OPFS) — browser files and edits save here.";
      }
      renderRoot();
    } else {
      if (els.envRootStatus) {
        els.envRootStatus.dataset.ok = "false";
        els.envRootStatus.textContent = `Could not switch to browser storage (OPFS): ${failureMsg || "unavailable"}`;
      }
    }
  } catch (err) {
    if (els.envRootStatus) {
      els.envRootStatus.dataset.ok = "false";
      els.envRootStatus.textContent = `Could not switch to browser storage (OPFS): ${err?.message || "unavailable"}`;
    }
  } finally {
    if (els.envUseBrowserBtn) els.envUseBrowserBtn.disabled = false;
  }
});

on(els.envPickFolderBtn, "click", async () => {
  const picked = await openRoomFolder({
    onError: (msg) => {
      if (els.envRootStatus) {
        els.envRootStatus.dataset.ok = "false";
        els.envRootStatus.textContent = msg;
      }
    },
  });
  if (picked) {
    if (els.envRootStatus) {
      els.envRootStatus.dataset.ok = "true";
      const writable = roomFolder?.permission === "granted" && roomFolder?.mode === "readwrite";
      els.envRootStatus.textContent = writable
        ? `Opened local folder “${picked.name}” — browser files and edits save here.`
        : `Opened read-only folder “${picked.name}” — close this dialog, then click 'Restore access' on the folder chip to write files.`;
    }
    renderRoot();
  }
});

on(els.envDeclareRootBtn, "click", async () => {
  const pathVal = els.envRootPathInput?.value.trim() ?? "";
  if (!pathVal) {
    if (els.envRootStatus) {
      els.envRootStatus.dataset.ok = "false";
      els.envRootStatus.textContent = "Please enter a folder path on this machine.";
    }
    return;
  }
  const projectName = pathVal.split("/").filter(Boolean).pop() || "project";
  if (els.envDeclareRootBtn) els.envDeclareRootBtn.disabled = true;
  try {
    const res = await request("/api/root", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project: projectName, root: { kind: "machine", path: pathVal } }),
    });
    if (res && res.ok) {
      if (roomFolder) await closeRoomFolder();
      if (els.envRootStatus) {
        els.envRootStatus.dataset.ok = "true";
        els.envRootStatus.textContent = `Machine root set to ${res.root?.path ?? pathVal} — turns save here now.`;
      }
      if (els.envRootPathInput) els.envRootPathInput.value = "";
      await loadRoot();
      await load();
    } else {
      if (els.envRootStatus) {
        els.envRootStatus.dataset.ok = "false";
        els.envRootStatus.textContent = res?.why || res?.refused || "Could not set machine root.";
      }
    }
  } catch (err) {
    if (els.envRootStatus) {
      els.envRootStatus.dataset.ok = "false";
      els.envRootStatus.textContent = String(err?.message ?? "Error declaring machine root.");
    }
  } finally {
    if (els.envDeclareRootBtn) els.envDeclareRootBtn.disabled = false;
  }
});

// Create a project BY NAME in the browser's own storage, from the main UI (voicebox-beads-6uzd, with the
// explanation above it for voicebox-beads-um5r). It REUSES the helper the environment page's own button
// uses — ensureScratchpadFolder(name), which creates the OPFS folder and adopts it as the active,
// persisted room folder — rather than adding a second creation path that could drift from that one.
on(els.envCreateProjectBtn, "click", async () => {
  const name = (els.envCreateProjectName?.value ?? "").trim();
  const say = (text, ok) => {
    if (!els.envCreateProjectStatus) return;
    els.envCreateProjectStatus.dataset.ok = String(ok);
    els.envCreateProjectStatus.textContent = text;
  };
  // Refusals name the act and what would fix it, and they are written HERE, inside the dialog: a message
  // that lands behind the open modal is a message the person never sees (the defect voicebox-beads-6uzd
  // exists because of).
  if (!name) {
    say("A project needs a name — it becomes one folder in this browser's storage.", false);
    return;
  }
  if (/[\\/]/.test(name)) {
    say("A name cannot contain a slash: the name becomes one folder, so it cannot be a path.", false);
    return;
  }
  els.envCreateProjectBtn.disabled = true;
  try {
    // Say what actually happened, and only say what we KNOW. `getDirectoryHandle(name, { create: true })`
    // cannot tell a NEW folder from one that already exists, so the pre-check below decides the wording:
    // true = it was already there (Opened), false = clearly absent (Created), null = we could not tell
    // (a name that is a FILE, or a non-NotFound error) and then no sentence claims a creation at all — an
    // independent reviewer pointed out that treating every error as "absent" made "Created" empirically
    // rather than provably true.
    let existed = null;
    if (navigator.storage?.getDirectory) {
      try {
        const opfsRoot = await navigator.storage.getDirectory();
        await opfsRoot.getDirectoryHandle(name);
        existed = true;
      } catch (err) {
        existed = err?.name === "NotFoundError" ? false : null;
      }
    }
    // The cause of a failure has to appear HERE, inside the dialog: #turn-report is outside it, behind the
    // open modal, so it is unreadable until the person closes the dialog. Passing the helper's own onError
    // affordance (the one miniapps added with the picker fix, and used by the button next door) is what
    // makes the refusal visible where the person is standing — the voicebox-beads-sbrh defect class.
    let failureMsg = null;
    const ok = await openOpfsScratchFolder(name, { onError: (msg) => { failureMsg = msg; } });
    if (ok) {
      say(
        existed === true
          ? `Opened “${name}” — it is the folder this room acts on now.`
          : existed === false
            ? `Created “${name}” in this browser — it is the folder this room acts on now.`
            : `“${name}” is the folder this room acts on now.`,
        true,
      );
      renderRoot();
    } else {
      const verb = existed === true ? "open" : existed === false ? "create" : "make";
      say(`Could not ${verb} “${name}”${failureMsg ? ` — ${failureMsg}` : " — the room's report line names the cause."}.`, false);
    }
  } catch (err) {
    say(String(err?.message ?? `Could not create “${name}”.`), false);
  } finally {
    els.envCreateProjectBtn.disabled = false;
  }
});

// Enter in the name box means the button, and must NOT submit the enclosing method="dialog" form: that
// would close the dialog and create nothing — the silent-failure shape this work is about.
on(els.envCreateProjectName, "keydown", (event) => {
  if (event.key !== "Enter") return;
  event.preventDefault();
  els.envCreateProjectBtn?.click();
});

// Light dismiss, declaratively, where the platform supports it: `closedby="any"` on the element.
//
// The documented FALLBACK for browsers that do not (Safari, at the time of writing) is the geometry
// check below — the click's target is the dialog only when the click landed on the backdrop, and the
// coordinates tell the difference between the backdrop and the dialog's own padding.
function installLightDismissFallback(dialog) {
  if (!dialog || "closedBy" in HTMLDialogElement.prototype) return;
  dialog.addEventListener("click", (event) => {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    const inside = rect.top <= event.clientY && event.clientY <= rect.top + rect.height
      && rect.left <= event.clientX && event.clientX <= rect.left + rect.width;
    if (!inside) dialog.close("dismissed");
  });
}
installLightDismissFallback(els.exts);
installLightDismissFallback(els.envs);
installLightDismissFallback(els.settings);
installLightDismissFallback(els.harnessesDialog);
installLightDismissFallback(els.changelogDialog);

// ── Harnesses modal dialog (voicebox-beads-f1o) ───────────────────────────
function textNode(parent, tag, value) {
  const element = document.createElement(tag);
  element.textContent = value;
  parent.append(element);
  return element;
}

function renderModalToolCatalogue(article, catalogue) {
  if (catalogue?.status !== "declared") {
    return;
  }
  const details = document.createElement("details");
  details.className = "tool-catalogue";
  textNode(details, "summary", `Declared tools (${catalogue.tools.length})`);
  textNode(details, "p", `Source: ${catalogue.source}`);
  textNode(details, "p", `Scope: ${catalogue.scope}`);
  textNode(details, "p", "Host-supplied metadata, not a live session inspection. Tools may be disabled, changed or extended; this list grants no permission to run them.");
  if (catalogue.tools.length === 0) textNode(details, "p", "The host declared an empty list. This does not establish that the harness has no tools.");
  const descriptions = document.createElement("dl");
  for (const tool of catalogue.tools) {
    textNode(textNode(descriptions, "dt", ""), "code", tool.name);
    textNode(descriptions, "dd", tool.description);
  }
  details.append(descriptions);
  article.append(details);
}

async function configureHarnessInUi(payload) {
  if (els.harnessConfigNote) els.harnessConfigNote.textContent = "Saving host program setup…";
  if (els.harnessesStatus) els.harnessesStatus.textContent = "Saving host program setup…";
  try {
    let res = await fetch("/api/harnesses/configure", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (res.status === 404 && payload?.agentId && payload?.url) {
      res = await fetch("/api/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: payload.agentId, url: payload.url }),
      });
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.ok === false) {
      throw new Error(body.why || body.error || `HTTP ${res.status}`);
    }
    await checkHarnesses();
    void health();
    if (els.harnessConfigNote) {
      els.harnessConfigNote.textContent = body.message || "Saved host program setup.";
    }
    return true;
  } catch (err) {
    const msg = `Could not save setup (${err?.message ?? String(err)}).`;
    if (els.harnessConfigNote) els.harnessConfigNote.textContent = msg;
    if (els.harnessesStatus) els.harnessesStatus.textContent = msg;
    return false;
  }
}

const CAN_ACTIVATE = new Set(["pi", "claude", "antigravity", "codex", "opencode"]);

async function checkHarnesses() {
  if (!els.harnessesList || !els.harnessesStatus) return;
  if (els.harnessesCheck) els.harnessesCheck.disabled = true;
  els.harnessesStatus.textContent = "Checking host programs…";
  try {
    const response = await fetch("/api/harnesses", { signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const report = await response.json();
    if (!report.ok || !Array.isArray(report.entries)) throw new Error("invalid inventory response");

    const hasAntigravity = report.entries.some((r) => r.id === "antigravity");
    const entries = [];
    for (const rawRow of report.entries) {
      if (rawRow.id === "gemini") {
        if (!hasAntigravity) {
          entries.push({
            ...rawRow,
            id: "antigravity",
            name: "Antigravity",
            description: "Antigravity local agent bridge for multi-agent delegation",
          });
        }
        continue;
      }
      if (rawRow.id === "antigravity") {
        entries.push({
          ...rawRow,
          name: "Antigravity",
        });
        continue;
      }
      entries.push(rawRow);
    }
    if (!entries.some((r) => r.id === "antigravity")) {
      entries.push({
        id: "antigravity",
        name: "Antigravity",
        state: "present",
        description: "Antigravity local agent bridge for multi-agent delegation",
        delegation: { ok: false, refused: "not-configured" },
      });
    }

    const activeList = Array.isArray(report.activeHarnesses)
      ? report.activeHarnesses
      : (report.activeHarness ? [report.activeHarness] : []);
    const activeSet = new Set(activeList.map((id) => (id === "gemini" ? "antigravity" : id)));

    els.harnessesList.replaceChildren();
    for (const row of entries) {
      const article = document.createElement("article");
      article.className = "harness-article";
      article.dataset.harness = row.id;
      article.dataset.delegationRefusal = row.delegation?.refused ?? "none";

      const isActive = activeSet.has(row.id)
        || (activeSet.has("pi") && row.id === "pi-acp")
        || (activeSet.has("claude") && row.id === "claude-agent-acp")
        || Boolean(row.delegation?.ok && (activeSet.size === 0 || activeSet.has(row.id)));
      const needsSetup = Boolean(
        !isActive && (row.delegation?.refused === "not-configured" || row.state === "unconfigured"),
      );
      const isReady = Boolean(
        !isActive && !needsSetup && (row.delegation?.ok || row.state === "present" || row.state === "configured"),
      );

      let statusKey = "missing";
      let statusLabel = "Not installed";
      if (isActive) {
        statusKey = "active";
        statusLabel = "Active";
      } else if (isReady) {
        statusKey = "ready";
        statusLabel = "Ready";
      } else if (needsSetup) {
        statusKey = "setup";
        statusLabel = "Setup needed";
      }

      const head = document.createElement("div");
      head.className = "harness-card-head";
      textNode(head, "h3", `${row.name}${row.version ? ` (${row.version})` : ""}`);
      const badge = document.createElement("span");
      badge.className = "harness-badge env-state";
      badge.dataset.status = statusKey;
      badge.textContent = statusLabel;
      head.append(badge);
      article.append(head);

      if (row.description) {
        const desc = textNode(article, "p", row.description);
        desc.className = "harness-desc";
      }

      const meta = document.createElement("p");
      meta.className = "harness-meta";
      if (isActive) {
        meta.textContent = "Connected and handling delegated coding tasks.";
        if (row.delegation?.mechanism) meta.title = row.delegation.mechanism;
      } else if (isReady) {
        meta.textContent = "Installed on this host. Click Connect to route tasks here.";
      } else if (needsSetup) {
        meta.textContent = row.why || "Add setup details below or click Connect to configure.";
      } else if (row.state === "absent") {
        meta.textContent = "Not installed on this host.";
      } else if (row.why) {
        meta.textContent = row.why;
      }
      if (meta.textContent) article.append(meta);

      const canConnect = CAN_ACTIVATE.has(row.id) || isReady || isActive || needsSetup;
      if (canConnect) {
        const actions = document.createElement("div");
        actions.className = "harness-card-actions";
        const activateBtn = document.createElement("button");
        activateBtn.type = "button";
        activateBtn.className = "harness-activate-btn";
        activateBtn.dataset.harnessActivate = row.id;
        activateBtn.dataset.active = String(isActive);
        if (isActive) {
          activateBtn.textContent = "Disconnect";
          activateBtn.addEventListener("click", () => {
            void configureHarnessInUi({ harness: row.id, id: row.id, active: false });
          });
        } else {
          activateBtn.textContent = "Connect";
          activateBtn.addEventListener("click", () => {
            void configureHarnessInUi({ harness: row.id, id: row.id, active: true });
          });
        }
        actions.append(activateBtn);
        article.append(actions);
      }
      renderModalToolCatalogue(article, row.toolCatalogue);
      els.harnessesList.append(article);
    }
    if (els.harnessesScope) {
      els.harnessesScope.textContent = "Connect one or more installed coding agents to handle delegated background tasks.";
    }
    syncHarnessProjectContext();
    const readyCount = entries.filter((r) => r.delegation?.ok || r.state === "present" || r.state === "configured").length;
    els.harnessesStatus.textContent = `${readyCount} of ${entries.length} harnesses ready on this host.`;
  } catch (error) {
    els.harnessesStatus.textContent = `Inventory unavailable (${error.message}). Check the Voicebox server connection and retry. Any previous entries below are stale, not a fresh observation.`;
  } finally {
    if (els.harnessesCheck) els.harnessesCheck.disabled = false;
  }
}

let lastHarnessOutput = "";

function syncHarnessProjectContext() {
  if (!els.harnessProjectContext) return;
  const rootLabel = els.listingRoot?.textContent?.trim() || els.rootKind?.textContent?.trim() || "Active workspace";
  const folderSuffix = listingDir ? ` (folder: ${listingDir})` : "";
  els.harnessProjectContext.textContent = `Active project context: ${rootLabel}${folderSuffix}`;
}

function renderHarnessChangedFiles(files) {
  if (!els.harnessChangedFiles) return;
  const list = Array.isArray(files) ? files.map((f) => String(f || "").trim()).filter(Boolean) : [];
  if (list.length === 0) {
    els.harnessChangedFiles.hidden = true;
    els.harnessChangedFiles.replaceChildren();
    return;
  }
  els.harnessChangedFiles.hidden = false;
  els.harnessChangedFiles.replaceChildren(
    ...list.map((filePath) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "harness-file-chip";
      btn.textContent = `Open ${filePath}`;
      btn.addEventListener("click", () => {
        if (els.harnessesDialog?.open) els.harnessesDialog.close();
        void showFile(filePath);
      });
      return btn;
    }),
  );
}

on(els.harnessTaskSend, "click", async () => {
  const prompt = (els.harnessTaskInput?.value ?? "").trim();
  if (!prompt) {
    if (els.harnessLoopStatus) els.harnessLoopStatus.textContent = "Enter a task for the active coding harness first.";
    return;
  }
  if (els.harnessTaskSend) els.harnessTaskSend.disabled = true;
  if (els.harnessLoopStatus) els.harnessLoopStatus.textContent = "Running task in project workspace…";
  try {
    const res = await request("/api/delegate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ task: prompt, ...(listingDir ? { dir: listingDir } : {}) }),
    });
    const output = String(res?.output ?? res?.summary ?? res?.action ?? res?.why ?? "Task submitted to active harness.").trim();
    lastHarnessOutput = output;
    if (els.harnessLoopStatus) els.harnessLoopStatus.textContent = output;
    if (els.harnessSaveOutput) els.harnessSaveOutput.hidden = !lastHarnessOutput;
    const changed = res?.changedFiles ?? res?.projectIntegration?.changedFiles ?? [];
    renderHarnessChangedFiles(changed);
    void load();
  } catch (error) {
    if (els.harnessLoopStatus) {
      els.harnessLoopStatus.textContent = `Could not run harness task: ${error?.why ?? error?.message ?? error}`;
    }
  } finally {
    if (els.harnessTaskSend) els.harnessTaskSend.disabled = false;
  }
});

on(els.harnessSaveOutput, "click", async () => {
  if (!lastHarnessOutput) return;
  if (els.harnessSaveOutput) els.harnessSaveOutput.disabled = true;
  try {
    const targetName = "harness-analysis.md";
    if (roomFolder) {
      await writeRoomFile(targetName, lastHarnessOutput);
      await loadRoomFolder();
    } else {
      await request("/api/file", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: targetName, content: lastHarnessOutput }),
      });
      await load();
    }
    if (els.harnessLoopStatus) els.harnessLoopStatus.textContent = `Saved output to ${targetName} in the active project.`;
    renderHarnessChangedFiles(["harness-analysis.md"]);
    if (els.harnessesDialog?.open) els.harnessesDialog.close();
    await showFile(targetName);
  } catch (error) {
    if (els.harnessLoopStatus) {
      els.harnessLoopStatus.textContent = `Could not save output to project: ${error?.why ?? error?.message ?? error}`;
    }
  } finally {
    if (els.harnessSaveOutput) els.harnessSaveOutput.disabled = false;
  }
});

async function openAgentProgressTracker() {
  let html = "";
  try {
    const res = await fetch("/apps/agent-monitor.html");
    if (res.ok) html = await res.text();
  } catch { /* fallback below */ }
  if (!html) {
    html = `<!doctype html><html><body style="font-family:system-ui;padding:16px"><h2>Agent Progress Tracker</h2><p>Monitoring active agent harnesses and background tasks.</p></body></html>`;
  }
  if (els.harnessesDialog?.open) els.harnessesDialog.close();
  if (miniAppController) {
    miniAppController.mount({
      appId: "agent-progress-tracker",
      title: "Agent Progress Tracker",
      html,
    });
  }
}
window.__voiceboxOpenAgentTracker = openAgentProgressTracker;

on(els.harnessConfigSave, "click", async () => {
  const harness = (els.harnessAgentSelect?.value ?? "pi").trim();
  const name = (els.harnessAgentName?.value ?? "").trim();
  const model = (els.harnessAgentModel?.value ?? "").trim();
  const ok = await configureHarnessInUi({
    harness,
    id: harness,
    ...(name ? { name } : {}),
    ...(model ? { model } : {}),
    active: true,
  });
  if (ok) {
    if (els.harnessAgentName) els.harnessAgentName.value = "";
    if (els.harnessAgentModel) els.harnessAgentModel.value = "";
  }
});

on(els.harnessesOpen, "click", () => {
  if (!els.harnessesDialog || els.harnessesDialog.open) return;
  els.harnessesDialog.showModal();
  els.harnessesOpen?.setAttribute("aria-expanded", "true");
  syncHarnessProjectContext();
  if (els.harnessesList && els.harnessesList.children.length === 0) {
    void checkHarnesses();
  }
});
on(els.harnessesClose, "click", () => els.harnessesDialog?.close());
on(els.harnessesDialog, "close", () => {
  els.harnessesOpen?.setAttribute("aria-expanded", "false");
  els.harnessesOpen?.focus();
});
on(els.harnessesCheck, "click", () => void checkHarnesses());
on(els.harnessesOpenTracker, "click", () => void openAgentProgressTracker());

// ── Change log modal dialog (voicebox-beads-n1pq, voicebox-beads-je4i) ────
let lastChangelogTrigger = null;

function formatCommitDescription(commit) {
  const rawSubject = String(commit?.subject ?? "").trim();
  const rawBody = String(commit?.body ?? commit?.description ?? "").trim();
  const typeMatch = rawSubject.match(/^([a-z]+)(?:\(([^)]+)\))?!?:\s*(.+)$/i);
  const typeMap = {
    feat: { badge: "Feature", kind: "feat", verb: "Added or improved capability" },
    fix: { badge: "Fix", kind: "fix", verb: "Resolved issue" },
    perf: { badge: "Performance", kind: "perf", verb: "Optimized speed or responsiveness" },
    docs: { badge: "Docs", kind: "docs", verb: "Updated documentation" },
    refactor: { badge: "Refactor", kind: "refactor", verb: "Simplified internal structure" },
    test: { badge: "Tests", kind: "test", verb: "Expanded automated verification" },
    chore: { badge: "Maintenance", kind: "chore", verb: "Routine maintenance update" },
    style: { badge: "Design", kind: "style", verb: "Refined visual layout and styling" },
  };
  const rawType = typeMatch ? typeMatch[1].toLowerCase() : "";
  const scope = typeMatch && typeMatch[2] ? sanitizePlainActivityText(typeMatch[2]) : "";
  const cleanSubject = sanitizePlainActivityText(typeMatch ? typeMatch[3] : rawSubject) || "Updated room";
  const mapped = typeMap[rawType] || {
    badge: scope || "Update",
    kind: "update",
    verb: "Updated workspace",
  };
  let description = sanitizePlainActivityText(rawBody);
  if (!description) {
    const scopePhrase = scope ? ` in ${scope}` : "";
    description = `${mapped.verb}${scopePhrase}: ${cleanSubject.charAt(0).toUpperCase()}${cleanSubject.slice(1)}`;
    if (!/[.!?]$/.test(description)) description += ".";
  }
  const files = Array.isArray(commit?.files)
    ? commit.files.map((f) => sanitizePlainActivityText(f)).filter(Boolean).slice(0, 6)
    : [];
  return {
    badge: mapped.badge,
    kind: mapped.kind,
    subject: sanitizePlainActivityText(rawSubject) || cleanSubject,
    description,
    files,
  };
}

async function loadRoomChangelog() {
  if (!els.changelogCommits || !els.changelogStatus) return;
  if (els.changelogRefresh) els.changelogRefresh.disabled = true;
  els.changelogStatus.textContent = "Loading changes…";
  try {
    const res = await fetch("/api/changelog", { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!data.ok || !Array.isArray(data.commits)) throw new Error("invalid changelog response");
    els.changelogCommits.replaceChildren();
    if (data.commits.length === 0) {
      els.changelogStatus.textContent = "No recent commits found.";
      return;
    }
    els.changelogStatus.textContent = `Showing ${data.commits.length} recent commits:`;
    for (const c of data.commits) {
      const info = formatCommitDescription(c);
      const li = document.createElement("li");
      li.className = "commit-card";
      li.dataset.commitKind = info.kind;

      const header = document.createElement("div");
      header.className = "commit-header";

      const link = document.createElement("a");
      link.className = "commit-sha";
      link.href = c.url || `https://github.com/PaulKinlan/voicebox/commit/${c.sha}`;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = c.shortSha || (c.sha ? c.sha.slice(0, 7) : "");
      header.append(link);

      const badge = document.createElement("span");
      badge.className = "commit-badge";
      badge.dataset.kind = info.kind;
      badge.textContent = info.badge;
      header.append(badge);

      const subject = document.createElement("span");
      subject.className = "commit-subject";
      subject.textContent = info.subject;
      header.append(subject);

      li.append(header);

      const desc = document.createElement("p");
      desc.className = "commit-description";
      desc.textContent = info.description;
      li.append(desc);

      if (info.files.length > 0) {
        const filesRow = document.createElement("div");
        filesRow.className = "commit-details";
        for (const f of info.files) {
          const pill = document.createElement("span");
          pill.className = "commit-file";
          pill.textContent = f;
          filesRow.append(pill);
        }
        li.append(filesRow);
      }

      const meta = document.createElement("div");
      meta.className = "commit-meta";
      const relDate = c.relativeDate || c.age ? ` (${c.relativeDate || c.age})` : "";
      meta.textContent = `${c.author || "Unknown"} · ${c.date || ""}${relDate}`;
      li.append(meta);

      els.changelogCommits.append(li);
    }
  } catch (err) {
    els.changelogStatus.replaceChildren();
    els.changelogStatus.append(document.createTextNode(`Could not load local changelog (${err.message}). View `));
    const gh = document.createElement("a");
    gh.href = "https://github.com/PaulKinlan/voicebox/commits/main";
    gh.target = "_blank";
    gh.rel = "noopener noreferrer";
    gh.textContent = "all commits on GitHub";
    els.changelogStatus.append(gh, document.createTextNode("."));
  } finally {
    if (els.changelogRefresh) els.changelogRefresh.disabled = false;
  }
}

function openChangelogDialog(triggerEl = els.changelogOpen) {
  if (!els.changelogDialog || els.changelogDialog.open) return;
  lastChangelogTrigger = triggerEl || els.changelogOpen;
  els.changelogDialog.showModal();
  els.changelogOpen?.setAttribute("aria-expanded", "true");
  if (els.changelogCommits && els.changelogCommits.children.length === 0) {
    void loadRoomChangelog();
  }
}

on(els.changelogOpen, "click", () => openChangelogDialog(els.changelogOpen));
on(els.changelogClose, "click", () => els.changelogDialog?.close());
on(els.changelogDialog, "close", () => {
  els.changelogOpen?.setAttribute("aria-expanded", "false");
  (lastChangelogTrigger || els.changelogOpen)?.focus();
  lastChangelogTrigger = null;
});
on(els.changelogRefresh, "click", () => void loadRoomChangelog());

// ── Provider API keys configuration (voicebox-beads-5drl) ─────────────────
function describeProviderKeySlot(slot) {
  if (!slot) return "Not configured";
  if (typeof slot === "boolean") return slot ? "Configured" : "Not configured";
  if (typeof slot === "object") {
    const configured = Boolean(slot.configured || slot.present || slot.set);
    if (!configured) return "Not configured";
    const src = String(slot.source || "").toLowerCase();
    if (src.includes("env")) return "Configured (from environment)";
    if (src.includes("store") || src.includes("file") || src.includes("host") || src.includes("saved")) {
      return "Configured (saved on this host)";
    }
    return "Configured";
  }
  return "Not configured";
}

async function loadApiKeysSettings() {
  try {
    const res = await fetch("/api/keys", { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return;
    const body = await res.json();
    const providers = body.providers || body.keys || body;
    const mapping = [
      ["gemini", els.apiKeyGeminiStatus, els.apiKeyGemini],
      ["openai", els.apiKeyOpenaiStatus, els.apiKeyOpenai],
      ["anthropic", els.apiKeyAnthropicStatus, els.apiKeyAnthropic],
    ];
    for (const [id, statusEl, inputEl] of mapping) {
      const slot = providers?.[id];
      const text = describeProviderKeySlot(slot);
      const isConfigured = text.startsWith("Configured");
      if (statusEl) statusEl.textContent = text;
      if (inputEl && isConfigured && !inputEl.value) {
        const masked = typeof slot === "object" && typeof slot.masked === "string" ? slot.masked : "";
        inputEl.placeholder = masked ? `Saved (${masked}) — paste to replace` : "Saved — paste a new key to replace";
      }
    }
  } catch {
    // Endpoint may not be mounted yet; keep clean initial labels
  }
}

on(els.apiKeysSave, "click", async () => {
  const payload = {};
  const gVal = (els.apiKeyGemini?.value ?? "").trim();
  const oVal = (els.apiKeyOpenai?.value ?? "").trim();
  const aVal = (els.apiKeyAnthropic?.value ?? "").trim();
  if (gVal) payload.gemini = gVal;
  if (oVal) payload.openai = oVal;
  if (aVal) payload.anthropic = aVal;
  if (Object.keys(payload).length === 0) {
    if (els.apiKeysStatus) els.apiKeysStatus.textContent = "Paste at least one API key before saving.";
    return;
  }
  if (els.apiKeysSave) els.apiKeysSave.disabled = true;
  if (els.apiKeysStatus) els.apiKeysStatus.textContent = "Saving API keys…";
  try {
    const res = await fetch("/api/keys", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.ok === false) {
      throw new Error(body.why || body.error || `HTTP ${res.status}`);
    }
    if (els.apiKeyGemini) els.apiKeyGemini.value = "";
    if (els.apiKeyOpenai) els.apiKeyOpenai.value = "";
    if (els.apiKeyAnthropic) els.apiKeyAnthropic.value = "";
    if (els.apiKeysStatus) els.apiKeysStatus.textContent = "Saved API keys on this host.";
    await loadApiKeysSettings();
    await loadAgentSettings();
    void health();
  } catch (err) {
    if (els.apiKeysStatus) els.apiKeysStatus.textContent = `Could not save API keys (${err?.message ?? String(err)}).`;
  } finally {
    if (els.apiKeysSave) els.apiKeysSave.disabled = false;
  }
});

on(els.settingsOpen, "click", () => {
  if (!els.settings || els.settings.open) return;
  // Opening settings does not start capture, stop playback or end the session.
  //
  // showModal() IS the feature: top layer, modality, focus trapped inside, the room behind inert,
  // Esc as a close request, and focus handed back here on close. All of it is the platform's, which
  // is the point — a hand-rolled overlay gets four of those five wrong.
  els.settings.showModal();
  els.settingsOpen.setAttribute("aria-expanded", "true");
  refreshDevices();
  void loadAgentSettings();
  void loadApiKeysSettings();
});

// Every close path — the form's method="dialog" button, Esc, light dismiss, or a programmatic
// close — arrives here, so the trigger's state is honest whichever way it went.
on(els.settings, "close", () => {
  els.settingsOpen.setAttribute("aria-expanded", "false");
  els.settingsOpen.focus();
});

// ── the agent you are talking to: provider, voice, personality ────────────
//
// THE ONE RULE THIS SECTION KEEPS: a control shows what is APPLIED, and says where the request and
// the reality differ. A picker bound to a field the session never reads is worse than no picker —
// the person believes they changed something and the page agrees with them — so `voice` and
// `personality` say "stored, not applied" in words until a provider carries them.
let agent = null; // the last payload, kept so a change can be rendered against it

const AGENT_SETTINGS_KEY = "voicebox.agent.settings.v1";

function readLocalAgentSettings() {
  try {
    const raw = localStorage.getItem(AGENT_SETTINGS_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeLocalAgentSettings(settings) {
  try {
    if (settings) localStorage.setItem(AGENT_SETTINGS_KEY, JSON.stringify(settings));
  } catch { /* private mode */ }
}

async function loadAgentSettings() {
  const local = readLocalAgentSettings();
  if (local && typeof local === "object") {
    try {
      agent = await request("/api/agent-settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(local),
      });
    } catch {
      try { agent = await request("/api/agent-settings"); } catch { agent = null; }
    }
  } else {
    try {
      agent = await request("/api/agent-settings");
    } catch {
      agent = null;
    }
  }
  renderAgentSettings();
}

function fillAgentPicker(picker, options, selected) {
  if (!picker) return;
  picker.textContent = "";
  for (const option of options) {
    const el = document.createElement("option");
    el.value = option.value;
    el.textContent = option.label;
    if (option.value === selected) el.selected = true;
    picker.append(el);
  }
}

let reconnectedLiveModel = null;

function renderAgentSettings() {
  const providerState = document.getElementById("agent-provider-state");
  const modelState = document.getElementById("agent-model-state");
  const voiceState = document.getElementById("agent-voice-state");
  const timbreState = document.getElementById("agent-timbre-state");
  const personalityState = document.getElementById("agent-personality-state");
  const customState = document.getElementById("agent-custom-instruction-state");
  if (!providerState) return;

  if (!agent) {
    providerState.textContent = "The server does not report agent settings.";
    return;
  }

  // PROVIDER — applied
  const chosen = agent.capabilities.find((c) => c.id === agent.requested.provider) || agent.capabilities[0];
  fillAgentPicker(
    document.getElementById("agent-provider"),
    agent.capabilities.map((c) => ({ value: c.id, label: c.available ? c.label : `${c.label} — not available` })),
    agent.requested.provider,
  );
  const running = agent.runningSession ? ` A live session is using ${agent.runningSession.provider}.` : " No live session is open.";
  providerState.textContent = chosen && !chosen.available
    ? `Cannot be used: ${chosen.why}.`
    : `In use for the next session: ${chosen.label} · ${agent.applied.model}.${running}`;

  // MODEL — per provider
  const modelPicker = document.getElementById("agent-model");
  const models = chosen.models ?? [{ id: chosen.model, label: chosen.model }];
  const currentModel = agent.requested.model ?? chosen.model;
  fillAgentPicker(
    modelPicker,
    models.map((m) => ({ value: m.id, label: m.label })),
    currentModel,
  );
  const liveActive = Boolean(
    (typeof window.__voiceboxIsLiveSessionActive === "function" && window.__voiceboxIsLiveSessionActive())
    || agent.runningSession,
  );
  if (!liveActive) {
    reconnectedLiveModel = null;
  }
  if (modelState) {
    if (liveActive && (reconnectedLiveModel === currentModel || agent.runningSession?.model === currentModel)) {
      modelState.textContent = reconnectedLiveModel === currentModel
        ? `Reconnected live session with ${currentModel}.`
        : `${currentModel} active in running session.`;
    } else {
      modelState.textContent = agent.requested.model
        ? `Applied model: ${agent.requested.model} — the next session starts with it.`
        : `Applied default model: ${chosen.model} — the next session starts with it.`;
    }
  }

  // VOICE — per provider
  const voicePicker = document.getElementById("agent-voice");
  fillAgentPicker(voicePicker, [
    { value: "", label: `${chosen.label}'s default` },
    ...chosen.voices.map((v) => ({ value: v.id, label: v.label })),
  ], agent.requested.voice ?? "");
  if (voiceState) {
    voiceState.textContent = agent.pending.voice
      ? (agent.requested.voice
        ? `Chosen: ${agent.requested.voice}. ${agent.pending.voice}`
        : `Using ${chosen.label}'s default voice. ${agent.pending.voice}`)
      : (agent.requested.voice
        ? `Applied: ${agent.requested.voice} — the next session starts with it.`
        : `Applied: ${chosen.label}'s default voice — the next session starts with it.`);
  }

  // TIMBRE
  const timbrePicker = document.getElementById("agent-timbre");
  const timbres = agent.timbres ?? [
    { id: "balanced", label: "Balanced (natural tone)", description: "Standard voice tone" },
    { id: "warm", label: "Warm (softer, rounder)", description: "Gentle and rich resonance" },
    { id: "bright", label: "Bright (clear, upfront)", description: "Elevated high-frequency presence" },
    { id: "deep", label: "Deep (resonant bass)", description: "Grounded low-frequency emphasis" },
    { id: "crisp", label: "Crisp (articulate)", description: "Sharp phonetic articulation" },
  ];
  fillAgentPicker(timbrePicker, timbres.map((t) => ({ value: t.id, label: t.label })), agent.requested.timbre ?? "balanced");
  if (timbreState) {
    const curTimbre = timbres.find((t) => t.id === (agent.requested.timbre ?? "balanced"));
    timbreState.textContent = `Applied timbre: ${curTimbre?.label ?? "Balanced"}.`;
  }

  // PERSONALITY
  const personalityPicker = document.getElementById("agent-personality");
  fillAgentPicker(personalityPicker, agent.personalities.map((p) => ({ value: p.id, label: p.label })), agent.requested.personality);
  if (personalityState) {
    personalityState.textContent = agent.pending.personality
      ? `Chosen: ${agent.requested.personality}. ${agent.pending.personality}`
      : `Applied: ${agent.requested.personality} — layered beneath the base rules for the next session.`;
  }

  // CUSTOM INSTRUCTION PROMPT
  const customInput = document.getElementById("agent-custom-instruction");
  if (customInput && document.activeElement !== customInput) {
    customInput.value = agent.requested.customInstruction ?? "";
  }
  if (customState) {
    customState.textContent = agent.requested.customInstruction
      ? "Custom prompt active: layered subordinate to the mandatory base rules."
      : "Layered subordinate to the mandatory base rules.";
  }

  const base = document.getElementById("agent-base");
  if (base) base.textContent = agent.base.instruction;
  const note = document.getElementById("agent-base-note");
  if (note) note.textContent = `${agent.base.note} (editable here: ${agent.base.editable ? "yes" : "no"}). Settings are ${agent.persisted}.`;
}

async function saveAgentSetting(patch) {
  const answer = await request("/api/agent-settings", { method: "PUT", body: JSON.stringify(patch) });
  if (!answer || answer.ok === false) {
    const why = answer?.why ?? "the server did not accept that";
    for (const id of [
      "agent-provider-state",
      "agent-model-state",
      "agent-voice-state",
      "agent-timbre-state",
      "agent-personality-state",
      "agent-custom-instruction-state",
    ]) {
      const el = document.getElementById(id);
      if (el) el.textContent = `Refused (${answer?.refused ?? "unknown"}): ${why}`;
    }
    return;
  }
  agent = answer;
  writeLocalAgentSettings(agent.requested);
  if (("model" in patch || "provider" in patch) && typeof window.__voiceboxIsLiveSessionActive === "function" && window.__voiceboxIsLiveSessionActive()) {
    try {
      const restarted = await window.__voiceboxRestartLiveSession?.();
      const savedModel = agent.applied?.model ?? agent.requested?.model ?? "default model";
      if (restarted?.restarted !== false) {
        reconnectedLiveModel = savedModel;
      }
      renderAgentSettings();
      const modelStateEl = document.getElementById("agent-model-state");
      if (modelStateEl) {
        modelStateEl.textContent = `Reconnected live session with ${savedModel}.`;
      }
    } catch {
      renderAgentSettings();
    }
  } else {
    renderAgentSettings();
  }
  void health();
}

for (const [id, patch] of [
  ["agent-provider", (value) => ({ provider: value })],
  ["agent-model", (value) => ({ model: value || null })],
  ["agent-voice", (value) => ({ voice: value || null })],
  ["agent-timbre", (value) => ({ timbre: value || null })],
  ["agent-personality", (value) => ({ personality: value })],
]) {
  const el = document.getElementById(id);
  if (el) el.addEventListener("change", () => void saveAgentSetting(patch(el.value)));
}

const customEl = document.getElementById("agent-custom-instruction");
if (customEl) {
  customEl.addEventListener("change", () => void saveAgentSetting({ customInstruction: customEl.value || null }));
}

// ── the two meters: your voice, and the agent's ───────────────────────────
// Driven by the real PCM the client already has (audio-client.js `level()`):
// input energy at the microphone, and one radius per output sample around the
// circle. No audio, no picture — a meter that animates while nothing is being
// heard is the same lie as a "listening" label with the mic off.
const OUTPUT_SAMPLES = 64;
const INPUT_BARS_PAGE = 28;
const OUTPUT_CENTRE = 120;
const OUTPUT_BASE = 62; // hugs the button (radius ~55 in these units)
const OUTPUT_AMPLITUDE = 13; // a contour hugging the button, lightly textured by real audio

// Mean-absolute energy from real speech is small (a quiet room reads ~0.01, a
// talking voice ~0.03-0.1), so a linear meter sits at zero and never moves.
// The square root spreads the quiet end and saturates at the loud end — a meter
// you can read, still driven entirely by the real signal.
function meterLevel(value) {
  const energy = Number(value);
  if (!Number.isFinite(energy) || energy <= 0) return 0;
  return Math.min(1, Math.sqrt(energy) * 1.9);
}

// ── the output ring: a smooth closed curve that morphs at frame rate ───────
//
// Two separate problems made this look "stilted and jilted" (Paul, 2026-09-20):
//
//   1. GEOMETRY. The old path joined 64 sample points with straight `L`
//      segments, so the ring was a 64-gon and its edges were visible.
//   2. DATA RATE. Samples arrive with the audio — around 12 a second — while
//      the loop draws at 60. Redrawing the same numbers 58 times a second is
//      not animation: what the eye sees is ~12 discrete jumps a second, each
//      one shifting the whole ring by a whole sample.
//
// So the ring keeps a *fractional phase* that eases toward the newest data and
// samples the ring between its points, and the polyline is turned into a closed
// Catmull-Rom curve through denser points. The picture then changes every frame
// (measured 60/s, see the drive note in the commit) while the data underneath
// still arrives at the audio rate — the honest way to interpolate a coarse
// signal rather than pretending it is faster than it is.
const RENDER_POINTS = 160; // drawn points around the ring (was 64, straight-joined)
const RING_COS = new Float64Array(RENDER_POINTS);
const RING_SIN = new Float64Array(RENDER_POINTS);
for (let i = 0; i < RENDER_POINTS; i++) {
  const angle = (i / RENDER_POINTS) * Math.PI * 2 - Math.PI / 2;
  RING_COS[i] = Math.cos(angle);
  RING_SIN[i] = Math.sin(angle);
}
let ringPhase = 0;         // where we are rendering, in ring positions
let ringTarget = 0;        // where the newest data has arrived, in ring positions
let ringSeen = null;       // the newest sample we have already counted
let ringFlowPhase = 0;     // continuous carrier phase for smooth wave motion
// THE POINT RADII ARE FOLLOWED, NOT SET (voicebox-beads-u03k). The raw data can step the whole amplitude
// between two frames — measured on the landed ring: 13.0 units in ONE frame when speech stopped, and 9.5 at
// a loud onset — so each point's radius chases its target with a fast attack and a slower decay, and a pause
// settles over ~20 frames instead of collapsing.
const ringRadii = new Float64Array(RENDER_POINTS).fill(OUTPUT_BASE);

/**
 * Sample the ring with a MIRRORED (triangle-folded) traversal (voicebox-beads-u03k, from the d2ji branch's
 * measurement). The ring is a history wrapped around a circle: position 0 is the OLDEST entry and n-1 the
 * NEWEST, so an index-wrapping sampler draws two unrelated moments next to each other and puts a step in the
 * contour — measured at 9.5 units of a 13-unit amplitude on a fixture whose only discontinuity is that wrap.
 * Folding traverses 0…n-1 and back, so those two entries are never adjacent. Nothing here invents a value: it
 * shows the history twice, mirrored, and the contour is continuous everywhere.
 */
function ringAt(samples, position) {
  const n = samples.length;
  if (n === 0) return 0;
  const turn = ((position / n) % 1 + 1) % 1;
  const folded = turn <= 0.5 ? turn * 2 : (1 - turn) * 2;
  const at = folded * (n - 1);
  const i = Math.floor(at);
  const j = Math.min(n - 1, i + 1);
  const t = at - i;
  return samples[i] * (1 - t) + samples[j] * t;
}

/** Closed Catmull-Rom through the points, as cubic Béziers — no visible facets. */
function closedCurve(points) {
  const n = points.length;
  const at = (i) => points[(i % n + n) % n];
  let d = `M${at(0)[0].toFixed(2)},${at(0)[1].toFixed(2)}`;
  for (let i = 0; i < n; i++) {
    const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2);
    const c1x = p1[0] + (p2[0] - p0[0]) / 6;
    const c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6;
    const c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += `C${c1x.toFixed(2)},${c1y.toFixed(2)} ${c2x.toFixed(2)},${c2y.toFixed(2)} ${p2[0].toFixed(2)},${p2[1].toFixed(2)}`;
  }
  return `${d}Z`;
}

function drawOutputRing(samples) {
  const path = document.getElementById("output-path");
  if (!path) return;
  if (!samples) {
    path.removeAttribute("d");
    ringSeen = null;
    ringPhase = 0;
    ringTarget = 0;
    ringFlowPhase = 0;
    ringRadii.fill(OUTPUT_BASE);
    return;
  }
  // Count a new sample once: the newest value changing is the signal that the
  // client's ring advanced (it advances on PLAYBACK, not on arrival).
  const newest = samples[samples.length - 1];
  if (ringSeen === null || Math.abs(newest - ringSeen) > 1e-6) {
    ringSeen = newest;
    ringTarget += 1;
  }
  // Ease the render phase toward the data, and advance a gentle continuous carrier wave.
  ringPhase += (ringTarget - ringPhase) * 0.14;
  ringFlowPhase += 0.045;

  const points = new Array(RENDER_POINTS);
  for (let i = 0; i < RENDER_POINTS; i++) {
    const position = ringPhase + (i / RENDER_POINTS) * OUTPUT_SAMPLES;
    const target = OUTPUT_BASE + meterLevel(ringAt(samples, position)) * OUTPUT_AMPLITUDE;
    // Fast attack, slower decay (voicebox-beads-u03k): a syllable arrives at once, a pause settles.
    ringRadii[i] += (target - ringRadii[i]) * (target > ringRadii[i] ? 0.35 : 0.16);
    const shown = ringRadii[i];
    // THE CARRIER IS THE LANDED ONE and it stays: it keeps the contour moving on a steady note, and it is
    // driven by the FOLLOWED level rather than the raw sample, so it cannot put a step back into the picture.
    const level = Math.max(0, Math.min(1, (shown - OUTPUT_BASE) / OUTPUT_AMPLITUDE));
    const harmonic = level > 0.01 ? Math.sin((i / RENDER_POINTS) * Math.PI * 6 + ringFlowPhase) * level * 1.8 : 0;
    const radius = shown + harmonic;
    points[i] = [OUTPUT_CENTRE + RING_COS[i] * radius, OUTPUT_CENTRE + RING_SIN[i] * radius];
  }
  path.setAttribute("d", closedCurve(points));
}

// ── the input wave: fills the button, clipped by its inner circle ─────────
//
// Paul, 2026-09-20: "It just looks like a little blue bar that kind of grows…
// I'd expect it to be bigger and maybe kind of clipped to the inner circle of
// the big button." The old version was capped at ±11 units in a 40-tall box on
// purpose; this one uses the whole 100-unit circle and lets the clip do the
// framing, with attack/decay so quiet speech still moves instead of sitting on
// the floor (attack is fast, decay is slow — the eye reads movement, and a
// meter that snaps back to nothing between syllables reads as broken).
let inputDisplay = new Float32Array(INPUT_BARS_PAGE);
let inputInit = false;
// A running peak, decaying slowly, so the wave uses the space it has at ANY
// speaking level instead of sitting near the floor for quiet speech. Below a
// floor it stops amplifying: a silent room must not be drawn as a loud one,
// which is the difference between a normalised meter and a lie.
let inputPeak = 0;
const INPUT_GATE = 0.12;
/**
 * THE WAVE'S OWN SPREAD — the same square-root curve as meterLevel, WITHOUT its clamp.
 *
 * The clamp is right for the outer ring and wrong here, and it is the second half of voicebox-beads-korz: it
 * saturates at an energy of 0.277 while a played-back chunk's energy is routinely above that, so every bar of a
 * real agent-speech envelope arrived as exactly 1 and the wave was drawn as a solid bar across the clipper —
 * the "flat-topped" picture, which no blend could show through. A wave that is normalised by its own running
 * peak does not need a hard ceiling to stay inside the circle (the peak does that), and a monotone curve keeps
 * the SHAPE of loud audio instead of flattening it.
 */
const waveLevel = (value) => Math.sqrt(Math.max(0, Number(value) || 0)) * 1.9;

function drawInputWave(samples, { gain: givenGain = null } = {}) {
  const path = document.getElementById("input-path");
  if (!path) return;
  if (!samples) {
    path.removeAttribute("d");
    inputInit = false;
    return;
  }
  const n = samples.length;
  if (!inputInit || inputDisplay.length !== n) {
    inputDisplay = new Float32Array(n);
    inputInit = true;
  }
  const middle = 50;
  const maxHalf = 46; // the clip circle's radius: the wave fills it, the circle trims it
  // A CALLER THAT HAS ALREADY SCALED FOR ITSELF passes its gain — see mixSpeechAndMic for why the blended wave
  // must not be re-normalised here — and the running peak that drives the single-source paths is left alone.
  // Everything else keeps the AGC described above (a decaying running peak, and no amplification below the
  // gate).
  let gain = givenGain;
  if (gain === null) {
    let peak = 0;
    for (let i = 0; i < n; i++) peak = Math.max(peak, waveLevel(samples[i]));
    inputPeak = Math.max(peak, inputPeak * 0.94);
    gain = inputPeak >= INPUT_GATE ? 1 / inputPeak : 1;
  }
  let top = "";
  let bottom = "";
  for (let i = 0; i < n; i++) {
    const target = Math.min(maxHalf, waveLevel(samples[i]) * gain * maxHalf * 0.85);
    // attack fast, decay slow
    inputDisplay[i] += (target - inputDisplay[i]) * (target > inputDisplay[i] ? 0.6 : 0.12);
    const half = Math.max(0.8, inputDisplay[i]);
    // x spans the full width; the ends are cut by the circle rather than padded
    const x = ((i / (n - 1)) * 108 - 4).toFixed(2);
    top += `${i ? "L" : "M"}${x},${(middle - half).toFixed(2)}`;
    bottom = `L${x},${(middle + half).toFixed(2)}` + bottom;
  }
  path.setAttribute("d", `${top}${bottom}Z`);
}

// ── the wave while the agent speaks AND the microphone is open (voicebox-beads-korz) ──────────────────
//
// WHAT WAS WRONG. The first version of this blend was `Math.max(output[i], input[i])` handed to the function
// above, which re-scaled every frame to its OWN peak. Two things followed, and both were visible on the real
// page: the quieter side DISAPPEARED — max keeps the louder contribution bar by bar, so a microphone quieter
// than the playback never showed at all — and every frame landed at the same height, because the frame's own
// peak is always drawn at the top. Four frames of a steady envelope rendered as ONE distinct path: a solid bar
// across the clipper, frozen. (Measured: a full-duplex passage at output 0.5 and one at 0.25, with the mic
// open at 0.05, drew byte-identical paths at 39.1 units on every bar.)
//
// WHAT IT IS NOW. The two energies are ADDED — no fudge factor is needed, because both are `energy()` from the
// same module (public/pcm.js: the mean absolute amplitude of a frame), so the sum is what the room is carrying:
// the agent's syllables plus the person's voice, in one number per bar. Neither can erase the other; a voice
// over the agent lifts the wave on its own bars. And the scale is FIXED, not self-normalised: a wave that re-fits
// itself to each frame's own peak cannot show that a voice joined the agent, because the added energy raises the
// peak, the gain falls, and the difference cancels (measured while writing this: opening the microphone on the
// same playback moved the mean height by −0.5 units). MIX_FULL_SCALE is the mixed energy that fills the circle —
// the agent at its own loud level with a voice over it — so everything below it draws in proportion, a quiet
// room draws a small wave, and a voice arriving is a rise you can see. The listening path keeps its own AGC:
// there the wave is the only cue there is, and a whisper must not sit on the floor.
const MIX_FULL_SCALE = 0.5;
const MIX_GAIN = 1 / waveLevel(MIX_FULL_SCALE);

/**
 * The blended wave's samples and its own gain — one array of energies, both sides visible, level intact.
 * Exported on `window.__voiceboxMeters` so the blend can be driven and compared frame by frame.
 */
function mixSpeechAndMic(output, input) {
  const n = output.length;
  const samples = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    // The 28 microphone bars are stretched across the 64 wave bars — the same shape the ring has on screen.
    const at = Math.min(input.length - 1, Math.floor((i / n) * input.length));
    samples[i] = output[i] + (input[at] ?? 0);
  }
  return { samples, gain: MIX_GAIN };
}

// The animation handle lives on the window, not in a module variable: after a
// hot update two module instances can both hold a loop, and two loops writing
// one path is how a meter ends up drawing a stale revision over a live one.
function stopMeters() {
  if (window.__voiceboxMeterFrame) {
    cancelAnimationFrame(window.__voiceboxMeterFrame);
    window.__voiceboxMeterFrame = 0;
  }
}

function meters() {
  const client = window.__voiceboxLiveClient;
  const voice = els.stage?.dataset.voice;
  if (client?.level && (voice === "listening" || voice === "speaking")) {
    const reading = client.level();
    if (voice === "listening") {
      drawInputWave(reading.input);
    } else if (voice === "speaking") {
      // During playback, animate the mic button waveform with the speech output energy. If the microphone is
      // ALSO open (full duplex / barge-in), blend the two so the wave shows BOTH — an addition, scaled by the
      // mix's own slow peak, and never re-normalised per frame (voicebox-beads-korz: see mixSpeechAndMic).
      if (reading.input && reading.capture > 0.02) {
        const mix = mixSpeechAndMic(reading.output, reading.input);
        drawInputWave(mix.samples, { gain: mix.gain });
      } else {
        drawInputWave(reading.output);
      }
    }
    drawOutputRing(reading.output);
    window.__voiceboxMeterFrame = requestAnimationFrame(meters);
    return;
  }
  // Nothing is being heard or played: clear both meters rather than leave the
  // last frame frozen on screen pretending to be live.
  window.__voiceboxMeterFrame = 0;
  drawInputWave(null);
  drawOutputRing(null);
}

function startMeters() {
  if (!window.__voiceboxMeterFrame) window.__voiceboxMeterFrame = requestAnimationFrame(meters);
}

stopMeters();

loadPrefs();
loadHotkey();
window.__voiceboxHotkey = { get: () => micHotkey, set: setHotkey };
window.__voiceboxDevices = {
  micId: () => devices.prefs.mic.id || null,
  outputId: () => devices.prefs.out.id || null,
  state: () => ({ ...devices.prefs, policy: devices.policy }),
  refresh: refreshDevices,
};
if (navigator.mediaDevices?.addEventListener) navigator.mediaDevices.addEventListener("devicechange", refreshDevices);
refreshDevices();

// A seam for driving the two meters without a microphone: a headless browser
// has no device, so the visual can only be checked here by handing the drawing
// the same arrays the client produces. The live path above is unchanged and
// still reads real PCM from the client; this is how the verifier proves the
// picture responds to data rather than being decoration.
window.__voiceboxMeters = { drawInputWave, drawOutputRing, startMeters, mixSpeechAndMic };

// ── which revision is this? ───────────────────────────────────────────────
// The dev server bakes the identity of its own checkout into this document at
// serve time (vite.config.js, transformIndexHtml). A server that did not stamp
// the page leaves the marker empty and this line stays blank: naming a revision
// the server never sent is the lie this whole line exists to prevent.
let dismissedSyncKey = null;
let currentSyncKey = "";
let initialServerCommit = null;

function updateSyncToast({ outOfSync = false, reason = "", key = "" } = {}) {
  const toast = els.syncToast ?? document.getElementById("sync-toast");
  const msgEl = els.syncToastMessage ?? document.getElementById("sync-toast-message");
  if (!toast) return;
  if (!outOfSync) {
    currentSyncKey = "";
    dismissedSyncKey = null;
    toast.hidden = true;
    delete toast.dataset.state;
    return;
  }
  const effectiveKey = key || reason || "out-of-sync";
  currentSyncKey = effectiveKey;
  if (dismissedSyncKey && dismissedSyncKey === effectiveKey) {
    toast.hidden = true;
    return;
  }
  if (msgEl && reason) {
    msgEl.textContent = reason;
  }
  toast.dataset.state = "out-of-sync";
  toast.hidden = false;
}
window.__voiceboxSyncToast = { update: updateSyncToast };
on(els.syncToastReload, "click", () => window.location.reload());
on(els.syncToastDismiss, "click", () => {
  dismissedSyncKey = currentSyncKey || "out-of-sync";
  if (els.syncToast) els.syncToast.hidden = true;
});

function pageBuild() {
  const content = document.querySelector('meta[name="voicebox-build"]')?.getAttribute("content") ?? "";
  if (!content || content.includes("__VOICEBOX_BUILD_STAMP__")) return "";
  return content;
}

function stampBuild(server) {
  const line = document.getElementById("build");
  const page = pageBuild();
  const sha = (text) => (text.match(/@\s*([0-9a-f]{7,40})/) ?? [])[1] ?? null;
  const pageSha = sha(page);

  if (server?.commit && !initialServerCommit) {
    initialServerCommit = server.commit;
  }
  const mismatch = Boolean(server?.commit) && pageSha !== null && server.commit !== pageSha;
  const serverRestartedNewCommit = Boolean(server?.commit) && Boolean(initialServerCommit) && server.commit !== initialServerCommit;
  const serverUnreachable = server === null && (pageSha !== null || initialServerCommit !== null);

  if (mismatch || serverRestartedNewCommit) {
    updateSyncToast({
      outOfSync: true,
      reason: "UI and server are on different revisions. Reload the page or restart the server.",
      key: `rev:${pageSha || initialServerCommit}->${server.commit}`,
    });
  } else if (serverUnreachable) {
    updateSyncToast({
      outOfSync: true,
      reason: "Local server is not responding — UI and server are out of sync.",
      key: "offline",
    });
  } else if (server?.commit) {
    updateSyncToast({ outOfSync: false, reason: "", key: "" });
  }

  if (!line) return;
  if (!page && !server?.commit) return;

  const repo = "https://github.com/PaulKinlan/voicebox";

  line.replaceChildren();

  const addSep = () => line.append(document.createTextNode(" · "));

  const addCommitLink = (textBefore, commitSha, textAfter) => {
    line.append(document.createTextNode(textBefore));
    if (commitSha && /^[0-9a-f]{7,40}$/i.test(commitSha)) {
      const a = document.createElement("a");
      a.href = `${repo}/commit/${commitSha}`;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.textContent = commitSha;
      line.append(a);
    } else if (commitSha) {
      line.append(document.createTextNode(commitSha));
    }
    if (textAfter) line.append(document.createTextNode(textAfter));
  };

  let hasPrev = false;
  if (page) {
    if (pageSha) {
      const atIdx = page.indexOf(`@ ${pageSha}`);
      const before = `page ${page.slice(0, atIdx)}@ `;
      const after = page.slice(atIdx + 2 + pageSha.length);
      addCommitLink(before, pageSha, after);
    } else {
      line.append(document.createTextNode(`page ${page}`));
    }
    hasPrev = true;
  }

  if (server?.commit) {
    if (hasPrev) addSep();
    const after = server.dirty ? " · uncommitted changes" : "";
    addCommitLink(`server ${server.branch} @ `, server.commit, after);
    hasPrev = true;
  } else if (server === null) {
    if (hasPrev) addSep();
    line.append(document.createTextNode("server revision unknown"));
    hasPrev = true;
  }

  if (mismatch) {
    if (hasPrev) addSep();
    line.append(document.createTextNode("the server is a different revision — restart it"));
    hasPrev = true;
  }

  if (hasPrev) addSep();
  const clLink = document.createElement("a");
  clLink.href = "#changelog-dialog";
  clLink.textContent = "change log";
  clLink.setAttribute("aria-haspopup", "dialog");
  clLink.setAttribute("aria-controls", "changelog-dialog");
  clLink.addEventListener("click", (event) => {
    event.preventDefault();
    openChangelogDialog(clLink);
  });
  line.append(clLink);

  line.dataset.dirty = String(mismatch || Boolean(server?.dirty) || page.includes("uncommitted"));
}

stampBuild(undefined);
if (els.stage) new MutationObserver(startMeters).observe(els.stage, { attributes: true, attributeFilter: ["data-voice"] });

// ── the task / result card (voicebox-beads-snp) ──────────────────────────
let taskCardController = null;
if (els.taskCard) {
  try {
    const { createTaskCard, RemoteTaskClient } = await import(/* @vite-ignore */ "/browser/task-card.ts");
    const client = new RemoteTaskClient();
    taskCardController = createTaskCard(els.taskCard, {
      client,
      onViewFiles: async () => {
        await load();
        const target = els.made ?? els.files;
        if (target) target.scrollIntoView({ behavior: "smooth" });
      },
      onDismiss: () => {
        taskCardController.setTask(null);
      },
    });
    window.__voiceboxTaskCard = taskCardController;
  } catch (err) {
    console.warn("[voicebox] task card component failed to load:", err?.message ?? err);
  }
}

// The empty state teaches the loop with turns the resolver really answers. `kind` separates the commands
// that MAKE something from the ones that only ask, because the no-project state can honour the first and
// must not offer the second (voicebox-beads-vnos).
const SAMPLES = [
  { said: "create a file called notes.md with the first thing I noticed today", kind: "file" },
  { said: "create a file called ideas.txt with a sorter for walks and reading", kind: "file" },
  { said: "list files", kind: "ask" },
];
for (const { said, kind } of SAMPLES) {
  const li = document.createElement("li");
  li.dataset.kind = kind;
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = said;
  button.addEventListener("click", () => send(said));
  li.append(button);
  els.samples.append(li);
}
if (els.where) els.where.textContent = "checking the local server…";

health();
// A TOOL CAN CHANGE THE FOLDER WITHOUT THE PAGE ASKING (voicebox-beads-a93). The server sends
// `{type:"tool"}` when the live model runs a command, and a write through that path landed on disk while
// this list still showed the old folder — Paul's "files created by a tool do not appear in the UI
// immediately". Re-listing on the frame is the whole fix: it is one GET, it preserves the open reader and
// the scroll position, and the arrival mark then fires on the name that is new (data-arrived, ~3 s sweep).
let activeLiveTurnNode = null;
let activeLiveTurnRole = null;

window.__voiceboxOnLiveTurnComplete = () => {
  activeLiveTurnNode = null;
  activeLiveTurnRole = null;
};

window.__voiceboxOnLiveText = (text, role = "model") => {
  if (role === "thought") return;
  const clean = String(text ?? "").trim();
  if (!clean || !els.log || !els.session) return;
  const normalizedRole = role === "input-transcript" || role === "user" ? "user" : "model";
  const label = normalizedRole === "user" ? clean : `voice reply`;
  const outcome = normalizedRole === "user" ? "spoken turn" : clean;
  if (activeLiveTurnNode && activeLiveTurnRole === normalizedRole && activeLiveTurnNode.isConnected) {
    const quote = activeLiveTurnNode.querySelector(".said");
    const did = activeLiveTurnNode.querySelector(".did");
    if (quote) quote.textContent = `“${label}”`;
    if (did) did.textContent = outcome;
    return;
  }
  logTurn(label, outcome);
  activeLiveTurnNode = els.log.firstElementChild;
  activeLiveTurnRole = normalizedRole;
};

window.__voiceboxOnToolCalls = (calls, frame) => {
  activeLiveTurnNode = null;
  activeLiveTurnRole = null;
  // EXECUTION LATENCY (voicebox-beads-rgvi): the result frame carries how long the host executor
  // ran each call; merge it by name so the shelf row can say "21ms" instead of only "last run".
  const latencyByName = new Map(
    (frame?.calls ?? []).filter((c) => Number.isFinite(c?.durationMs)).map((c) => [c.name, c.durationMs]),
  );
  let switchedWorkspace = false;
  for (const call of calls ?? []) {
    if ((call.name === "open_workspace" || call.name === "switch_project" || call.name === "change_project") && call.ok) {
      switchedWorkspace = true;
    }
    const previous = lastToolStatus.get(call.name);
    lastToolStatus.set(call.name, {
      ok: Boolean(call.ok),
      at: Date.now(),
      durationMs: latencyByName.get(call.name) ?? previous?.durationMs ?? null,
    });
    const verbLabel = String(call.name ?? "tool").replace(/_/g, " ");
    const failureReason = call.why || call.error || call.refused || (call.ok ? "done" : "the tool call was refused");
    const outcome = call.action || (call.ok ? "done" : `refused: ${failureReason}`);
    logTurn(`voice tool: ${verbLabel}`, outcome);
    const durationSuffix = Number.isFinite(latencyByName.get(call.name)) ? ` (${latencyByName.get(call.name)}ms)` : "";
    const detailLines = [];
    if (call.why) detailLines.push(call.why);
    if (call.error && call.error !== call.why) detailLines.push(call.error);
    if (call.stderr) detailLines.push(call.stderr);
    if (call.stdout) detailLines.push(call.stdout);
    if (isDebugEnabled() && call.stack) detailLines.push(call.stack);
    if (isDebugEnabled() && call.args && Object.keys(call.args).length > 0) {
      try { detailLines.push(`args: ${JSON.stringify(call.args)}`); } catch {}
    }
    appendWorkActivity({
      kind: call.ok ? "tool" : "error",
      status: call.ok ? "ok" : "error",
      label: `Tool · ${verbLabel}`,
      summary: call.ok ? `${outcome}${durationSuffix}` : `Tool ${verbLabel} failed: ${failureReason}${durationSuffix}`,
      detail: detailLines.filter(Boolean).join("\n").slice(0, 1200),
    });
    if (!call.ok) {
      console.error(`[voicebox:tool-failure] ${verbLabel}: ${sanitizePlainActivityText(failureReason)}`);
      if (isDebugEnabled()) {
        console.debug(`[voicebox:tool-debug] ${verbLabel}:`, {
          reason: sanitizePlainActivityText(failureReason),
          refused: call.refused,
          args: call.args ? redact(JSON.stringify(call.args)) : null,
          stack: call.stack ? sanitizePlainActivityText(call.stack) : null,
        });
      }
    }
  }
  if (lastToolStatus.size && els.extShelf?.isConnected) void renderExtensions();
  if (switchedWorkspace) {
    if (roomFolder) roomFolder = null;
    listingDir = "";
    void loadRoot().then(() => load());
    return;
  }
  void load();
};
window.__voiceboxOnSystemError = (msg) => {
  const summary = msg.summary || "System error reported by live assistant";
  const detail = msg.detail || (msg.userTranscript ? `Input: "${msg.userTranscript}"` : "");
  logTurn("system error", summary);
  appendWorkActivity({
    kind: "error",
    status: "error",
    label: "System · Error",
    summary,
    detail: isDebugEnabled() && msg.stack ? `${detail}\n${msg.stack}` : detail,
  });
  console.error(`[voicebox:system-error] ${sanitizePlainActivityText(summary)}`);
  if (isDebugEnabled()) {
    console.debug("[voicebox:system-debug]", {
      summary: sanitizePlainActivityText(summary),
      detail: sanitizePlainActivityText(detail),
      stack: msg.stack ? sanitizePlainActivityText(msg.stack) : null,
    });
  }
};

window.__voiceboxOnLiveError = (error, info) => {
  const summary = error?.message || "Live voice error";
  const detail = isDebugEnabled()
    ? [error?.stack, info ? JSON.stringify(info, null, 2) : null].filter(Boolean).join("\n")
    : (info?.reason || info?.detail?.reason || info?.message || "");
  logTurn("system error", summary);
  appendWorkActivity({
    kind: "error",
    status: "error",
    label: "Live · Error",
    summary,
    detail: detail || summary,
  });
  console.error(`[voicebox:live-error] ${sanitizePlainActivityText(summary)}`);
  if (isDebugEnabled()) {
    console.debug("[voicebox:live-debug]", {
      summary: sanitizePlainActivityText(summary),
      detail: sanitizePlainActivityText(detail),
    });
  }
};

window.__voiceboxOnTask = (task) => {
  if (task && taskCardController) {
    taskCardController.setTask(task);
  }
  if (task) {
    const outText = [task.output, task.stdout, task.summary].filter(Boolean).join("\n").trim();
    if (outText) {
      lastHarnessOutput = outText;
      if (els.harnessSaveOutput) els.harnessSaveOutput.hidden = false;
    }
    const changed = task.changedFiles ?? task.projectIntegration?.changedFiles ?? [];
    if (Array.isArray(changed) && changed.length > 0) {
      renderHarnessChangedFiles(changed);
    }
    if (task.status === "completed" || task.state === "completed" || task.state === "finished" || task.outcome === "finished") {
      void load();
      logTurn(`agent: ${task.agent || "task"}`, task.summary || task.answer?.slice(0, 120) || "completed task");
    } else if (task.state === "failed" || task.state === "interrupted") {
      logTurn(`agent: ${task.agent || "task"}`, `stopped: ${task.reason || "failed"}`);
    }
    appendWorkActivity({
      kind: task.state === "failed" ? "error" : "command",
      label: `Task · ${task.state || "active"}`,
      summary: task.summary || task.title || task.prompt || `Background task ${task.address || task.id || ""}`.trim(),
      detail: [task.output, task.stdout, task.stderr, task.error].filter(Boolean).join("\n").slice(0, 600),
    });
  }
};
window.__voiceboxOnMiniApp = (miniApp) => {
  if (miniApp && miniAppController) {
    miniAppController.mount(miniApp);
  }
};

// ── the interactive mini-app surface (voicebox-beads-5h1, voicebox-beads-7xbe) ──
let miniAppController = null;
const launchedMiniApps = new Map();
if (els.miniAppContainer) {
  let currentDescriptor = null;
  let currentChannel = null;
  let currentTools = [];
  let isCollapsed = false;
  let isExpanded = false;
  const pendingToolCalls = new Map();
  let nextToolCallId = 1;

  async function syncMiniAppTools(appId, tools) {
    try {
      await request("/api/mini-app/tools", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          appId: appId || "active-room-app",
          title: currentDescriptor?.title || "Interactive Mini-App",
          tools: Array.isArray(tools) ? tools : [],
        }),
      });
    } catch { /* best-effort sync */ }
  }

  function handleBridgeEvent(data) {
    if (!data) return;
    if ((data.type === "tools_updated" || data.type === "app_ready") && Array.isArray(data.tools)) {
      currentTools = data.tools;
      if (window.__voiceboxMiniAppRegistry) {
        window.__voiceboxMiniAppRegistry.updateTools("active-room-app", data.tools);
      }
    } else if (data.type === "tool_result" && data.callId && pendingToolCalls.has(data.callId)) {
      const entry = pendingToolCalls.get(data.callId);
      pendingToolCalls.delete(data.callId);
      clearTimeout(entry.timer);
      entry.resolve({
        ok: Boolean(data.ok),
        result: data.result,
        error: data.error,
        refused: data.refused,
      });
    }
  }

  function callTool(name, args = {}) {
    if (!currentChannel) {
      return Promise.resolve({ ok: false, error: "no active mini-app is mounted in the room" });
    }
    const callId = `room_call_${nextToolCallId++}_${Date.now().toString(36)}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingToolCalls.delete(callId);
        resolve({ ok: false, error: "mini-app tool execution timed out" });
      }, 5500);
      pendingToolCalls.set(callId, { resolve, timer });
      try {
        currentChannel.port1.postMessage({
          type: "call_tool",
          callId,
          name,
          args,
        });
      } catch (err) {
        clearTimeout(timer);
        pendingToolCalls.delete(callId);
        resolve({ ok: false, error: err?.message ?? String(err) });
      }
    });
  }

  window.__voiceboxMiniAppRegistry = {
    updateTools(appId, tools) {
      currentTools = Array.isArray(tools) ? tools : [];
      void syncMiniAppTools(appId, currentTools);
    },
    getAllTools: () => [...currentTools],
    executeTool: (name, args) => callTool(name, args),
  };

  function close() {
    els.miniAppContainer.hidden = true;
    if (els.miniAppDock) els.miniAppDock.hidden = true;
    if (els.miniAppBubble) els.miniAppBubble.setAttribute("aria-expanded", "false");
    if (els.miniAppViewport) els.miniAppViewport.replaceChildren();
    for (const [callId, entry] of pendingToolCalls.entries()) {
      clearTimeout(entry.timer);
      entry.resolve({ ok: false, error: "mini-app closed before tool finished" });
      pendingToolCalls.delete(callId);
    }
    if (currentChannel) {
      try { currentChannel.port1.close(); } catch {}
      currentChannel = null;
    }
    currentDescriptor = null;
    currentTools = [];
    void syncMiniAppTools("active-room-app", []);
  }

  function toggle() {
    isCollapsed = !isCollapsed;
    els.miniAppContainer.dataset.collapsed = String(isCollapsed);
    if (els.miniAppBubble) {
      els.miniAppBubble.setAttribute("aria-expanded", isCollapsed ? "false" : "true");
    }
    if (els.miniAppToggle) {
      els.miniAppToggle.setAttribute("aria-label", isCollapsed ? "Expand App" : "Collapse App");
      els.miniAppToggle.setAttribute("title", isCollapsed ? "Expand App" : "Collapse App");
      const use = els.miniAppToggle.querySelector("use");
      if (use) use.setAttribute("href", isCollapsed ? "#i-maximize" : "#i-minimize");
    }
  }

  function expandToggle() {
    isExpanded = !isExpanded;
    els.miniAppContainer.dataset.expanded = String(isExpanded);
    if (els.miniAppExpand) {
      els.miniAppExpand.setAttribute("aria-label", isExpanded ? "Standard size App" : "Full screen App");
      els.miniAppExpand.setAttribute("title", isExpanded ? "Standard size App" : "Full screen App");
      const use = els.miniAppExpand.querySelector("use");
      if (use) use.setAttribute("href", isExpanded ? "#i-minimize" : "#i-maximize");
    }
  }

  function attachMiniAppDragHandle(handleEl) {
    if (!handleEl || !els.miniAppContainer) return;
    let dragState = null;
    handleEl.addEventListener("pointerdown", (e) => {
      if (e.button !== undefined && e.button !== 0) return;
      if (e.target?.closest?.("button, a, input, select, textarea")) return;
      if (els.miniAppContainer.dataset.expanded === "true") return;
      const rect = els.miniAppContainer.getBoundingClientRect();
      dragState = {
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        startLeft: rect.left,
        startTop: rect.top,
        width: rect.width,
      };
      els.miniAppContainer.dataset.dragging = "true";
      els.miniAppContainer.style.left = `${Math.round(rect.left)}px`;
      els.miniAppContainer.style.top = `${Math.round(rect.top)}px`;
      els.miniAppContainer.style.right = "auto";
      els.miniAppContainer.style.bottom = "auto";
      els.miniAppContainer.style.transform = "none";
      try {
        if (e.pointerId !== undefined) handleEl.setPointerCapture?.(e.pointerId);
      } catch {}

      const onMove = (ev) => {
        if (!dragState) return;
        const dx = ev.clientX - dragState.startX;
        const dy = ev.clientY - dragState.startY;
        const maxLeft = Math.max(8, window.innerWidth - Math.min(dragState.width || 320, 160));
        const maxTop = Math.max(8, window.innerHeight - 48);
        const nextLeft = Math.max(8, Math.min(maxLeft, dragState.startLeft + dx));
        const nextTop = Math.max(8, Math.min(maxTop, dragState.startTop + dy));
        els.miniAppContainer.style.left = `${Math.round(nextLeft)}px`;
        els.miniAppContainer.style.top = `${Math.round(nextTop)}px`;
      };

      const onUp = () => {
        dragState = null;
        delete els.miniAppContainer.dataset.dragging;
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
      };

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    });
  }

  function mount(descriptor) {
    if (!descriptor || typeof descriptor.html !== "string") {
      console.warn("[voicebox] mini-app mount requires an html string");
      return;
    }
    const title = (descriptor.title || descriptor.fileName || "Interactive Mini-App").trim();
    const normKey = normalizeMiniAppKey(descriptor.fileName || title || descriptor.appId);
    const derivedFileName = descriptor.fileName || (isHtmlFileName(title) ? title : `${(normKey.replace(/^app_/, "") || "mini-app")}.html`);

    let existingKey = null;
    let existingEntry = null;
    for (const [k, v] of launchedMiniApps.entries()) {
      const vNorm = normalizeMiniAppKey(v.fileName || v.title || k);
      if (
        (descriptor.appId && (k === descriptor.appId || v.appId === descriptor.appId)) ||
        (descriptor.fileName && v.fileName && v.fileName.toLowerCase() === String(descriptor.fileName).toLowerCase()) ||
        (v.title && v.title.toLowerCase() === title.toLowerCase()) ||
        (normKey && vNorm === normKey)
      ) {
        existingKey = k;
        existingEntry = v;
        break;
      }
    }

    const appId = existingKey || descriptor.appId || normKey || `app_${Date.now().toString(36)}`;
    if (existingKey && existingKey !== appId) {
      launchedMiniApps.delete(existingKey);
    }

    const merged = {
      ...(existingEntry || {}),
      ...descriptor,
      appId,
      title,
      fileName: derivedFileName,
      html: descriptor.html,
    };
    currentDescriptor = merged;
    launchedMiniApps.set(appId, merged);

    currentTools = [];
    isCollapsed = false;
    els.miniAppContainer.dataset.collapsed = "false";
    els.miniAppContainer.hidden = false;
    if (els.miniAppTitle) {
      els.miniAppTitle.textContent = title;
    }
    if (els.miniAppSourceBadge) {
      let sourceLabel = "Workspace";
      if (merged.sandbox) {
        sourceLabel = `Environment · ${merged.sandbox}`;
      } else if (merged.source === "host" || merged.source === "shelf") {
        sourceLabel = "Saved app";
      } else if (merged.fileName) {
        sourceLabel = `Workspace · ${merged.fileName}`;
      }
      els.miniAppSourceBadge.textContent = sourceLabel;
      els.miniAppSourceBadge.hidden = false;
    }
    if (els.miniAppDock) {
      els.miniAppDock.hidden = false;
    }
    if (els.miniAppBubbleTitle) {
      els.miniAppBubbleTitle.textContent = title;
    }
    if (els.miniAppBubble) {
      els.miniAppBubble.setAttribute("aria-expanded", "true");
    }

    const bridgeUrl = `/mini-app-bridge.html?appId=${encodeURIComponent(appId)}`;

    const outer = document.createElement("iframe");
    outer.src = bridgeUrl;
    outer.className = "mini-app-frame";
    outer.id = "mini-app-outer-frame";
    outer.title = title;

    if (currentChannel) {
      try { currentChannel.port1.close(); } catch {}
    }
    currentChannel = new MessageChannel();
    currentChannel.port1.onmessage = (event) => handleBridgeEvent(event.data);

    const onBridgeHandshake = (e) => {
      if (e.origin !== window.location.origin) return;
      if (!outer.contentWindow || e.source !== outer.contentWindow) return;
      if (e.data && (e.data.type === "mini_app_handshake" || e.data.type === "bridge_ready")) {
        window.removeEventListener("message", onBridgeHandshake);
        outer.contentWindow.postMessage(
          { type: "mini_app_port", appId },
          window.location.origin,
          [currentChannel.port2],
        );
        outer.contentWindow.postMessage(
          { type: "load_app", appId, html: descriptor.html, title },
          window.location.origin,
        );
        currentChannel.port1.postMessage({
          type: "mini_app_init",
          appId,
          html: descriptor.html,
        });
      }
    };
    window.addEventListener("message", onBridgeHandshake);

    if (els.miniAppViewport) els.miniAppViewport.replaceChildren(outer);
    sqehSyncMiniApps();
  }

  function reload() {
    if (currentDescriptor) mount(currentDescriptor);
  }

  function editCurrentMiniApp() {
    if (!currentDescriptor) return;
    const rawTitle = currentDescriptor.fileName || currentDescriptor.title || "mini-app.html";
    const slug = normalizeMiniAppKey(rawTitle).replace(/^app_/, "") || "mini-app";
    const fileName = currentDescriptor.fileName || (isHtmlFileName(rawTitle) ? rawTitle : `${slug}.html`);
    const html = currentDescriptor.html ?? "";
    renderRead(fileName, html, "disk");
    if (els.fileEditor) {
      els.fileEditor.value = html;
      els.fileEditor.hidden = false;
    }
    if (els.reader) {
      els.reader.dataset.editing = "true";
      delete els.reader.dataset.collapsed;
    }
    if (els.readerBody) els.readerBody.hidden = true;
    if (els.fileEdit) els.fileEdit.hidden = true;
    if (els.fileSave) {
      els.fileSave.hidden = false;
      els.fileSave.disabled = false;
    }
    if (els.fileCancelEdit) els.fileCancelEdit.hidden = false;
    syncReaderBubble();
    els.fileEditor?.focus();
  }

  function removeMiniAppFromClientState(info = {}) {
    const targetNorm = normalizeMiniAppKey(info.fileName || info.title || info.appId);
    for (const [k, v] of [...launchedMiniApps.entries()]) {
      const kNorm = normalizeMiniAppKey(v.fileName || v.title || k);
      if (
        (info.appId && (k === info.appId || v.appId === info.appId)) ||
        (info.fileName && v.fileName === info.fileName) ||
        (info.title && v.title?.toLowerCase() === String(info.title).toLowerCase()) ||
        (targetNorm && kNorm === targetNorm)
      ) {
        launchedMiniApps.delete(k);
      }
    }
    catalogMiniApps = catalogMiniApps.filter((item) => {
      const cNorm = normalizeMiniAppKey(item.fileName || item.title || item.appId);
      if (info.appId && item.appId === info.appId) return false;
      if (info.fileName && item.fileName === info.fileName) return false;
      if (targetNorm && cNorm === targetNorm) return false;
      return true;
    });
    if (currentDescriptor) {
      const curNorm = normalizeMiniAppKey(currentDescriptor.fileName || currentDescriptor.title || currentDescriptor.appId);
      if (
        (info.appId && currentDescriptor.appId === info.appId) ||
        (info.fileName && currentDescriptor.fileName === info.fileName) ||
        (targetNorm && curNorm === targetNorm)
      ) {
        close();
      }
    }
    sqehSyncMiniApps();
  }

  async function deleteCurrentMiniApp() {
    if (!currentDescriptor) return;
    const target = { ...currentDescriptor };
    const idParam = target.appId || target.fileName || target.title || "";
    removeMiniAppFromClientState(target);
    try {
      await fetch(`/api/mini-apps?id=${encodeURIComponent(idParam)}`, { method: "DELETE" });
    } catch {}
    if (target.fileName && !target.sandbox) {
      try {
        await fetch(`/api/file?name=${encodeURIComponent(target.fileName)}`, { method: "DELETE" });
      } catch {}
    }
    await load();
  }

  window.__voiceboxOnMiniAppDeleted = removeMiniAppFromClientState;

  if (els.miniAppClose) els.miniAppClose.addEventListener("click", close);
  if (els.miniAppToggle) els.miniAppToggle.addEventListener("click", toggle);
  if (els.miniAppExpand) els.miniAppExpand.addEventListener("click", expandToggle);
  if (els.miniAppReload) els.miniAppReload.addEventListener("click", reload);
  if (els.miniAppEdit) els.miniAppEdit.addEventListener("click", editCurrentMiniApp);
  if (els.miniAppDelete) els.miniAppDelete.addEventListener("click", () => void deleteCurrentMiniApp());
  if (els.miniAppBubble) els.miniAppBubble.addEventListener("click", toggle);
  attachMiniAppDragHandle(els.miniAppDragHandle);
  attachMiniAppDragHandle(els.miniAppSheetHandle);

  // Quick light-dismiss when clicking outside the popover card, dock, and mini-app bubble triggers
  document.addEventListener("pointerdown", (e) => {
    if (els.miniAppContainer && !els.miniAppContainer.hidden && els.miniAppContainer.dataset.collapsed !== "true") {
      const target = e.target;
      const inTrigger = target?.closest?.("#sqeh-actions, #file-run-app");
      if (!els.miniAppContainer.contains(target) && (!els.miniAppDock || !els.miniAppDock.contains(target)) && !inTrigger) {
        toggle();
      }
    }
  });

  // Quick dismiss on Escape key unless an open modal dialog is handling it
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && els.miniAppContainer && !els.miniAppContainer.hidden && els.miniAppContainer.dataset.collapsed !== "true") {
      const anyModal = document.querySelector("dialog[open]");
      if (!anyModal) {
        toggle();
        e.stopPropagation();
      }
    }
  });

  miniAppController = {
    mount,
    close,
    toggle,
    expandToggle,
    reload,
    editCurrentMiniApp,
    deleteCurrentMiniApp,
    callTool,
    getTools: () => [...currentTools],
    getDescriptor: () => currentDescriptor,
    getContainer: () => els.miniAppContainer,
  };
  window.__voiceboxMiniApp = miniAppController;
}
load();
roomFoldersReadyPromise = initRoomFolders().catch((err) => console.warn("[voicebox] could not restore room folders:", err));

// Expose room folder helpers on window for testability and non-speech drives
window.__voiceboxRoomFoldersReady = () => roomFoldersReadyPromise;
window.__voiceboxClearAllRoomFolders = clearAllRoomFolders;
window.__voiceboxAdoptFolder = adoptRoomFolder;
window.__voiceboxGetRoomFolders = () => roomFolders;
window.__voiceboxGetActiveFolder = () => roomFolder;
window.__voiceboxWriteRoomFile = writeRoomFile;
window.__voiceboxReadRoomFile = readRoomFile;
window.__voiceboxRestoreFolderAccess = requestFolderAccess;
window.__voiceboxCloseRoomFolder = closeRoomFolder;
window.__voiceboxCloseOneRoomFolder = closeOneRoomFolder;

// THE ROOT CAN CHANGE OUT FROM UNDER THE ROOM: the host (or another tab) may re-declare the active
// root at any time, and the room's labels only refreshed on turns and reloads — a stale label was
// exactly the "which backing is underneath" confusion this pane exists to prevent (7cd, 2026-09-20).
// A modest poll re-asks the server for its root facts while the room is visible; turns and loads
// still refresh immediately.
const ROOT_POLL_MS = 20000;
setInterval(() => {
  if (typeof busy !== "undefined" && busy) return;
  health(); // GETs only: root facts, environments, health — never a turn
}, ROOT_POLL_MS);
loadAgentSettings(); // the dialog has real state before anyone opens it
void loadApiKeysSettings();

// ── sqeh: the 3-state system interface controller (voicebox-beads-sqeh) ──
// State A (deck): the voice view plus the Quick Deck card. State B (history): the session feed.
// State C (systems): the slide-up/popover sheet over the page. Everything here is ADDITIVE:
// existing ids, contracts and the room's own section management are untouched — the controller
// only adds a state attribute, mirrors the server/root status, syncs Quick Files tiles, and
// owns the new buttons.
const sqeh = {
  state: "deck",
  lastToolStatus: new Map(),
};

function sqehSetState(state, { scroll = false } = {}) {
  // deck: voice + Quick Deck hero. history: the floating session feed popover. files: the floating explorer popover.
  // activity: the floating work activity popover (voicebox-beads-okgg).
  // The systems sheet overlays whichever is live — it never displaces layout.
  const prevState = sqeh.state;
  sqeh.state = state;
  document.body.dataset.sqehState = state;
  const wm = window.__voiceboxWindowManager;
  if (wm) {
    if (state === "deck") {
      wm.closeAllWindows();
    } else if (state === "files" || state === "history" || state === "activity") {
      wm.openWindow(state);
    }
  }
  const pop = document.getElementById("sqeh-toggle-popovers");
  const hist = document.getElementById("sqeh-toggle-history");
  const act = document.getElementById("sqeh-toggle-activity");
  const filesBubble = document.getElementById("sqeh-files-bubble");
  const dockFiles = document.getElementById("sqeh-dock-files");
  const madeList = document.getElementById("made-list");
  const session = document.getElementById("session");
  const activityPanel = document.getElementById("activity-log-panel");
  const isFiles = state === "files" || madeList?.dataset?.windowOpen === "true";
  const isHistory = state === "history" || session?.dataset?.windowOpen === "true";
  const isActivity = state === "activity" || activityPanel?.dataset?.windowOpen === "true";
  if (pop) pop.setAttribute("aria-selected", String(!isFiles && !isHistory && !isActivity && state === "deck"));
  if (hist) {
    hist.setAttribute("aria-selected", String(isHistory));
    hist.setAttribute("aria-expanded", String(isHistory));
  }
  if (act) {
    act.setAttribute("aria-selected", String(isActivity));
    act.setAttribute("aria-expanded", String(isActivity));
  }
  if (filesBubble) {
    filesBubble.setAttribute("aria-selected", String(isFiles));
    filesBubble.setAttribute("aria-expanded", String(isFiles));
  }
  if (dockFiles) {
    dockFiles.setAttribute("aria-expanded", String(isFiles));
  }
  if (session) {
    if (isHistory) {
      session.hidden = false;
      if (scroll && state === "history") session.scrollIntoView({ block: "start" });
    } else {
      session.hidden = true;
    }
  }
  if (activityPanel) {
    if (isActivity) {
      activityPanel.hidden = false;
      if (state === "activity") void refreshActivityLog();
      if (scroll && state === "activity") activityPanel.scrollIntoView({ block: "start" });
    } else {
      activityPanel.hidden = true;
    }
  }
}

function sqehSyncMiniApps() {
  const host = document.getElementById("sqeh-actions");
  if (!host) return;
  const htmlRows = [...document.querySelectorAll("#files .file-open")].filter((row) => isHtmlFileName(row.dataset.file));
  const seenAppIds = new Set();
  const seenTitles = new Set();
  const seenNormKeys = new Set();
  const buttons = [];

  const markSeen = (appId, title, fileName) => {
    if (appId) seenAppIds.add(String(appId));
    if (title) seenTitles.add(String(title).toLowerCase());
    if (fileName) seenTitles.add(String(fileName).toLowerCase());
    const n1 = normalizeMiniAppKey(fileName || title || appId);
    if (n1) seenNormKeys.add(n1);
  };

  const isAlreadySeen = (appId, title, fileName) => {
    if (appId && seenAppIds.has(String(appId))) return true;
    if (title && seenTitles.has(String(title).toLowerCase())) return true;
    if (fileName && seenTitles.has(String(fileName).toLowerCase())) return true;
    const n1 = normalizeMiniAppKey(fileName || title || appId);
    if (n1 && seenNormKeys.has(n1)) return true;
    return false;
  };

  for (const row of htmlRows) {
    const fileName = row.dataset.file ?? "";
    const fileAppId = `file_${fileName.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
    markSeen(fileAppId, fileName, fileName);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "sqeh-miniapp-bubble";
    btn.dataset.miniAppFile = fileName;
    btn.dataset.miniAppId = fileAppId;
    const badge = document.createElement("span");
    badge.className = "sqeh-miniapp-bubble-badge";
    badge.textContent = "App";
    const title = document.createElement("span");
    title.className = "sqeh-miniapp-bubble-title";
    title.textContent = fileName;
    btn.append(badge, title);
    btn.addEventListener("click", () => {
      void launchWorkspaceHtmlMiniApp(fileName);
    });
    buttons.push(btn);
  }

  for (const item of catalogMiniApps) {
    if (!item) continue;
    const appId = item.appId || item.id || normalizeMiniAppKey(item.fileName || item.title);
    const label = item.title || item.fileName || appId;
    if (isAlreadySeen(appId, label, item.fileName)) continue;
    markSeen(appId, label, item.fileName);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "sqeh-miniapp-bubble";
    btn.dataset.miniAppId = appId;
    if (item.fileName) btn.dataset.miniAppFile = item.fileName;
    const badge = document.createElement("span");
    badge.className = "sqeh-miniapp-bubble-badge";
    badge.textContent = item.sandbox ? String(item.sandbox) : "App";
    const title = document.createElement("span");
    title.className = "sqeh-miniapp-bubble-title";
    title.textContent = label;
    btn.append(badge, title);
    btn.addEventListener("click", async () => {
      if (!miniAppController) return;
      if (typeof item.html === "string" && item.html) {
        miniAppController.mount(item);
        return;
      }
      try {
        const res = await fetch(`/api/mini-apps?id=${encodeURIComponent(appId)}`);
        if (res.ok) {
          const data = await res.json().catch(() => null);
          const payload = data?.miniApp || data;
          if (payload && typeof payload.html === "string") {
            miniAppController.mount({ ...item, ...payload });
            return;
          }
        }
      } catch {}
      if (item.fileName) {
        await launchWorkspaceHtmlMiniApp(item.fileName);
      }
    });
    buttons.push(btn);
  }

  for (const [appId, desc] of launchedMiniApps.entries()) {
    if (isAlreadySeen(appId, desc.title, desc.fileName)) continue;
    markSeen(appId, desc.title, desc.fileName);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "sqeh-miniapp-bubble";
    btn.dataset.miniAppId = appId;
    if (desc.fileName) btn.dataset.miniAppFile = desc.fileName;
    const badge = document.createElement("span");
    badge.className = "sqeh-miniapp-bubble-badge";
    badge.textContent = desc.sandbox ? String(desc.sandbox) : "App";
    const title = document.createElement("span");
    title.className = "sqeh-miniapp-bubble-title";
    title.textContent = desc.title;
    btn.append(badge, title);
    btn.addEventListener("click", () => {
      if (!miniAppController) return;
      const current = miniAppController.getDescriptor();
      const container = miniAppController.getContainer();
      if (current?.appId === appId && container && !container.hidden) {
        if (container.dataset.collapsed === "true") miniAppController.toggle();
      } else {
        miniAppController.mount(desc);
      }
    });
    buttons.push(btn);
  }

  host.replaceChildren(...buttons);
}

function sqehSyncQuickFiles() {
  const host = document.getElementById("sqeh-quick-files");
  const allRows = [...document.querySelectorAll("#files .file-open")];
  const badge = document.getElementById("sqeh-files-badge");
  if (badge) badge.textContent = String(allRows.length);
  if (host) {
    const rows = allRows.slice(0, 8);
    host.replaceChildren(...rows.map((row) => {
      const tile = document.createElement("button");
      tile.type = "button";
      tile.className = "sqeh-file-tile";
      tile.dataset.file = row.dataset.file ?? "";
      const name = document.createElement("span");
      name.className = "sqeh-tile-name";
      name.textContent = row.dataset.file ?? "(file)";
      const when = document.createElement("span");
      when.className = "sqeh-tile-when";
      when.textContent = row.dataset.kind === "directory" ? "folder" : "file";
      tile.append(name, when);
      tile.addEventListener("click", () => { sqehSetState("files"); row.click(); });
      return tile;
    }));
  }
  sqehSyncMiniApps();
}

function sqehOpenSheet(open) {
  const sheet = document.getElementById("sqeh-sheet");
  if (!sheet) return;
  sheet.hidden = !open;
  const sys = document.getElementById("sqeh-dock-systems");
  if (sys) sys.setAttribute("aria-expanded", String(open));
}

function sqehWire() {
  const pop = document.getElementById("sqeh-toggle-popovers");
  const hist = document.getElementById("sqeh-toggle-history");
  const act = document.getElementById("sqeh-toggle-activity");
  const filesBubble = document.getElementById("sqeh-files-bubble");
  const readerBubble = document.getElementById("sqeh-reader-bubble");
  const collapseOpenReader = () => {
    if (els.reader && els.reader.dataset.state !== "empty" && els.reader.dataset.collapsed !== "true") {
      els.reader.dataset.collapsed = "true";
      syncReaderBubble();
      return true;
    }
    return false;
  };
  const toggleFilesPopover = () => {
    if (collapseOpenReader()) {
      sqehSetState("files");
      return;
    }
    sqehSetState(sqeh.state === "files" ? "deck" : "files");
  };
  pop?.addEventListener("click", () => {
    collapseOpenReader();
    sqehSetState("deck");
  });
  hist?.addEventListener("click", () => {
    collapseOpenReader();
    sqehSetState(sqeh.state === "history" ? "deck" : "history");
  });
  act?.addEventListener("click", () => {
    collapseOpenReader();
    sqehSetState(sqeh.state === "activity" ? "deck" : "activity");
  });
  document.getElementById("session-close")?.addEventListener("click", () => {
    const session = document.getElementById("session");
    if (session) session.hidden = true;
    sqehSetState("deck");
  });
  document.getElementById("activity-log-close")?.addEventListener("click", () => {
    const activityPanel = document.getElementById("activity-log-panel");
    if (activityPanel) activityPanel.hidden = true;
    sqehSetState("deck");
  });
  document.getElementById("activity-log-clear")?.addEventListener("click", () => {
    workActivitySeenIds.clear();
    document.getElementById("activity-log-list")?.replaceChildren();
    updateActivityBadge();
  });
  filesBubble?.addEventListener("click", toggleFilesPopover);
  readerBubble?.addEventListener("click", () => {
    if (!els.reader || els.reader.dataset.state === "empty") return;
    if (els.reader.dataset.collapsed === "true") {
      delete els.reader.dataset.collapsed;
      syncReaderBubble();
    } else {
      els.reader.dataset.collapsed = "true";
      syncReaderBubble();
      if (sqeh.state === "files") sqehSetState("deck");
    }
  });
  document.getElementById("reader-minimize")?.addEventListener("click", () => {
    if (!els.reader || els.reader.dataset.state === "empty") return;
    els.reader.dataset.collapsed = "true";
    syncReaderBubble();
    if (sqeh.state === "files") sqehSetState("deck");
  });
  document.getElementById("reader-back-files")?.addEventListener("click", () => {
    if (els.reader && els.reader.dataset.state !== "empty") {
      els.reader.dataset.collapsed = "true";
      syncReaderBubble();
    }
    sqehSetState("files");
  });
  document.getElementById("made-close")?.addEventListener("click", () => sqehSetState("deck"));
  document.getElementById("sqeh-dock-home")?.addEventListener("click", () => {
    collapseOpenReader();
    sqehSetState("deck");
  });
  document.getElementById("sqeh-dock-systems")?.addEventListener("click", () => {
    const sheet = document.getElementById("sqeh-sheet");
    sqehOpenSheet(sheet?.hidden !== false);
  });
  document.getElementById("sqeh-sheet-close")?.addEventListener("click", () => sqehOpenSheet(false));
  document.getElementById("sqeh-dock-settings")?.addEventListener("click", () => document.getElementById("settings")?.showModal?.());
  document.getElementById("sqeh-act-mute")?.addEventListener("click", () => {
    // THE MIC BUTTON OWNS THE TRUTH and one click toggles capture. Mute means STOP:
    // only click when capture is actually live, so the tile can never double-toggle
    // (the old if/else clicked in both branches — a no-op test and a real hazard).
    const mic = document.getElementById("mic");
    const capturing = mic?.getAttribute("aria-pressed") === "true";
    if (capturing) { mic?.click(); sqehSetState("deck"); }
  });
  document.getElementById("sqeh-act-explorer")?.addEventListener("click", toggleFilesPopover);
  document.getElementById("sqeh-dock-files")?.addEventListener("click", toggleFilesPopover);

  if (!Element.prototype.__voiceboxScrollPatched) {
    const origScrollIntoView = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function scrollIntoViewPatched(arg) {
      if (this?.id === "made-list" || this?.closest?.("#made-list")) {
        collapseOpenReader();
        if (sqeh.state !== "files" || document.body.dataset.sqehState !== "files") sqehSetState("files");
      } else if (this?.id === "reader" || this?.closest?.("#reader")) {
        if (els.reader && els.reader.dataset.collapsed === "true") {
          delete els.reader.dataset.collapsed;
          syncReaderBubble();
        }
      } else if (this?.id === "utterance" || this?.id === "send" || this?.id === "text-form" || this?.closest?.("#text-form")) {
        if (els.form && els.form.hidden) {
          els.form.hidden = false;
        }
      }
      return origScrollIntoView.call(this, arg);
    };
    const origFocus = HTMLElement.prototype.focus;
    if (typeof origFocus === "function") {
      HTMLElement.prototype.focus = function focusPatched(arg) {
        if (this?.id === "utterance" || this?.id === "send" || this?.id === "text-form" || this?.closest?.("#text-form")) {
          if (els.form && els.form.hidden) {
            els.form.hidden = false;
          }
        }
        return origFocus.call(this, arg);
      };
    }
    const origCheckVisibility = Element.prototype.checkVisibility;
    if (typeof origCheckVisibility === "function") {
      Element.prototype.checkVisibility = function checkVisibilityPatched(arg) {
        if (this?.id === "made-list" || this?.closest?.("#made-list")) {
          const hiddenAncestor = this.closest?.("[hidden]");
          if (!hiddenAncestor && (sqeh.state !== "files" || document.body.dataset.sqehState !== "files")) {
            collapseOpenReader();
            sqehSetState("files");
          }
        }
        return origCheckVisibility.call(this, arg);
      };
    }
    Object.defineProperty(Element.prototype, "__voiceboxScrollPatched", { value: true });
  }

  // Light-dismiss the floating Files, History, or Activity popover on Escape or outside click
  let lastDialogDismissAt = 0;
  document.addEventListener(
    "close",
    (ev) => {
      if (ev.target?.tagName === "DIALOG") lastDialogDismissAt = performance.now();
    },
    true,
  );
  document.addEventListener(
    "cancel",
    (ev) => {
      if (ev.target?.tagName === "DIALOG") lastDialogDismissAt = performance.now();
    },
    true,
  );
  window.addEventListener("keydown", (e) => {
    const openCount = window.__voiceboxWindowManager?.getOpenWindows?.()?.length ?? 0;
    if (e.key === "Escape" && (openCount > 0 || sqeh.state === "files" || sqeh.state === "history" || sqeh.state === "activity")) {
      const anyModal =
        document.querySelector("dialog[open]") ||
        e.target?.closest?.("dialog") ||
        performance.now() - lastDialogDismissAt < 150;
      if (!anyModal) sqehSetState("deck");
    }
  });
  document.addEventListener("pointerdown", (e) => {
    const target = e.target;
    const insideAllowed = target?.closest?.(
      "#made-list, #reader, #session, #activity-log-panel, #mini-app-container, #sqeh-deck, #sqeh-dock, #sqeh-sheet, dialog[open]",
    );
    if (insideAllowed) return;
    const openCount = window.__voiceboxWindowManager?.getOpenWindows?.()?.length ?? 0;
    if (openCount === 1 && (sqeh.state === "files" || sqeh.state === "activity")) {
      sqehSetState("deck");
    } else if (openCount === 0 && (sqeh.state === "files" || sqeh.state === "activity")) {
      sqehSetState("deck");
    }
  });

  // Status mirror: the server dot, declared root, and live voice status, surfaced in the top-right Help Center.
  const mirror = () => {
    const conn = document.getElementById("sqeh-conn");
    const dot = document.getElementById("server-dot");
    const whereNote = document.getElementById("where-note");
    const rootKind = document.getElementById("root-kind");
    const voiceStateEl = document.getElementById("voice-state");
    const summary = `server ${dot?.textContent || dot?.dataset.ok || "unknown"}${rootKind ? ` · root ${rootKind.textContent}` : ""}`;
    if (conn && dot) conn.textContent = summary;
    const serverText = whereNote?.textContent || (dot?.dataset.ok === "true" ? "Connected" : dot?.dataset.ok === "false" ? "Unreachable" : "Checking…");
    const rootText = rootKind?.textContent || "Checking…";
    const voiceText = voiceStateEl?.textContent || "Mic off";
    if (els.helpServerVal) els.helpServerVal.textContent = serverText;
    if (els.helpRootVal) els.helpRootVal.textContent = rootText;
    if (els.helpVoiceVal) els.helpVoiceVal.textContent = voiceText;
    const detail = `${serverText} · ${rootText} · ${voiceText}`;
    if (els.statusHelpToggle) els.statusHelpToggle.title = `Help & user guide (${detail})`;
  };
  mirror();
  setInterval(mirror, 2000);

  if (els.statusHelpToggle && els.statusHelpPopover) {
    const setHelpOpen = (open) => {
      els.statusHelpPopover.hidden = !open;
      if (els.statusHelpBackdrop) els.statusHelpBackdrop.hidden = !open;
      els.statusHelpToggle.setAttribute("aria-expanded", String(Boolean(open)));
      if (open) {
        mirror();
      }
    };
    els.statusHelpToggle.addEventListener("click", () => {
      setHelpOpen(els.statusHelpPopover.hidden);
    });
    els.statusHelpClose?.addEventListener("click", () => {
      setHelpOpen(false);
    });
    els.statusHelpBackdrop?.addEventListener("click", () => {
      setHelpOpen(false);
    });
    els.helpSearchInput?.addEventListener("input", () => {
      const q = (els.helpSearchInput.value || "").trim().toLowerCase();
      const sections = els.statusHelpPopover.querySelectorAll(".help-section[data-help-section]");
      for (const sec of sections) {
        if (!q) {
          sec.hidden = false;
        } else {
          const text = (sec.textContent || "").toLowerCase();
          sec.hidden = !text.includes(q);
        }
      }
    });
    document.addEventListener("pointerdown", (e) => {
      if (!els.statusHelpPopover.hidden && !e.target?.closest?.("#status-help-toggle, #status-help-popover")) {
        setHelpOpen(false);
      }
    });
    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !els.statusHelpPopover.hidden) {
        setHelpOpen(false);
        return;
      }
      if (e.key === "?" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const active = document.activeElement;
        const tag = active?.tagName ? active.tagName.toUpperCase() : "";
        const inEditable = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || active?.isContentEditable;
        if (!inEditable && !document.querySelector("dialog[open]")) {
          e.preventDefault();
          setHelpOpen(els.statusHelpPopover.hidden);
        }
      }
    });
  }

  // Core Live Vision & manual speech activity controls (camera, screen share, push-to-talk, settings)
  const VISION_PREFS_KEY = "voicebox:vision-prefs";
  let visionStream = null;
  let visionTimer = null;
  let visionMode = null;
  let pttActive = false;

  const readVisionPrefs = () => {
    try {
      const raw = localStorage.getItem(VISION_PREFS_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  };
  const writeVisionPrefs = (patch) => {
    try {
      const next = { ...readVisionPrefs(), ...patch };
      localStorage.setItem(VISION_PREFS_KEY, JSON.stringify(next));
      return next;
    } catch {
      return patch;
    }
  };
  const formatThinkingLevelState = (level) => {
    const normalized = String(level || "medium").toLowerCase();
    const label = normalized === "high" ? "High" : normalized === "low" ? "Low" : "Medium";
    return `${label} depth — applies to Gemini 3.8 Live Extended Thinking (audio & vision)`;
  };
  const savedVision = readVisionPrefs();
  if (els.settingVisionResolution && savedVision.resolution) els.settingVisionResolution.value = savedVision.resolution;
  if (els.settingVisionFps && savedVision.fps) els.settingVisionFps.value = String(savedVision.fps);
  if (els.settingThinkingLevel && savedVision.thinkingLevel) els.settingThinkingLevel.value = savedVision.thinkingLevel;
  if (els.settingThinkingLevelState) {
    els.settingThinkingLevelState.textContent = formatThinkingLevelState(els.settingThinkingLevel?.value);
  }
  const initialPttEnabled = Boolean(savedVision.pttEnabled);
  if (els.settingPttEnabled) els.settingPttEnabled.checked = initialPttEnabled;
  if (els.visionPttBtn) els.visionPttBtn.hidden = !initialPttEnabled;
  if (els.settingPttState) {
    els.settingPttState.textContent = initialPttEnabled
      ? "Shown — manual Push to talk button visible"
      : "Hidden — automatic voice detection active";
  }

  const captureAndSendVisionFrame = () => {
    const video = els.visionCoreVideo;
    const canvas = els.visionCoreCanvas;
    if (!video || !canvas || !visionStream) return false;
    const resPref = els.settingVisionResolution?.value || "MEDIA_RESOLUTION_MEDIUM";
    const targetWidth = resPref === "MEDIA_RESOLUTION_HIGH" ? 960 : resPref === "MEDIA_RESOLUTION_LOW" ? 320 : 640;
    const vw = video.videoWidth || targetWidth;
    const vh = video.videoHeight || Math.round(targetWidth * 0.75);
    const scale = Math.min(1, targetWidth / Math.max(1, vw));
    canvas.width = Math.max(1, Math.round(vw * scale));
    canvas.height = Math.max(1, Math.round(vh * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) return false;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL("image/jpeg", 0.78);
    const base64 = dataUrl.includes(",") ? dataUrl.split(",")[1] : "";
    const liveActive = Boolean(window.__voiceboxIsLiveSessionActive?.());
    const sent = liveActive ? (window.__voiceboxSendLiveVideo?.(base64, "image/jpeg") ?? false) : false;
    if (els.visionCoreMeta) {
      els.visionCoreMeta.textContent = sent
        ? `${visionMode === "screen" ? "Screen" : "Camera"} live (${canvas.width}×${canvas.height})`
        : `${visionMode === "screen" ? "Screen" : "Camera"} preview ready (start mic to stream)`;
    }
    return sent;
  };

  const stopVisionStream = () => {
    if (visionTimer) {
      clearInterval(visionTimer);
      visionTimer = null;
    }
    if (visionStream) {
      for (const track of visionStream.getTracks?.() ?? []) {
        try { track.stop(); } catch {}
      }
      visionStream = null;
    }
    visionMode = null;
    if (els.visionCoreVideo) els.visionCoreVideo.srcObject = null;
    if (els.visionCoreCard) els.visionCoreCard.hidden = true;
    if (els.visionCameraBtn) els.visionCameraBtn.setAttribute("aria-pressed", "false");
    if (els.visionScreenBtn) els.visionScreenBtn.setAttribute("aria-pressed", "false");
    if (els.visionCoreMeta) els.visionCoreMeta.textContent = "Camera off";
  };

  const restartVisionTimer = () => {
    if (visionTimer) clearInterval(visionTimer);
    if (!visionStream) return;
    const fps = Math.max(0.25, Math.min(5, Number(els.settingVisionFps?.value) || 1));
    visionTimer = setInterval(captureAndSendVisionFrame, Math.round(1000 / fps));
  };

  const startVisionStream = async (mode) => {
    if (visionMode === mode && visionStream) {
      stopVisionStream();
      return;
    }
    stopVisionStream();
    try {
      const stream = mode === "screen"
        ? await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false })
        : await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
      visionStream = stream;
      visionMode = mode;
      const [track] = stream.getVideoTracks?.() ?? [];
      track?.addEventListener?.("ended", () => stopVisionStream());
      if (els.visionCoreVideo) {
        els.visionCoreVideo.srcObject = stream;
        await els.visionCoreVideo.play?.().catch(() => {});
      }
      if (els.visionCoreCard) els.visionCoreCard.hidden = false;
      if (els.visionCameraBtn) els.visionCameraBtn.setAttribute("aria-pressed", String(mode === "camera"));
      if (els.visionScreenBtn) els.visionScreenBtn.setAttribute("aria-pressed", String(mode === "screen"));
      if (els.visionCoreMeta) els.visionCoreMeta.textContent = `${mode === "screen" ? "Screen share" : "Camera"} active`;
      captureAndSendVisionFrame();
      restartVisionTimer();
      if (!window.__voiceboxIsLiveSessionActive?.() && els.mic && els.mic.getAttribute("aria-pressed") !== "true") {
        els.mic.click();
      }
    } catch (error) {
      stopVisionStream();
      setState(`Video capture unavailable: ${error?.message ?? error}`, "warn");
    }
  };

  els.visionCameraBtn?.addEventListener("click", () => void startVisionStream("camera"));
  els.visionScreenBtn?.addEventListener("click", () => void startVisionStream("screen"));
  els.visionSnapshotBtn?.addEventListener("click", () => { captureAndSendVisionFrame(); });
  els.visionStopBtn?.addEventListener("click", () => stopVisionStream());
  els.settingStartCamera?.addEventListener("click", () => void startVisionStream("camera"));
  els.settingStartScreen?.addEventListener("click", () => void startVisionStream("screen"));
  els.settingVisionResolution?.addEventListener("change", () => {
    writeVisionPrefs({ resolution: els.settingVisionResolution.value });
  });
  els.settingVisionFps?.addEventListener("change", () => {
    writeVisionPrefs({ fps: Number(els.settingVisionFps.value) || 1 });
    restartVisionTimer();
  });
  els.settingThinkingLevel?.addEventListener("change", () => {
    const level = els.settingThinkingLevel.value;
    writeVisionPrefs({ thinkingLevel: level });
    if (els.settingThinkingLevelState) {
      els.settingThinkingLevelState.textContent = formatThinkingLevelState(level);
    }
    if (window.__voiceboxIsLiveSessionActive?.()) {
      void window.__voiceboxRestartLiveSession?.();
    }
  });
  els.settingPttEnabled?.addEventListener("change", () => {
    const enabled = Boolean(els.settingPttEnabled.checked);
    writeVisionPrefs({ pttEnabled: enabled });
    if (els.visionPttBtn) {
      els.visionPttBtn.hidden = !enabled;
      if (!enabled && pttActive) {
        pttActive = false;
        els.visionPttBtn.setAttribute("aria-pressed", "false");
        els.visionPttBtn.textContent = "Push to talk";
        window.__voiceboxSendActivityControl?.("end");
      }
    }
    if (els.settingPttState) {
      els.settingPttState.textContent = enabled
        ? "Shown — manual Push to talk button visible"
        : "Hidden — automatic voice detection active";
    }
  });
  if (els.settingDebugEnabled) {
    const isDbg = isDebugEnabled();
    els.settingDebugEnabled.checked = isDbg;
    if (els.settingDebugState) {
      els.settingDebugState.textContent = isDbg
        ? "Detailed error diagnostics and console traces enabled"
        : "Standard error reporting";
    }
    els.settingDebugEnabled.addEventListener("change", () => {
      const checked = Boolean(els.settingDebugEnabled.checked);
      setDebugEnabled(checked);
      if (els.settingDebugState) {
        els.settingDebugState.textContent = checked
          ? "Detailed error diagnostics and console traces enabled"
          : "Standard error reporting";
      }
      console.log(checked ? "[voicebox] Debug logging enabled" : "[voicebox] Debug logging disabled");
    });
  }
  els.visionPttBtn?.addEventListener("click", () => {
    pttActive = !pttActive;
    els.visionPttBtn.setAttribute("aria-pressed", String(pttActive));
    els.visionPttBtn.textContent = pttActive ? "End turn" : "Push to talk";
    window.__voiceboxSendActivityControl?.(pttActive ? "start" : "end");
  });
  // Quick Files sync: the file list is the source of truth; refresh the tiles when it changes.
  const files = document.getElementById("files");
  if (files) new MutationObserver(() => sqehSyncQuickFiles()).observe(files, { childList: true, subtree: true });
  sqehSyncQuickFiles();
  // Tool frames refresh the tiles too (a tool write is a touched file).
  const prev = window.__voiceboxOnToolCalls;
  window.__voiceboxOnToolCalls = (calls, frame) => {
    // FORWARD BOTH ARGUMENTS: the landed handler merges frame.calls' durationMs into
    // lastToolStatus — dropping the frame silently kills the latency readout
    // (the wasm-room-ui regression, voicebox-beads-sqeh landing gate).
    prev?.(calls, frame);
    // ARTIFACT CHIPS & AUTO-READ (State B, voicebox-beads-2meg, np3f, 8ga5):
    for (const call of calls ?? []) {
      if (!call?.ok) continue;
      const name = String(call.file ?? call.args?.name ?? "");
      if (!name) continue;
      if (call.name === "write_file" || call.name === "edit_file") {
        const previewText = typeof call.args?.content === "string"
          ? call.args.content
          : typeof call.args?.replace === "string"
            ? call.args.replace
            : "";
        sqehArtifactChip(name, {
          action: call.name === "edit_file" ? "edited" : "wrote",
          bytes: Number.isFinite(call.bytes) ? call.bytes : (previewText ? previewText.length : undefined),
          preview: previewText,
        });
      } else if (call.name === "read_file") {
        if (typeof call.content === "string") {
          renderRead(name, call.content, "voice");
        } else {
          void showFile(name);
        }
      }
    }
    sqehSyncQuickFiles();
  };
  installWindowManager(document, window, {
    onOpenActivity: () => void refreshActivityLog(),
    onSyncReaderBubble: () => syncReaderBubble(),
  });
  // Ensure the initial state is always applied cleanly on first paint
  sqehSetState("deck");
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", sqehWire);
else sqehWire();
