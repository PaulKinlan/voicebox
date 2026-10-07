// Debug capture is page-local in a bounded ring buffer. No transcript storage or background upload.
let inMemoryDebug = null;

function checkDebugEnabled() {
  if (inMemoryDebug !== null) return inMemoryDebug;
  try {
    if (typeof location !== "undefined" && new URLSearchParams(location.search).get("debug") === "1") return true;
    const storage = typeof window !== "undefined" ? window.localStorage : (globalThis.localStorage ?? null);
    if (storage?.getItem?.("voiceboxDebug") === "1") return true;
  } catch { /* location or localStorage unavailable */ }
  return false;
}

export const debugEnabled = checkDebugEnabled();
export function isDebugEnabled() {
  return checkDebugEnabled();
}
export function setDebugEnabled(enabled) {
  inMemoryDebug = enabled === null || enabled === undefined ? null : Boolean(enabled);
  try {
    const storage = typeof window !== "undefined" ? window.localStorage : (globalThis.localStorage ?? null);
    if (enabled === null) {
      storage?.removeItem?.("voiceboxDebug");
    } else {
      storage?.setItem?.("voiceboxDebug", enabled ? "1" : "0");
    }
  } catch {}
}

export const MAX_EVENTS = 200;
const events = [];
const listeners = new Set();
const started = Date.now();
let sequence = 0;

export function getDebugEvents() {
  return events.slice();
}

export function clearDebugEvents() {
  events.length = 0;
  sequence = 0;
}

export function recordDebug(event) {
  if (!event || typeof event !== "object") return null;
  const entry = structuredClone({
    timestamp: new Date().toISOString(),
    source: "page",
    ...event,
    sequence: ++sequence,
    elapsedMs: Date.now() - started,
  });
  events.push(entry);
  if (events.length > MAX_EVENTS) {
    events.splice(0, events.length - MAX_EVENTS);
  }
  for (const listener of listeners) listener(entry);
  return entry;
}

const sensitive = /auth|headers|cookie|password|passwd|secret|token|credential|key|signature/i;
const hidden = "[redacted]";

/** Conservative export boundary: field names AND embedded text, including nested JSON. */
export function redact(value, aliases = new Map()) {
  if (Array.isArray(value)) return value.map(item => redact(item, aliases));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [redactText(key, aliases), sensitive.test(key) ? hidden : redact(item, aliases)]));
  if (typeof value !== "string") return value;
  // Tools sometimes return JSON as a string, not as an object.
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === "object") return JSON.stringify(redact(parsed, aliases));
  } catch { /* ordinary prose */ }
  return redactText(value, aliases);
}

function redactText(text, aliases) {
  const opaque = (match) => {
    if (!aliases.has(match)) aliases.set(match, `[redacted:${aliases.size + 1}]`);
    return aliases.get(match);
  };
  return text
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, hidden)
    .replace(/\b(?:authorization|proxy-authorization|set-cookie|cookie)\s*:[^\r\n]*/gi, hidden)
    .replace(/\b(?:Bearer|Basic)\s+[^\s"'<>]+/gi, hidden)
    .replace(/((?:api[-_ ]?key|[a-z0-9_]*key|password|passwd|secret|token|credential|signature)\s*["']?\s*[:=]\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/gi, `$1"${hidden}"`)
    .replace(/((?:api[-_ ]?key|[a-z0-9_]*key|password|passwd|secret|token|credential|signature)\s*["']?\s*[:=]\s*["']?)[^\s,;&"'}]+/gi, `$1${hidden}`)
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, `$1${hidden}@`)
    // Opaque values and vendor key prefixes are unsafe even under an innocuous key or inside a transcript.
    // This intentionally also hides long identifiers and hashes.
    .replace(/\b(?:AIza[A-Za-z0-9_-]{6,}|sk-[A-Za-z0-9_-]{6,})|[A-Za-z0-9_+\/.=-]{24,}/g, opaque);
}

export function exportDebug(entries = events) {
  const aliases = new Map(); // repeated opaque call IDs retain correlation without exposing the value
  if (!entries || entries.length === 0) return "";
  return entries.map(entry => JSON.stringify(redact(entry, aliases))).join("\n") + "\n";
}

export function isDebugError(event) {
  if (!event || typeof event !== "object") return false;
  const type = typeof event.type === "string" ? event.type : "";
  return event.severity === "error" || event.ok === false || type.endsWith("error") ||
    type.endsWith("refused") || type.endsWith("dropped");
}

export function observeDebugSocket(socket) {
  if (!socket || typeof socket.addEventListener !== "function") return;
  const connection = crypto.randomUUID();
  recordDebug({ type: "live.connect", connection });
  socket.addEventListener("message", ({ data }) => {
    if (typeof data !== "string") return; // never PCM / audio payloads
    try {
      const message = JSON.parse(data);
      if (message.type === "debug") recordDebug({ ...message.event, connection });
      else recordDebug({ type: `live.${message.type}`, connection, message,
        severity: message.type === "error" || message.type === "refused" || message.state === "error" ? "error" : "info" });
    } catch { recordDebug({ type: "live.frame.error", connection, error: "Non-JSON control frame", data }); }
  });
  socket.addEventListener("close", ({ code, reason, wasClean }) => recordDebug({ type: "live.close", connection, code, reason, wasClean, severity: wasClean ? "info" : "error" }));
  socket.addEventListener("error", () => recordDebug({ type: "live.socket.error", connection, error: "WebSocket transport error" }));
}

export function formatSessionTranscript(logElement) {
  const el = logElement ?? (typeof document !== "undefined" ? document.getElementById("session-log") : null);
  const rawItems = el
    ? (typeof el.querySelectorAll === "function" ? [...el.querySelectorAll("li")] : [...(el.children ?? [])])
    : [];
  const items = rawItems.reverse();
  const lines = items.map((li) => {
    const said = li.querySelector?.(".said")?.textContent?.trim() ?? "";
    const did = li.querySelector?.(".did")?.textContent?.trim() ?? "";
    if (said || did) return `${said} → ${did}`;
    return (li.textContent ?? "").trim();
  }).filter(Boolean);
  return lines.join("\n");
}

const wiredDialogs = new WeakSet();

function findInDialogOrDoc(dialogEl, doc, id) {
  return dialogEl?.querySelector?.(`#${id}`) ?? doc?.getElementById?.(id) ?? null;
}

export function wireTranscriptDialog(dialogElement, docRef) {
  const doc = docRef ?? (typeof document !== "undefined" ? document : null);
  const dialogEl = dialogElement ?? doc?.getElementById?.("transcript-dialog") ?? null;
  if (!dialogEl || wiredDialogs.has(dialogEl)) return dialogEl;
  wiredDialogs.add(dialogEl);

  const turnsEl = findInDialogOrDoc(dialogEl, doc, "transcript-dialog-turns");
  const debugEl = findInDialogOrDoc(dialogEl, doc, "transcript-dialog-debug");
  const statusEl = findInDialogOrDoc(dialogEl, doc, "transcript-copy-status");
  const copyTurnsBtn = findInDialogOrDoc(dialogEl, doc, "transcript-copy-turns");
  const copyDebugBtn = findInDialogOrDoc(dialogEl, doc, "transcript-copy-debug");
  const closeBtn = findInDialogOrDoc(dialogEl, doc, "transcript-dialog-close");

  copyTurnsBtn?.addEventListener?.("click", async () => {
    const text = turnsEl?.value ?? formatSessionTranscript(doc?.getElementById?.("session-log"));
    if (turnsEl) {
      turnsEl.value = text;
      turnsEl.textContent = text;
    }
    if (!text) {
      if (statusEl) statusEl.textContent = "No turns recorded in this tab yet.";
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      if (statusEl) statusEl.textContent = "Copied turns to the clipboard.";
    } catch {
      turnsEl?.focus?.();
      turnsEl?.select?.();
      if (statusEl) statusEl.textContent = "Clipboard unavailable. The turns are selected above; copy them manually.";
    }
  });

  copyDebugBtn?.addEventListener?.("click", async () => {
    const text = exportDebug();
    if (debugEl) {
      debugEl.value = text;
      debugEl.textContent = text;
    }
    try {
      await navigator.clipboard.writeText(text);
      if (statusEl) statusEl.textContent = "Copied all events as redacted JSONL. Review before sharing; transcripts can contain personal information.";
    } catch {
      debugEl?.focus?.();
      debugEl?.select?.();
      if (statusEl) statusEl.textContent = "Clipboard unavailable. The redacted export is selected below; copy it manually.";
    }
  });

  closeBtn?.addEventListener?.("click", (event) => {
    if (typeof dialogEl.close === "function" && dialogEl.open) {
      event?.preventDefault?.();
      dialogEl.close();
    } else {
      dialogEl.open = false;
      dialogEl.removeAttribute?.("open");
    }
  });

  if (typeof HTMLDialogElement !== "undefined" && !("closedBy" in HTMLDialogElement.prototype)) {
    dialogEl.addEventListener?.("click", (event) => {
      if (event.target !== dialogEl || typeof dialogEl.getBoundingClientRect !== "function") return;
      const rect = dialogEl.getBoundingClientRect();
      const inside = rect.top <= event.clientY && event.clientY <= rect.top + rect.height &&
        rect.left <= event.clientX && event.clientX <= rect.left + rect.width;
      if (!inside) dialogEl.close?.();
    });
  }

  return dialogEl;
}

export function openTranscriptDialog(options = {}) {
  const isElement = options && typeof options === "object" && ("nodeType" in options || typeof options.querySelectorAll === "function");
  const opts = isElement ? { logElement: options } : (options ?? {});
  const doc = opts.document ?? (typeof document !== "undefined" ? document : null);
  const logEl = opts.logElement ?? doc?.getElementById?.("session-log") ?? null;
  const dialogEl = opts.dialogElement ?? doc?.getElementById?.("transcript-dialog") ?? null;
  const entries = opts.entries ?? events;

  if (dialogEl) wireTranscriptDialog(dialogEl, doc);

  const turnsText = formatSessionTranscript(logEl);
  const debugText = exportDebug(entries);
  const turnCount = turnsText ? turnsText.split("\n").filter(Boolean).length : 0;
  const errorCount = entries.filter(isDebugError).length;
  const summaryText = `${turnCount} ${turnCount === 1 ? "turn" : "turns"} · ${entries.length} debug ${entries.length === 1 ? "event" : "events"} · ${errorCount} ${errorCount === 1 ? "error" : "errors"} (redacted)`;

  const turnsEl = findInDialogOrDoc(dialogEl, doc, "transcript-dialog-turns");
  const debugEl = findInDialogOrDoc(dialogEl, doc, "transcript-dialog-debug");
  const summaryEl = findInDialogOrDoc(dialogEl, doc, "transcript-dialog-summary");
  const statusEl = findInDialogOrDoc(dialogEl, doc, "transcript-copy-status");

  if (turnsEl) {
    turnsEl.value = turnsText;
    turnsEl.textContent = turnsText;
  }
  if (debugEl) {
    debugEl.value = debugText;
    debugEl.textContent = debugText;
  }
  if (summaryEl) {
    summaryEl.textContent = summaryText;
  }
  if (statusEl) {
    statusEl.textContent = "";
  }

  if (dialogEl) {
    if (typeof dialogEl.showModal === "function") {
      if (!dialogEl.open) {
        try {
          dialogEl.showModal();
        } catch {
          dialogEl.setAttribute?.("open", "");
          dialogEl.open = true;
        }
      }
    } else {
      dialogEl.setAttribute?.("open", "");
      dialogEl.open = true;
    }
  }

  return {
    turns: turnsText,
    debug: debugText,
    summary: summaryText,
    turnCount,
    eventCount: entries.length,
    errorCount,
  };
}

export function initDebugTranscript(docRef) {
  const doc = docRef ?? (typeof document !== "undefined" ? document : null);
  if (!doc) return;

  const dialogEl = doc.getElementById?.("transcript-dialog");
  if (dialogEl) wireTranscriptDialog(dialogEl, doc);

  if (!events.some((e) => e.type === "debug.start")) {
    recordDebug({
      type: "debug.start",
      schema: 1,
      origin: typeof location !== "undefined" ? location.origin : "",
      build: doc.querySelector?.('meta[name="voicebox-build"]')?.content,
      scope: "This tab since page load; all emitted text/control events, no audio bytes, no previous visits. Raw details stay in this tab. Export is redacted.",
      inputTranscript: "Spoken words are absent unless the provider already emits input transcription. Debug does not enable transcription or change provider setup. Typed turns and tool arguments are included.",
      delivery: "transport-accepted is a local send, NOT a provider acknowledgement or proof the model consumed the result. Missing result/delivery events mean unknown or still pending.",
    });
  }

  if (!checkDebugEnabled()) return;
  const panel = doc.getElementById?.("debug-panel");
  if (!panel) return;
  panel.hidden = false;
  const list = doc.getElementById("debug-events");
  const status = doc.getElementById("debug-status");
  const next = doc.getElementById("debug-next-error");
  const errors = [];
  let errorIndex = 0;
  const render = (event) => {
    const row = doc.createElement("li");
    const details = doc.createElement("details");
    const summary = doc.createElement("summary");
    const bad = isDebugError(event);
    row.dataset.error = String(bad);
    summary.textContent = `${bad ? "Error · " : ""}${event.elapsedMs} ms · ${event.type}${event.name ? ` · ${event.name}` : ""}${event.callId ? ` · ${event.callId}` : ""}`;
    const body = doc.createElement("pre");
    body.textContent = JSON.stringify(event, null, 2);
    details.append(summary, body);
    row.append(details);
    list.append(row);
    while (list.children.length > events.length) {
      list.firstElementChild?.remove();
    }
    if (bad) errors.push(details);
    status.textContent = `${events.length} events · ${errors.length} errors`;
    next.disabled = errors.length === 0;
  };
  listeners.add(render);
  for (const event of events) render(event);
  next.addEventListener("click", () => {
    const item = errors[errorIndex++ % errors.length];
    if (!item) return;
    item.open = true;
    item.querySelector("summary").focus();
    item.scrollIntoView({ block: "nearest" });
  });
  doc.getElementById("debug-copy").addEventListener("click", async () => {
    const output = doc.getElementById("debug-export");
    const message = doc.getElementById("debug-copy-status");
    // Redact afresh on EVERY copy, including the manual clipboard fallback.
    output.value = exportDebug();
    output.hidden = false;
    try {
      await navigator.clipboard.writeText(output.value);
      message.textContent = "Copied all events as redacted JSONL. Review before sharing; transcripts can contain personal information.";
    } catch {
      output.focus();
      output.select();
      message.textContent = "Clipboard unavailable. The redacted export is selected below; copy it manually.";
    }
  });
}

if (typeof document !== "undefined") {
  initDebugTranscript(document);
}

