// Debug capture is opt-in and page-local. No transcript storage or background upload.
export const debugEnabled = typeof location !== "undefined" && new URLSearchParams(location.search).get("debug") === "1";
const events = [];
const listeners = new Set();
const started = Date.now();
let sequence = 0;

export function recordDebug(event) {
  if (!debugEnabled) return;
  const entry = structuredClone({ timestamp: new Date().toISOString(), source: "page", ...event, sequence: ++sequence, elapsedMs: Date.now() - started });
  events.push(entry);
  for (const listener of listeners) listener(entry);
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
    // Opaque values are unsafe even under an innocuous key or inside a transcript.
    // This intentionally also hides long identifiers and hashes.
    .replace(/[A-Za-z0-9_+\/.=-]{24,}/g, opaque);
}

export function exportDebug(entries = events) {
  const aliases = new Map(); // repeated opaque call IDs retain correlation without exposing the value
  return entries.map(entry => JSON.stringify(redact(entry, aliases))).join("\n") + "\n";
}

export function isDebugError(event) {
  return event.severity === "error" || event.ok === false || event.type.endsWith("error") ||
    event.type.endsWith("refused") || event.type.endsWith("dropped");
}

export function observeDebugSocket(socket) {
  if (!debugEnabled) return;
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

if (debugEnabled && typeof document !== "undefined") {
  const panel = document.getElementById("debug-panel");
  if (panel) {
    panel.hidden = false;
    const list = document.getElementById("debug-events");
    const status = document.getElementById("debug-status");
    const next = document.getElementById("debug-next-error");
    const errors = [];
    let errorIndex = 0;
    const render = (event) => {
      const row = document.createElement("li");
      const details = document.createElement("details");
      const summary = document.createElement("summary");
      const bad = isDebugError(event);
      row.dataset.error = String(bad);
      summary.textContent = `${bad ? "Error · " : ""}${event.elapsedMs} ms · ${event.type}${event.name ? ` · ${event.name}` : ""}${event.callId ? ` · ${event.callId}` : ""}`;
      const body = document.createElement("pre");
      body.textContent = JSON.stringify(event, null, 2);
      details.append(summary, body);
      row.append(details);
      list.append(row);
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
    document.getElementById("debug-copy").addEventListener("click", async () => {
      const output = document.getElementById("debug-export");
      const message = document.getElementById("debug-copy-status");
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
    recordDebug({ type: "debug.start", schema: 1, origin: location.origin,
      build: document.querySelector('meta[name="voicebox-build"]')?.content,
      scope: "This tab since page load; all emitted text/control events, no audio bytes, no previous visits. Raw details stay in this tab. Export is redacted.",
      inputTranscript: "Spoken words are absent unless the provider already emits input transcription. Debug does not enable transcription or change provider setup. Typed turns and tool arguments are included.",
      delivery: "transport-accepted is a local send, NOT a provider acknowledgement or proof the model consumed the result. Missing result/delivery events mean unknown or still pending." });
  }
}
