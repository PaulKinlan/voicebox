// tests/room-delete.test.mjs — direct file deletion from the room, driven.
//
// voicebox-beads-g8y: "add a user interface for direct file deletion from the page. Needs
// confirmation + the deletion must go through the real storage path with an audit log entry."
//
// The room's file list had no delete at all. This drives the three states that matter, with real
// mouse and keyboard input against a real server and a real folder on disk:
//
//   · the control is offered for a FILE and not for a folder (no recursive delete in this bead);
//   · a confirmation names the file and the root it will be deleted from, and closing it without
//     an answer — the Keep button, Esc, or a click outside — KEEPS the file;
//   · only "Delete file" removes it, from the real folder, and the root's own audit records it.
//
//   node --test tests/room-delete.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { startServer } from "./lib/server.mjs";
import { launch } from "./lib/cdp.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let server;
let BASE;
let page;
let scratch;
let workspace;
let folder;

async function until(check, label, ms = 15000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const r = await check();
    if (r) return r;
    await sleep(50);
  }
  assert.fail(`no ${label} within ${ms}ms`);
}

const audit = () => fetch(`${BASE}/api/audit`).then((r) => r.json());

const dialogState = () =>
  page.evaluate(() => {
    const dialog = document.getElementById("delete-confirm");
    return {
      open: dialog.open,
      modal: dialog.matches(":modal"),
      what: document.getElementById("delete-confirm-what")?.textContent ?? "",
      where: document.getElementById("delete-confirm-where")?.textContent ?? "",
      activeInside: dialog.contains(document.activeElement),
    };
  });

const pressEscape = async () => {
  for (const type of ["keyDown", "keyUp"]) {
    await page.send("Input.dispatchKeyEvent", { type, key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  }
};

test.before(async () => {
  scratch = realpathSync(mkdtempSync(path.join(os.tmpdir(), "voicebox-room-delete-")));
  workspace = path.join(scratch, "root");
  folder = path.join(workspace, "notes");
  mkdirSync(folder, { recursive: true });
  writeFileSync(path.join(workspace, "keep.txt"), "kept\n");
  writeFileSync(path.join(workspace, "doomed.txt"), "delete me\n");

  server = await startServer({ cwd: ROOT, env: { VOICEBOX_WORKSPACE: workspace, VOICEBOX_INSTANCE: "room-delete" } });
  BASE = server.base;
  page = await launch();
  await page.goto(`${BASE}/`);
  await until(() => page.evaluate(() => document.querySelector('.file-open[data-file="doomed.txt"]') !== null), "the room to list doomed.txt");
});

test.after(async () => {
  await page?.close();
  await server?.stop();
  rmSync(scratch, { recursive: true, force: true });
});

test("a file row offers delete; a folder row does not", async () => {
  const hasDelete = await page.evaluate(() => document.querySelector('.file-delete[data-file="doomed.txt"]') !== null);
  assert.equal(hasDelete, true, "the file row has no delete control");
  const folderDelete = await page.evaluate(() => document.querySelector('.file-delete[data-file="notes"]') !== null);
  assert.equal(folderDelete, false, "a folder row offered deletion — this bead does not do recursive deletes");
});

test("the confirmation names the file and its root, and closing without an answer keeps it", { timeout: 90000 }, async () => {
  await page.click('.file-delete[data-file="doomed.txt"]');
  const opened = await dialogState();
  assert.equal(opened.open, true, "the confirmation did not open");
  assert.equal(opened.modal, true, "the confirmation is not a real modal");
  assert.match(opened.what, /doomed\.txt/, "the confirmation does not name the file");
  assert.match(opened.where, new RegExp(workspace.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "the confirmation does not name the root it will delete from");
  assert.equal(opened.activeInside, true, "focus is outside the dialog it just opened");

  // KEEP — the file survives.
  await page.click("#delete-confirm-no");
  await until(async () => (await dialogState()).open === false, "the confirmation to close");
  assert.equal(existsSync(path.join(workspace, "doomed.txt")), true, "the Keep button deleted the file");

  // ESC — an unanswered question is not a yes.
  await page.click('.file-delete[data-file="doomed.txt"]');
  await until(async () => (await dialogState()).open === true, "the confirmation to reopen");
  await pressEscape();
  await until(async () => (await dialogState()).open === false, "Escape to close the confirmation");
  assert.equal(existsSync(path.join(workspace, "doomed.txt")), true, "Escape deleted the file");
});

test("delete removes it from the real folder and the root's log records it", { timeout: 90000 }, async () => {
  await page.click('.file-delete[data-file="doomed.txt"]');
  await until(async () => (await dialogState()).open === true, "the confirmation to open");
  await page.click("#delete-confirm-yes");

  // DISK FIRST, then the row: the file leaving the folder is the outcome; the list catching up is a
  // second, slower fact (a fetch and a render). Under a loaded box the two can be 15s apart, and a
  // test that waits only on the UI would call a slow render a broken delete.
  await until(() => !existsSync(path.join(workspace, "doomed.txt")), "the file to leave the folder", 30000);
  await until(() => page.evaluate(() => document.querySelector('.file-open[data-file="doomed.txt"]') === null), "the row to leave the listing", 30000);
  assert.equal(existsSync(path.join(workspace, "keep.txt")), true, "another file was deleted with it");

  const log = await audit();
  const entry = (log.entries ?? []).find((e) => e.act?.kind === "delete" && e.act?.target === "doomed.txt");
  assert(entry, `the root's log has no delete entry: ${JSON.stringify((log.entries ?? []).map((e) => e.act))}`);
  assert.equal(entry.result, "ok", "the delete entry does not record a result");
});

test("a page-owned root: the room's delete ROUTES to the page that owns the file", { timeout: 120000 }, async () => {
  // The half that makes this feature real rather than a UI trick: the room writes through the server,
  // but an OPFS project is the page's to act on — so the delete must route to the page and the page's
  // own storage is the witness. (journal-omr's root probe and this bead share the page-side seam.)
  const owned = await startServer({ env: { VOICEBOX_INSTANCE: "room-delete-page" } });
  const envPage = await launch();
  let room;
  try {
    await envPage.goto(`${owned.base}/environment.html`);
    await envPage.waitFor(() => window.e1m0 !== undefined, { label: "the environment page's host API" });
    await envPage.evaluate(() => window.e1m0.ready);
    const opened = await envPage.evaluate(async () => await window.e1m0.send({ type: "openProject", name: "roomdel" }));
    assert.equal(opened.ok, true, JSON.stringify(opened));
    await envPage.evaluate(async () => await window.e1m0.create("pagedel.txt", "text", "the page owns this"));

    const declared = await fetch(`${owned.base}/api/root`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-voicebox-host-token": owned.hostToken },
      body: JSON.stringify({ project: "roomdel", root: { kind: "opfs", path: "v1/projects/roomdel" } }),
    }).then((r) => r.json());
    assert.equal(declared.ok, true, JSON.stringify(declared));
    assert.equal(declared.actsVia, "page", "the declared root must name the page as the executor");

    room = await launch();
    await room.goto(`${owned.base}/`);
    await until(() => room.evaluate(() => document.querySelector('.file-open[data-file="assets"]') !== null), "the room to list the project's assets folder");
    await room.click('.file-open[data-file="assets"]');
    await until(() => room.evaluate(() => document.querySelector('.file-delete[data-file="pagedel.txt"]') !== null), "the page-owned file's delete control");
    await room.click('.file-delete[data-file="pagedel.txt"]');
    await until(async () => room.evaluate(() => document.getElementById("delete-confirm").open === true), "the room's confirmation to open");
    await room.click("#delete-confirm-yes");
    await until(async () => (await envPage.evaluate(async () => await window.e1m0.send({ type: "readFile", path: "assets/pagedel.txt" }))).ok === false, "the page's file to be gone", 30000);
    await until(() => room.evaluate(() => document.querySelector('.file-open[data-file="pagedel.txt"]') === null), "the row to leave the room's list", 30000);

    // The PAGE's storage is the witness, not the room's report.
    const read = await envPage.evaluate(async () => await window.e1m0.send({ type: "readFile", path: "assets/pagedel.txt" }));
    assert.equal(read.ok, false, `the page still holds the file after the room deleted it: ${JSON.stringify(read)}`);
    const pageAudit = await envPage.evaluate(async () => await window.e1m0.send({ type: "audit" }));
    const entry = (pageAudit.entries ?? []).find((e) => e.act?.kind === "delete" && String(e.act?.target ?? "").endsWith("assets/pagedel.txt"));
    assert(entry, "the page-owned root's log has no delete entry");
  } finally {
    await room?.close();
    await envPage.close();
    await owned.stop();
  }
});
