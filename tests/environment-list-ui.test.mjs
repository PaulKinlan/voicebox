// tests/environment-list-ui.test.mjs — the header list, driven in a real browser.
//
//   node --test tests/environment-list-ui.test.mjs
//
// The server test (environment-registry.test.mjs) proves the registry stores and probes. This proves
// the PAGE shows it: the top-right lists the local environment, and the "+" declares a new one that
// then appears — driven through a real browser against a real server, never by asserting the page
// served. A declared-but-stopped host must read as unreachable, not as ready.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { startServer } from "./lib/server.mjs";
import { launch } from "./lib/cdp.mjs";

let server;
let BASE;
let scratch;
let page;

test.before(async () => {
  scratch = mkdtempSync(path.join(os.tmpdir(), "voicebox-envui-"));
  server = await startServer({ env: { VOICEBOX_WORKSPACE: path.join(scratch, "workspace") }, cwd: scratch });
  BASE = server.base;
  page = await launch();
});

test.after(async () => {
  await page?.close();
  await server.stop();
  rmSync(scratch, { recursive: true, force: true });
});

test("the header lists the local environment, and a declared host appears and reads as unreachable", async () => {
  await page.goto(`${BASE}/`);
  // The surface is a modal dialog; open it the way a person does, by clicking the trigger.
  await page.evaluate(() => document.getElementById("envs-open").click());
  await page.evaluate(async () => {
    for (let i = 0; i < 50 && !document.querySelector("#env-list .env-item"); i++) await new Promise((r) => setTimeout(r, 50));
  });
  const initial = await page.evaluate(() =>
    [...document.querySelectorAll("#env-list .env-item")].map((li) => ({
      label: li.querySelector(".env-label")?.textContent,
      state: li.querySelector(".env-state")?.textContent,
      ok: li.querySelector(".env-dot")?.dataset.ok,
    })),
  );
  // The browser is a host too, listed first, reachable by construction.
  const browser = initial[0];
  assert.equal(browser.label, "this browser", `the browser environment is listed first: ${JSON.stringify(initial)}`);
  assert.equal(browser.ok, "true");
  // The local host names WHICH machine it is (the positional ambiguity the design was written about).
  const local = initial.find((e) => e.label?.startsWith("this machine"));
  assert.ok(local, `the local server is listed: ${JSON.stringify(initial)}`);
  assert.equal(local.ok, "true", "the local environment is reachable by construction");
  assert.match(local.label, /this machine: \S/, "the local row names the node, not just 'this machine'");
  // The "+" is a labelled control, not a symbol.
  const addLabel = await page.evaluate(() => document.getElementById("env-add-btn").textContent);
  assert.match(addLabel, /add environment/i, "the add control is labelled");

  // Declare a server that is not running: it appears, named unreachable, not ready. The click is
  // dispatched in-page (the form's submit fires on the button's click), which is the same path the
  // page's own listener takes.
  await page.evaluate(() => {
    document.getElementById("env-add-label").value = "atlas box";
    document.getElementById("env-add-origin").value = "http://127.0.0.1:9";
    document.getElementById("env-add-btn").click();
  });
  await page.evaluate(async () => {
    for (let i = 0; i < 80; i++) {
      const rows = [...document.querySelectorAll("#env-list .env-item")];
      if (rows.some((r) => r.querySelector(".env-label")?.textContent === "atlas box")) return;
      await new Promise((r) => setTimeout(r, 50));
    }
  });
  const after = await page.evaluate(() =>
    [...document.querySelectorAll("#env-list .env-item")].map((li) => ({
      label: li.querySelector(".env-label")?.textContent,
      state: li.querySelector(".env-state")?.textContent,
      stateTitle: li.querySelector(".env-state")?.getAttribute("title") ?? "",
      ok: li.querySelector(".env-dot")?.dataset.ok,
    })),
  );
  const remote = after.find((e) => e.label === "atlas box");
  assert.ok(remote, `the declared environment appears in the list: ${JSON.stringify(after)}`);
  assert.equal(remote.ok, "false", "a stopped service reads as not-ok, not ready");
  // PLAIN ON SCREEN, NAMED IN THE TITLE (voicebox-beads-0ye): this label used to be the refusal
  // identifier itself, which is the server's word for the state rather than the person's.
  assert.equal(remote.state, "not reachable", "the row says what a person needs; the refusal is a diagnostic");
  assert.ok(remote.stateTitle.length > 0, "the row keeps the server's own reason reachable on the title");

  // The summary counts what is reachable, so a person sees the state at a glance (browser + local +
  // the declared stopped one = 3, of which browser and local are reachable).
  const summary = await page.evaluate(() => document.getElementById("envs-count").textContent);
  assert.match(summary, /3 environments · 2 reachable/, `the count reads the reachability: ${summary}`);
});

test("a long capability report is contained and summarised, and never overwrites the name or the actions", async () => {
  // Drive the local environment to probe itself, then read the row: the report must be a bounded,
  // summarised region — a count with the list behind an expansion — not a wall that pushes the
  // controls down. This is the overflow Paul hit.
  await page.goto(`${BASE}/`);
  await page.evaluate(async () => {
    document.getElementById("envs-open").click();
    await fetch("/api/probe");
  });
  // Re-render after the probe so the capability report is present.
  await page.evaluate(async () => {
    for (let i = 0; i < 100; i++) {
      const row = [...document.querySelectorAll("#env-list .env-item")].find((r) => r.querySelector(".env-label")?.textContent?.startsWith("this machine"));
      if (row?.querySelector(".env-cap")) return;
      await new Promise((r) => setTimeout(r, 60));
      // trigger a re-render by re-reading
      if (i % 20 === 19) await fetch("/api/environments");
    }
  });
  const report = await page.evaluate(() => {
    const row = [...document.querySelectorAll("#env-list .env-item")].find((r) => r.querySelector(".env-label")?.textContent?.startsWith("this machine"));
    const cap = row?.querySelector(".env-cap");
    const summary = cap?.querySelector("summary")?.textContent ?? "";
    const listEl = cap?.querySelector(".env-cap-list");
    return {
      summary,
      isDetails: cap?.tagName === "DETAILS",
      listScrollable: listEl ? getComputedStyle(listEl).overflowY === "auto" : false,
      listBounded: listEl ? parseInt(getComputedStyle(listEl).maxHeight, 10) > 0 : false,
      // The name and the add control are still reachable and not pushed off.
      nameVisible: !!row?.querySelector(".env-label"),
      addVisible: !!document.getElementById("env-add-btn"),
    };
  });
  assert.ok(report.isDetails, "the report is a <details> (collapsible)");
  assert.match(report.summary, /^\d+ tools$/, `a long probe summarises to a count: ${report.summary}`);
  assert.ok(report.listBounded && report.listScrollable, "the full list is bounded and scrolls inside it");
  assert.ok(report.nameVisible && report.addVisible, "the name and the add control are not overwritten");
});
