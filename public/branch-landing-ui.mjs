// public/branch-landing-ui.mjs — Candidate Branch & Diff Landing Inspector UI.
//
// Manages the discovery, review, diff inspection, and landing (merge) of candidate
// branches created by coding agents in the Voicebox room.

/**
 * Escape HTML special characters for safe insertion into DOM.
 */
function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function createBranchLandingController({
  openBtn,
  badgeEl,
  dialog,
  closeBtn,
  refreshBtn,
  statusEl,
  branchesList,
  detailPanel,
  detailName,
  mergeBadge,
  landBtn,
  keepBtn,
  actionResult,
  filesCount,
  filesList,
  diffViewer,
  onLanded,
} = {}) {
  let candidateBranches = [];
  let selectedBranch = null;
  let isLoading = false;

  async function fetchCandidates({ priority = "low" } = {}) {
    if (isLoading) return candidateBranches;
    isLoading = true;
    if (statusEl) statusEl.textContent = "Checking candidate branches…";
    try {
      const res = await fetch("/api/branches/candidates", {
        signal: AbortSignal.timeout(10000),
        priority,
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const data = await res.json();
      if (!data.ok || !Array.isArray(data.branches)) {
        throw new Error(data.why || "Failed to load candidate branches");
      }
      candidateBranches = data.branches;
      updateBadge();
      renderBranchList();
      if (statusEl) {
        statusEl.textContent =
          candidateBranches.length === 0
            ? "No candidate branches waiting to land."
            : `${candidateBranches.length} candidate branch${candidateBranches.length === 1 ? "" : "es"} ready for review.`;
      }
      return candidateBranches;
    } catch (err) {
      if (statusEl) statusEl.textContent = `Could not check branches: ${err.message}`;
      return [];
    } finally {
      isLoading = false;
    }
  }

  function updateBadge() {
    const count = candidateBranches.length;
    if (badgeEl) {
      badgeEl.textContent = String(count);
    }
    if (openBtn) {
      // Hidden when no candidate branches exist, so it does not clutter the header in solo mode
      if (count === 0) {
        openBtn.setAttribute("hidden", "");
      } else {
        openBtn.removeAttribute("hidden");
      }
    }
  }

  function renderBranchList() {
    if (!branchesList) return;
    branchesList.replaceChildren();

    if (candidateBranches.length === 0) {
      const li = document.createElement("li");
      li.className = "branch-empty";
      li.textContent = "No branches waiting to land.";
      branchesList.append(li);
      if (detailPanel) detailPanel.setAttribute("hidden", "");
      return;
    }

    for (const b of candidateBranches) {
      const li = document.createElement("li");
      li.className = "branch-item";
      if (selectedBranch?.name === b.name) {
        li.classList.add("selected");
      }
      li.tabIndex = 0;
      li.setAttribute("role", "option");
      li.setAttribute("aria-selected", selectedBranch?.name === b.name ? "true" : "false");

      const nameRow = document.createElement("div");
      nameRow.className = "branch-item-header";

      const nameSpan = document.createElement("span");
      nameSpan.className = "branch-name";
      nameSpan.textContent = b.name;
      nameRow.append(nameSpan);

      if (b.commit) {
        const shaSpan = document.createElement("span");
        shaSpan.className = "branch-commit-sha";
        shaSpan.textContent = b.commit.slice(0, 7);
        nameRow.append(shaSpan);
      }
      li.append(nameRow);

      if (b.subject) {
        const subDiv = document.createElement("div");
        subDiv.className = "branch-subject";
        subDiv.textContent = b.subject;
        li.append(subDiv);
      }

      const metaRow = document.createElement("div");
      metaRow.className = "branch-meta-info";
      metaRow.textContent = `${b.ahead || 0} commit${b.ahead === 1 ? "" : "s"} ahead · ${b.filesChanged || 0} file${b.filesChanged === 1 ? "" : "s"} changed`;
      li.append(metaRow);

      li.addEventListener("click", () => selectBranch(b));
      li.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          selectBranch(b);
        }
      });

      branchesList.append(li);
    }
  }

  async function selectBranch(branch) {
    selectedBranch = branch;
    renderBranchList();

    if (!detailPanel) return;
    detailPanel.removeAttribute("hidden");
    if (detailName) detailName.textContent = branch.name;
    if (mergeBadge) {
      mergeBadge.textContent = "Checking merge…";
      mergeBadge.className = "branch-merge-badge checking";
    }
    if (actionResult) actionResult.textContent = "";
    if (landBtn) landBtn.disabled = true;
    if (keepBtn) keepBtn.disabled = true;
    if (filesList) filesList.replaceChildren();
    if (diffViewer) {
      const code = diffViewer.querySelector("code") || diffViewer;
      code.textContent = "Loading diff…";
    }

    try {
      const res = await fetch(`/api/branches/diff?branch=${encodeURIComponent(branch.name)}`, {
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (!data.ok) throw new Error(data.why || "Failed to inspect branch diff");

      if (mergeBadge) {
        if (data.cleanMergePossible) {
          mergeBadge.textContent = "Clean merge possible";
          mergeBadge.className = "branch-merge-badge ready";
        } else {
          mergeBadge.textContent = "Merge conflicts detected";
          mergeBadge.className = "branch-merge-badge conflict";
        }
      }

      if (landBtn) landBtn.disabled = !data.cleanMergePossible;
      if (keepBtn) keepBtn.disabled = false;

      if (filesCount) filesCount.textContent = String(data.files?.length || 0);
      if (filesList) {
        filesList.replaceChildren();
        for (const f of data.files || []) {
          const fileLi = document.createElement("li");
          fileLi.className = "branch-file-item";

          const statusSpan = document.createElement("span");
          statusSpan.className = `file-status status-${f.status?.toLowerCase() || "m"}`;
          statusSpan.textContent = f.status || "M";
          fileLi.append(statusSpan);

          const pathSpan = document.createElement("span");
          pathSpan.className = "file-path";
          pathSpan.textContent = f.path;
          fileLi.append(pathSpan);

          const statSpan = document.createElement("span");
          statSpan.className = "file-stats";
          statSpan.textContent = `+${f.additions || 0} -${f.deletions || 0}`;
          fileLi.append(statSpan);

          filesList.append(fileLi);
        }
      }

      if (diffViewer) {
        const code = diffViewer.querySelector("code") || diffViewer;
        code.textContent = data.diff || "(empty diff)";
      }
    } catch (err) {
      if (mergeBadge) {
        mergeBadge.textContent = "Inspection failed";
        mergeBadge.className = "branch-merge-badge conflict";
      }
      if (actionResult) actionResult.textContent = `Inspection error: ${err.message}`;
    }
  }

  async function landSelectedBranch() {
    if (!selectedBranch) return;
    if (landBtn) landBtn.disabled = true;
    if (keepBtn) keepBtn.disabled = true;
    if (actionResult) actionResult.textContent = `Landing branch "${selectedBranch.name}"…`;

    try {
      const res = await fetch("/api/branches/merge", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ branch: selectedBranch.name }),
        signal: AbortSignal.timeout(15000),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(data.why || "Failed to land branch");
      }
      if (actionResult) {
        actionResult.textContent = `Successfully landed "${selectedBranch.name}" into workspace (commit ${data.headCommit || "latest"}).`;
      }
      if (onLanded) onLanded(selectedBranch.name);
      await fetchCandidates({ priority: "high" });
    } catch (err) {
      if (actionResult) {
        actionResult.textContent = `Merge failed: ${err.message}`;
      }
      if (landBtn) landBtn.disabled = false;
      if (keepBtn) keepBtn.disabled = false;
    }
  }

  async function keepSelectedBranchSeparate() {
    if (!selectedBranch) return;
    if (landBtn) landBtn.disabled = true;
    if (keepBtn) keepBtn.disabled = true;
    if (actionResult) actionResult.textContent = `Marking branch "${selectedBranch.name}" as separate…`;

    try {
      const res = await fetch("/api/branches/keep-separate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ branch: selectedBranch.name }),
        signal: AbortSignal.timeout(10000),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(data.why || "Failed to update branch status");
      }
      if (actionResult) {
        actionResult.textContent = `Branch "${selectedBranch.name}" kept separate.`;
      }
      await fetchCandidates({ priority: "high" });
    } catch (err) {
      if (actionResult) {
        actionResult.textContent = `Action failed: ${err.message}`;
      }
      if (keepBtn) keepBtn.disabled = false;
    }
  }

  function openDialog(triggerEl = openBtn) {
    if (!dialog || dialog.open) return;
    dialog.showModal();
    if (openBtn) openBtn.setAttribute("aria-expanded", "true");
    fetchCandidates({ priority: "high" });
  }

  function closeDialog() {
    if (!dialog || !dialog.open) return;
    dialog.close();
    if (openBtn) {
      openBtn.setAttribute("aria-expanded", "false");
      openBtn.focus();
    }
  }

  // Wire event handlers
  if (openBtn) {
    openBtn.addEventListener("click", () => openDialog(openBtn));
  }
  if (closeBtn) {
    closeBtn.addEventListener("click", (e) => {
      e.preventDefault();
      closeDialog();
    });
  }
  if (dialog) {
    dialog.addEventListener("close", () => {
      if (openBtn) openBtn.setAttribute("aria-expanded", "false");
    });
  }
  if (refreshBtn) {
    refreshBtn.addEventListener("click", () => fetchCandidates({ priority: "high" }));
  }
  if (landBtn) {
    landBtn.addEventListener("click", () => landSelectedBranch());
  }
  if (keepBtn) {
    keepBtn.addEventListener("click", () => keepSelectedBranchSeparate());
  }

  return {
    fetchCandidates,
    openDialog,
    closeDialog,
    selectBranch,
    landSelectedBranch,
    keepSelectedBranchSeparate,
    getCandidates: () => candidateBranches,
    getSelectedBranch: () => selectedBranch,
  };
}
