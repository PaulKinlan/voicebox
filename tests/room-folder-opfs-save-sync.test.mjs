// tests/room-folder-opfs-save-sync.test.mjs — the ROOM-FOLDER save call site, driven for real (voicebox-beads-7ubj).
//
//   node --test tests/room-folder-opfs-save-sync.test.mjs
//
// WHY THIS FILE EXISTS. `saveEditedFile()` in public/fused.js has ONE body shared by TWO call sites:
//
//   · `if (roomFolder) { … writeRoomFile(shownFile, content); syncMiniAppAfterFileSave(shownFile, content); }`
//   · the machine-root path below it (`PUT /api/file`, then `syncMiniAppAfterFileSave(shownFile, content)`)
//
// tests/room-folder-save-sync.test.mjs (voicebox-beads-543c) drives the SECOND one: its fixture declares a
// MACHINE root, so the save goes over `PUT /api/file` and `roomFolder` is null the whole way. gate-recover
// said so plainly while confirming the 4c1441b union, and this bead is its residual: everything the dropped
// source pins claimed about the BODY is still proven, but the room-folder CALL SITE was proven only
// indirectly — by reading the source — which cannot see whether the room-folder path calls the sync at all.
//
// So this arm walks the OTHER branch, and it does it harder than the machine-root arm could: the file is
// NESTED (`sub/nested.html`) inside a room folder the page itself opened from OPFS, reached through the
// room's own listing and saved with the room's own button. The nested shown path is the whole point — it is
// the input that the m4no defect used to send on the wire, so the leaf-only body assertion below is a claim
// about a path that genuinely has a directory in it.
//
// The request asserted is the one that LEFT THE BROWSER (`Network.requestWillBeSent`), not a page-side
// story about what it meant to send. No source pin, no fixture string standing in for the behaviour, and
// the mutation that turns this file RED is deleting the room-folder `syncMiniAppAfterFileSave(...)` call:
// the save still succeeds, the file is still written, and nothing is ever posted.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { startServer } from "./lib/server.mjs";
import { launch } from "./lib/cdp.mjs";

/** The nested shown path: a directory in it, so a leaf-only body is a real claim rather than a coincidence. */
const SHOWN = "sub/nested.html";
const LEAF = "nested.html";
const NESTED_V1 = "<!doctype html><p>nested v1</p>";
const NESTED_V2 = "<!doctype html><p>nested v2 — edited through the room's own editor</p>";

/** A bounded wait for a CDP-side observable (the page cannot answer for events the browser sent). */
async function until(fn, label, ms = 10000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

test("a room-folder save posts the LEAF name of a NESTED file, and the shown path never reaches the body (voicebox-beads-7ubj)", { timeout: 120000 }, async (t) => {
  const scratch = mkdtempSync(path.join(os.tmpdir(), "voicebox-room-opfs-save-"));
  const root = path.join(scratch, "root");
  mkdirSync(root, { recursive: true });
  writeFileSync(path.join(root, "notes.txt"), "a note\n", "utf8");

  // The workspace gives the page a room to be in; the ROOM FOLDER is the OPFS one this arm opens, so no
  // `/api/root` declaration is used here at all — that is what makes this the room-folder branch.
  const server = await startServer({ env: { VOICEBOX_INSTANCE: "room-opfs-save", VOICEBOX_WORKSPACE: root } });
  t.after(async () => {
    await server.stop();
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const page = await launch({ width: 1280, height: 900 });
  t.after(() => page.close());
  await page.send("Network.enable");
  await page.send("Runtime.enable");
  await page.goto(`${server.base}/`);
  await page.waitFor(() => document.querySelector(".file-open[data-file='notes.txt']") !== null, {
    label: "the room's listing to paint",
  });

  /** Click a control only once it can do its job: the wait is on the thing being acted on, not on a neighbour. */
  async function clickWhenEnabled(selector) {
    await page.waitFor(
      (sel) => {
        const el = document.querySelector(sel);
        return Boolean(el) && !el.disabled && !el.hidden;
      },
      { label: `${selector} to be enabled`, args: [selector] },
    );
    await page.click(selector);
  }

  /**
   * Everything the page knows about the save, so that a failure NAMES its cause instead of only timing out.
   * The first run of this arm timed out waiting for the POST and said nothing about why: the app reports a
   * refused or failed save in its own facts line and console, and neither was being captured. Ids are read
   * defensively and the visible text is included as the fallback, because the point is to learn the cause
   * from the next run rather than to guess at it now.
   */
  async function saveState() {
    return await page.evaluate(() => {
      // THE REAL IDS, read out of the app's own els map after the first capture guessed two that do not
      // exist and returned null for exactly the two fields that matter: readerFacts -> "file-facts",
      // report -> "turn-report" (voicebox-beads-7ubj).
      const text = (id) => document.getElementById(id)?.textContent ?? null;
      return {
        fileFacts: text("file-facts"),
        turnReport: text("turn-report"),
        activityTop: text("activity-list") ?? text("activity") ?? null,
        saveText: text("file-save"),
        saveDisabled: document.getElementById("file-save")?.disabled ?? null,
        saveHidden: document.getElementById("file-save")?.hidden ?? null,
        editing: document.getElementById("reader")?.dataset.editing ?? null,
        editorChars: document.getElementById("file-editor")?.value?.length ?? null,
        readerTitle: text("reader-title"),
        bodyText: (document.body?.innerText ?? "").replace(/\s+/g, " ").slice(0, 400),
      };
    }).catch((error) => ({ saveStateFailed: String(error?.message ?? error) }));
  }

  /**
   * The prime suspect, measured rather than assumed. The room-folder branch is the ONLY save path that
   * awaits `durableFact()`, which awaits `navigator.storage.persist()` — a call that can sit on a permission
   * decision a headless browser cannot answer, in which case the await never settles and the save stalls
   * silently AFTER setting the button to "Saving…". Both are probed here with a bound, so the next run says
   * which one it is instead of leaving a hypothesis: `persisted`, and whether `persist()` settles at all.
   */
  async function durableProbe() {
    return await page.evaluate(async () => {
      const out = { hasStorage: typeof navigator.storage?.persisted === "function", persisted: null, persistSettles: null };
      try {
        out.persisted = await navigator.storage.persisted();
      } catch (error) {
        out.persisted = `threw: ${error?.message ?? error}`;
      }
      try {
        out.persistSettles = await Promise.race([
          navigator.storage.persist().then((v) => `resolved: ${v}`),
          new Promise((resolve) => setTimeout(() => resolve("DID NOT SETTLE within 3000ms"), 3000)),
        ]);
      } catch (error) {
        out.persistSettles = `threw: ${error?.message ?? error}`;
      }
      return out;
    }).catch((error) => ({ probeFailed: String(error?.message ?? error) }));
  }

  const consoleTail = () =>
    page
      .events("Runtime.consoleAPICalled")
      .slice(-8)
      .map((event) => `${event.type}: ${(event.args ?? []).map((a) => a.value ?? a.description ?? "").join(" ")}`);

  const syncPosts = () =>
    page.events("Network.requestWillBeSent").filter(
      (event) => event.request.method === "POST" && event.request.url.includes("/api/mini-apps"),
    );

  // ── SEED: the nested HTML goes into the OPFS directory the OPFS door mounts, before the door is used ────
  await page.evaluate(async ({ relative, initial }) => {
    const [dir, leaf] = relative.split("/");
    const opfs = await navigator.storage.getDirectory();
    const room = await opfs.getDirectoryHandle("scratchpad", { create: true });
    const sub = await room.getDirectoryHandle(dir, { create: true });
    const file = await sub.getFileHandle(leaf, { create: true });
    const writable = await file.createWritable();
    await writable.write(initial);
    await writable.close();
  }, { relative: SHOWN, initial: NESTED_V1 });

  // ── OPEN THE ROOM: the page's own OPFS door, not a dropped or machine root ───────────────────────────────
  await clickWhenEnabled("#open-opfs-folder");
  await page.waitFor(() => document.querySelector("#files .file-open[data-kind='directory']") !== null, {
    label: "the room folder's own listing (a directory row)",
  });

  // ── WALK IN through the room's own listing, so the reader's shown path really is `sub/nested.html` ──────
  await page.evaluate(() => document.querySelector('#files .file-open[data-kind="directory"]').click());
  await page.waitFor((wanted) => document.querySelector(`#files .file-open[data-path="${wanted}"]`) !== null, {
    label: `the listing inside the nested folder to show ${SHOWN}`,
    args: [SHOWN],
  });
  await page.evaluate((wanted) => document.querySelector(`#files .file-open[data-path="${wanted}"]`).click(), SHOWN);
  await page.waitFor((leaf) => document.getElementById("reader-title")?.textContent?.includes(leaf) === true, {
    label: "the reader to open the nested file",
    args: [LEAF],
  });

  await clickWhenEnabled("#file-edit");
  await page.waitFor(() => document.getElementById("reader")?.dataset.editing === "true", {
    label: "the reader to enter editing mode",
  });
  await page.evaluate((value) => {
    document.getElementById("file-editor").value = value;
  }, NESTED_V2);

  // ── A WITNESS TRAIL, because a capture taken 10s later cannot tell the two apart ────────────────────────
  // The button reads "Saving…" for exactly as long as the save path is inside its try, and `exitEditMode()`
  // clears the editing flag only on the way out of a save that ran. So the state sampled AFTER a 10s timeout
  // shows "editing false, save hidden, Save" for BOTH "the save ran and completed" and "the click never
  // reached the save at all" — the distinction this arm exists to make. Sample the fields that separate them
  // while waiting, and report the trail.
  const trail = [];
  const sampler = setInterval(() => {
    if (trail.length >= 60) return;
    page
      .evaluate(() => ({
        editing: document.getElementById("reader")?.dataset.editing ?? null,
        saveText: document.getElementById("file-save")?.textContent ?? null,
        saveHidden: document.getElementById("file-save")?.hidden ?? null,
        facts: document.getElementById("file-facts")?.textContent ?? null,
        report: document.getElementById("turn-report")?.textContent ?? null,
      }))
      .then((sample) => trail.push(sample))
      .catch(() => {});
  }, 250);
  t.after(() => clearInterval(sampler));

  // ── SAVE with the room's own button: this is the call site the bead is about ────────────────────────────
  // 9lpi: a save is not a promotion — a PLAIN page's save posts nothing now, so this arm first promotes
  // the file the way Open as Mini-App does, then proves the save of a SHELF app syncs the leaf name.
  // (The plain-page negative is driven by tests/room-folder-save-sync.test.mjs arm 1.)
  const promote = await page.evaluate(async (leaf) => {
    const res = await fetch("/api/mini-apps", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fileName: leaf, title: leaf, html: "<!doctype html><p>nested v1</p>" }),
    });
    return { status: res.status };
  }, LEAF);
  assert.equal(promote.status, 200, "the explicit promotion lands the shelf record");

  const before = syncPosts().length;
  await clickWhenEnabled("#file-save");

  let sent;
  try {
    sent = await until(
      () => (syncPosts().length > before ? syncPosts()[syncPosts().length - 1] : null),
      "the room-folder save to POST to /api/mini-apps",
    );
  } catch (error) {
    // A timeout here must name the cause: the click was accepted and the POST never left, so the answer is
    // in the page's own facts line or console, not in a longer wait.
    const state = await saveState();
    const durable = await durableProbe();
    // The facts line is written by the save path itself the moment it writes anything, so it is the field
    // that names the cause; captured a second time after the probe in case it is painted late.
    // The trail is the part that separates "the save ran" from "the click never saved": if it never shows
    // "Saving…" the save path was never entered and the fault is in reaching the button, not in the sync.
    const compact = trail.map(({ editing, saveText, facts }) => `${editing}/${saveText}/${(facts ?? "").slice(0, 40)}`);
    throw new Error(
      `${error.message} — page state: ${JSON.stringify(state)} — durable probe: ${JSON.stringify(durable)} — sawSaving: ${trail.some((x) => x.saveText === "Saving…")} — trail(${compact.length}): ${JSON.stringify(compact.slice(0, 10))} … ${JSON.stringify(compact.slice(-4))} — console: ${JSON.stringify(consoleTail())}`,
    );
  }
  const body = JSON.parse(sent.request.postData);

  // ── THE ASSERTIONS THE MACHINE-ROOT ARM MAKES, for the branch it could not reach ────────────────────────
  assert.equal(body.fileName, LEAF, "the room-folder save asks for the LEAF name of the nested file");
  assert.equal(body.title, LEAF, "and the title is that same leaf name");
  assert.ok(String(body.html).includes("edited through the room's own editor"), "and the body carries what was just saved");
  assert.ok(
    !JSON.stringify(body).includes("sub/"),
    `the shown path never reaches the request body — that is the m4no defect (the server rewrote it into a ` +
      `misnamed duplicate, then refused it): ${JSON.stringify(body).slice(0, 300)}`,
  );
  assert.deepEqual(
    Object.keys(body).sort(),
    ["fileName", "html", "title"],
    "the body is the one-name shape the save API takes, and nothing else",
  );

  const answered = await until(
    () => page.events("Network.responseReceived").find((event) => event.requestId === sent.requestId) ?? null,
    "the server's answer to the sync",
  );
  assert.equal(answered.response.status, 200, "the server accepted the sync for the leaf name");

  // ── AND THE SAVE REALLY HAPPENED, in the room folder rather than only in the request ────────────────────
  const saved = await page.evaluate(async (relative) => {
    const [dir, leaf] = relative.split("/");
    const opfs = await navigator.storage.getDirectory();
    const room = await opfs.getDirectoryHandle("scratchpad");
    const sub = await room.getDirectoryHandle(dir);
    const file = await sub.getFileHandle(leaf);
    return await (await file.getFile()).text();
  }, SHOWN);
  assert.ok(saved.includes("edited through the room's own editor"), "the nested file really was written inside the room folder");

  // ── ONE APP, NAMED BY THE LEAF: the duplicate/misnamed slug is what m4no produced ───────────────────────
  const catalog = await (await fetch(`${server.base}/api/mini-apps`)).json();
  const apps = (catalog.miniApps ?? catalog.apps ?? []).filter((app) =>
    String(app.fileName ?? app.title ?? "").includes(LEAF),
  );
  assert.equal(apps.length, 1, `saving the nested HTML made exactly one shelf app: ${JSON.stringify(catalog).slice(0, 300)}`);
  assert.equal(apps[0].title, LEAF, "the shelf app is named by the LEAF, which is what the request asked for");
  assert.equal(apps[0].slug, "nested", "and its slug is derived from that leaf, not from the folder path");

  // ── SWITCHING ROOM FOLDERS: the reader must clear so edits cannot target another folder (voicebox-beads-jwmi) ──
  await page.evaluate(async () => {
    const opfs = await navigator.storage.getDirectory();
    await opfs.getDirectoryHandle("other-room", { create: true });
    globalThis.showDirectoryPicker = async () => (await navigator.storage.getDirectory()).getDirectoryHandle("other-room");
  });
  await page.click("#open-folder");
  await page.waitFor(
    () =>
      document.querySelector("#room-folders-list")?.textContent?.includes("other-room") &&
      document.getElementById("listing-root")?.textContent?.includes("other-room"),
    { label: "other room to become active" },
  );
  const readerState = await page.evaluate(() => ({
    title: document.getElementById("reader-title")?.textContent,
    editDisabled: document.getElementById("file-edit")?.disabled,
    state: document.getElementById("reader")?.dataset.state,
  }));
  assert.equal(readerState.title, "Nothing open", "switching room folders clears the previous room file from the reader");
  assert.equal(readerState.editDisabled, true, "editing is disabled after switching to an empty room");
  assert.equal(readerState.state, "empty", "reader state is reset to empty");
});
