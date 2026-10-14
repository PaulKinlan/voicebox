// public/components/sync-toast.mjs — the revision-mismatch toast and the build stamp, extracted
// from public/fused.js (voicebox-beads-uei2.5, a slice of the fused.js decomposition scoped in
// voicebox-beads-uei2).
//
// OWNS: the sync toast (its message, reload and dismiss controls, and the dismissed-key memory),
// and the build stamp: reading the page's own stamp, turning the page/server revisions into the
// #build line, and the "change log" link that opens the changelog dialog.
//
// WIRED AT ONE SITE with { els, on, openChangelogDialog }. The changelog dialog's opener is passed
// in because that link calls it and components/changelog-dialog.mjs returns it for exactly this
// caller — the module must not reach for the dialog itself.
//
// WHY pageBuild IS EXPORTED rather than a private helper: renderAbout() in the host calls it to name
// the page revision in the About box, and that call can happen while the host is still evaluating its
// own top-level body. A function reached through the controller object would be a temporal-dead-zone
// crash there, because the controller is constructed after that point; an ESM import binding is
// initialised before the importing module's body runs, so this export is safe at any point.

// ── which revision is this? ───────────────────────────────────────────────
// The dev server bakes the identity of its own checkout into this document at
// serve time (vite.config.js, transformIndexHtml). A server that did not stamp
// the page leaves the marker empty and this line stays blank: naming a revision
// the server never sent is the lie this whole line exists to prevent.

// ── the page's own build stamp (read from the served meta tag) ─────────────
export function pageBuild() {
  const content = document.querySelector('meta[name="voicebox-build"]')?.getAttribute("content") ?? "";
  if (!content || content.includes("__VOICEBOX_BUILD_STAMP__")) return "";
  return content;
}

// ── the sync toast + build stamp (voicebox-beads-ebu-era surface; extracted in uei2.5) ──
export function createSyncToastController({ els, on, openChangelogDialog }) {
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

  on(els.syncToastReload, "click", () => window.location.reload());
  on(els.syncToastDismiss, "click", () => {
    dismissedSyncKey = currentSyncKey || "out-of-sync";
    if (els.syncToast) els.syncToast.hidden = true;
  });

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

  // `update` keeps the page global's shape: tests drive window.__voiceboxSyncToast.update(...)
  // and the host still assigns that global (see fused.js), so the contract is unchanged.
  return { update: updateSyncToast, stampBuild };
}
