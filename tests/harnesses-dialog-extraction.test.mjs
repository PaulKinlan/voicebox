// tests/harnesses-dialog-extraction.test.mjs — the Harnesses modal dialog lives in
// public/components/harnesses-dialog.mjs, not inline in public/fused.js (voicebox-beads-uei2.9).
//
// This slice's risk is not the markup: it is the SEAM. The dialog reads four pieces of host state that the
// host REASSIGNS (roomFolder, listingDir, miniAppController, lastHarnessOutput) and two of its functions are
// called from outside it. So this file pins, in order:
//   1. statically, that the surface moved and the host kept the handle/binding/global it must keep;
//   2. on the real page, that one click on the check button is exactly ONE /api/harnesses fetch (a leftover
//      inline copy would make it two), that a listener-free clone does nothing, and that the host's OWN task
//      path reaches the module through the accessor PAIR it was handed;
//   3. standalone with spies, that the injected pair and the returned callbacks are the only paths the
//      module uses — so a snapshot or a stale handle cannot pass.
// Owner suites keep driving the feature and are unchanged: tests/modal-panels.test.mjs,
// tests/ux-bubble-stage.test.mjs, tests/configured-harness.test.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { startServer } from "./lib/server.mjs";
import { launch } from "./lib/cdp.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MODULE_PATH = path.join(ROOT, "public", "components", "harnesses-dialog.mjs");
const HOST_PATH = path.join(ROOT, "public", "fused.js");

// Distinctive strings of the moved block: gone from the host (a second copy would be a second wiring), and
// present in the module.
const MOVED_MARKERS = [
  "function checkHarnesses",
  "function configureHarnessInUi",
  "function syncHarnessProjectContext",
  "function renderHarnessChangedFiles",
  "function openAgentProgressTracker",
  "renderModalToolCatalogue",
  "CAN_ACTIVATE",
  "harness-card-head",
];

function assertSeam(host, mod) {
  for (const marker of MOVED_MARKERS) {
    assert.ok(!host.includes(marker), `fused.js must no longer carry ${JSON.stringify(marker)}`);
    assert.ok(mod.includes(marker), `the extracted module must carry ${JSON.stringify(marker)}`);
  }
  assert.match(host, /import \{ initHarnessesDialog \} from "\.\/components\/harnesses-dialog\.mjs";/, "the host imports the factory");
  // The binding STAYS: the page's own __voiceboxOnTask handler writes it, and that call site is unchanged.
  assert.match(host, /let lastHarnessOutput = "";/, "the binding stays in the host");
  assert.match(host, /const \{ renderHarnessChangedFiles, openAgentProgressTracker \} = initHarnessesDialog\(\{/, "the two outward functions come back from the factory");
  for (const getter of ["getRoomFolder: () => roomFolder,", "getListingDir: () => listingDir,", "getMiniAppController: () => miniAppController,", "getLastHarnessOutput: () => lastHarnessOutput,"]) {
    assert.ok(host.includes(getter), `the host must hand over a LIVE accessor: ${getter}`);
  }
  assert.ok(host.includes("setLastHarnessOutput: (next) => {"), "and the write half of the pair");
  assert.match(host, /window\.__voiceboxOpenAgentTracker = openAgentProgressTracker;/, "the page global is still assigned at the seam");
  // The outward call sites the whole slice exists to preserve, byte for byte.
  assert.ok(host.includes("lastHarnessOutput = outText;"), "the task handler still writes the same binding");
  assert.ok(host.includes("renderHarnessChangedFiles(changed);"), "the task handler still renders changed files");
  assert.equal((host.match(/void openAgentProgressTracker\(\);/g) || []).length, 2, "both system-command sites still call the tracker");
  assert.match(mod, /export function initHarnessesDialog\(\{/, "the module's seam");
  assert.match(mod, /return \{ renderHarnessChangedFiles, openAgentProgressTracker \};/, "the module returns exactly the two functions the page calls from outside");
}

test("the dialog is in the module, gone from the host, and the host keeps the binding, the pair, the global and both outward call sites", () => {
  const host = readFileSync(HOST_PATH, "utf8");
  const mod = readFileSync(MODULE_PATH, "utf8");
  assertSeam(host, mod);

  // NEGATIVE MUTANTS.
  const leftover = host.replace("let lastHarnessOutput = \"\";", "let lastHarnessOutput = \"\";\nfunction checkHarnesses() {}\nfunction renderHarnessChangedFiles() {}");
  assert.notEqual(leftover, host);
  assert.throws(() => assertSeam(leftover, mod), { name: "AssertionError" }, "a leftover inline copy must be caught");

  const noImport = host.replace(/import \{ initHarnessesDialog \} from "\.\/components\/harnesses-dialog\.mjs";\n/, "");
  assert.notEqual(noImport, host);
  assert.throws(() => assertSeam(noImport, mod), { name: "AssertionError" }, "a dropped import must be caught");

  const noPair = host.replace("setLastHarnessOutput: (next) => {", "setLastHarnessOutput: (next) => { /* no-op */");
  assert.notEqual(noPair, host);
  assert.throws(() => assertSeam(host.replace("setLastHarnessOutput: (next) => {", ""), mod), { name: "AssertionError" }, "losing the write half of the pair must be caught");

  const noGlobal = host.replace("window.__voiceboxOpenAgentTracker = openAgentProgressTracker;\n", "");
  assert.notEqual(noGlobal, host);
  assert.throws(() => assertSeam(noGlobal, mod), { name: "AssertionError" }, "a dropped page global must be caught");

  const moduleWithoutCallbacks = mod.replace("return { renderHarnessChangedFiles, openAgentProgressTracker };", "return { renderHarnessChangedFiles };");
  assert.notEqual(moduleWithoutCallbacks, mod);
  assert.throws(() => assertSeam(host, moduleWithoutCallbacks), { name: "AssertionError" }, "a dropped outward callback must be caught");
});

let server;
let base;
let page;

test.before(async () => {
  server = await startServer({ cwd: ROOT, env: { VOICEBOX_INSTANCE: "harnesses-dialog-extraction-test" } });
  base = server.base;
  page = await launch();
  await page.goto(`${base}/`);
  await page.waitFor(() => typeof window.__voiceboxOpenAgentTracker === "function", { label: "the host to wire the harnesses dialog" });
});

test.after(async () => {
  await page?.close();
  await server?.stop();
});

test("on the real page: one check is exactly ONE /api/harnesses fetch, a listener-free clone is none, and the host's own task path reaches the module through the accessor pair", async () => {
  // Open the dialog through its own control, as a user does. Opening it RUNS a check, so wait for that one
  // to finish (the host probe takes ~7s here) before counting clicks: the button is disabled while a check
  // is in flight, and a click on a disabled button would silently measure nothing.
  await page.evaluate(() => document.getElementById("harnesses-open")?.click());
  await page.waitFor(() => document.getElementById("harnesses-dialog")?.open === true, { label: "the dialog to open" });
  await page.waitFor(
    () => {
      const btn = document.getElementById("harnesses-check");
      return Boolean(btn) && !btn.disabled;
    },
    { label: "the open-triggered host inventory check to finish" },
  );

  // Count the inventory fetches. Exactly one per click is the double-wiring detector: a leftover copy of the
  // old inline handler in fused.js would send two. The clone is taken BEFORE the real click, while the real
  // button is enabled, so "the clone fetches nothing" is evidence about listeners and not about disabled.
  const counted = await page.evaluate(async () => {
    const realFetch = window.fetch;
    const calls = [];
    window.fetch = function countingFetch(input, init) {
      const url = typeof input === "string" ? input : input?.url ?? String(input);
      calls.push(url);
      return realFetch.call(this, input, init);
    };
    const count = () => calls.filter((u) => u.includes("/api/harnesses")).length;
    const btn = document.getElementById("harnesses-check");
    const clone = btn.cloneNode(true);
    btn.parentElement.appendChild(clone);
    calls.length = 0;
    btn.click();
    await new Promise((r) => setTimeout(r, 400));
    const first = count();
    clone.click();
    await new Promise((r) => setTimeout(r, 300));
    const afterClone = count() - first;
    clone.remove();
    window.fetch = realFetch;
    return { first, afterClone, status: document.getElementById("harnesses-status")?.textContent ?? "", rows: document.getElementById("harnesses-list")?.childElementCount ?? 0 };
  });
  assert.equal(counted.first, 1, "one click on the check button must be exactly one /api/harnesses fetch — two means a leftover wiring");
  assert.equal(counted.afterClone, 0, "a listener-free clone must fetch nothing, which is what makes that count evidence about wiring rather than markup");
  assert.match(counted.status, /harnesses ready on this host/, "the check must paint the host inventory it read");
  assert.ok(counted.rows > 0, "and render the harness rows");

  // THE SEAM, through the host's own path. __voiceboxOnTask writes lastHarnessOutput (the binding the host
  // kept) and calls renderHarnessChangedFiles (the callback the module returned). Both directions are
  // exercised by one call, and only the accessor PAIR can carry the value across.
  const seam = await page.evaluate(async () => {
    const changed = document.getElementById("harness-changed-files");
    changed.hidden = true;
    window.__voiceboxOnTask({ output: "PROBE_TASK_OUTPUT", changedFiles: ["probe-changed-a.md"], agent: "probe", state: "running" });
    await new Promise((r) => setTimeout(r, 150));
    const afterTask = { hidden: changed.hidden, text: changed.textContent ?? "" };
    const realFetch = window.fetch;
    const bodies = [];
    window.fetch = function spy(input, init) {
      if (init?.body) bodies.push(String(init.body));
      return realFetch.call(this, input, init);
    };
    // The save handler READS the pair first: `if (!getLastHarnessOutput()) return;`. A sentinel in the status
    // line makes that read observable — a stale snapshot would leave the sentinel untouched, while a live pair
    // lets the handler proceed (whether the save itself can succeed in this environment or not).
    const status = document.getElementById("harness-loop-status");
    status.textContent = "PROBE_SENTINEL_BEFORE_SAVE";
    document.getElementById("harness-save-output").hidden = false;
    document.getElementById("harness-save-output").click();
    await new Promise((r) => setTimeout(r, 600));
    window.fetch = realFetch;
    return {
      afterTask,
      saveStatus: status.textContent ?? "",
      changedAfterSave: changed.textContent ?? "",
      bodies,
    };
  });
  assert.equal(seam.afterTask.hidden, false, "the returned renderHarnessChangedFiles must paint the dialog's changed-files element");
  assert.match(seam.afterTask.text, /probe-changed-a\.md/, "with the file the task reported");
  assert.notEqual(
    seam.saveStatus,
    "PROBE_SENTINEL_BEFORE_SAVE",
    "the save handler must have got PAST its `if (!getLastHarnessOutput()) return;` — that read is the accessor pair, and a stale snapshot would leave this sentinel untouched",
  );
  assert.match(seam.saveStatus, /Saved output to harness-analysis\.md|Could not save/, `the save must have been attempted against the value the host wrote: ${JSON.stringify(seam.saveStatus)}`);
  if (seam.bodies.length > 0) {
    assert.ok(seam.bodies.some((b) => b.includes("PROBE_TASK_OUTPUT")), "when the save goes over HTTP the body must carry the value the host wrote into the pair");
  }
  if (/Saved output to harness-analysis\.md/.test(seam.saveStatus)) {
    assert.match(seam.changedAfterSave, /harness-analysis\.md/, "and a successful save renders the saved name through the returned callback");
  }

  // The miniAppController accessor must be LIVE: it is declared AFTER this surface in the host, so a snapshot
  // taken at init would be null and the tracker's mount would silently do nothing.
  const tracker = await page.evaluate(async () => {
    window.__voiceboxOpenAgentTracker();
    await new Promise((r) => setTimeout(r, 500));
    const frame = document.querySelector('#mini-app-viewport iframe, iframe#mini-app-outer-frame');
    return { src: frame?.getAttribute("src") ?? "" };
  });
  assert.match(tracker.src, /appId=agent-progress-tracker/, "the tracker must mount the mini-app through the LIVE controller — a snapshot of miniAppController would be null here and nothing would mount");
});

test("standalone with spies: the injected pair and the returned callbacks are the only paths the module uses", async () => {
  const result = await page.evaluate(async () => {
    const { initHarnessesDialog } = await import("/components/harnesses-dialog.mjs");
    const div = () => document.createElement("div");
    const els = {
      harnessesDialog: document.createElement("dialog"), harnessesOpen: div(), harnessesClose: div(),
      harnessesCheck: div(), harnessesList: div(), harnessesStatus: div(), harnessesScope: div(),
      harnessesOpenTracker: div(), harnessAgentName: div(), harnessAgentSelect: div(), harnessAgentModel: div(),
      harnessConfigSave: div(), harnessConfigNote: div(), harnessProjectContext: div(),
      harnessTaskInput: document.createElement("input"), harnessTaskSend: div(), harnessLoopStatus: div(),
      harnessSaveOutput: div(), harnessChangedFiles: div(), listingRoot: div(), rootKind: div(),
    };
    const calls = { set: [], get: 0, listing: 0, room: 0, mini: 0, load: 0, loadRoomFolder: 0, write: [], showFile: [], health: 0, requests: [] };
    const state = { output: "", listing: "/probe/dir", room: { name: "probe-root" }, mini: { mount: (d) => calls.miniMount = d } };
    const controller = initHarnessesDialog({
      els,
      on: (el, type, fn) => el && el.addEventListener(type, fn),
      request: async (url, init) => { calls.requests.push(url); return { ok: true, output: "PROBE_OUT", changedFiles: ["a.md", "b.md"] }; },
      health: () => { calls.health += 1; },
      load: () => { calls.load += 1; },
      showFile: (n) => { calls.showFile.push(n); },
      loadRoomFolder: () => { calls.loadRoomFolder += 1; },
      writeRoomFile: async (n, c) => { calls.write.push([n, c]); },
      getRoomFolder: () => { calls.room += 1; return state.room; },
      getListingDir: () => { calls.listing += 1; return state.listing; },
      getMiniAppController: () => { calls.mini += 1; return state.mini; },
      getLastHarnessOutput: () => { calls.get += 1; return state.output; },
      setLastHarnessOutput: (v) => { calls.set.push(v); state.output = v; },
    });
    const returnedKeys = Object.keys(controller).sort();

    // Drive the task launcher: it must WRITE through the pair and then READ back through it.
    els.harnessTaskInput.value = "probe task";
    els.harnessTaskSend.click();
    await new Promise((r) => setTimeout(r, 200));
    const afterTask = {
      set: [...calls.set],
      stateOutput: state.output,
      rendered: els.harnessChangedFiles.childElementCount,
      listingUsed: calls.listing > 0,
      loadCalled: calls.load > 0,
      requestUrl: calls.requests[0],
    };

    // Drive the save: `setLastHarnessOutput` above must be what the save path reads.
    els.harnessSaveOutput.click();
    await new Promise((r) => setTimeout(r, 200));
    const afterSave = { write: [...calls.write], loadRoomFolder: calls.loadRoomFolder, showFile: [...calls.showFile] };

    // The tracker must ask for the controller at CALL time, not at init time.
    await controller.openAgentProgressTracker();
    const afterTracker = { miniReads: calls.mini > 0 };

    return { returnedKeys, afterTask, afterSave, afterTracker };
  });

  assert.deepEqual(result.returnedKeys, ["openAgentProgressTracker", "renderHarnessChangedFiles"], "the factory returns exactly the two outward functions");
  assert.deepEqual(result.afterTask.set, ["PROBE_OUT"], "the task path must WRITE the output through the injected setter, not into a private copy");
  assert.equal(result.afterTask.stateOutput, "PROBE_OUT", "and the injected store is the one that changed");
  assert.ok(result.afterTask.rendered >= 2, "the task path must render the changed files through the module's own renderer");
  assert.ok(result.afterTask.listingUsed, "the task path must read the listing dir through the live accessor");
  assert.ok(result.afterTask.loadCalled, "and still call the injected load");
  assert.equal(result.afterTask.requestUrl, "/api/delegate", "the task posts to the delegate route");
  assert.deepEqual(result.afterSave.write, [["harness-analysis.md", "PROBE_OUT"]], "the save must read back the value through the getter — this is the pair working end to end");
  assert.ok(result.afterSave.loadRoomFolder > 0, "and refresh the room folder it wrote into");
  assert.deepEqual(result.afterSave.showFile, ["harness-analysis.md"], "and open the saved file");
  assert.ok(result.afterTracker.miniReads, "the tracker asks for the mini-app controller when it runs, so the accessor is never a stale handle");
});
