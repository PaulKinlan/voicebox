/**
 * **The create-project dialog's opener** (`voicebox-beads-5tv3`).
 *
 * IT IS A CLASSIC, PARSER-TIME SCRIPT ON PURPOSE, and that is the reason this file exists rather than a
 * detail of how it is loaded. `browser/ui/ui.ts` is a `type="module"`, and a module is deferred by
 * definition, so the page reaches `interactive` with none of its handlers attached: a click — or an Enter
 * on the focused button — made in that window opened nothing, and was never replayed when the module
 * arrived. Measured: with the module held at the request stage the button did nothing and the dialog
 * stayed shut, and a SECOND activation worked, which is what proved the module itself was healthy and
 * only the first interaction was lost. The keyboard case is the same loss, and it is the one an
 * accessibility pass names: a working control that does nothing when activated from the keyboard.
 *
 * A deferred file cannot repair that with a catch-up step the way the Help page's search filter does
 * (`voicebox-beads-aenb` re-applies the value already sitting in its box). A click leaves no state behind
 * to re-apply, so the only repair is to never miss the window: this runs while the document is still
 * parsing, exactly where the inline handler it replaces used to run.
 *
 * ONE OWNER, and the module is not a second one. `ui.ts` deliberately does NOT bind this button any more:
 * a second listener would re-run the whole opener — clearing the status, re-syncing the panel and opening a
 * dialog that is already open — so the button's effects would happen twice on every activation. (That second
 * `showModal()` is a silent no-op rather than the `InvalidStateError` this comment originally asserted from
 * the spec; measured, and the reason the one-owner test counts invocations instead of expecting a throw:
 * `voicebox-beads-r3xp`.)
 * Opening lives here; closing, the status line inside the dialog, and every submit path stay in the
 * module, which reads `showDestination` from the seam below instead of keeping a copy of it.
 *
 * TODO(baseline/invoker-commands): delete this file and put `commandfor="create-project-dialog"` with
 * `command="show-modal"` on the button instead, which hands the open to the browser and makes it
 * "functional immediately upon HTML parsing" — the property this file exists to imitate. Invoker
 * commands are Baseline Newly available (since 2025-12-12: Chrome/Edge 135, Firefox 144, Safari 26.2),
 * so the swap needs a polyfill for older browsers, feature-detected as
 * `'commandForElement' in HTMLButtonElement.prototype` and loaded ONLY when it is missing. That polyfill
 * would have to be vendored here: the guide's CDN route is a cross-origin import, which this page's
 * `script-src 'self'` policy would block.
 */

// One fact, one place. The module's radio handlers need this too, so it is published on the seam below
// rather than copied into both files.
const DEST_PANELS = { opfs: "dest-opfs", picked: "dest-picked", machine: "dest-machine" };

function showDestination(value) {
  for (const [dest, panel] of Object.entries(DEST_PANELS)) document.getElementById(panel).hidden = dest !== value;
}

window.__voiceboxCreateProject = { showDestination };

document.getElementById("create-project").addEventListener("click", () => {
  // The status is cleared FIRST, and then the destination is opened on what is actually chosen, so that
  // the dialog and its radios cannot disagree. Both steps are the ones the module used to run: a stale
  // refusal sitting next to a fresh dialog would describe an act nobody just made.
  const status = document.getElementById("dest-status");
  if (status) {
    status.hidden = true;
    status.textContent = "";
    delete status.dataset.ok;
  }
  const chosen = document.querySelector('input[name="dest"]:checked');
  showDestination(chosen?.value ?? "opfs");
  document.getElementById("create-project-dialog")?.showModal();
});
