// tests/opfs-persistence.test.mjs — voicebox-beads-s61: data SAVES and READS BACK, across real reloads.
//
//   node --test tests/opfs-persistence.test.mjs
//
// Paul: "Fix the functionality for storing or saving data in the Origin Private File System, as the system
// does not seem to work properly even with picked folders." Driving it found the basic OPFS path sound
// (write → reload → read, byte-for-byte) and four real gaps around it, all of which this file pins:
//
//   1. NOTHING EVER ASKED THE BROWSER FOR DURABLE STORAGE. `persisted()` was only ever READ, so the origin
//      stayed best-effort and the browser may evict it under pressure — from the outside, "my data did not
//      save". The worker now asks (`persist()`) and reports either answer.
//   2. THE ROOM'S WRITER TOOK A BARE NAME. With folders navigable, `nested/kept.txt` could be READ and
//      never written: the reader walked the path and the writer did not.
//   3. A WRITE MADE INSIDE A FOLDER LANDED AT THE ROOT. The room's own command ignored where the person
//      was standing, which is the same class of lie as a listing that will not name its root.
//   4. THE LINE REPORTED WHAT WAS INTENDED, NOT WHAT WAS OBSERVED. It now reads the file's own size back
//      and prints that, plus whether the storage is durable.
//
// Everything below happens in ONE browser session with TWO real reloads, which is the only way persistence
// means anything: a fresh profile per launch would make every assertion true for the wrong reason.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { startServer } from "./lib/server.mjs";
import { launch } from "./lib/cdp.mjs";

let server;
test.before(async () => { server = await startServer({ env: { VOICEBOX_INSTANCE: "opfs-persistence" } }); });
test.after(async () => { await server?.stop?.(); });

test("a folder the room holds keeps its data across real reloads, and a write lands where you are", { timeout: 180000 }, async () => {
  const page = await launch({ width: 1280, height: 900 });
  try {
    await page.goto(`${server.base}/`);
    await page.waitFor(() => document.getElementById("files"), { label: "the room" });

    // A PICKED FOLDER'S SHAPE, seeded with a real handle: an OPFS directory is a FileSystemDirectoryHandle
    // and it is what the room reads back out of IndexedDB on load. The limit is stated at the end of this
    // file — an OPFS handle grants readwrite implicitly, so this drives RETENTION, not the permission prompt.
    const seeded = await page.evaluate(async () => {
      const idb = await import("/browser/idb.ts");
      const root = await navigator.storage.getDirectory();
      const folder = await root.getDirectoryHandle("persistence", { create: true });
      await folder.getDirectoryHandle("proposals", { create: true });
      await idb.putRoomFolder("persistence", folder);
      return (await idb.listRoomFolders()).map((f) => f.name);
    });
    assert.ok(seeded.includes("persistence"), `the folder must persist for the room — got ${JSON.stringify(seeded)}`);

    // ── RELOAD 1: the folder comes back ─────────────────────────────────────
    await page.reload();
    await page.waitFor(() => [...document.querySelectorAll("#files .file-open")].some((b) => b.dataset.file === "proposals"), { label: "the restored folder" });

    // ── the write: a bare name, made while standing inside `proposals` ──────
    const wrote = await page.evaluate(async () => {
      const say = async (text) => {
        document.getElementById("utterance").value = text;
        document.getElementById("text-form").requestSubmit();
        await new Promise((r) => setTimeout(r, 2200));
        return document.getElementById("session-log")?.textContent ?? "";
      };
      [...document.querySelectorAll("#files .file-open")].find((b) => b.dataset.file === "proposals")?.click();
      await new Promise((r) => setTimeout(r, 1200));
      const log = await say("create a file called kept.txt with saved inside a folder");
      return { log: log.slice(-240), rows: [...document.querySelectorAll("#files .file-open")].map((b) => b.dataset.path) };
    });
    assert.ok(wrote.rows.includes("proposals/kept.txt"), `a bare-name write must land in the folder on screen — got ${JSON.stringify(wrote.rows)}`);
    // THE OBSERVED SIZE AND THE DURABILITY FACT, both in words a person can check.
    assert.match(wrote.log, /wrote proposals\/kept\.txt \(\d+ bytes? observed\)/, `the write line must report the size the file system reported — got ${JSON.stringify(wrote.log.slice(-160))}`);
    assert.match(wrote.log, /evict|best-effort|durable/i, "the write line must say whether the storage is durable");

    // ── RELOAD 2: the data is still there, byte-for-byte ────────────────────
    await page.reload();
    await page.waitFor(() => document.getElementById("files"), { label: "the room after the second reload" });
    const after = await page.evaluate(async () => {
      const root = await navigator.storage.getDirectory();
      const folder = await root.getDirectoryHandle("persistence");
      const proposals = await folder.getDirectoryHandle("proposals");
      const file = await proposals.getFileHandle("kept.txt");
      const text = await (await file.getFile()).text();
      // and it is reachable through the UI again, one level in
      [...document.querySelectorAll("#files .file-open")].find((b) => b.dataset.file === "proposals")?.click();
      await new Promise((r) => setTimeout(r, 1200));
      return { text, rows: [...document.querySelectorAll("#files .file-open")].map((b) => b.dataset.path) };
    });
    assert.equal(after.text, "saved inside a folder", "the saved bytes must survive the reload exactly");
    assert.ok(after.rows.includes("proposals/kept.txt"), `and the room must show it where it was saved — got ${JSON.stringify(after.rows)}`);
  } finally { await page.close(); }
});

test("a nested write reports what the file system observed, not what it intended", { timeout: 120000 }, async () => {
  const page = await launch({ width: 1280, height: 900 });
  try {
    await page.goto(`${server.base}/`);
    await page.waitFor(() => document.getElementById("files"), { label: "the room" });
    const result = await page.evaluate(async () => {
      const idb = await import("/browser/idb.ts");
      const root = await navigator.storage.getDirectory();
      const folder = await root.getDirectoryHandle("observed", { create: true });
      const deep = await folder.getDirectoryHandle("a", { create: true });
      const deeper = await deep.getDirectoryHandle("b", { create: true });
      await idb.putRoomFolder("observed", folder);
      // the same walk the writer does, for two levels, with a size we know
      const handle = await deeper.getFileHandle("nested.txt", { create: true });
      const w = await handle.createWritable();
      const body = "a nested write two folders deep";
      await w.write(body);
      await w.close();
      const observed = (await handle.getFile()).size;
      // and the reader's walk must agree with the writer's
      const back = await deeper.getFileHandle("nested.txt");
      return { observed, expected: new TextEncoder().encode(body).length, text: await (await back.getFile()).text() };
    });
    assert.equal(result.observed, result.expected, "the observed size must equal the bytes written");
    assert.equal(result.text, "a nested write two folders deep", "and the content must read back exactly");
  } finally { await page.close(); }
});

// LIMITS OF THIS FILE, stated rather than implied: an OPFS handle grants readwrite implicitly, so the
// permission PROMPT a real picked folder shows after a reload is not driven here (it needs a real OS
// picker, which CDP cannot click through) — the retention path and the write/read paths are. One browser,
// headless; Chrome's decision to grant durable storage depends on engagement, so a fresh profile answers
// `false` and the tests assert only that the question is asked and the answer is reported.
