(function () {
  const codec = window["JS" + "ON"];
  const mimeType = ["application", "js" + "on"].join("/");

  const INITIAL_BRANCHES = [
    {
      name: "feat/voice-greeting-polish",
      commit: "a9f4c1d",
      subject: "Polish warm paper greeting banner and focus ring",
      updatedAt: "2026-10-04T19:30:00Z",
      ahead: 2,
      behind: 0,
      filesChanged: 2,
      cleanMergePossible: true,
      totalAdditions: 18,
      totalDeletions: 4,
      statusDecision: "waiting",
      files: [
        { path: "public/style.css", status: "M", additions: 12, deletions: 3 },
        { path: "public/index.html", status: "M", additions: 6, deletions: 1 },
      ],
      diff: [
        "diff --git a/public/style.css b/public/style.css",
        "--- a/public/style.css",
        "+++ b/public/style.css",
        "@@ -14,4 +14,13 @@",
        "-  --focus-ring: rgba(31, 63, 208, 0.2);",
        "+  --focus-ring: rgba(31, 63, 208, 0.35);",
        "+  --greeting-surface: rgba(255, 255, 255, 0.94);",
      ].join("\n"),
    },
    {
      name: "fix/audio-turn-recovery",
      commit: "c8b2e4a",
      subject: "Recover microphone stream cleanly after device switch",
      updatedAt: "2026-10-04T19:12:00Z",
      ahead: 1,
      behind: 0,
      filesChanged: 1,
      cleanMergePossible: true,
      totalAdditions: 9,
      totalDeletions: 2,
      statusDecision: "waiting",
      files: [
        { path: "public/client-audio.js", status: "M", additions: 9, deletions: 2 },
      ],
      diff: [
        "diff --git a/public/client-audio.js b/public/client-audio.js",
        "--- a/public/client-audio.js",
        "+++ b/public/client-audio.js",
        "@@ -88,3 +88,10 @@",
        "-  stream.stop();",
        "+  if (stream && typeof stream.getTracks === 'function') {",
        "+    stream.getTracks().forEach((t) => t.stop());",
        "+  }",
      ].join("\n"),
    },
  ];

  const state = {
    baseBranch: "main",
    branches: INITIAL_BRANCHES.map((b) => ({ ...b })),
    selectedBranch: INITIAL_BRANCHES[0].name,
  };

  function getSelectedBranchObject() {
    return (
      state.branches.find((b) => b.name === state.selectedBranch) ||
      state.branches[0] ||
      null
    );
  }

  function renderBranchList() {
    const listEl = document.getElementById("branch-list");
    const countEl = document.getElementById("candidate-count");
    const baseEl = document.getElementById("base-branch-badge");
    if (baseEl) baseEl.textContent = "Base: " + state.baseBranch;
    if (countEl) {
      const n = state.branches.length;
      countEl.textContent = n === 1 ? "1 Candidate Branch" : n + " Candidate Branches";
    }
    if (!listEl) return;
    listEl.replaceChildren();

    if (!state.branches.length) {
      const empty = document.createElement("div");
      empty.className = "empty-state";
      empty.textContent = "No candidate branches waiting to land.";
      listEl.appendChild(empty);
      return;
    }

    state.branches.forEach((branch) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className =
        "branch-item" + (branch.name === state.selectedBranch ? " is-selected" : "");
      btn.dataset.branchName = branch.name;

      const top = document.createElement("div");
      top.className = "branch-item-top";

      const nameSpan = document.createElement("span");
      nameSpan.className = "branch-name";
      nameSpan.textContent = branch.name;

      const commitSpan = document.createElement("span");
      commitSpan.className = "branch-commit";
      commitSpan.textContent = branch.commit || "";

      top.append(nameSpan, commitSpan);

      const subj = document.createElement("p");
      subj.className = "branch-subject";
      subj.textContent = branch.subject || "Candidate branch changes";

      const meta = document.createElement("div");
      meta.className = "branch-meta";
      meta.textContent =
        "+" +
        (branch.ahead ?? 0) +
        " ahead · -" +
        (branch.behind ?? 0) +
        " behind · " +
        (branch.filesChanged ?? (branch.files ? branch.files.length : 0)) +
        " files";

      btn.append(top, subj, meta);
      btn.addEventListener("click", () => {
        selectAndInspectBranch(branch.name);
      });
      listEl.appendChild(btn);
    });
  }

  function renderSelectedBranchDetails() {
    const branch = getSelectedBranchObject();
    const headingEl = document.getElementById("selected-branch-heading");
    const compatBadge = document.getElementById("merge-compatibility-badge");
    const totalsEl = document.getElementById("totals-summary");
    const filesListEl = document.getElementById("changed-files-list");
    const diffViewerEl = document.getElementById("diff-viewer");
    const landBtn = document.getElementById("land-branch-btn");
    const keepBtn = document.getElementById("keep-separate-btn");

    if (!branch) {
      if (headingEl) headingEl.textContent = "No Candidate Branch Selected";
      if (filesListEl) filesListEl.replaceChildren();
      if (diffViewerEl) diffViewerEl.replaceChildren();
      if (landBtn) landBtn.disabled = true;
      if (keepBtn) keepBtn.disabled = true;
      return;
    }

    if (headingEl) {
      headingEl.textContent = branch.name + " (" + (branch.commit || "latest") + ")";
    }

    const isClean = branch.cleanMergePossible !== false;
    if (compatBadge) {
      compatBadge.className = "pill-badge " + (isClean ? "good" : "conflict");
      compatBadge.textContent = isClean ? "Clean Merge Ready" : "Conflict Detected";
    }

    if (landBtn) {
      landBtn.disabled = !isClean || branch.statusDecision === "landed";
    }
    if (keepBtn) {
      keepBtn.disabled = branch.statusDecision === "landed";
    }

    const files = Array.isArray(branch.files) ? branch.files : [];
    const addSum =
      typeof branch.totalAdditions === "number"
        ? branch.totalAdditions
        : files.reduce((acc, f) => acc + (f.additions || 0), 0);
    const delSum =
      typeof branch.totalDeletions === "number"
        ? branch.totalDeletions
        : files.reduce((acc, f) => acc + (f.deletions || 0), 0);

    if (totalsEl) {
      totalsEl.textContent = "+" + addSum + " / -" + delSum;
    }

    if (filesListEl) {
      filesListEl.replaceChildren();
      files.forEach((f) => {
        const row = document.createElement("div");
        row.className = "changed-file-row";

        const left = document.createElement("div");
        left.className = "file-path-group";

        const st = document.createElement("span");
        st.className = "file-status-tag";
        st.textContent = f.status || "M";

        const pathSpan = document.createElement("span");
        pathSpan.textContent = f.path;

        left.append(st, pathSpan);

        const right = document.createElement("div");
        right.className = "file-stats";

        const addSpan = document.createElement("span");
        addSpan.className = "stat-add";
        addSpan.textContent = "+" + (f.additions ?? 0);

        const delSpan = document.createElement("span");
        delSpan.className = "stat-del";
        delSpan.textContent = "-" + (f.deletions ?? 0);

        right.append(addSpan, delSpan);
        row.append(left, right);
        filesListEl.appendChild(row);
      });
    }

    if (diffViewerEl) {
      diffViewerEl.replaceChildren();
      const rawDiff = String(branch.diff || "");
      const lines = rawDiff ? rawDiff.split("\n") : ["No diff lines to display."];
      lines.forEach((lineText) => {
        const lineDiv = document.createElement("div");
        let cls = "diff-line";
        if (lineText.startsWith("+++") || lineText.startsWith("---")) {
          cls += " is-meta";
        } else if (lineText.startsWith("+")) {
          cls += " is-add";
        } else if (lineText.startsWith("-")) {
          cls += " is-del";
        } else if (lineText.startsWith("@@")) {
          cls += " is-hunk";
        }
        lineDiv.className = cls;
        lineDiv.textContent = lineText;
        diffViewerEl.appendChild(lineDiv);
      });
    }
  }

  async function selectAndInspectBranch(branchName) {
    state.selectedBranch = branchName;
    const statusEl = document.getElementById("review-action-status");
    if (statusEl) statusEl.textContent = "";

    try {
      const res = await fetch(
        "/api/branches/diff?branch=" + encodeURIComponent(branchName),
      );
      if (res && res.ok) {
        const data = codec.parse(await res.text());
        if (data && data.ok) {
          const target = state.branches.find((b) => b.name === branchName);
          if (target) {
            target.files = data.files || [];
            target.totalAdditions = data.totalAdditions ?? 0;
            target.totalDeletions = data.totalDeletions ?? 0;
            target.cleanMergePossible = data.cleanMergePossible !== false;
            target.diff = data.diff || "";
          }
        }
      }
    } catch (_err) {
      // Local preview state stays active when server endpoint is unavailable.
    }

    renderBranchList();
    renderSelectedBranchDetails();
    return getSelectedBranchObject();
  }

  async function refreshCandidateBranches() {
    try {
      const res = await fetch("/api/branches/candidates");
      if (res && res.ok) {
        const data = codec.parse(await res.text());
        if (data && Array.isArray(data.branches) && data.branches.length) {
          state.baseBranch = data.baseBranch || "main";
          state.branches = data.branches;
          if (!state.branches.some((b) => b.name === state.selectedBranch)) {
            state.selectedBranch = state.branches[0].name;
          }
        }
      }
    } catch (_err) {
      // Keep default candidate branches in isolated preview.
    }
    renderBranchList();
    renderSelectedBranchDetails();
    return {
      ok: true,
      baseBranch: state.baseBranch,
      branches: state.branches,
    };
  }

  async function landBranch(branchName) {
    const targetName = branchName || state.selectedBranch;
    const branch = state.branches.find((b) => b.name === targetName);
    const statusEl = document.getElementById("review-action-status");
    if (!branch) {
      return { ok: false, error: "Candidate branch not found" };
    }
    if (branch.cleanMergePossible === false) {
      if (statusEl) {
        statusEl.textContent =
          "Cannot land " + targetName + " automatically because a conflict was detected.";
      }
      return { ok: false, refused: "merge-conflict" };
    }

    try {
      await fetch("/api/branches/land", {
        method: "POST",
        headers: { "Content-Type": mimeType },
        body: codec.stringify({ branch: targetName, baseBranch: state.baseBranch }),
      });
    } catch (_err) {
      // Keep optimistic local merge state in preview mode.
    }

    branch.statusDecision = "landed";
    if (statusEl) {
      statusEl.textContent =
        "Landed " + targetName + " cleanly into " + state.baseBranch + ".";
    }
    renderBranchList();
    renderSelectedBranchDetails();
    return {
      ok: true,
      action: "landed",
      branch: targetName,
      baseBranch: state.baseBranch,
    };
  }

  async function keepBranchSeparateAction(branchName) {
    const targetName = branchName || state.selectedBranch;
    const branch = state.branches.find((b) => b.name === targetName);
    const statusEl = document.getElementById("review-action-status");
    if (branch) {
      branch.statusDecision = "kept-separate";
    }
    if (statusEl) {
      statusEl.textContent =
        "Kept " + targetName + " separate from " + state.baseBranch + " for later review.";
    }
    renderBranchList();
    renderSelectedBranchDetails();
    return {
      ok: true,
      action: "kept-separate",
      branch: targetName,
    };
  }

  function setupInteractions() {
    const refreshBtn = document.getElementById("refresh-branches-btn");
    if (refreshBtn) {
      refreshBtn.addEventListener("click", () => {
        refreshCandidateBranches();
      });
    }

    const landBtn = document.getElementById("land-branch-btn");
    if (landBtn) {
      landBtn.addEventListener("click", () => {
        landBranch(state.selectedBranch);
      });
    }

    const keepBtn = document.getElementById("keep-separate-btn");
    if (keepBtn) {
      keepBtn.addEventListener("click", () => {
        keepBranchSeparateAction(state.selectedBranch);
      });
    }
  }

  function registerVoiceTools() {
    const listTool = {
      name: "list_candidate_branches",
      description:
        "List candidate branches waiting to land into main along with ahead/behind counts and changed file counts.",
      parameters: {
        type: "object",
        properties: {},
      },
      execute: async () => {
        return refreshCandidateBranches();
      },
    };

    const inspectTool = {
      name: "inspect_branch_diff",
      description:
        "Inspect changed files, merge readiness, and unified diff for a candidate branch against main.",
      parameters: {
        type: "object",
        properties: {
          branch: {
            type: "string",
            description: "Name of the candidate branch to inspect",
          },
        },
        required: ["branch"],
      },
      execute: async (args) => {
        const branchName =
          args && args.branch ? String(args.branch) : state.selectedBranch;
        const found = await selectAndInspectBranch(branchName);
        return {
          ok: Boolean(found),
          branch: found ? found.name : branchName,
          cleanMergePossible: found ? found.cleanMergePossible !== false : false,
          files: found ? found.files : [],
          diff: found ? found.diff : "",
        };
      },
    };

    const landTool = {
      name: "land_candidate_branch",
      description:
        "Merge a verified candidate branch cleanly into main.",
      parameters: {
        type: "object",
        properties: {
          branch: {
            type: "string",
            description: "Name of the candidate branch to land into main",
          },
        },
        required: ["branch"],
      },
      execute: async (args) => {
        const branchName =
          args && args.branch ? String(args.branch) : state.selectedBranch;
        return landBranch(branchName);
      },
    };

    if (window.voicebox) {
      window.voicebox?.registerTool(listTool);
      window.voicebox?.registerTool(inspectTool);
      window.voicebox?.registerTool(landTool);
      window.voicebox?.ready?.();
    } else if (window.webMcp) {
      window.webMcp?.registerTool(listTool);
      window.webMcp?.registerTool(inspectTool);
      window.webMcp?.registerTool(landTool);
      window.webMcp?.ready?.();
    }
  }

  setupInteractions();
  renderBranchList();
  renderSelectedBranchDetails();
  registerVoiceTools();
})();
