// public/components/harnesses-dialog.mjs — the Harnesses modal dialog (voicebox-beads-f1o).
//
// A slice of the public/fused.js decomposition (voicebox-beads-uei2.9, scoped by voicebox-beads-uei2.8).
// Owns the whole dialog surface: the host-inventory check (/api/harnesses), the harness rows and their
// states, the config form, the task launcher, the output save, the project-context line, the modal tool
// catalogue renderer, and every listener on the dialog's controls.
//
// WHY THE SEAM LOOKS LIKE THIS (each reason measured, not assumed):
//   * The dialog reads FOUR pieces of host state that the host REASSIGNS while the page lives — roomFolder,
//     listingDir, miniAppController and lastHarnessOutput. All four arrive as LIVE accessors; a snapshot
//     would pin a stale root, a stale listing, or a dead mini-app handle.
//   * lastHarnessOutput is also WRITTEN from outside this surface (the page's own __voiceboxOnTask handler
//     stores a completed task's output), so it is an accessor PAIR and the host keeps the binding. That is
//     why the host's own call site needed no edit at all.
//   * TWO functions are called from outside the dialog: renderHarnessChangedFiles (from that same task
//     handler) and openAgentProgressTracker (from the system-command path). This factory RETURNS them; both
//     callers run after boot, so a returned binding is safe here — a host caller that could run during
//     top-level evaluation would need an ESM export instead (see components/sync-toast.mjs for that shape).
//   * window.__voiceboxOpenAgentTracker is assigned by the HOST at the seam, at the same point in the boot
//     sequence, so its timing and shape are unchanged (nothing else in the repo reads it).
//   * miniAppController is declared AFTER this surface in the host, so its accessor must not be called
//     during init: it is read only inside openAgentProgressTracker, which runs on demand.
export function initHarnessesDialog({
  els,
  on,
  request,
  health,
  load,
  showFile,
  loadRoomFolder,
  writeRoomFile,
  getRoomFolder,
  getListingDir,
  getMiniAppController,
  getLastHarnessOutput,
  setLastHarnessOutput,
}) {
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


function syncHarnessProjectContext() {
  if (!els.harnessProjectContext) return;
  const rootLabel = els.listingRoot?.textContent?.trim() || els.rootKind?.textContent?.trim() || "Active workspace";
  const folderSuffix = getListingDir() ? ` (folder: ${getListingDir()})` : "";
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
      body: JSON.stringify({ task: prompt, ...(getListingDir() ? { dir: getListingDir() } : {}) }),
    });
    const output = String(res?.output ?? res?.summary ?? res?.action ?? res?.why ?? "Task submitted to active harness.").trim();
    setLastHarnessOutput(output);
    if (els.harnessLoopStatus) els.harnessLoopStatus.textContent = output;
    if (els.harnessSaveOutput) els.harnessSaveOutput.hidden = !getLastHarnessOutput();
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
  if (!getLastHarnessOutput()) return;
  if (els.harnessSaveOutput) els.harnessSaveOutput.disabled = true;
  try {
    const targetName = "harness-analysis.md";
    if (getRoomFolder()) {
      await writeRoomFile(targetName, getLastHarnessOutput());
      await loadRoomFolder();
    } else {
      await request("/api/file", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: targetName, content: getLastHarnessOutput() }),
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
  if (getMiniAppController()) {
    getMiniAppController().mount({
      appId: "agent-progress-tracker",
      title: "Agent Progress Tracker",
      html,
    });
  }
}

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

  return { renderHarnessChangedFiles, openAgentProgressTracker };
}
