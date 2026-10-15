// tests/environment-list-confirmation.test.mjs — a successful row action must leave its confirmation
// readable (voicebox-beads-2qxi).
//
// REPRODUCED on main before the fix, in a real browser: the Re-probe handler wrote
// "Re-probed this machine: voicebox." and then awaited renderEnvironments(), whose own first statement clears
// `#env-note` — so the confirmation existed for one paint. A MutationObserver on the element recorded the
// paint at 1213 ms and the clear at 1217 ms (voicebox-beads-2qxi holds that trace). Remove's
// "Removed '…'." has the same ordering and the same fate.
//
// The error paths never had this problem: they write their note AFTER the render, past the clear. This file
// pins that ordering for the success paths by asserting the confirmation is still on the page once the
// refresh it triggers has visibly happened — the rows being replaced is the observable, so nothing here waits
// for a duration (voicebox-beads-a8rg).
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "./lib/server.mjs";
import { launch } from "./lib/cdp.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let server;
let base;
let page;

test.before(async () => {
  server = await startServer({ cwd: ROOT, env: { VOICEBOX_INSTANCE: "environment-list-confirmation-test" } });
  base = server.base;
  page = await launch();
  await page.goto(`${base}/`);
  await page.waitFor(
    () => (document.querySelectorAll("#env-list .env-item").length > 0 ? true : false),
    { label: "the environments list to render", timeout: 20000 },
  );
});

test.after(async () => {
  await page?.close();
  await server?.stop();
});

test("a successful Re-probe leaves its confirmation readable after the refresh it triggers", async () => {
  // The declared env is not involved yet: the local row is the one carrying Re-probe.
  const armed = await page.evaluate(() => {
    window.__noteRow = document.querySelector("#env-list .env-item");
    window.__noteBtn = document.querySelector("#env-list .env-reprobe-btn");
    return Boolean(window.__noteBtn);
  });
  assert.ok(armed, "the local row carries a Re-probe control");

  await page.evaluate(() => window.__noteBtn.click());
  // The observable: the refresh replaced the rows. Not a duration — and note that this wait succeeds on an
  // unfixed build too, because the refresh itself is what happens; the assertion below is what fails.
  await page.waitFor(
    () => {
      const row = document.querySelector("#env-list .env-item");
      return row && row !== window.__noteRow ? true : false;
    },
    { label: "the re-probe's refresh to re-render the list", timeout: 30000 },
  );

  const note = await page.evaluate(() => document.getElementById("env-note")?.textContent ?? "");
  assert.match(
    note,
    /Re-probed/,
    `the confirmation must survive the refresh it triggers; an unfixed build clears it inside renderEnvironments() and leaves the note empty here. Saw ${JSON.stringify(note)}`,
  );
});

test("a successful Remove leaves its confirmation readable after the refresh it triggers", async () => {
  // Declare a stopped host so its row carries Remove (the local row carries Re-probe instead).
  await page.evaluate(() => {
    document.getElementById("env-add-label").value = "confirmation probe box";
    document.getElementById("env-add-origin").value = "http://127.0.0.1:9";
    document.getElementById("env-add-btn").click();
  });
  await page.waitFor(
    () => {
      const row = [...document.querySelectorAll("#env-list .env-item")].find(
        (r) => r.querySelector(".env-label")?.textContent === "confirmation probe box",
      );
      const remove = row?.querySelector(".env-remove-btn");
      if (remove) {
        window.__removeBtn = remove;
        return true;
      }
      return false;
    },
    { label: "the declared host's row to carry a Remove control", timeout: 30000 },
  );

  await page.evaluate(() => window.__removeBtn.click());
  // The observable: the removal's refresh dropped the row.
  await page.waitFor(
    () =>
      [...document.querySelectorAll("#env-list .env-item")].some(
        (r) => r.querySelector(".env-label")?.textContent === "confirmation probe box",
      )
        ? false
        : true,
    { label: "the removal's refresh to drop the declared host's row", timeout: 30000 },
  );

  const note = await page.evaluate(() => document.getElementById("env-note")?.textContent ?? "");
  assert.match(
    note,
    /Removed/,
    `the removal confirmation must survive its refresh too. Saw ${JSON.stringify(note)}`,
  );
});
