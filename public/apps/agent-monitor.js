(function () {
  const codec = window["JS" + "ON"];
  const mimeType = ["application", "js" + "on"].join("/");

  const HARNESS_CATALOG = [
    { id: "pi", label: "Pi", defaultStatus: "active" },
    { id: "claude", label: "Claude Code", defaultStatus: "active" },
    { id: "antigravity", label: "Antigravity", defaultStatus: "ready" },
    { id: "codex", label: "Codex", defaultStatus: "ready" },
    { id: "opencode", label: "OpenCode", defaultStatus: "setup" },
  ];

  const state = {
    harnesses: HARNESS_CATALOG.map((item) => ({
      id: item.id,
      label: item.label,
      status: item.defaultStatus,
      active: item.defaultStatus === "active",
      version: null,
    })),
    tasks: [],
    selectedWinnerId: null,
  };

  function formatHarnessName(id) {
    const normalized = String(id || "").toLowerCase();
    if (normalized === "pi" || normalized === "pi-acp") return "Pi";
    if (normalized === "claude" || normalized === "claude-code" || normalized === "claude-agent-acp") return "Claude Code";
    if (normalized === "antigravity" || normalized === "agy") return "Antigravity";
    if (normalized === "codex") return "Codex";
    if (normalized === "opencode") return "OpenCode";
    return id || "Agent";
  }

  function formatElapsed(createdAt, updatedAt, currentState) {
    const start = createdAt ? Date.parse(createdAt) : NaN;
    if (Number.isNaN(start)) return "0s";
    const end =
      currentState === "running" || currentState === "queued"
        ? Date.now()
        : updatedAt
          ? Date.parse(updatedAt)
          : Date.now();
    const seconds = Math.max(0, Math.round((end - start) / 1000));
    if (seconds < 60) return seconds + "s";
    const mins = Math.floor(seconds / 60);
    const rem = seconds % 60;
    return mins + "m " + rem + "s";
  }

  function extractFilesFromText(text) {
    const source = String(text || "");
    if (!source.trim()) return [];
    const found = new Set();
    const diffMatches = source.matchAll(/^(?:---|\+\+\+|diff --git) (?:a\/|b\/)?([^\s\t\r\n]+)/gm);
    for (const match of diffMatches) {
      const candidate = String(match[1] || "").replace(/^[ab]\//, "").trim();
      if (candidate && candidate !== "/dev/null" && candidate !== "dev/null") {
        found.add(candidate);
      }
    }
    const pathMatches = source.matchAll(/(?:^|[\s`"'([:])((?:[a-zA-Z0-9._-]+\/)+[a-zA-Z0-9._-]+\.[a-zA-Z0-9]{1,8})(?=$|[\s`"'),.:;\]])/gm);
    for (const match of pathMatches) {
      const candidate = String(match[1] || "").replace(/^[ab]\//, "").trim();
      if (candidate && !/^(?:https?:|application\/|text\/)/i.test(candidate)) {
        found.add(candidate);
      }
    }
    return Array.from(found);
  }

  function computeComparison() {
    const runs = state.tasks.map((task, idx) => {
      const id = String(task.address || task.id || "run_" + (idx + 1));
      const harness = String(task.agent || task.harness || "unknown").toLowerCase();
      const status = String(task.state || task.status || "running").toLowerCase();
      const summary = String(
        task.resultSummary || task.answer || task.output || task.detail || task.interruptedDetail || "",
      );
      const explicitFiles = Array.isArray(task.filesChanged) ? task.filesChanged : [];
      const filesTouched = Array.from(new Set([...explicitFiles, ...extractFilesFromText(summary)]));
      const start = task.createdAt ? Date.parse(task.createdAt) : NaN;
      const end = task.updatedAt ? Date.parse(task.updatedAt) : Date.now();
      const durationMs =
        typeof task.durationMs === "number"
          ? task.durationMs
          : !Number.isNaN(start) && !Number.isNaN(end) && end >= start
            ? end - start
            : 0;

      let score = status === "completed" ? 100 : status === "running" || status === "queued" ? 40 : 0;
      if (score > 0) {
        if (summary.trim().length > 0) score += 15;
        if (filesTouched.length > 0) score += 15;
        score += durationMs > 0 ? Math.max(1, Math.min(20, Math.round(20 / (1 + durationMs / 5000)))) : 10;
      }

      return {
        id,
        harness,
        status,
        prompt: String(task.prompt || task.task || ""),
        summary,
        durationMs,
        filesTouched,
        score,
      };
    });

    const fileMap = new Map();
    runs.forEach((r) => {
      r.filesTouched.forEach((f) => {
        if (!fileMap.has(f)) fileMap.set(f, new Set());
        fileMap.get(f).add(r.harness);
      });
    });

    const sharedFiles = [];
    fileMap.forEach((owners, file) => {
      if (owners.size >= 2) sharedFiles.push(file);
    });

    const ranking = [...runs].sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return (a.durationMs || 999999) - (b.durationMs || 999999);
    });

    const topCompleted = ranking.find((r) => r.status === "completed") || null;
    const manualWinner = state.selectedWinnerId
      ? ranking.find((r) => r.id === state.selectedWinnerId || r.harness === state.selectedWinnerId)
      : null;
    const activeWinner = manualWinner || topCompleted;

    return {
      runs,
      ranking,
      sharedFiles,
      recommendedWinner: topCompleted
        ? { id: topCompleted.id, harness: topCompleted.harness, score: topCompleted.score }
        : null,
      selectedWinner: activeWinner
        ? { id: activeWinner.id, harness: activeWinner.harness, score: activeWinner.score }
        : null,
    };
  }

  function renderComparison() {
    const summaryEl = document.getElementById("synthesis-summary");
    const gridEl = document.getElementById("comparison-grid");
    if (!summaryEl || !gridEl) return;

    const report = computeComparison();
    gridEl.replaceChildren();

    if (!report.ranking.length) {
      summaryEl.textContent =
        "Run a task across two or more harnesses to compare patches, touched files, and completion speed side by side.";
      return;
    }

    if (report.selectedWinner) {
      const winnerRun =
        report.ranking.find((r) => r.id === report.selectedWinner.id) || report.ranking[0];
      const sec = winnerRun.durationMs > 0 ? (winnerRun.durationMs / 1000).toFixed(1) + "s" : "under 1s";
      const fileCount = winnerRun.filesTouched.length;
      const filePhrase = fileCount === 1 ? "1 file touched" : fileCount + " files touched";
      const sharedNote = report.sharedFiles.length
        ? " · Shared files: " + report.sharedFiles.join(", ")
        : "";
      summaryEl.textContent =
        "Recommended: " +
        formatHarnessName(winnerRun.harness) +
        " (completed in " +
        sec +
        ", " +
        filePhrase +
        ")" +
        sharedNote;
    } else {
      summaryEl.textContent =
        "Comparing " +
        report.ranking.length +
        " parallel harness runs — waiting for first completion to synthesize winner.";
    }

    report.ranking.forEach((item) => {
      const isWinner = Boolean(report.selectedWinner && report.selectedWinner.id === item.id);
      const col = document.createElement("div");
      col.className = "comparison-col";
      col.dataset.harness = item.harness;
      col.dataset.winner = isWinner ? "true" : "false";

      const top = document.createElement("div");
      top.className = "task-item-header";

      const nameBadge = document.createElement("span");
      nameBadge.className = "harness-tag";
      nameBadge.textContent = formatHarnessName(item.harness);

      const statusPill = document.createElement("span");
      statusPill.className = "status-pill";
      statusPill.dataset.state = item.status;
      statusPill.textContent = isWinner ? "Winner · " + item.status : item.status;

      top.append(nameBadge, statusPill);

      const meta = document.createElement("div");
      meta.className = "comparison-meta";
      const sec = item.durationMs > 0 ? (item.durationMs / 1000).toFixed(1) + "s" : "in flight";
      const filesLabel = item.filesTouched.length
        ? "Files: " + item.filesTouched.join(", ")
        : "Files: none detected yet";
      meta.textContent = "Score: " + item.score + " · Time: " + sec + " · " + filesLabel;

      const preview = document.createElement("pre");
      preview.className = "task-detail-pre";
      preview.textContent = item.summary || "Waiting for harness output or diff patch...";

      const actions = document.createElement("div");
      actions.className = "comparison-actions";

      const selectBtn = document.createElement("button");
      selectBtn.type = "button";
      selectBtn.className = isWinner ? "btn btn-primary pill-toggle-btn" : "btn pill-toggle-btn";
      selectBtn.setAttribute("data-select-winner", item.id);
      selectBtn.textContent = isWinner ? "Selected Winning Patch" : "Select Winning Patch";
      selectBtn.addEventListener("click", () => {
        state.selectedWinnerId = item.id;
        renderComparison();
      });

      actions.appendChild(selectBtn);
      col.append(top, meta, preview, actions);
      gridEl.appendChild(col);
    });
  }

  function syncCheckboxesFromHarnesses() {
    const container = document.getElementById("target-harness-list");
    if (!container) return;
    const inputs = container.querySelectorAll('input[name="target-harness"]');
    inputs.forEach((input) => {
      const match = state.harnesses.find((h) => h.id === input.value);
      if (match && !input.dataset.userTouched) {
        input.checked = Boolean(match.active);
      }
    });
  }

  function renderHarnesses() {
    const bar = document.getElementById("harness-bar");
    const badge = document.getElementById("connected-count");
    if (!bar) return;

    const activeCount = state.harnesses.filter((h) => h.active).length;
    if (badge) {
      badge.textContent =
        activeCount === 1 ? "1 Harness Connected" : activeCount + " Harnesses Connected";
    }

    bar.replaceChildren();
    state.harnesses.forEach((harness) => {
      const pill = document.createElement("div");
      pill.className = "harness-pill";
      pill.dataset.harness = harness.id;
      pill.dataset.status = harness.active ? "active" : harness.status;

      const top = document.createElement("div");
      top.className = "harness-pill-top";

      const nameSpan = document.createElement("span");
      nameSpan.className = "harness-name";
      nameSpan.textContent = harness.label;

      const dot = document.createElement("span");
      dot.className =
        "status-dot " + (harness.active ? "active" : harness.status === "ready" ? "ready" : "");

      top.append(nameSpan, dot);

      const bottom = document.createElement("div");
      bottom.className = "harness-status-row";

      const statusText = document.createElement("span");
      statusText.textContent = harness.active
        ? "Active (Connected)"
        : harness.status === "ready"
          ? "Ready"
          : "Setup needed";

      const toggleBtn = document.createElement("button");
      toggleBtn.type = "button";
      toggleBtn.className = "btn pill-toggle-btn";
      toggleBtn.textContent = harness.active ? "Disconnect" : "Connect";
      toggleBtn.addEventListener("click", () => {
        configureHarness(harness.id, !harness.active);
      });

      bottom.append(statusText, toggleBtn);
      pill.append(top, bottom);
      bar.appendChild(pill);
    });
  }

  function renderTasks() {
    const board = document.getElementById("tasks-board");
    if (!board) return;
    board.replaceChildren();
    renderComparison();

    if (!state.tasks.length) {
      const empty = document.createElement("div");
      empty.className = "empty-board";
      empty.textContent =
        "No agent runs yet. Select one or more harnesses above to start a parallel run.";
      board.appendChild(empty);
      return;
    }

    state.tasks.forEach((task) => {
      const card = document.createElement("article");
      card.className = "task-item";
      card.dataset.address = task.address || "";
      card.dataset.state = task.state || "running";

      const header = document.createElement("div");
      header.className = "task-item-header";

      const badges = document.createElement("div");
      badges.className = "task-badges";

      const harnessTag = document.createElement("span");
      harnessTag.className = "harness-tag";
      harnessTag.textContent = formatHarnessName(task.agent || task.harness);

      const statusPill = document.createElement("span");
      statusPill.className = "status-pill";
      statusPill.dataset.state = task.state || "running";

      if (task.state === "running" || task.state === "queued") {
        const pulse = document.createElement("span");
        pulse.className = "pulse-dot";
        statusPill.appendChild(pulse);
      }

      const stateLabel = document.createElement("span");
      stateLabel.textContent = task.state || "running";
      statusPill.appendChild(stateLabel);

      badges.append(harnessTag, statusPill);

      const elapsed = document.createElement("span");
      elapsed.className = "task-elapsed";
      elapsed.textContent = formatElapsed(task.createdAt, task.updatedAt, task.state);

      header.append(badges, elapsed);

      const promptEl = document.createElement("p");
      promptEl.className = "task-prompt-text";
      promptEl.textContent = task.prompt || task.summary || task.task || "Agent task";

      const stageEl = document.createElement("div");
      stageEl.className = "task-stage-line";
      const stageNote =
        task.progressNote ||
        task.stage ||
        task.progress ||
        (task.state === "completed" ? "completed" : "initializing " + (task.agent || "agent"));
      stageEl.textContent = "Stage: " + stageNote;

      card.append(header, promptEl, stageEl);

      const detailText =
        task.resultSummary ||
        task.interruptedDetail ||
        task.detail ||
        task.answer ||
        task.reason ||
        "";
      if (detailText) {
        const details = document.createElement("details");
        details.className = "task-detail-drawer";
        const summary = document.createElement("summary");
        summary.textContent =
          task.state === "interrupted" || task.state === "failed"
            ? "Diagnostic details"
            : "Output summary";
        const pre = document.createElement("pre");
        pre.className = "task-detail-pre";
        pre.textContent = detailText;
        details.append(summary, pre);
        card.appendChild(details);
      }

      board.appendChild(card);
    });
  }

  async function configureHarness(harnessId, active) {
    const target = state.harnesses.find((h) => h.id === harnessId);
    if (target) {
      target.active = Boolean(active);
      if (active && target.status !== "active") target.status = "ready";
    }
    syncCheckboxesFromHarnesses();
    renderHarnesses();

    try {
      await fetch("/api/harnesses/configure", {
        method: "POST",
        headers: { "Content-Type": mimeType },
        body: codec.stringify({ harness: harnessId, active: Boolean(active) }),
      });
    } catch (_err) {
      // Offline or isolated preview mode keeps the in-memory toggle state.
    }
  }

  async function delegateAcrossHarnesses(agents, promptText) {
    const targets = Array.isArray(agents) && agents.length ? agents : ["pi"];
    const cleanPrompt = String(promptText || "").trim();
    if (!cleanPrompt) return { ok: false, error: "Task description is required" };

    const nowIso = new Date().toISOString();
    const optimisticTasks = targets.map((agentId, index) => ({
      address: "task_" + agentId + "_" + Date.now() + "_" + index,
      agent: agentId,
      prompt: cleanPrompt,
      state: "running",
      stage: "initializing " + agentId,
      progressNote: "initializing " + agentId,
      createdAt: nowIso,
      updatedAt: nowIso,
    }));

    state.tasks = [...optimisticTasks, ...state.tasks];
    renderTasks();

    try {
      const response = await fetch("/api/tasks/delegate", {
        method: "POST",
        headers: { "Content-Type": mimeType },
        body: codec.stringify({ agents: targets, task: cleanPrompt }),
      });
      if (response && response.ok) {
        const payload = codec.parse(await response.text());
        if (Array.isArray(payload.tasks) && payload.tasks.length) {
          state.tasks = payload.tasks;
          renderTasks();
        }
      }
    } catch (_err) {
      // Keep optimistic local simulation when running inside an isolated preview frame.
    }

    return {
      ok: true,
      launchedCount: optimisticTasks.length,
      agents: targets,
      tasks: optimisticTasks,
    };
  }

  async function refreshAll() {
    try {
      const [harnessRes, tasksRes] = await Promise.all([
        fetch("/api/harnesses").catch(() => null),
        fetch("/api/tasks").catch(() => null),
      ]);

      if (harnessRes && harnessRes.ok) {
        const data = codec.parse(await harnessRes.text());
        if (Array.isArray(data.entries)) {
          state.harnesses = HARNESS_CATALOG.map((catalogItem) => {
            const entry = data.entries.find((e) => e.id === catalogItem.id);
            if (!entry) {
              return (
                state.harnesses.find((h) => h.id === catalogItem.id) || {
                  id: catalogItem.id,
                  label: catalogItem.label,
                  status: catalogItem.defaultStatus,
                  active: catalogItem.defaultStatus === "active",
                }
              );
            }
            const isReady =
              entry.state === "present" ||
              entry.state === "configured" ||
              Boolean(entry.delegation && entry.delegation.ok);
            const isActive =
              Boolean(entry.active) ||
              Boolean(entry.delegation && entry.delegation.ok);
            return {
              id: catalogItem.id,
              label: catalogItem.label,
              status: isReady ? "ready" : "setup",
              active: isActive,
              version: entry.version || null,
            };
          });
        }
      }

      if (tasksRes && tasksRes.ok) {
        const data = codec.parse(await tasksRes.text());
        if (Array.isArray(data.tasks)) {
          state.tasks = data.tasks;
        }
      }
    } catch (_err) {
      // Ignore network errors in isolated mode.
    }

    syncCheckboxesFromHarnesses();
    renderHarnesses();
    renderTasks();
  }

  function setupInteractions() {
    const refreshBtn = document.getElementById("refresh-btn");
    if (refreshBtn) {
      refreshBtn.addEventListener("click", () => {
        refreshAll();
      });
    }

    const container = document.getElementById("target-harness-list");
    if (container) {
      container.addEventListener("change", (event) => {
        const target = event.target;
        if (target && target.name === "target-harness") {
          target.dataset.userTouched = "true";
        }
      });
    }

    const form = document.getElementById("dispatch-form");
    const input = document.getElementById("task-prompt-input");
    if (form && input) {
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const checked = Array.from(
          form.querySelectorAll('input[name="target-harness"]:checked'),
        ).map((el) => el.value);
        const promptText = input.value.trim();
        if (!promptText) return;
        input.value = "";
        await delegateAcrossHarnesses(checked.length ? checked : ["pi"], promptText);
      });
    }
  }

  function registerVoiceTools() {
    const getProgressTool = {
      name: "get_agent_progress",
      description:
        "Get active coding harnesses and live progress of running and recent agent tasks.",
      parameters: {
        type: "object",
        properties: {},
      },
      execute: async () => {
        return {
          activeHarnesses: state.harnesses.filter((h) => h.active).map((h) => h.id),
          tasks: state.tasks,
        };
      },
    };

    const delegateMultiTool = {
      name: "delegate_multi_harness",
      description:
        "Run a coding or investigation task across one or multiple harnesses simultaneously.",
      parameters: {
        type: "object",
        properties: {
          agents: {
            type: "array",
            description: "List of harness identifiers such as pi, claude, antigravity, codex, opencode",
            items: { type: "string" },
          },
          task: {
            type: "string",
            description: "Task instructions to run across the selected harnesses",
          },
        },
        required: ["agents", "task"],
      },
      execute: async (args) => {
        const agents = Array.isArray(args && args.agents) ? args.agents : ["pi", "claude"];
        const taskText = args && args.task ? String(args.task) : "";
        return delegateAcrossHarnesses(agents, taskText);
      },
    };

    const compareResultsTool = {
      name: "compare_harness_results",
      description:
        "Compare outputs, touched files, and scores across current multi-harness runs and optionally select a winning patch.",
      parameters: {
        type: "object",
        properties: {
          selectedWinnerId: {
            type: "string",
            description: "Optional task ID or harness name to mark as the chosen winning patch",
          },
        },
      },
      execute: async (args) => {
        if (args && typeof args.selectedWinnerId === "string" && args.selectedWinnerId.trim()) {
          state.selectedWinnerId = args.selectedWinnerId.trim();
          renderComparison();
        }
        const report = computeComparison();
        return {
          ok: true,
          totalRuns: report.ranking.length,
          ranking: report.ranking,
          sharedFiles: report.sharedFiles,
          recommendedWinner: report.recommendedWinner,
          selectedWinner: report.selectedWinner,
        };
      },
    };

    if (window.voicebox) {
      window.voicebox?.registerTool(getProgressTool);
      window.voicebox?.registerTool(delegateMultiTool);
      window.voicebox?.registerTool(compareResultsTool);
      window.voicebox?.ready?.();
    } else if (window.webMcp) {
      window.webMcp?.registerTool(getProgressTool);
      window.webMcp?.registerTool(delegateMultiTool);
      window.webMcp?.registerTool(compareResultsTool);
      window.webMcp?.ready?.();
    }
  }

  setupInteractions();
  renderHarnesses();
  renderTasks();
  registerVoiceTools();
  refreshAll();

  setInterval(() => {
    if (document.visibilityState !== "hidden") {
      refreshAll();
    }
  }, 2500);
})();
