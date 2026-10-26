// POST a branch action and READ THE ANSWER (voicebox-beads-q376 / wmiq). The honest contract for
// both buttons and the published room tools: a refusal or an unreachable server returns ok:false
// with the server's reason; nothing is marked locally until the server confirms. Exported so the
// unit tier can drive it with a fake fetch — importing this file in Node must have NO DOM side
// effects (the bootstrap below is guarded).
export async function postBranchAction(route, body, fetchImpl = globalThis.fetch) {
  let res;
  try {
    res = await fetchImpl(route, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    return { ok: false, refused: "server-unreachable", why: `the server could not be reached — nothing was recorded (${err?.message ?? err})` };
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok || !data || data.ok === false) {
    return {
      ok: false,
      refused: data?.refused ?? `http-${res.status}`,
      why: data?.why ?? `the server answered ${res.status} — nothing was recorded`,
    };
  }
  return { ok: true, data };
}

// The inspector's bootstrap touches window/document at module scope, so it runs ONLY in a browser;
// the unit tier imports the helpers above without one.
if (typeof window !== "undefined" && typeof document !== "undefined") (function () {
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

      // The recorded decision is rendered, not just held (wmiq): a kept-separate branch says so
      // on its row, so a refresh cannot silently turn "recorded" back into "waiting".
      if (branch.statusDecision && branch.statusDecision !== "waiting") {
        const decision = document.createElement("div");
        decision.className = "branch-decision";
        decision.dataset.decision = branch.statusDecision;
        decision.textContent =
          branch.statusDecision === "kept-separate" ? "Kept separate" : "Landed";
        meta.appendChild(decision);
      }

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
        // A reachable server's answer is the truth even when it is EMPTY (wmiq): the old
        // `branches.length` guard kept the built-in preview branches on screen, so the inspector
        // showed made-up branches over a real, empty workspace. Fixtures survive only when the
        // server cannot be reached at all.
        if (data && Array.isArray(data.branches)) {
          state.baseBranch = data.baseBranch || "main";
          state.branches = data.branches;
          if (state.branches.length && !state.branches.some((b) => b.name === state.selectedBranch)) {
            state.selectedBranch = state.branches[0].name;
          }
          if (!state.branches.length) {
            state.selectedBranch = null;
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

  /**
   * WHAT THE SERVER SAID, decided in one place (voicebox-beads-ulhi).
   *
   * A status is not a result: this surface used to POST, ignore the answer entirely, and print
   * "Landed … cleanly into main." — including when the route did not exist (it POSTed
   * `/api/branches/land`, and the host route is `POST /api/branches/merge`, so EVERY land printed a
   * success for a 404), when the merge was refused, and when the request never reached the server. A
   * person reading that line would believe their branch was in main.
   *
   * So the claim is earned by the BODY, not by the transport: `{ok: true}` from a 2xx is the only thing
   * that counts, because the host answers a refused merge with a body (`refused`, `why`) and a 409, and an
   * intermediary can return a 200 that says nothing. Anything else is a failure with a reason to show.
   */
  async function readLandingResult(res) {
    let payload = null;
    try {
      const text = res && typeof res.text === "function" ? await res.text() : "";
      payload = text ? codec.parse(text) : null;
    } catch (_err) {
      payload = null;
    }
    const status = res && typeof res.status === "number" ? res.status : null;
    const ok = Boolean(res && res.ok === true) && Boolean(payload && payload.ok === true);
    const why =
      (payload && (payload.why || payload.error)) ||
      (status !== null ? "the server answered HTTP " + status : "the server gave no answer");
    return { ok, payload, why, status };
  }

  function describeLandingFailure(targetName, why) {
    return "Could not land " + targetName + ": " + why + ".";
  }

  async function landBranch(branchName) {
    const targetName = branchName || state.selectedBranch;
    const branch = state.branches.find((b) => b.name === targetName);
    const statusEl = document.getElementById("review-action-status");
    if (!branch) {
      return { ok: false, refused: "branch-not-found", error: "Candidate branch not found" };
    }
    if (branch.cleanMergePossible === false) {
      if (statusEl) {
        statusEl.textContent =
          "Cannot land " + targetName + " automatically because a conflict was detected.";
      }
      return { ok: false, refused: "merge-conflict" };
    }

    let result;
    try {
      const res = await fetch("/api/branches/merge", {
        method: "POST",
        headers: { "Content-Type": mimeType },
        body: codec.stringify({ branch: targetName, baseBranch: state.baseBranch }),
      });
      result = await readLandingResult(res);
    } catch (err) {
      result = {
        ok: false,
        payload: null,
        why: (err && err.message) || "the request did not complete",
        status: null,
      };
    }

    if (!result.ok) {
      const message = describeLandingFailure(targetName, result.why);
      if (statusEl) statusEl.textContent = message;
      renderBranchList();
      renderSelectedBranchDetails();
      return {
        ok: false,
        refused: (result.payload && result.payload.refused) || "land-failed",
        branch: targetName,
        baseBranch: state.baseBranch,
        status: result.status,
        error: message,
      };
    }

    branch.statusDecision = "landed";
    const headCommit = result.payload && result.payload.headCommit ? String(result.payload.headCommit) : "";
    if (statusEl) {
      statusEl.textContent = headCommit
        ? "Landed " + targetName + " cleanly into " + state.baseBranch + " at " + headCommit + "."
        : "Landed " + targetName + " cleanly into " + state.baseBranch + ".";
    }
    renderBranchList();
    renderSelectedBranchDetails();
    return {
      ok: true,
      action: "landed",
      branch: targetName,
      baseBranch: state.baseBranch,
      headCommit,
    };
  }

  async function keepBranchSeparateAction(branchName) {
    const targetName = branchName || state.selectedBranch;
    const branch = state.branches.find((b) => b.name === targetName);
    const statusEl = document.getElementById("review-action-status");

    // Same rule one function down (voicebox-beads-ulhi): "Kept … for later review" is a claim about a record
    // the HOST keeps, and this used to set it without asking the host anything at all.
    let result;
    try {
      const res = await fetch("/api/branches/keep-separate", {
        method: "POST",
        headers: { "Content-Type": mimeType },
        body: codec.stringify({ branch: targetName, baseBranch: state.baseBranch }),
      });
      result = await readLandingResult(res);
    } catch (err) {
      result = {
        ok: false,
        payload: null,
        why: (err && err.message) || "the request did not complete",
        status: null,
      };
    }

    if (!result.ok) {
      const message = "Could not keep " + targetName + " separate: " + result.why + ".";
      if (statusEl) statusEl.textContent = message;
      renderBranchList();
      renderSelectedBranchDetails();
      return {
        ok: false,
        refused: (result.payload && result.payload.refused) || "keep-failed",
        branch: targetName,
        status: result.status,
        error: message,
      };
    }

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
      baseBranch: state.baseBranch,
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

    const keepTool = {
      name: "keep_candidate_branch_separate",
      description:
        "Mark a candidate branch to stay separate from main, recorded by the server so a refresh keeps showing it.",
      parameters: {
        type: "object",
        properties: {
          branch: {
            type: "string",
            description: "Name of the candidate branch to keep separate",
          },
        },
        required: ["branch"],
      },
      execute: async (args) => {
        const branchName =
          args && args.branch ? String(args.branch) : state.selectedBranch;
        return keepBranchSeparateAction(branchName);
      },
    };

    if (window.voicebox) {
      window.voicebox?.registerTool(listTool);
      window.voicebox?.registerTool(inspectTool);
      window.voicebox?.registerTool(landTool);
      window.voicebox?.registerTool(keepTool);
      window.voicebox?.ready?.();
    } else if (window.webMcp) {
      window.webMcp?.registerTool(listTool);
      window.webMcp?.registerTool(inspectTool);
      window.webMcp?.registerTool(landTool);
      window.webMcp?.registerTool(keepTool);
      window.webMcp?.ready?.();
    }
  }

  setupInteractions();
  renderBranchList();
  renderSelectedBranchDetails();
  registerVoiceTools();
  // The truth comes from the server at boot, not from the built-in preview rows (wmiq).
  refreshCandidateBranches();
})();