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
import { applyTheme, initTheme } from "./theme.mjs";

import { initExtensionsUI, renderExtensions } from "./extensions-ui.mjs";
import { initSettingsUi } from "./settings-ui.mjs";
import { createBoundedSeenSet, encodeVisionFrame } from "./vision-frame-encoder.mjs";
import { drawInputWave, drawOutputRing, meterLevel, mixSpeechAndMic } from "./audio-meters.mjs";
import { createBranchLandingController } from "./branch-landing-ui.mjs";
import { createOfflineSpeechController } from "./offline-speech-client.mjs";
import { createPresenceUIController } from "./presence-ui.mjs";
import { createVisionGroundingController } from "./vision-grounding.mjs";
import { initChangelogDialog } from "./components/changelog-dialog.mjs";
import { initEnvironmentRootDialog } from "./components/environment-root-dialog.mjs";
import { initMicHotkeyController } from "./components/mic-hotkey-controller.mjs";
import { createSyncToastController, pageBuild } from "./components/sync-toast.mjs";
import { initEnvironmentList } from "./components/environment-list.mjs";
import { initMiniAppHost } from "./components/mini-app-surface.mjs";
import { initHarnessesDialog } from "./components/harnesses-dialog.mjs";
import { createAudioDeviceController } from "./components/audio-device-controller.mjs";
import { initActivityLog } from "./components/activity-log-ui.mjs";

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
  branchesOpen: "branches-open", branchesBadge: "branches-badge",
  branchLandingDialog: "branch-landing-dialog", branchLandingClose: "branch-landing-close",
  branchRefreshBtn: "branch-refresh-btn", branchLandingStatus: "branch-landing-status",
  branchesList: "branches-list", branchDetailPanel: "branch-detail-panel",
  branchDetailName: "branch-detail-name", branchMergeBadge: "branch-merge-badge",
  branchLandBtn: "branch-land-btn", branchKeepBtn: "branch-keep-btn",
  branchActionResult: "branch-action-result", branchFilesCount: "branch-files-count",
  branchFilesList: "branch-files-list", branchDiffViewer: "branch-diff-viewer",
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
  visionGroundingOverlay: "vision-grounding-overlay",
  visionCoreMeta: "vision-core-meta", visionSnapshotBtn: "vision-snapshot-btn", visionStopBtn: "vision-stop-btn",
  settingPttEnabled: "setting-ptt-enabled", settingPttState: "setting-ptt-state",
  settingDebugEnabled: "setting-debug-enabled", settingDebugState: "setting-debug-state",
  settingOfflineSpeechEnabled: "setting-offline-speech-enabled", settingOfflineSpeechState: "setting-offline-speech-state",
  settingVisionResolution: "setting-vision-resolution", settingVisionFps: "setting-vision-fps",
  settingThinkingLevel: "setting-thinking-level", settingThinkingLevelState: "setting-thinking-level-state",
  settingStartCamera: "setting-start-camera", settingStartScreen: "setting-start-screen",
  thinkingTrace: "thinking-trace", thinkingTraceBody: "thinking-trace-body", thinkingTraceLabel: "thinking-trace-label",
  roomPresenceStrip: "room-presence-strip", presenceCount: "presence-count",
  presenceFloorBadge: "presence-floor-badge", presenceRoster: "presence-roster",
  presenceFloorBtn: "presence-floor-btn",
  settingsRunDoctor: "settings-run-doctor", settingsDoctorStatus: "settings-doctor-status",
  settingsDoctorResults: "settings-doctor-results", settingsDoctorList: "settings-doctor-list",
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

// ── Theme preference lives in ./theme.mjs (voicebox-beads-ri9x, first slice of voicebox-beads-mvxl).
//    Handed the three controls it syncs, so it depends on nothing else in this file; the system-command
//    branch below still calls its applyTheme. Booted here, where this file used to do the work itself. ──
initTheme({ themeSelect: els.themeSelect, themeSelectState: els.themeSelectState, themeToggle: els.themeToggle });

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
  // THE FIELD NAMES HERE ARE THE PRODUCER'S, NOT THIS FUNCTION'S (voicebox-beads-ucak).
  // lib/system-commands.mjs is the declared owner of the command vocabulary and emits `mode` for
  // switch_theme and `target` for open_panel; server.mjs forwards exactly those fields on both client
  // paths (the /channel "system_command" frame and the POST /api/turn response). This function used to
  // read `cmd.theme` and `cmd.panel`, which NOBODY has ever produced — so the guard never matched,
  // the branch never ran, and every navigation and appearance command silently did nothing while the
  // server reported ok and logged it. Do not add a `cmd.mode || cmd.theme` fallback: two names for
  // one fact is what scripts/single-owner.mjs exists to prevent.
  if (cmd.command === "switch_theme" && cmd.mode) {
    applyTheme(cmd.mode, { persist: true });
    return { ok: true, theme: cmd.mode };
  }
  if (cmd.command === "open_panel" && cmd.target) {
    // Every target the catalogue emits is handled here, including the two that had no branch at all:
    // `agent-tracker` (the built-in Agent Progress Tracker mini-app, openAgentProgressTracker) and
    // `close` (back to the deck, which closes every open window). Invocation stays imperative —
    // showModal() and the modules' own controls — deliberately: this is a vocabulary repair, and
    // moving it to declarative Invoker Commands would need a polyfill for a feature that is only
    // Baseline newly available.
    const p = String(cmd.target).toLowerCase();
    if (p === "settings") els.settingsOpen?.click();
    else if (p === "harnesses") els.harnessesOpen?.click?.();
    else if (p === "extensions") els.extsOpen?.click?.();
    else if (p === "environments") els.envsOpen?.click?.();
    else if (p === "changelog") els.changelogOpen?.click?.();
    else if (p === "branches" || p === "waiting-branches") {
      if (window.__voiceboxBranchLanding?.openDialog) window.__voiceboxBranchLanding.openDialog();
      else els.branchesOpen?.click?.();
    }
    else if (p === "agent-tracker") void openAgentProgressTracker();
    else if (p === "close") {
      // "close panel" closes what is actually open: any modal sheet on the page, then the deck home,
      // which closes the open windows. Closing only the deck would leave a person with the Settings
      // sheet in front of them after asking for it to be closed, which is the plain reading of the
      // command. The dialogs are all <dialog closedby="any">, so the platform closes them for a
      // click or Escape already — this is the same action, from a voice command.
      for (const dialog of document.querySelectorAll("dialog[open]")) dialog.close();
      sqehSetState("deck");
    }
    else if (p === "files" || p === "history" || p === "activity" || p === "deck") sqehSetState(p);
    return { ok: true, panel: p };
  }
  if (cmd.command === "stop_speaking") {
    try { window.speechSynthesis?.cancel?.(); } catch {}
    const mode = cmd.mode || (/unmute/i.test(cmd.text || "") ? "unmute" : /mute/i.test(cmd.text || "") ? "mute" : "interrupt");
    const micPressed = els.mic?.getAttribute("aria-pressed") === "true";
    if (mode === "unmute") {
      if (!micPressed) {
        els.mic?.click();
      }
      return { ok: true, action: "unmute", message: "Microphone unmuted." };
    }
    if (mode === "mute") {
      if (micPressed) {
        els.mic?.click();
      }
      return { ok: true, action: "mute", message: "Microphone muted." };
    }
    els.interrupt?.click();
    return { ok: true, action: "interrupt", message: "Stopped speaking." };
  }
  if (cmd.command === "show_waiting_branches") {
    if (window.__voiceboxBranchLanding?.openDialog) {
      window.__voiceboxBranchLanding.openDialog();
    } else {
      els.branchesOpen?.click?.();
    }
    return { ok: true, action: "show_waiting_branches" };
  }
  if (cmd.command === "land_branch") {
    if (window.__voiceboxBranchLanding?.landSelectedBranch) {
      void window.__voiceboxBranchLanding.landSelectedBranch();
    }
    return { ok: true, action: "land_branch" };
  }
  if (cmd.command === "keep_branch_separate") {
    if (window.__voiceboxBranchLanding?.keepSelectedBranchSeparate) {
      void window.__voiceboxBranchLanding.keepSelectedBranchSeparate();
    }
    return { ok: true, action: "keep_branch_separate" };
  }
  if (cmd.command === "compare_harnesses") {
    void openAgentProgressTracker();
    return { ok: true, action: "compare_harnesses" };
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
let lastPaintedRootKey = null;

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

// The activity log and the project-change flash live in their own module. Its state (the flash
// timer, the sequence counter and the bounded duplicate-id set) travelled with it, while the
// redaction vocabulary above stayed here, because three other host surfaces redact through it.
const activityLog = initActivityLog({
  sanitizePlainActivityText,
  isDebugEnabled,
  createBoundedSeenSet,
});
const { appendWorkActivity, refreshActivityLog, triggerProjectChangeFlash, updateActivityBadge } = activityLog;
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

async function openOpfsScratchFolder(projectName = SCRATCHPAD_NAME, { onError, action } = {}) {
  try {
    let existed = null;
    if (navigator.storage?.getDirectory) {
      try {
        const opfsRoot = await navigator.storage.getDirectory();
        await opfsRoot.getDirectoryHandle(projectName);
        existed = true;
      } catch (err) {
        existed = err?.name === "NotFoundError" ? false : null;
      }
    }
    const handle = await ensureScratchpadFolder(projectName);
    const reportText = action
      ? `${action} '${projectName}' in browser storage (OPFS) — browser files and edits save here.`
      : existed === true
        ? `Opened '${projectName}' in browser storage (OPFS) — browser files and edits save here.`
        : existed === false
          ? `Created '${projectName}' in browser storage (OPFS) — browser files and edits save here.`
          : `In browser storage (OPFS): '${projectName}' — browser files and edits save here.`;
    setReport(reportText, "good");
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
    err.route = path;
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

async function loadRoot(reportRefusal = false) {
  const before = rootIdentity();
  let refusal;
  try {
    const answer = await request("/api/root");
    activeRoot = answer?.declared ? answer : null;
  } catch (err) {
    activeRoot = undefined; // an older server with no root seam: say so, do not invent one
    if (reportRefusal && err?.refused) refusal = err;
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
  if (refusal) throw refusal;
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






// Execution status for the tools view (voicebox-beads-ri4k): the live socket's {type:"tool"}
// frames land here via window.__voiceboxOnToolCalls. The wasm shelf rows still read it, but no
// longer directly: public/extensions-ui.mjs (voicebox-beads-v25a) reads it through the live
// getToolStatus accessor handed over at initExtensionsUI() below.
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

// ── the environment list (core/environment.ts is the seam; server.mjs owns the store) ────
// One source: the header chip, the settings surface and the "+" all read /api/environments. A host
// that is listed but not running is named unreachable, never shown as ready; a registry the server
// cannot read is a different named refusal from an empty list.
// The list itself — the /api/environments read, the rows and their Re-probe/Remove actions, the auto-probe
// and the three states of the active-root readout — now lives in public/components/environment-list.mjs
// (voicebox-beads-uei2.10). This is the one place it is wired: els, request and SCRATCHPAD_NAME go in as
// plain values, and roomFolder/activeRoot go in as LIVE accessors because the host reassigns both while the
// page lives. renderEnvironments comes back the other way, because the health poll and the root/room changes
// call it.
const { renderEnvironments } = initEnvironmentList({
  els,
  request,
  SCRATCHPAD_NAME,
  getRoomFolder: () => roomFolder,
  getActiveRoot: () => activeRoot,
});


async function health() {
  let answer;
  try {
    answer = await request("/api/health");
  } catch (err) {
    if (els.dot) els.dot.dataset.ok = "false";
    if (els.where) {
      els.where.textContent = "the machine is not answering — fix the host";
      els.where.title = `source: GET /api/health · ${err?.refused ?? "machine-unreachable"}: ${err?.why ?? err?.message ?? "the local server is not answering"}`;
    }
    syncToastController.stampBuild(null);
    if (els.rootKind) els.rootKind.textContent = "folder unknown";
    renderEmptyState();
    if (els.rootNote) {
      els.rootNote.textContent = "The local server is not answering, so which folder it saves into cannot be checked.";
      els.rootNote.dataset.tone = "warn";
      els.rootNote.hidden = false;
    }
    return;
  }
  if (els.dot) els.dot.dataset.ok = "true";
  let downstreamRoute = "/api/root";
  try {
    // State is derived from GET /api/health's provider and build fields:
    // the indicator names the agent provider so it is visible whether the
    // provider side is configured and ready.
    const provider = answer.provider || "agent";
    if (els.where) {
      els.where.textContent = `agent: ${provider}`;
      els.where.title = `source: GET /api/health · provider: ${provider}, build: ${answer.build?.commit || "dev"}`;
    }
    window.__voiceboxServerBuild = answer.build ?? null;
    syncToastController.stampBuild(answer.build ?? null);
    renderAbout();
    await loadRoot(true);
    downstreamRoute = "/api/environments";
    await renderEnvironments();
    downstreamRoute = "/api/extensions";
    await renderExtensions();
  } catch (err) {
    // A healthy heartbeat is not invalidated by a protected or unreadable downstream route.
    // Name the route that failed; only /api/health can mark this server offline.
    const source = err?.route ?? downstreamRoute;
    if (els.where) {
      if (err?.refused === "loopback-unauthenticated") {
        els.where.textContent = "this page has no session on this origin — redeem a bootstrap ticket here or restart without VOICEBOX_LOOPBACK_AUTH";
      } else {
        els.where.textContent = err?.refused === "environment-list-unreadable"
          ? "the environment list could not be read — fix the file"
          : source === "/api/environments"
            ? "the environment list could not be read — check its error"
            : "the folder details could not be read — check its error";
      }
      els.where.title = `source: GET ${source} · ${err?.refused ?? err?.message ?? "request failed"}: ${err?.why ?? err?.message ?? "see the route error"}`;
    }
    if (els.envNote && err?.refused === "loopback-unauthenticated") {
      els.envNote.textContent = "This page has no session on this origin. Redeem a bootstrap ticket here, or restart without VOICEBOX_LOOPBACK_AUTH.";
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
  if (window.__voiceboxOfflineSpeech?.isFallbackActive?.() && outcome) {
    window.__voiceboxOfflineSpeech.speak(outcome);
  }
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

// ── Offline Speech Fallback (voicebox-beads-ijtf) ─────────────────────────
const offlineSpeechController = createOfflineSpeechController({
  onTranscript: (transcript, { isFinal } = {}) => {
    if (transcript) {
      if (els.utterance) {
        if (els.form?.hidden) els.form.hidden = false;
        els.utterance.value = transcript;
        if (els.send) els.send.disabled = !transcript.trim();
      }
      if (isFinal) {
        setState("Heard it — sending your turn…");
        void send(transcript);
      }
    }
  },
  onStateChange: (vState) => {
    if (vState === "listening") {
      listening(true);
      setState("Listening offline — speak your turn, then pause.");
    } else if (vState === "speaking") {
      setState("Assistant speaking (offline speech synthesis)…");
    } else {
      listening(false);
    }
  },
});

let offlineFallbackActive = false;
let offlineFallbackEnabled = true;

window.__voiceboxOfflineSpeech = {
  controller: offlineSpeechController,
  isEnabled: () => offlineFallbackEnabled,
  setEnabled: (val) => {
    offlineFallbackEnabled = Boolean(val);
    if (!offlineFallbackEnabled && offlineFallbackActive) {
      offlineSpeechController.stopListening();
      offlineSpeechController.stopSpeaking();
      offlineFallbackActive = false;
    }
  },
  isFallbackActive: () => offlineFallbackActive,
  activateFallback: () => {
    offlineFallbackActive = true;
    setState("Live cloud voice unavailable — switched to on-device speech fallback.", "warn");
  },
  deactivateFallback: () => {
    offlineFallbackActive = false;
    offlineSpeechController.stopListening();
    offlineSpeechController.stopSpeaking();
  },
  speak: (text, opts) => offlineSpeechController.speak(text, opts),
  startListening: (opts) => offlineSpeechController.startListening(opts),
  stopListening: () => offlineSpeechController.stopListening(),
  stopSpeaking: () => offlineSpeechController.stopSpeaking(),
};

// ── the microphone: the browser's dictation, and nothing more ─────────────
let recognition = null;

function listening(on) {
  if (els.stage) els.stage.dataset.voice = on ? "listening" : "off";
  els.mic?.setAttribute("aria-pressed", String(on));
}

function startListening() {
  if (window.__voiceboxOfflineSpeech?.isFallbackActive?.()) {
    const res = window.__voiceboxOfflineSpeech.startListening();
    if (!res?.ok) {
      setState("No speech recognition in this browser — type your turn below.", "warn");
    }
    return;
  }
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

const audioDeviceController = createAudioDeviceController({
  els,
  on,
  // LIVE accessor, not a value (voicebox-beads-w1f9): the client is created after this controller
  // and replaced between rooms, so a snapshot captured here would keep naming the boot-time client.
  getLiveClient: () => window.__voiceboxLiveClient,
  storage: localStorage,
});


const micHotkeyController = initMicHotkeyController({ els, on, storage: localStorage });

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
  if (micHotkeyController.matchesHotkey(e.key)) {
    e.preventDefault();
    micHotkeyController.toggleMic();
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


// The extension surface now lives in public/extensions-ui.mjs (voicebox-beads-v25a). This is the one
// place its listeners are installed, and the only place fused.js hands it anything: els is a
// pass-through of the element map, request/on/installLightDismissFallback are the same helpers the
// rest of the page uses, and getToolStatus is a LIVE read of the host-owned map above. A snapshot here WOULD
// freeze the shelf latency readout - and before voicebox-beads-w1f9 that was invisible, because the
// suite stayed green while the readout was wrong. Now tests/extensions-ui-extraction.test.mjs drives
// the real page and a captured accessor turns it RED. lastToolStatus stays owned by
// fused.js because the live websocket tool-call hook writes it.
initExtensionsUI({
  els,
  request,
  on,
  installLightDismissFallback,
  getToolStatus: (name) => lastToolStatus.get(name),
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

// ── The Environments dialog's root surface now lives in
// public/components/environment-root-dialog.mjs (voicebox-beads-mvxl). This is the one place its
// listeners are installed, and the only place fused.js hands it anything: els is a pass-through of the
// element map, on/request are the same helpers the rest of the page uses, the room/root helpers are the
// functions above, and getRoomFolder is a LIVE read of fused.js's own `roomFolder` binding — the
// picked-folder line is worded from the folder that is active at click time, and a snapshot taken here
// WOULD call a folder the person can write "read-only". tests/environment-root-dialog-extraction.test.mjs
// drives the real page, so that mistake turns it RED instead of shipping (the voicebox-beads-w1f9 shape).
initEnvironmentRootDialog({
  els,
  on,
  request,
  openOpfsScratchFolder,
  openRoomFolder,
  closeRoomFolder,
  renderRoot,
  loadRoot,
  load,
  scratchpadName: SCRATCHPAD_NAME,
  getRoomFolder: () => roomFolder,
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
installLightDismissFallback(els.branchLandingDialog);

// ── Harnesses modal dialog (voicebox-beads-f1o) ──────────────────────
// The dialog's own surface — the host-inventory check, the harness rows and their actions, the config form,
// the task launcher, the output save and every listener on its controls — now lives in
// public/components/harnesses-dialog.mjs (voicebox-beads-uei2.9). This is the one place it is wired: els and
// on are the same pass-throughs the rest of the page uses, and the host state the dialog reads is handed
// over as LIVE accessors, because the host reassigns all of it — roomFolder, listingDir and miniAppController
// by the room/root code, and lastHarnessOutput by the page's own task handler below, which is also why that
// one is a get/set PAIR and the binding stays here. The two functions the rest of the page calls from
// outside the dialog — renderHarnessChangedFiles (that same task handler) and openAgentProgressTracker (the
// system-command path) — come back the other way.
let lastHarnessOutput = "";
const { renderHarnessChangedFiles, openAgentProgressTracker } = initHarnessesDialog({
  els,
  on,
  request,
  health,
  load,
  showFile,
  loadRoomFolder,
  writeRoomFile,
  getRoomFolder: () => roomFolder,
  getListingDir: () => listingDir,
  getMiniAppController: () => miniAppController,
  getLastHarnessOutput: () => lastHarnessOutput,
  setLastHarnessOutput: (next) => {
    lastHarnessOutput = next;
  },
});
window.__voiceboxOpenAgentTracker = openAgentProgressTracker;


// ── Change log modal dialog (voicebox-beads-n1pq, voicebox-beads-je4i) ────
// The dialog's own surface — its fetch, its commit formatting and its open/close/refresh handling —
// now lives in public/components/changelog-dialog.mjs (voicebox-beads-mvxl). This is the one place its
// listeners are installed, and the only place fused.js hands it anything: els is a pass-through of the
// element map, on is the same helper the rest of the page uses, and sanitizeText is this file's own
// sanitizePlainActivityText, so the Activity log and this dialog still redact with one vocabulary.
// openChangelogDialog comes back the other way, because the build stamp's commit link opens it.
const { openChangelogDialog } = initChangelogDialog({
  els,
  on,
  sanitizeText: sanitizePlainActivityText,
});


// ── Branch Landing Inspector (voicebox-beads-8kfa) ─────────────────────────
const branchLandingController = createBranchLandingController({
  openBtn: els.branchesOpen,
  badgeEl: els.branchesBadge,
  dialog: els.branchLandingDialog,
  closeBtn: els.branchLandingClose,
  refreshBtn: els.branchRefreshBtn,
  statusEl: els.branchLandingStatus,
  branchesList: els.branchesList,
  detailPanel: els.branchDetailPanel,
  detailName: els.branchDetailName,
  mergeBadge: els.branchMergeBadge,
  landBtn: els.branchLandBtn,
  keepBtn: els.branchKeepBtn,
  actionResult: els.branchActionResult,
  filesCount: els.branchFilesCount,
  filesList: els.branchFilesList,
  diffViewer: els.branchDiffViewer,
  onLanded: () => {
    void loadListing();
  },
});
window.__voiceboxBranchLanding = branchLandingController;
void branchLandingController.fetchCandidates();

// ── Room Presence & Floor Control (voicebox-beads-2mi8) ────────────────────
const presenceUIController = createPresenceUIController({
  stripEl: els.roomPresenceStrip,
  countEl: els.presenceCount,
  rosterEl: els.presenceRoster,
  floorBtn: els.presenceFloorBtn,
  floorBadgeEl: els.presenceFloorBadge,
});
window.__voiceboxPresenceUI = presenceUIController;
presenceUIController.start();

// ── Visual Grounding & Callout Pointer (voicebox-beads-gnf2) ───────────────
const visionGroundingController = createVisionGroundingController({
  canvas: els.visionGroundingOverlay,
});
window.__voiceboxVisionGrounding = visionGroundingController;

// Settings dialog, agent preferences and provider keys have one UI owner.
const { loadAgentSettings, loadApiKeysSettings } = initSettingsUi({ els, request, health, refreshDevices: audioDeviceController.refresh, on });

// ── the two meters: your voice, and the agent's (public/audio-meters.mjs, voicebox-beads-uei2.1) ──
// Driven by the real PCM the client already has (audio-client.js level()).
// Animation loop and frame management stay on window.__voiceboxMeterFrame.

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

audioDeviceController.loadPrefs();
micHotkeyController.loadHotkey();
window.__voiceboxHotkey = { get: micHotkeyController.getHotkey, set: micHotkeyController.setHotkey };
window.__voiceboxDevices = {
  micId: audioDeviceController.micId,
  outputId: audioDeviceController.outputId,
  state: audioDeviceController.state,
  refresh: audioDeviceController.refresh,
};
if (navigator.mediaDevices?.addEventListener) navigator.mediaDevices.addEventListener("devicechange", audioDeviceController.refresh);
audioDeviceController.refresh();

// A seam for driving the two meters without a microphone: a headless browser
// has no device, so the visual can only be checked here by handing the drawing
// the same arrays the client produces. The live path above is unchanged and
// still reads real PCM from the client; this is how the verifier proves the
// picture responds to data rather than being decoration.
window.__voiceboxMeters = { drawInputWave, drawOutputRing, startMeters, mixSpeechAndMic };

const syncToastController = createSyncToastController({ els, on, openChangelogDialog });
window.__voiceboxSyncToast = { update: syncToastController.update };

syncToastController.stampBuild(undefined);
if (els.stage) new MutationObserver(startMeters).observe(els.stage, { attributes: true, attributeFilter: ["data-voice"] });

// ── the task / result card (voicebox-beads-snp) ──────────────────────────
let taskCardController = null;
if (els.taskCard) {
  import(/* @vite-ignore */ "/browser/task-card.ts")
    .then(({ createTaskCard, RemoteTaskClient }) => {
      const client = new RemoteTaskClient();
      taskCardController = createTaskCard(els.taskCard, {
        client,
        onViewFiles: async () => {
          await load();
          const target = els.made ?? els.files;
          if (target) target.scrollIntoView({ behavior: "smooth" });
        },
        onDismiss: () => {
          taskCardController?.setTask(null);
        },
      });
      window.__voiceboxTaskCard = taskCardController;
    })
    .catch((err) => {
      console.warn("[voicebox] task card component failed to load:", err?.message ?? err);
    });
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
  // The interactive surface lives in its own module. It RETURNS the controller into the host's
  // handle rather than owning it, so the fourteen call sites that read `miniAppController` (six of
  // them null-guarded) are untouched, and the global below keeps its exact position and shape.
  miniAppController = initMiniAppHost({
    els,
    request,
    load,
    isHtmlFileName,
    normalizeMiniAppKey,
    // A live pair, not a snapshot: the delete path reassigns the catalogue.
    getCatalog: () => catalogMiniApps,
    setCatalog: (next) => { catalogMiniApps = next; },
    syncReaderBubble,
    renderRead,
    sqehSyncMiniApps,
    launchedMiniApps,
  });
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

  // THE STRIP LISTS APPS, NOT PAGES (voicebox-beads-rtsr). A workspace `.html` file used to be
  // scraped straight out of the Files list and badged "App" here, so browsing a folder of pages
  // filled the Mini-App tray with them. Classification now happens where provenance lives — the
  // store's `kind` — and this loop renders only what the store calls an app; a page stays in the
  // Files list and is still launchable (the viewer's "Open as Mini-App", or launch_mini_app by name).
  // A payload from an older server carries no `kind`, and that defaults to an app, as it always was.
  for (const item of catalogMiniApps) {
    if (!item) continue;
    if (item.kind === "page") continue;
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
    // The log's own operation lives with the log: clearing has to forget the duplicate-id set too, and
    // that set travelled into public/components/activity-log-ui.mjs with the rest of the surface's state.
    activityLog.clearActivityLog();
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
  document.getElementById("sqeh-dock-settings")?.addEventListener("click", () => els.settingsOpen?.click());
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

  let visionEncodingInFlight = false;
  const captureAndSendVisionFrame = async () => {
    if (visionEncodingInFlight) return false;
    const video = els.visionCoreVideo;
    const canvas = els.visionCoreCanvas;
    if (!video || !canvas || !visionStream) return false;
    const resPref = els.settingVisionResolution?.value || "MEDIA_RESOLUTION_MEDIUM";
    const targetWidth = resPref === "MEDIA_RESOLUTION_HIGH" ? 960 : resPref === "MEDIA_RESOLUTION_LOW" ? 320 : 640;
    const vw = video.videoWidth || targetWidth;
    const vh = video.videoHeight || Math.round(targetWidth * 0.75);
    const scale = Math.min(1, targetWidth / Math.max(1, vw));
    const targetW = Math.max(1, Math.round(vw * scale));
    const targetH = Math.max(1, Math.round(vh * scale));

    visionEncodingInFlight = true;
    try {
      const result = await encodeVisionFrame(video, targetW, targetH, 0.78, canvas);
      const base64 = result?.base64 || "";
      const liveActive = Boolean(window.__voiceboxIsLiveSessionActive?.());
      const sent = liveActive && base64 ? (window.__voiceboxSendLiveVideo?.(base64, "image/jpeg") ?? false) : false;
      if (els.visionCoreMeta) {
        els.visionCoreMeta.textContent = sent
          ? `${visionMode === "screen" ? "Screen" : "Camera"} live (${targetW}×${targetH})`
          : `${visionMode === "screen" ? "Screen" : "Camera"} preview ready (start mic to stream)`;
      }
      return sent;
    } finally {
      visionEncodingInFlight = false;
    }
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
    visionGroundingController?.clearCallouts();
    window.__voiceboxPipCompanion?.setVisionStream(null);
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
        els.visionCoreVideo.onloadedmetadata = () => {
          visionGroundingController?.resizeOverlay(
            els.visionCoreVideo.videoWidth || 320,
            els.visionCoreVideo.videoHeight || 180,
          );
        };
      }
      if (els.visionCoreCard) els.visionCoreCard.hidden = false;
      if (els.visionCameraBtn) els.visionCameraBtn.setAttribute("aria-pressed", String(mode === "camera"));
      if (els.visionScreenBtn) els.visionScreenBtn.setAttribute("aria-pressed", String(mode === "screen"));
      if (els.visionCoreMeta) els.visionCoreMeta.textContent = `${mode === "screen" ? "Screen share" : "Camera"} active`;
      window.__voiceboxPipCompanion?.setVisionStream(stream);
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
  if (els.settingOfflineSpeechEnabled) {
    const isOfflineEnabled = window.__voiceboxOfflineSpeech?.isEnabled?.() ?? true;
    els.settingOfflineSpeechEnabled.checked = isOfflineEnabled;
    if (els.settingOfflineSpeechState) {
      els.settingOfflineSpeechState.textContent = isOfflineEnabled
        ? "Automatic — falls back to browser voice when cloud is unavailable"
        : "Disabled — cloud voice only";
    }
    els.settingOfflineSpeechEnabled.addEventListener("change", () => {
      const checked = Boolean(els.settingOfflineSpeechEnabled.checked);
      window.__voiceboxOfflineSpeech?.setEnabled(checked);
      if (els.settingOfflineSpeechState) {
        els.settingOfflineSpeechState.textContent = checked
          ? "Automatic — falls back to browser voice when cloud is unavailable"
          : "Disabled — cloud voice only";
      }
    });
  }
  els.settingsRunDoctor?.addEventListener("click", async () => {
    if (!els.settingsDoctorList || !els.settingsDoctorStatus) return;
    els.settingsDoctorStatus.textContent = "Checking host environment…";
    if (els.settingsRunDoctor) els.settingsRunDoctor.disabled = true;
    try {
      const res = await fetch("/api/doctor", { signal: AbortSignal.timeout(8000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (!data.ok || !Array.isArray(data.checks)) throw new Error("Invalid report");

      els.settingsDoctorList.replaceChildren();
      for (const check of data.checks) {
        const li = document.createElement("li");
        li.className = "doctor-check-item";

        const labelSpan = document.createElement("span");
        labelSpan.className = "doctor-check-label";
        labelSpan.textContent = check.label;
        li.append(labelSpan);

        const rightDiv = document.createElement("div");
        rightDiv.className = "doctor-check-right";

        const statusSpan = document.createElement("span");
        statusSpan.className = `doctor-check-status status-${check.status || "ok"}`;
        statusSpan.textContent = check.status || "ok";
        rightDiv.append(statusSpan);

        const detailSpan = document.createElement("span");
        detailSpan.className = "doctor-check-detail";
        detailSpan.textContent = check.detail || "";
        rightDiv.append(detailSpan);

        li.append(rightDiv);
        els.settingsDoctorList.append(li);
      }
      if (els.settingsDoctorResults) els.settingsDoctorResults.removeAttribute("hidden");
      els.settingsDoctorStatus.textContent = `Completed (${data.checks.length} checks)`;
    } catch (err) {
      els.settingsDoctorStatus.textContent = `Check failed: ${err.message}`;
    } finally {
      if (els.settingsRunDoctor) els.settingsRunDoctor.disabled = false;
    }
  });
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
