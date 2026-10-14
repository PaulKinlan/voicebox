// ── THE ENVIRONMENTS DIALOG'S ROOT SURFACE (extracted from public/fused.js by voicebox-beads-mvxl) ──
// The four ways a person gives the room somewhere to save — the browser's own workspace (OPFS), a
// local folder they pick, a folder on the machine the server runs on — plus creating a project by
// name in browser storage. One section of the Environments dialog, one module.
//
// WHY IT IS A MODULE. These listeners sat inside public/fused.js, in the region the architect
// measured as a collision hotspot (~150 edits in 30 days across the settings/root blocks). Every
// edit to any part of that 277KB file maps, through scripts/test-changed.mjs, to every test whose
// source names it — measured before this extraction: 147 test files for a one-line touch of
// public/fused.js. After it, the same edit to this module selects only the tests that name THIS
// file. That is the whole point of the slice: the blast radius, not the line count.
//
// EXTRACTED VERBATIM. The handler bodies below are unchanged from public/fused.js; what changed is
// that the eleven things they used to reach for as fused.js locals now arrive through one
// initEnvironmentRootDialog() call (the seam initExtensionsUI() already establishes):
//
//   els                    the page's element map, passed through — not a second element map, and
//                          not a second copy of the ids. This module reads only these keys:
//                          envUseBrowserBtn, envPickFolderBtn, envRootPathInput, envDeclareRootBtn,
//                          envRootStatus, envCreateProjectBtn, envCreateProjectName,
//                          envCreateProjectStatus.
//   on                     fused.js's own listener helper, so attachment behaves as the rest of the
//                          page does (a null element is not an error, and there is one place to
//                          change that behaviour).
//   request                the page's fetch wrapper: the refusals it throws carry the server's own
//                          `why`/`refused`, and those sentences reach the person unchanged.
//   openOpfsScratchFolder  the browser-workspace opener and its onError affordance.
//   openRoomFolder         the local-folder picker (`showDirectoryPicker`, with its read-only
//                          fallback and its AbortError silence) — owned by fused.js and shared with
//                          the folder chip, so the dialog cannot open a folder the chip disagrees
//                          about.
//   closeRoomFolder        the one way to let go of the active room folder.
//   renderRoot             repaints the header chip and this dialog's "Active root:" line. Deliberately
//                          NOT moved: it also paints the header, the About drawer and the project-change
//                          flash, so it is a state-display function this surface CALLS, not part of it.
//   loadRoot / load        the refresh after a root change: the root facts, then the room's files.
//   scratchpadName         fused.js's SCRATCHPAD_NAME, so there is still exactly one name for it.
//   getRoomFolder          LIVE BY CONTRACT — the accessor must read fused.js's own `roomFolder`
//                          binding on every click, never a copy of it. The picked-folder line below
//                          is worded from the folder that is active AT THAT MOMENT: a snapshot taken
//                          at init would say "read-only" about a folder the person can write, which is
//                          the voicebox-beads-w1f9 defect class (a captured accessor that stays green
//                          while the surface is wrong). tests/environment-root-dialog-extraction.test.mjs
//                          drives the real page with a writable folder picked when no folder was active
//                          before, so a stale read turns that test RED instead of shipping.
//
// The module makes no request and touches no DOM at import or at initialization: it only attaches
// listeners and holds the injected references. The ONE body change beyond the accessor is the
// picked-folder line reading that accessor ONCE into `folder` instead of twice inside one expression —
// the same value either way, because nothing awaits between the two reads.

let els = {};
let on = () => { throw new Error("environment-root-dialog: on() not injected — call initEnvironmentRootDialog first"); };
let request = () => { throw new Error("environment-root-dialog: request() not injected — call initEnvironmentRootDialog first"); };
let openOpfsScratchFolder = () => { throw new Error("environment-root-dialog: openOpfsScratchFolder() not injected — call initEnvironmentRootDialog first"); };
let openRoomFolder = () => { throw new Error("environment-root-dialog: openRoomFolder() not injected — call initEnvironmentRootDialog first"); };
let closeRoomFolder = async () => { throw new Error("environment-root-dialog: closeRoomFolder() not injected — call initEnvironmentRootDialog first"); };
let renderRoot = () => { throw new Error("environment-root-dialog: renderRoot() not injected — call initEnvironmentRootDialog first"); };
let loadRoot = () => { throw new Error("environment-root-dialog: loadRoot() not injected — call initEnvironmentRootDialog first"); };
let load = () => { throw new Error("environment-root-dialog: load() not injected — call initEnvironmentRootDialog first"); };
let scratchpadName = "scratchpad";
// Live by contract: reads fused.js's own `roomFolder` on every call, never a copy of it.
let getRoomFolder = () => { throw new Error("environment-root-dialog: getRoomFolder() not injected — call initEnvironmentRootDialog first"); };

// One dep at a time, and only when it was actually handed over: a missing dep keeps the loud default
// above rather than silently replacing it with `undefined`. (Same shape as initExtensionsUI.)
export function initEnvironmentRootDialog(deps = {}) {
  if (deps.els) els = deps.els;
  if (deps.on) on = deps.on;
  if (deps.request) request = deps.request;
  if (deps.openOpfsScratchFolder) openOpfsScratchFolder = deps.openOpfsScratchFolder;
  if (deps.openRoomFolder) openRoomFolder = deps.openRoomFolder;
  if (deps.closeRoomFolder) closeRoomFolder = deps.closeRoomFolder;
  if (deps.renderRoot) renderRoot = deps.renderRoot;
  if (deps.loadRoot) loadRoot = deps.loadRoot;
  if (deps.load) load = deps.load;
  if (deps.scratchpadName) scratchpadName = deps.scratchpadName;
  if (deps.getRoomFolder) getRoomFolder = deps.getRoomFolder;

  on(els.envUseBrowserBtn, "click", async () => {
    try {
      if (els.envUseBrowserBtn) els.envUseBrowserBtn.disabled = true;
      let failureMsg = null;
      const ok = await openOpfsScratchFolder(scratchpadName, {
        onError: (msg) => { failureMsg = msg; },
      });
      if (ok) {
        if (els.envRootStatus) {
          els.envRootStatus.dataset.ok = "true";
          els.envRootStatus.textContent = "Switched to browser storage (OPFS) — browser files and edits save here.";
        }
        renderRoot();
      } else {
        if (els.envRootStatus) {
          els.envRootStatus.dataset.ok = "false";
          els.envRootStatus.textContent = `Could not switch to browser storage (OPFS): ${failureMsg || "unavailable"}`;
        }
      }
    } catch (err) {
      if (els.envRootStatus) {
        els.envRootStatus.dataset.ok = "false";
        els.envRootStatus.textContent = `Could not switch to browser storage (OPFS): ${err?.message || "unavailable"}`;
      }
    } finally {
      if (els.envUseBrowserBtn) els.envUseBrowserBtn.disabled = false;
    }
  });

  on(els.envPickFolderBtn, "click", async () => {
    const picked = await openRoomFolder({
      onError: (msg) => {
        if (els.envRootStatus) {
          els.envRootStatus.dataset.ok = "false";
          els.envRootStatus.textContent = msg;
        }
      },
    });
    if (picked) {
      if (els.envRootStatus) {
        els.envRootStatus.dataset.ok = "true";
        // THE LIVE READ: what is writable is the folder active NOW, not the one that was active when
        // this module was initialised (which, on a first run, is no folder at all).
        const folder = getRoomFolder();
        const writable = folder?.permission === "granted" && folder?.mode === "readwrite";
        els.envRootStatus.textContent = writable
          ? `Opened local folder “${picked.name}” — browser files and edits save here.`
          : `Opened read-only folder “${picked.name}” — close this dialog, then click 'Restore access' on the folder chip to write files.`;
      }
      renderRoot();
    }
  });

  on(els.envDeclareRootBtn, "click", async () => {
    const pathVal = els.envRootPathInput?.value.trim() ?? "";
    if (!pathVal) {
      if (els.envRootStatus) {
        els.envRootStatus.dataset.ok = "false";
        els.envRootStatus.textContent = "Please enter a folder path on this machine.";
      }
      return;
    }
    const projectName = pathVal.split("/").filter(Boolean).pop() || "project";
    if (els.envDeclareRootBtn) els.envDeclareRootBtn.disabled = true;
    try {
      const res = await request("/api/root", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ project: projectName, root: { kind: "machine", path: pathVal } }),
      });
      if (res && res.ok) {
        // Same live read, for the same reason: whether there is a folder to let go of is a fact about
        // now, not about init.
        if (getRoomFolder()) await closeRoomFolder();
        if (els.envRootPathInput) els.envRootPathInput.value = "";
        // THE SUCCESS LINE IS WRITTEN AFTER THE DIALOG'S OWN ROOT LINE AGREES WITH IT
        // (voicebox-beads-ax2v, ported into this module by the voicebox-beads-3auh integration). It used to
        // be written straight from the POST's answer, while the refresh that repaints `#env-active-root-val`
        // (`loadRoot()` -> `renderRoot()`) still had a network round trip to run — so for that round trip
        // this dialog could say "Machine root set to <path>" beside "no folder chosen yet". That window is
        // one fetch wide: invisible on a quiet box, reproducible with a few browsers in flight
        // (tests/environment-integrated-ui.test.mjs failed there on union tree 0c34af3d). Announcing the
        // change only after the surface has drawn it closes the window instead of racing it. Here the
        // repaint is the INJECTED loadRoot()/load() handed over at init, so the ordering is the whole
        // repair; the live getRoomFolder() read above is unchanged from the extraction.
        await loadRoot();
        await load();
        if (els.envRootStatus) {
          els.envRootStatus.dataset.ok = "true";
          els.envRootStatus.textContent = `Machine root set to ${res.root?.path ?? pathVal} — turns save here now.`;
        }
      } else {
        if (els.envRootStatus) {
          els.envRootStatus.dataset.ok = "false";
          els.envRootStatus.textContent = res?.why || res?.refused || "Could not set machine root.";
        }
      }
    } catch (err) {
      if (els.envRootStatus) {
        els.envRootStatus.dataset.ok = "false";
        els.envRootStatus.textContent = String(err?.message ?? "Error declaring machine root.");
      }
    } finally {
      if (els.envDeclareRootBtn) els.envDeclareRootBtn.disabled = false;
    }
  });

  // Create a project BY NAME in the browser's own storage, from the main UI (voicebox-beads-6uzd, with the
  // explanation above it for voicebox-beads-um5r). It REUSES the helper the environment page's own button
  // uses — ensureScratchpadFolder(name), which creates the OPFS folder and adopts it as the active,
  // persisted room folder — rather than adding a second creation path that could drift from that one.
  on(els.envCreateProjectBtn, "click", async () => {
    const name = (els.envCreateProjectName?.value ?? "").trim();
    const say = (text, ok) => {
      if (!els.envCreateProjectStatus) return;
      els.envCreateProjectStatus.dataset.ok = String(ok);
      els.envCreateProjectStatus.textContent = text;
    };
    // Refusals name the act and what would fix it, and they are written HERE, inside the dialog: a message
    // that lands behind the open modal is a message the person never sees (the defect voicebox-beads-6uzd
    // exists because of).
    if (!name) {
      say("A project needs a name — it becomes one folder in this browser's storage.", false);
      return;
    }
    if (/[\\/]/.test(name)) {
      say("A name cannot contain a slash: the name becomes one folder, so it cannot be a path.", false);
      return;
    }
    els.envCreateProjectBtn.disabled = true;
    try {
      // Say what actually happened, and only say what we KNOW. `getDirectoryHandle(name, { create: true })`
      // cannot tell a NEW folder from one that already exists, so the pre-check below decides the wording:
      // true = it was already there (Opened), false = clearly absent (Created), null = we could not tell
      // (a name that is a FILE, or a non-NotFound error) and then no sentence claims a creation at all — an
      // independent reviewer pointed out that treating every error as "absent" made "Created" empirically
      // rather than provably true.
      let existed = null;
      if (navigator.storage?.getDirectory) {
        try {
          const opfsRoot = await navigator.storage.getDirectory();
          await opfsRoot.getDirectoryHandle(name);
          existed = true;
        } catch (err) {
          existed = err?.name === "NotFoundError" ? false : null;
        }
      }
      // The cause of a failure has to appear HERE, inside the dialog: #turn-report is outside it, behind the
      // open modal, so it is unreadable until the person closes the dialog. Passing the helper's own onError
      // affordance (the one miniapps added with the picker fix, and used by the button next door) is what
      // makes the refusal visible where the person is standing — the voicebox-beads-sbrh defect class.
      let failureMsg = null;
      const ok = await openOpfsScratchFolder(name, { onError: (msg) => { failureMsg = msg; } });
      if (ok) {
        say(
          existed === true
            ? `Opened “${name}” — it is the folder this room acts on now.`
            : existed === false
              ? `Created “${name}” in this browser — it is the folder this room acts on now.`
              : `“${name}” is the folder this room acts on now.`,
          true,
        );
        renderRoot();
      } else {
        const verb = existed === true ? "open" : existed === false ? "create" : "make";
        say(`Could not ${verb} “${name}”${failureMsg ? ` — ${failureMsg}` : " — the room's report line names the cause."}.`, false);
      }
    } catch (err) {
      say(String(err?.message ?? `Could not create “${name}”.`), false);
    } finally {
      els.envCreateProjectBtn.disabled = false;
    }
  });

  // Enter in the name box means the button, and must NOT submit the enclosing method="dialog" form: that
  // would close the dialog and create nothing — the silent-failure shape this work is about.
  on(els.envCreateProjectName, "keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    els.envCreateProjectBtn?.click();
  });
}
