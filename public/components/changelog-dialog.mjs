// ── THE CHANGE LOG DIALOG (extracted from public/fused.js by voicebox-beads-mvxl) ──
// The Change log modal: its commit list, and the three ways it is driven — the `#changelog-open`
// trigger (also reached from the build stamp's commit link), the `#changelog-refresh` button, and
// closing it (whose handler asks for focus back on whatever opened it). One dialog, one module.
//
// WHY IT IS A MODULE. These handlers sat inside public/fused.js, which the architect measured as the
// repo's collision hotspot. Through scripts/test-changed.mjs a one-line touch of `public/fused.js`
// selects 148 test files — a closure that cannot finish inside the fast gate's bound — because
// `server.mjs` serves `/fused.js` and 134 tests name `server.mjs`. That edge is REAL and stays: this
// extraction does not narrow the mapper and does not make the fused.js bootstrap cheap. What it does
// is make every FUTURE change to this dialog land in a file whose own closure is this module's
// focused test, instead of the whole 148. The blast radius, not the line count.
//
// EXTRACTED VERBATIM. The bodies below are unchanged from public/fused.js; what changed is that the
// two things they used to reach for as fused.js locals now arrive through one `initChangelogDialog()`
// call (the seam `initExtensionsUI()` and `initEnvironmentRootDialog()` already establish):
//
//   els            the page's element map, passed through — not a second element map, and not a second
//                  copy of the ids. This module reads only these keys: `changelogOpen`,
//                  `changelogDialog`, `changelogClose`, `changelogRefresh`, `changelogStatus`,
//                  `changelogCommits`.
//   on             fused.js's own listener helper, so attachment behaves as the rest of the page does
//                  (a null element is not an error, and there is one place to change that behaviour).
//   sanitizeText   fused.js's `sanitizePlainActivityText`. Commit subjects and bodies come from the
//                  repo's own git log through `/api/changelog`, and every one of them is rendered with
//                  `textContent` after this function has stripped what must not reach the page — the
//                  same redaction the Activity log uses, so there is still exactly one vocabulary for
//                  "text that is safe to show".
//
// AND THE RETURNED HANDLES. `openChangelogDialog` is called from OUTSIDE this surface: the build
// stamp's commit link (fused.js's `stampBuild`) opens this dialog. So `initChangelogDialog()` returns
// `{ openChangelogDialog }` and fused.js destructures it — the `initSettingsUi()` shape — rather than
// reaching into the module's internals or duplicating the guard.
//
// WHAT DID NOT MOVE, deliberately:
//   · the `/api/changelog` route itself (server-owned), and `public/changelog.html` + `public/changelog.js`
//     (the standalone page) are different surfaces that happen to fetch the same route.
//   · `installLightDismissFallback(els.changelogDialog)` stays in fused.js: it is the shared
//     `closedby="any"` fallback every dialog on the page uses, driven by the element, not by this
//     surface's listeners.
//   · `#changelog-open` is still clicked by name (`els.changelogOpen?.click?.()`) from the page's
//     command parser; that path goes through the same DOM trigger and is untouched.
//
// The module makes no request and touches no DOM at import or at initialization: it only attaches
// listeners and holds the injected references. `lastChangelogTrigger` — the trigger focus is asked
// for on close — is module-local state, read and written by nothing else. NOTE on that focus call:
// it is preserved verbatim from fused.js and it does run, but where focus ENDS UP is the browser's
// decision — the platform's own focus restore for a closed modal can land after this handler
// (measured on this page: the same sequence left focus on the trigger once and on `<body>` once).
// So the extraction test asserts the CALL, never `document.activeElement`, which would be flaky.

let els = {};
let on = () => { throw new Error("changelog-dialog: on() not injected — call initChangelogDialog first"); };
let sanitizeText = () => { throw new Error("changelog-dialog: sanitizeText() not injected — call initChangelogDialog first"); };

// The trigger the dialog returns focus to. Module-local: nothing outside this surface reads it.
let lastChangelogTrigger = null;

function formatCommitDescription(commit) {
  const rawSubject = String(commit?.subject ?? "").trim();
  const rawBody = String(commit?.body ?? commit?.description ?? "").trim();
  const typeMatch = rawSubject.match(/^([a-z]+)(?:\(([^)]+)\))?!?:\s*(.+)$/i);
  const typeMap = {
    feat: { badge: "Feature", kind: "feat", verb: "Added or improved capability" },
    fix: { badge: "Fix", kind: "fix", verb: "Resolved issue" },
    perf: { badge: "Performance", kind: "perf", verb: "Optimized speed or responsiveness" },
    docs: { badge: "Docs", kind: "docs", verb: "Updated documentation" },
    refactor: { badge: "Refactor", kind: "refactor", verb: "Simplified internal structure" },
    test: { badge: "Tests", kind: "test", verb: "Expanded automated verification" },
    chore: { badge: "Maintenance", kind: "chore", verb: "Routine maintenance update" },
    style: { badge: "Design", kind: "style", verb: "Refined visual layout and styling" },
  };
  const rawType = typeMatch ? typeMatch[1].toLowerCase() : "";
  const scope = typeMatch && typeMatch[2] ? sanitizeText(typeMatch[2]) : "";
  const cleanSubject = sanitizeText(typeMatch ? typeMatch[3] : rawSubject) || "Updated room";
  const mapped = typeMap[rawType] || {
    badge: scope || "Update",
    kind: "update",
    verb: "Updated workspace",
  };
  let description = sanitizeText(rawBody);
  if (!description) {
    const scopePhrase = scope ? ` in ${scope}` : "";
    description = `${mapped.verb}${scopePhrase}: ${cleanSubject.charAt(0).toUpperCase()}${cleanSubject.slice(1)}`;
    if (!/[.!?]$/.test(description)) description += ".";
  }
  const files = Array.isArray(commit?.files)
    ? commit.files.map((f) => sanitizeText(f)).filter(Boolean).slice(0, 6)
    : [];
  return {
    badge: mapped.badge,
    kind: mapped.kind,
    subject: sanitizeText(rawSubject) || cleanSubject,
    description,
    files,
  };
}

async function loadRoomChangelog(options = {}) {
  if (!els.changelogCommits || !els.changelogStatus) return;
  if (els.changelogRefresh) els.changelogRefresh.disabled = true;
  els.changelogStatus.textContent = "Loading changes…";
  try {
    const res = await fetch("/api/changelog", { signal: AbortSignal.timeout(10000), priority: options.priority ?? "low" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!data.ok || !Array.isArray(data.commits)) throw new Error("invalid changelog response");
    els.changelogCommits.replaceChildren();
    if (data.commits.length === 0) {
      els.changelogStatus.textContent = "No recent commits found.";
      return;
    }
    els.changelogStatus.textContent = `Showing ${data.commits.length} recent commits:`;
    for (const c of data.commits) {
      const info = formatCommitDescription(c);
      const li = document.createElement("li");
      li.className = "commit-card";
      li.dataset.commitKind = info.kind;

      const header = document.createElement("div");
      header.className = "commit-header";

      const link = document.createElement("a");
      link.className = "commit-sha";
      link.href = c.url || `https://github.com/PaulKinlan/voicebox/commit/${c.sha}`;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = c.shortSha || (c.sha ? c.sha.slice(0, 7) : "");
      header.append(link);

      const badge = document.createElement("span");
      badge.className = "commit-badge";
      badge.dataset.kind = info.kind;
      badge.textContent = info.badge;
      header.append(badge);

      const subject = document.createElement("span");
      subject.className = "commit-subject";
      subject.textContent = info.subject;
      header.append(subject);

      li.append(header);

      const desc = document.createElement("p");
      desc.className = "commit-description";
      desc.textContent = info.description;
      li.append(desc);

      if (info.files.length > 0) {
        const filesRow = document.createElement("div");
        filesRow.className = "commit-details";
        for (const f of info.files) {
          const pill = document.createElement("span");
          pill.className = "commit-file";
          pill.textContent = f;
          filesRow.append(pill);
        }
        li.append(filesRow);
      }

      const meta = document.createElement("div");
      meta.className = "commit-meta";
      const relDate = c.relativeDate || c.age ? ` (${c.relativeDate || c.age})` : "";
      meta.textContent = `${c.author || "Unknown"} · ${c.date || ""}${relDate}`;
      li.append(meta);

      els.changelogCommits.append(li);
    }
  } catch (err) {
    els.changelogStatus.replaceChildren();
    els.changelogStatus.append(document.createTextNode(`Could not load local changelog (${err.message}). View `));
    const gh = document.createElement("a");
    gh.href = "https://github.com/PaulKinlan/voicebox/commits/main";
    gh.target = "_blank";
    gh.rel = "noopener noreferrer";
    gh.textContent = "all commits on GitHub";
    els.changelogStatus.append(gh, document.createTextNode("."));
  } finally {
    if (els.changelogRefresh) els.changelogRefresh.disabled = false;
  }
}

function openChangelogDialog(triggerEl = els.changelogOpen) {
  if (!els.changelogDialog || els.changelogDialog.open) return;
  lastChangelogTrigger = triggerEl || els.changelogOpen;
  els.changelogDialog.showModal();
  els.changelogOpen?.setAttribute("aria-expanded", "true");
  if (els.changelogCommits && els.changelogCommits.children.length === 0) {
    void loadRoomChangelog();
  }
}

// One dep at a time, and only when it was actually handed over: a missing dep keeps the loud default
// above rather than silently replacing it with `undefined`. (Same shape as initExtensionsUI.)
export function initChangelogDialog(deps = {}) {
  if (deps.els) els = deps.els;
  if (deps.on) on = deps.on;
  if (deps.sanitizeText) sanitizeText = deps.sanitizeText;

  on(els.changelogOpen, "click", () => openChangelogDialog(els.changelogOpen));
  on(els.changelogClose, "click", () => els.changelogDialog?.close());
  on(els.changelogDialog, "close", () => {
    els.changelogOpen?.setAttribute("aria-expanded", "false");
    (lastChangelogTrigger || els.changelogOpen)?.focus();
    lastChangelogTrigger = null;
  });
  on(els.changelogRefresh, "click", () => void loadRoomChangelog({ priority: "high" }));

  return { loadRoomChangelog, openChangelogDialog };
}
