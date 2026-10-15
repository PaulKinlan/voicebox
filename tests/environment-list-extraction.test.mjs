// tests/environment-list-extraction.test.mjs — the environment list lives in
// public/components/environment-list.mjs, not inline in public/fused.js (voicebox-beads-uei2.10).
//
// This is a renderer with almost no seam: it builds its own rows with document.createElement and attaches its
// own handlers to those created buttons, so it needs no element-wiring helper. What it DOES need is the two
// pieces of host state it reads, `roomFolder` and `activeRoot`, which the host REASSIGNS while the page lives
// — so they arrive as LIVE accessors, and this file proves that by changing them between renders.
//
// Every wait here is on the observable its assertion is about, bounded, and the file ends with a CONTROL that
// proves the wait still fails closed when the app never resolves (voicebox-beads-a8rg, the same class of bug).
// Measured before the assertions were written, rather than assumed:
//   * a click on a row's Re-probe button issues its POST /api/probe in the SAME TICK as the click;
//   * a listener-free clone of that button issues none, in the same tick or later;
//   * #envs-open issues its GET /api/environments through the function this module RETURNS, in the same tick.
// Owner suites keep driving the feature and are unchanged: tests/environment-list-ui.test.mjs (primary),
// tests/environment-integrated-ui.test.mjs, tests/env-create-project.test.mjs,
// tests/environment-root-dialog-extraction.test.mjs, tests/health-auth-browser.test.mjs, tests/modern-web-room.test.mjs.
//
// WHAT THIS SUITE DOES NOT CATCH (found by mutating the real files, and left documented rather than hidden):
//   * removing the refresh that follows a successful probe survives, because the list is ALSO auto-refreshed by
//     the module's own never-probed path, so "the list was re-rendered" cannot be attributed to the handler.
//     The probe's request count is still pinned exactly (one click, one POST, no clone), which is the seam this
//     file exists to guard.
// Mutants that ARE caught, each verified against the real files: the Re-probe listener unwired; the root labels
// swapped; the readout never painted; the host's #envs-open handler not reaching the returned renderer;
// a leftover inline copy; a dropped import; a snapshot instead of a live accessor; a dropped return.
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { startServer } from "./lib/server.mjs";
import { launch } from "./lib/cdp.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MODULE_PATH = path.join(ROOT, "public", "components", "environment-list.mjs");
const HOST_PATH = path.join(ROOT, "public", "fused.js");

// Distinctive strings from the moved block: gone from the host (a second copy would be a second wiring),
// present in the module.
const MOVED_MARKERS = ["env-reprobe-btn", "env-cap-list", "Re-probed ", "env-remove-btn"];

function seamOf(host) {
  const at = host.indexOf("const { renderEnvironments } = initEnvironmentList({");
  assert.ok(at > 0, "the seam must exist");
  return host.slice(at, host.indexOf("});", at) + 3);
}

function assertSeam(host, mod) {
  for (const marker of MOVED_MARKERS) {
    assert.ok(!host.includes(marker), `fused.js must no longer carry ${JSON.stringify(marker)}`);
    assert.ok(mod.includes(marker), `the extracted module must carry ${JSON.stringify(marker)}`);
  }
  assert.match(host, /import \{ initEnvironmentList \} from "\.\/components\/environment-list\.mjs";/, "the host imports the factory");
  assert.match(mod, /return \{ renderEnvironments \};/, "the factory must return the renderer the host calls");
  // Scoped to THIS seam: another extracted module also takes a `getRoomFolder` accessor, so a whole-file
  // `includes` would be satisfied by that one and this check would be vacuous.
  const seam = seamOf(host);
  for (const accessor of ["getRoomFolder: () => roomFolder,", "getActiveRoot: () => activeRoot,"]) {
    assert.ok(seam.includes(accessor), `this seam must hand over a LIVE accessor: ${accessor}`);
  }
  // The reason those are accessors rather than values, asserted as the invariant that actually matters: the
  // host reassigns both AFTER the seam, so a snapshot would be stale for every later render.
  const seamAt = host.indexOf("const { renderEnvironments } = initEnvironmentList({");
  assert.ok(seamAt > 0, "the seam must exist");
  // The reason those are accessors rather than values: both are host state that is assigned somewhere other
  // than its declaration, so the value present at the seam is not the value later renders need. For activeRoot
  // those assignment sites sit BEFORE the seam but inside functions that run later — which is exactly why a
  // snapshot taken at the seam would freeze `undefined` for the life of the page.
  const assignments = (name) => (host.match(new RegExp(`(?:^|[^.\\w$])${name}\\s*=[^=]`, "gm")) || []).length;
  assert.ok(assignments("roomFolder") >= 2, `the host assigns roomFolder more than once (declaration plus reassignment): saw ${assignments("roomFolder")}`);
  assert.ok(assignments("activeRoot") >= 2, `the host assigns activeRoot more than once (declaration plus reassignment): saw ${assignments("activeRoot")}`);
  // All four outward call sites still reach the returned function.
  assert.equal((host.match(/(?:await |void )renderEnvironments\(\);/g) || []).length, 4, "the four places outside the list still call it");
}

test("the list is in the module, gone from the host, and the host keeps the live accessors the reassigned state needs", () => {
  const host = readFileSync(HOST_PATH, "utf8");
  const mod = readFileSync(MODULE_PATH, "utf8");
  assertSeam(host, mod);

  // Every mutant below is SCOPED to the seam block (or to the module) so that an unrelated module using the
  // same idiom cannot make a mutant look caught, or make a real one look fine.
  const mutated = (replace) => {
    const seam = seamOf(host);
    const next = replace(seam);
    assert.notEqual(next, seam, "the mutant must actually change the seam");
    return host.replace(seam, next);
  };
  const leftover = mutated((seam) => `${seam}\n// leftover marker: env-reprobe-btn`);
  assert.throws(() => assertSeam(leftover, mod), { name: "AssertionError" }, "a leftover inline copy must be caught");

  const noImport = host.replace(/import \{ initEnvironmentList \} from "\.\/components\/environment-list\.mjs";\n/, "");
  assert.notEqual(noImport, host);
  assert.throws(() => assertSeam(noImport, mod), { name: "AssertionError" }, "a dropped import must be caught");

  const snapshotRoom = mutated((seam) => seam.replace("getRoomFolder: () => roomFolder,", "getRoomFolder: roomFolder,"));
  assert.throws(() => assertSeam(snapshotRoom, mod), { name: "AssertionError" }, "a snapshot instead of a live accessor must be caught");

  const snapshotRoot = mutated((seam) => seam.replace("getActiveRoot: () => activeRoot,", "getActiveRoot: activeRoot,"));
  assert.throws(() => assertSeam(snapshotRoot, mod), { name: "AssertionError" }, "and for the active root");

  const noReturn = mod.replace("return { renderEnvironments };", "return {};");
  assert.notEqual(noReturn, mod);
  assert.throws(() => assertSeam(host, noReturn), { name: "AssertionError" }, "a dropped return must be caught");
});

let server;
let base;
let page;

test.before(async () => {
  server = await startServer({ cwd: ROOT, env: { VOICEBOX_INSTANCE: "environment-list-extraction-test" } });
  base = server.base;
  page = await launch();
  await page.goto(`${base}/`);
  // Wait for the LIST, not for a fixed delay: the boot health poll is what renders it through the returned
  // function, so a row appearing is itself evidence that the seam works.
  await page.waitFor(
    () => (document.querySelectorAll("#env-list .env-item").length > 0 ? document.querySelectorAll("#env-list .env-item").length : false),
    { label: "the environments list to render through the returned renderer", timeout: 20000 },
  );
});

test.after(async () => {
  await page?.close();
  await server?.stop();
});

test("on the real page: the rows and the root readout render, Re-probe is wired once (a clone is wired never), and the host's own trigger reaches the returned renderer", async () => {
  const readout = await page.evaluate(() => document.getElementById("env-active-root-val")?.textContent ?? "");
  assert.match(readout, /no folder chosen yet|browser storage · |picked folder · |machine folder · /, `the root readout must paint one of its named states: ${JSON.stringify(readout)}`);

  const counted = await page.evaluate(() => {
    const realFetch = window.fetch;
    window.__envProbeRealFetch = realFetch;
    window.__envProbeCalls = [];
    window.fetch = function countingFetch(input, init) {
      const url = typeof input === "string" ? input : input?.url ?? String(input);
      window.__envProbeCalls.push(`${init?.method ?? "GET"} ${url}`);
      return realFetch.call(this, input, init);
    };
    const count = (want) => window.__envProbeCalls.filter((c) => c === want).length;
    const btn = document.querySelector("#env-list .env-reprobe-btn");
    const clone = btn.cloneNode(true);
    window.__envProbeClone = clone;
    // The row the probe's own refresh replaces: holding this reference IS the observable the wait below uses,
    // because a re-render calls envList.replaceChildren(). The confirmation NOTE the handler writes is NOT a
    // usable observable — measured, it is painted and then cleared 4 ms later by that same refresh.
    window.__envFirstRow = document.querySelector("#env-list .env-item");
    btn.parentElement.appendChild(clone);
    window.__envProbeCalls.length = 0;
    // Clone FIRST, then the real button: both counts are read in the same tick as the click, which is valid
    // because the handler issues its request synchronously (measured). A clone whose wiring came from a
    // delegated parent rather than the element would show up here; this one must show nothing.
    clone.click();
    const cloneProbe = count("POST /api/probe");
    btn.click();
    const realProbe = count("POST /api/probe");
    return { cloneProbe, realProbe };
  });
  assert.equal(counted.cloneProbe, 0, "a listener-free clone of the Re-probe button must issue no probe");
  assert.equal(counted.realProbe, 1, "one click on Re-probe must be exactly one POST /api/probe — two would mean a double wiring");

  // Wait for the observable the click produces — the list being re-rendered — and then require the count to
  // still be one. This is the auto-probe-safe part of the claim: it says A refresh happened after the click
  // (the module's own refresh or its never-probed path), not specifically the handler's, which is why the
  // handler's refresh is listed in this file's header as a known blind spot rather than asserted here.
  await page.waitFor(
    () => {
      const row = document.querySelector("#env-list .env-item");
      return row && row !== window.__envFirstRow ? true : false;
    },
    { label: "the list to be re-rendered after the probe", timeout: 30000 },
  );
  const afterProbe = await page.evaluate(() => window.__envProbeCalls.filter((c) => c === "POST /api/probe").length);
  assert.equal(afterProbe, 1, "the probe's own refresh must not re-probe");

  // THE OUTWARD SEAM: #envs-open is the host's handler, and it calls the function this module returns.
  const outward = await page.evaluate(() => {
    window.__envProbeCalls.length = 0;
    document.getElementById("envs-open").click();
    return window.__envProbeCalls.filter((c) => c === "GET /api/environments").length;
  });
  assert.equal(outward, 1, "opening the Environments dialog must read the list exactly once, through the returned renderer");
  await page.waitFor(() => document.getElementById("envs")?.open === true, { label: "the Environments dialog to open", timeout: 15000 });
  const outwardAfter = await page.evaluate(() => {
    const n = window.__envProbeCalls.filter((c) => c === "GET /api/environments").length;
    window.__envProbeClone.remove();
    window.fetch = window.__envProbeRealFetch;
    return n;
  });
  assert.equal(outwardAfter, 1, "and still exactly once after it settled");
});

test("standalone with spies: the root facts are LIVE accessors, and the readout tracks all three named states", async () => {
  const result = await page.evaluate(async () => {
    const { initEnvironmentList } = await import("/components/environment-list.mjs");
    const els = { envActiveRootVal: document.createElement("div"), envList: document.createElement("div"), envCount: document.createElement("div"), envNote: document.createElement("div") };
    const state = { roomFolder: null, activeRoot: null };
    const requested = [];
    const controller = initEnvironmentList({
      els,
      request: async (url) => { requested.push(url); return { ok: true, entries: [] }; },
      SCRATCHPAD_NAME: "scratchpad",
      getRoomFolder: () => state.roomFolder,
      getActiveRoot: () => state.activeRoot,
    });
    const read = () => els.envActiveRootVal.textContent;
    const renders = [];

    state.roomFolder = { name: "probe-picked" };
    state.activeRoot = { root: { path: "/probe/path" } };
    await controller.renderEnvironments();
    renders.push({ label: "a picked folder wins over the root", text: read() });

    // The SAME controller, same call, different host state: a snapshot would repeat the first answer.
    state.roomFolder = { name: "scratchpad" };
    await controller.renderEnvironments();
    renders.push({ label: "the browser-storage scratchpad is named as such", text: read() });

    state.roomFolder = null;
    state.activeRoot = null;
    await controller.renderEnvironments();
    renders.push({ label: "no root chosen", text: read() });

    state.activeRoot = { root: { path: "/probe/machine", kind: "machine" }, facts: { where: "elsewhere" } };
    await controller.renderEnvironments();
    renders.push({ label: "a root with no folder open", text: read() });

    // Deliberate non-paint: activeRoot is `undefined` while the host has not asked yet ("not asked yet, say so,
    // do not invent one" in the host). The renderer leaves the readout alone rather than claiming a state.
    state.activeRoot = undefined;
    await controller.renderEnvironments();
    renders.push({ label: "a root the host has not asked about yet", text: read() });

    return { renders, requested, keys: Object.keys(controller) };
  });

  assert.deepEqual(result.keys, ["renderEnvironments"], "the factory returns exactly the one function the host calls");
  const byLabel = Object.fromEntries(result.renders.map((r) => [r.label, r.text]));
  assert.equal(byLabel["a picked folder wins over the root"], "picked folder · probe-picked", "an open folder is named as a picked folder");
  assert.equal(byLabel["the browser-storage scratchpad is named as such"], "browser storage · scratchpad", "and the scratchpad is named as browser storage, not as a picked folder");
  assert.equal(byLabel["no root chosen"], "no folder chosen yet", "an explicitly null root is named as no choice");
  assert.equal(byLabel["a root with no folder open"], "machine folder · /probe/machine", "and a root with no folder open is named by its kind and path");
  assert.equal(byLabel["a root the host has not asked about yet"], byLabel["a root with no folder open"], "an un-asked-for root leaves the readout as it was, rather than inventing a state");
  // Liveness, stated as evidence: the same call produced four different answers because the accessors were read
  // each time. A snapshot of either fact would have repeated the first answer for the rest of these renders.
  assert.equal(new Set(result.renders.map((r) => r.text)).size, 4, "the four painted renders must differ: that is the accessors being live, not captured");
  assert.equal(result.requested.length, 5, "each render reads the list exactly once");
  assert.ok(result.requested.every((u) => u === "/api/environments"), "and reads it from the one source");
});

// CONTROL (voicebox-beads-a8rg, applied here before it can bite): the waits above replaced nothing, but they
// must still FAIL CLOSED. This drives the same observable — a row appearing — with an /api/environments
// response that never settles, and requires the same page.waitFor primitive to reject, bounded.
test("control: the same wait still FAILS when the environment list genuinely never resolves", async () => {
  await page.evaluate(() => {
    const realFetch = window.fetch;
    window.__envProbeRealFetchControl = realFetch;
    window.fetch = function neverResolvingFetch(input, init) {
      const url = typeof input === "string" ? input : input?.url ?? String(input);
      if (url.includes("/api/environments")) return new Promise(() => {});
      return realFetch.call(this, input, init);
    };
    // Empty the list first, so "a row appears" is an honest observable for the NEXT render rather than
    // something the boot render already satisfied.
    document.getElementById("env-list").replaceChildren();
    if (document.getElementById("envs")?.open) document.getElementById("envs").close();
    document.getElementById("envs-open").click();
  });

  await assert.rejects(
    () =>
      page.waitFor(
        () => (document.querySelectorAll("#env-list .env-item").length > 0 ? true : false),
        { label: "an environment list that genuinely never resolves", timeout: 2500 },
      ),
    /timed out waiting for an environment list that genuinely never resolves/,
    "the wait must reject rather than hang or pass: that is what keeps it a real assertion",
  );

  const state = await page.evaluate(() => {
    window.fetch = window.__envProbeRealFetchControl;
    return { rows: document.querySelectorAll("#env-list .env-item").length };
  });
  assert.equal(state.rows, 0, "the control is honest: the list is still empty because the read never resolved");
});
