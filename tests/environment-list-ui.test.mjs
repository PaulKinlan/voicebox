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
  // The list is collapsed behind a summary; open it and read what it shows.
  await page.evaluate(() => document.getElementById("envs").setAttribute("open", ""));
  // Wait for the probe-backed render: the local row is always present and reachable.
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
  const local = initial.find((e) => e.label === "this machine");
  assert.ok(local, `the local server is listed: ${JSON.stringify(initial)}`);
  assert.equal(local.ok, "true", "the local environment is reachable by construction");

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
      ok: li.querySelector(".env-dot")?.dataset.ok,
    })),
  );
  const remote = after.find((e) => e.label === "atlas box");
  assert.ok(remote, `the declared environment appears in the list: ${JSON.stringify(after)}`);
  assert.equal(remote.ok, "false", "a stopped service reads as not-ok, not ready");
  assert.match(remote.state, /unreachable/i, "the row names the refusal, not a blank");

  // The summary counts what is reachable, so a person sees the state at a glance.
  const summary = await page.evaluate(() => document.getElementById("envs-count").textContent);
  assert.match(summary, /2 environments · 1 reachable/, `the count reads the reachability: ${summary}`);
});
