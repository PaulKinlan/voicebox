// tests/explorer-delete.test.mjs — deleting a file from the environment page's explorer.
//
// voicebox-beads-g8y, the second surface: the three-root explorer listed files but offered no
// delete, while the asset gallery already had delete + a confirmation gate + audit. This reuses
// that pattern for an ARBITRARY path, which is what a browser-stored project needs: the server may
// have no root declared at all (the fqq path), so the page's own storage adapter must do the work.
//
// Driven end to end in a real browser: a real OPFS project, real clicks through the explorer's
// directory rows, the page's own confirmation gate, and the root's own audit as the witness.
//
//   node --test tests/explorer-delete.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { startServer } from "./lib/server.mjs";
import { launch } from "./lib/cdp.mjs";

let server;
let BASE;
let page;

async function until(check, label, ms = 20000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const r = await check();
    if (r) return r;
    await sleep(50);
  }
  assert.fail(`no ${label} within ${ms}ms`);
}

const send = (message) => page.evaluate((m) => window.e1m0.send(m), message);

const gateState = () =>
  page.evaluate(() => {
    const dialog = document.getElementById("confirm");
    return { open: dialog.open, plan: document.getElementById("confirm-plan")?.textContent ?? "" };
  });

const GONE = "projects/explorer-del/assets/gone.txt";

test.before(async () => {
  server = await startServer({ env: { VOICEBOX_INSTANCE: "explorer-delete" } });
  BASE = server.base;
  page = await launch();
  await page.goto(`${BASE}/environment.html`);
  await page.waitFor(() => window.e1m0 !== undefined, { label: "the page's host API" });
  await page.evaluate(() => window.e1m0.ready);
});

test.after(async () => {
  await page?.close();
  await server?.stop();
});

test("the explorer deletes a file through the confirmation gate, and the root's log records it", { timeout: 120000 }, async () => {
  const opened = await send({ type: "openProject", name: "explorer-del" });
  assert.equal(opened.ok, true, JSON.stringify(opened));
  const created = await page.evaluate(async () => await window.e1m0.create("gone.txt", "text", "delete me"));
  assert.equal(created.ok, true, JSON.stringify(created));

  // Walk the explorer the way a person does: origin storage → projects → this project → assets.
  await page.evaluate(async () => await window.e1m0.renderView("opfs"));
  await until(() => page.evaluate(() => document.querySelector('li[data-path="projects"]') !== null), "the projects row");
  await page.click('li[data-path="projects"]');
  await until(() => page.evaluate(() => document.querySelector('li[data-path="projects/explorer-del"]') !== null), "the project row");
  await page.click('li[data-path="projects/explorer-del"]');
  await until(() => page.evaluate(() => document.querySelector('li[data-path="projects/explorer-del/assets"]') !== null), "the assets row");
  await page.click('li[data-path="projects/explorer-del/assets"]');
  await until(() => page.evaluate((p) => document.querySelector(`.entry-delete[data-path="${p}"]`) !== null, GONE), "the file row's delete control");
  // A dotfile is shown here but the verbs refuse it by name — no control, no promise.
  const dotfileControl = await page.evaluate((p) => document.querySelector(`.entry-delete[data-path="${p}"]`) !== null, "projects/explorer-del/assets/.keep");
  assert.equal(dotfileControl, false, "a dotfile was offered a delete control the loop would refuse");

  // 1. DECLINED: the gate names the file, and No keeps it.
  await page.click(`.entry-delete[data-path="${GONE}"]`);
  const gate = await until(async () => {
    const state = await gateState();
    return state.open ? state : null;
  }, "the confirmation gate to open");
  assert.match(gate.plan, /gone\.txt/, "the gate does not name the file it is about");
  await page.click("#confirm-no");
  await until(async () => (await gateState()).open === false, "the gate to close");
  const kept = await send({ type: "readFile", path: "assets/gone.txt" });
  assert.equal(kept.ok, true, "the declined gate deleted the file anyway");

  // 2. APPROVED: the file leaves the real storage and the log records the act.
  await page.click(`.entry-delete[data-path="${GONE}"]`);
  await until(async () => (await gateState()).open === true, "the gate to reopen");
  await page.click("#confirm-yes");
  await until(async () => (await send({ type: "readFile", path: "assets/gone.txt" })).ok === false, "the file to be gone from storage");

  const audit = await send({ type: "audit" });
  const entry = (audit.entries ?? []).find((e) => e.act?.kind === "delete" && String(e.act?.target ?? "").endsWith("assets/gone.txt") && e.result === "ok");
  assert(entry, `the root's log has no successful delete entry: ${JSON.stringify((audit.entries ?? []).map((e) => [e.act?.kind, e.act?.target, e.result]))}`);
});
