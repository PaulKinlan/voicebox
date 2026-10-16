/**
 * @summary Work activity log and project-change notification surface.
 */
// public/components/activity-log-ui.mjs — the work activity log and the project-change flash,
// extracted from public/fused.js (voicebox-beads-uei2.2, a slice of the decomposition scoped in
// voicebox-beads-uei2).
//
// OWNS: the activity list and its badge (append, the 60-item cap, the bounded duplicate-id set,
// the sequence counter), the /api/activity refresh, and the project-change flash: the body/where
// markers, the 650ms timer that clears them, and the activity entry that records the switch.
//
// TAKES ITS VOCABULARY AS A DEPENDENCY: the redaction that sanitises every label, summary and
// detail stays in the host (`sanitizePlainActivityText`), because the changelog dialog, the
// tool-failure path and the system-error path all redact through the same function. A copy here
// would be a second place to keep in step, which is exactly what this extraction must not create.
//
// WIRED AT ONE SITE with { sanitizePlainActivityText, isDebugEnabled, createSeenSet }. The stack
// branch is gated on isDebugEnabled(), so that gate is injected rather than re-implemented.
export function initActivityLog({ sanitizePlainActivityText, isDebugEnabled, createBoundedSeenSet }) {
  let projectFlashTimer = null;

  const workActivitySeenIds = createBoundedSeenSet(200);
  let workActivitySeq = 0;

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

  // Clearing the log is the surface's own operation now, because forgetting the duplicate-id set has to
  // travel with it, and that set lives in this module. The panel's open/close wiring stays with the host
  // shell (it is deck state, not log state).
  function clearActivityLog() {
    workActivitySeenIds.clear();
    document.getElementById("activity-log-list")?.replaceChildren();
    updateActivityBadge();
  }

  return { appendWorkActivity, refreshActivityLog, triggerProjectChangeFlash, updateActivityBadge, clearActivityLog };
}
