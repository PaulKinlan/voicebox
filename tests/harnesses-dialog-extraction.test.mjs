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
  assert.equal((host.match(/openAgentProgressTracker:\s*\(\)\s*=>/g) || []).length, 2, "both system-command wiring sites pass the tracker");
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

  const noTrackerWiring = host.replace("openAgentProgressTracker: () => (typeof openAgentProgressTracker === \"function\" ? openAgentProgressTracker() : window.__voiceboxOpenAgentTracker?.()),\n", "");
  assert.notEqual(noTrackerWiring, host);
  assert.throws(() => assertSeam(noTrackerWiring, mod), { name: "AssertionError" }, "a dropped tracker wiring must be caught");

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

  // Count the inventory fetches — WITH a 1200 ms delay injected on /api/harnesses (voicebox-beads-a8rg).
  // This arm used to read the painted status and rows after a fixed 400 ms, which a slower inventory response
  // turns into a FALSE failure (reproduced with a 1200 ms injection). The fix is to wait for the observable the
  // assertions actually need, and the delay stays IN the arm so that independence from wall time is proven
  // on every run rather than assumed. Exactly one fetch per click is the double-wiring detector: a leftover
  // copy of the old inline handler in fused.js would send two.
  const counts = await page.evaluate(() => {
    const realFetch = window.fetch;
    window.__a8rgRealFetch = realFetch;
    window.__a8rgCalls = [];
    window.fetch = function delayedCountingFetch(input, init) {
      const url = typeof input === "string" ? input : input?.url ?? String(input);
      if (url.includes("/api/harnesses")) {
        window.__a8rgCalls.push(url);
        return new Promise((r) => setTimeout(r, 1200)).then(() => realFetch.call(window, input, init));
      }
      return realFetch.call(window, input, init);
    };
    const btn = document.getElementById("harnesses-check");
    const clone = btn.cloneNode(true);
    window.__a8rgClone = clone;
    btn.parentElement.appendChild(clone);
    window.__a8rgCalls.length = 0;
    // Both counts are taken in the SAME TICK as the click: the handler issues its fetch synchronously, so a
    // wired-but-hidden second path would show up here without waiting on anything. And the clone is taken while
    // the real button is ENABLED, so "the clone fetches nothing" is evidence about listeners, not about disabled.
    btn.click();
    const afterReal = window.__a8rgCalls.length;
    clone.click();
    const afterClone = window.__a8rgCalls.length - afterReal;
    return { first: afterReal, afterClone };
  });
  assert.equal(counts.first, 1, "one click on the check button must be exactly one /api/harnesses fetch — two means a leftover wiring");
  assert.equal(counts.afterClone, 0, "a listener-free clone must fetch nothing, which is what makes that count evidence about wiring rather than markup");

  // Now wait for the OBSERVABLE those assertions are about: the delayed inventory response actually painted.
  // Under the injected delay this is the only reason the arm still passes; if the paint never arrives the wait
  // throws rather than passing on a stale read (see the control test at the end of this file).
  const painted = await page.waitFor(
    () => {
      const status = document.getElementById("harnesses-status")?.textContent ?? "";
      const rows = document.getElementById("harnesses-list")?.childElementCount ?? 0;
      return /harnesses ready on this host/.test(status) && rows > 0 ? { status, rows } : false;
    },
    { label: "the (deliberately delayed) host inventory response to be painted", timeout: 25000 },
  );
  await page.evaluate(() => {
    window.__a8rgClone.remove();
    window.fetch = window.__a8rgRealFetch;
  });
  assert.match(painted.status, /harnesses ready on this host/, "the check must paint the host inventory it read");
  assert.ok(painted.rows > 0, "and render the harness rows");

  // THE SEAM, through the host's own path. __voiceboxOnTask writes lastHarnessOutput (the binding the host
  // kept) and calls renderHarnessChangedFiles (the callback the module returned). Both directions are
  // exercised by one call, and only the accessor PAIR can carry the value across.
  await page.evaluate(() => {
    const changed = document.getElementById("harness-changed-files");
    changed.hidden = true;
    window.__voiceboxOnTask({ output: "PROBE_TASK_OUTPUT", changedFiles: ["probe-changed-a.md"], agent: "probe", state: "running" });
  });
  // Wait for the observable, not for a delay: the task path paints through the RETURNED callback.
  const taskPaint = await page.waitFor(
    () => {
      const el = document.getElementById("harness-changed-files");
      const text = el?.textContent ?? "";
      return el && !el.hidden && /probe-changed-a\.md/.test(text) ? { hidden: el.hidden, text } : false;
    },
    { label: "the task path's changed files to be painted through the returned callback", timeout: 15000 },
  );
  // The save handler READS the pair first: `if (!getLastHarnessOutput()) return;`. A sentinel in the status line
  // makes that read observable, and the wait below is on the OBSERVABLE — the sentinel being replaced — not on a
  // fixed 600 ms: a stale snapshot would leave the sentinel untouched and this wait FAILS, which is the same
  // semantics as the explicit assertion it replaces.
  await page.evaluate(() => {
    window.__a8rgBodies = [];
    const realFetch = window.fetch;
    window.__a8rgRealFetchSave = realFetch;
    window.fetch = function bodySpy(input, init) {
      if (init?.body) window.__a8rgBodies.push(String(init.body));
      return realFetch.call(this, input, init);
    };
    document.getElementById("harness-loop-status").textContent = "PROBE_SENTINEL_BEFORE_SAVE";
    document.getElementById("harness-save-output").hidden = false;
    document.getElementById("harness-save-output").click();
  });
  const saveStatus = await page.waitFor(
    () => {
      const text = document.getElementById("harness-loop-status")?.textContent ?? "";
      return text !== "PROBE_SENTINEL_BEFORE_SAVE" ? text : false;
    },
    { label: "the save handler to get past its read of the pair (a stale snapshot would leave the sentinel untouched)", timeout: 20000 },
  );
  const saveRest = await page.evaluate(() => ({
    bodies: window.__a8rgBodies,
    changed: document.getElementById("harness-changed-files")?.textContent ?? "",
  }));
  await page.evaluate(() => {
    window.fetch = window.__a8rgRealFetchSave;
  });
  assert.equal(taskPaint.hidden, false, "the returned renderHarnessChangedFiles must paint the dialog's changed-files element");
  assert.match(taskPaint.text, /probe-changed-a\.md/, "with the file the task reported");
  assert.match(saveStatus, /Saved output to harness-analysis\.md|Could not save/, `the save must have been attempted against the value the host wrote: ${JSON.stringify(saveStatus)}`);
  if (saveRest.bodies.length > 0) {
    assert.ok(saveRest.bodies.some((b) => b.includes("PROBE_TASK_OUTPUT")), "when the save goes over HTTP the body must carry the value the host wrote into the pair");
  }
  if (/Saved output to harness-analysis\.md/.test(saveStatus)) {
    assert.match(saveRest.changed, /harness-analysis\.md/, "and a successful save renders the saved name through the returned callback");
  }

  // The miniAppController accessor must be LIVE: it is declared AFTER this surface in the host, so a snapshot
  // taken at init would be null and the tracker's mount would silently do nothing.
  await page.evaluate(() => window.__voiceboxOpenAgentTracker());
  const tracker = await page.waitFor(
    () => {
      const frame = document.querySelector('iframe#mini-app-outer-frame[src*="appId=agent-progress-tracker"]');
      return frame ? { src: frame.getAttribute("src") ?? "" } : false;
    },
    { label: "the agent tracker's mini-app to mount through the live controller", timeout: 20000 },
  );
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

// CONTROL for the waits above (voicebox-beads-a8rg). A wait that replaced a fixed delay must still FAIL CLOSED
// when the state genuinely never arrives — otherwise every false failure becomes a hung suite instead of a red
// one. This drives the same observable (the painted inventory) with an /api/harnesses response that NEVER
// settles, and requires the same `page.waitFor` primitive the arm above uses to reject, bounded.
// It runs last because it deliberately leaves the dialog's check disabled.
test("control: the same wait still FAILS when the inventory genuinely never resolves", async () => {
  await page.evaluate(() => {
    const realFetch = window.fetch;
    window.__a8rgRealFetchControl = realFetch;
    window.fetch = function neverResolvingFetch(input, init) {
      const url = typeof input === "string" ? input : input?.url ?? String(input);
      if (url.includes("/api/harnesses")) return new Promise(() => {});
      return realFetch.call(this, input, init);
    };
    const btn = document.getElementById("harnesses-check");
    btn.disabled = false;
    btn.click();
  });

  await assert.rejects(
    () =>
      page.waitFor(
        () => {
          const status = document.getElementById("harnesses-status")?.textContent ?? "";
          return /harnesses ready on this host/.test(status) ? status : false;
        },
        { label: "an inventory that genuinely never resolves", timeout: 2500 },
      ),
    /timed out waiting for an inventory that genuinely never resolves/,
    "the wait must reject rather than hang or pass: that is what keeps it a real assertion",
  );

  const state = await page.evaluate(() => ({
    status: document.getElementById("harnesses-status")?.textContent ?? "",
    disabled: document.getElementById("harnesses-check")?.disabled,
  }));
  assert.match(state.status, /Checking host programs|CONTROL/, "the control is honest: the check started and never completed");
  assert.equal(state.disabled, true, "and the button is still disabled, which is what a never-resolving check looks like");
  await page.evaluate(() => {
    window.fetch = window.__a8rgRealFetchControl;
  });
});
