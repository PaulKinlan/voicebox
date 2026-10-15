// tests/room-folder-save-sync.test.mjs — the SAVE PATH's own POST, driven from a real page (voicebox-beads-543c, voicebox-beads-kxts).
//
// WHY THIS FILE EXISTS. tests/room-folder-ops.test.mjs held a SOURCE-TEXT pin over fused.js's
// syncMiniAppAfterFileSave — the derived leaf name, the one-name request body, and the warning for a refused
// sync — while recording that the behavioural half, "driving the real POST from a real page", had never been
// done (UNVERIFIED-WITH-REASON on voicebox-beads-m4no until a quiet window). A source pin cannot see whether
// the save path CALLS that function at all, and it cannot see what leaves the browser. This file is the drive:
//
//   · the file is opened INSIDE A FOLDER through the room's own listing (so the shown path really is
//     `proposals/draft.html`), edited in the reader's own editor and saved with the room's own button;
//   · the request that actually left the browser is read off the wire (`Network.requestWillBeSent`), so the
//     body asserted is the body that was sent, and the status asserted is the status the server returned;
//   · the m4no defect itself is the mutant that turns this file RED: posting the SHOWN path used to make the
//     server basename-rewrite the file into a duplicate AND, once the route was tightened, refuse it 400 with
//     the old fire-and-forget catch swallowing the status — a file saved inside a folder silently lost its
//     shelf/workspace sync. Dropping the leaf derivation (using `fileName`) makes the body assertion fail;
//     dropping the `if (!r.ok)` warning makes the refusal arm fail;
//   · NEGATIVE CONTROL for the shape guard: saving a NON-HTML file must not post to the sync API at all, so
//     "one save = one sync" is a claim about HTML rather than about a counter that fires for everything;
//   · OPFS ROOM-FOLDER SAVE DRIVE (voicebox-beads-kxts): saving an HTML file inside an adopted OPFS room
//     folder also posts the leaf name to /api/mini-apps, observing the public/fused.js:2337 call site.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startServer } from "./lib/server.mjs";
import { launch } from "./lib/cdp.mjs";

const DRAFT_V1 = "<!doctype html><p>draft v1</p>";
const DRAFT_V2 = "<!doctype html><p>draft v2 — edited in the reader</p>";

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

test("the save path posts the LEAF name to the sync API and names a refused sync (voicebox-beads-m4no)", { timeout: 120000 }, async (t) => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "voicebox-room-save-sync-"));
  const workspace = path.join(scratch, "project");
  fs.mkdirSync(path.join(workspace, "proposals"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "proposals", "draft.html"), DRAFT_V1, "utf8");
  fs.writeFileSync(path.join(workspace, "notes.txt"), "not html, never a mini-app", "utf8");

  const server = await startServer({ env: { VOICEBOX_WORKSPACE: workspace } });
  t.after(async () => {
    await server.stop();
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  // Declare the workspace as the machine root, so /api/files lists the seeded files (the fixture shape
  // tests/ux-bubble-stage.test.mjs uses).
  const rootRes = await fetch(`${server.base}/api/root`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-voicebox-host-token": server.hostToken },
    body: JSON.stringify({ project: "room-save-sync-test", root: { kind: "machine", path: workspace } }),
  });
  assert.equal(rootRes.ok, true, "declared workspace root");

  const page = await launch({ width: 1280, height: 900 });
  t.after(() => page.close());
  await page.send("Network.enable");
  await page.send("Runtime.enable");
  await page.goto(server.base);
  await page.waitFor(() => document.querySelectorAll("#files .file-open").length >= 2, {
    label: "the workspace listing (a folder and a plain file)",
  });

  /** Click a control only once it can do its job: the wait is on the thing being acted on, not on a neighbour. */
  async function clickWhenEnabled(selector) {
    await page.waitFor((sel) => {
      const el = document.querySelector(sel);
      return Boolean(el) && !el.disabled && !el.hidden;
    }, { label: `${selector} to be enabled`, args: [selector] });
    await page.click(selector);
  }

  const syncPosts = () =>
    page.events("Network.requestWillBeSent").filter(
      (event) => event.request.method === "POST" && event.request.url.includes("/api/mini-apps"),
    );

  async function walkInAndSave(relativePath, html, { refuseSync = false } = {}) {
    // WALK IN through the room's own listing: the folder row first, so the reader's shown path is the
    // folder-joined one — that path is the input this whole arm is about.
    await page.waitFor(() => document.querySelector('#files button.file-open[data-kind="directory"]'), {
      label: "the folder row at the root of the listing",
    });
    await page.evaluate(() => document.querySelector('#files button.file-open[data-kind="directory"]').click());
    await page.waitFor((wanted) => document.querySelector(`#files button.file-open[data-path="${wanted}"]`), {
      label: `the listing inside the folder to show ${relativePath}`,
      args: [relativePath],
    });
    await page.evaluate((wanted) => document.querySelector(`#files button.file-open[data-path="${wanted}"]`).click(), relativePath);
    await page.waitFor(() => document.getElementById("reader")?.dataset.editing !== undefined || document.getElementById("reader-title")?.textContent, {
      label: `the reader to open ${relativePath}`,
    });
    await page.waitFor((wanted) => document.getElementById("reader-title")?.textContent?.includes(wanted.split("/").pop()), {
      label: "the reader title to name the opened file",
      args: [relativePath],
    });

    await clickWhenEnabled("#file-edit");
    await page.waitFor(() => document.getElementById("reader")?.dataset.editing === "true", { label: "the reader to enter editing mode" });
    await page.evaluate((value) => {
      document.getElementById("file-editor").value = value;
    }, html);

    if (refuseSync) {
      // A refused shelf sync, without touching the file save: only the sync POST is answered 400. This is a
      // page-side stub on purpose — the assertion below is about what the PAGE does with a refusal.
      await page.evaluate(() => {
        if (window.__realFetchForSyncTest) return;
        window.__realFetchForSyncTest = window.fetch.bind(window);
        window.fetch = (input, init) => {
          const url = typeof input === "string" ? input : input?.url ?? input?.input ?? "";
          if (String(url).includes("/api/mini-apps") && String(init?.method ?? "").toUpperCase() === "POST") {
            return Promise.resolve(
              new Response(JSON.stringify({ ok: false, refused: "test-only-refusal" }), {
                status: 400,
                headers: { "content-type": "application/json" },
              }),
            );
          }
          return window.__realFetchForSyncTest(input, init);
        };
      });
    }

    const before = syncPosts().length;
    await clickWhenEnabled("#file-save");
    return { before };
  }

  // ── 1. THE SYNC ASKS FOR THE LEAF NAME, AND IT IS THE REQUEST THAT LEFT THE BROWSER ──────────────
  const beforeFirst = syncPosts().length;
  assert.equal(beforeFirst, 0, "nothing may sync before a save");
  await walkInAndSave("proposals/draft.html", DRAFT_V2);

  const first = await until(
    () => (syncPosts().length > beforeFirst ? syncPosts()[syncPosts().length - 1] : null),
    "the save to POST to /api/mini-apps",
  );
  const sentBody = JSON.parse(first.request.postData);
  assert.equal(sentBody.fileName, "draft.html", "the sync asks for the LEAF name of the file that was saved");
  assert.equal(sentBody.title, "draft.html", "and the title is that same leaf name");
  assert.ok(String(sentBody.html).includes("edited in the reader"), "and the body carries what was just saved");
  assert.ok(
    !JSON.stringify(sentBody).includes("proposals/draft.html"),
    "the shown path never reaches the request body — that is the m4no defect (the server rewrote it into a misnamed duplicate, then refused it)",
  );
  assert.deepEqual(
    Object.keys(sentBody).sort(),
    ["fileName", "html", "title"],
    "the body is the one-name shape the save API takes, and nothing else",
  );

  const firstResponse = await until(
    () => page.events("Network.responseReceived").find((event) => event.requestId === first.requestId),
    "the sync request's response",
  );
  assert.equal(firstResponse.response.status, 200, "the server accepted the sync for the leaf name");

  const saved = await page.evaluate(() => fetch("/api/file?name=proposals/draft.html").then((r) => r.json()));
  assert.ok(String(saved.content).includes("edited in the reader"), "and the FILE really was saved inside the folder");

  const catalog = await page.evaluate(() => fetch("/api/mini-apps").then((r) => r.json()));
  const drafted = (catalog.miniApps ?? catalog.apps ?? []).filter((app) => String(app.fileName ?? app.title ?? "").includes("draft.html"));
  assert.equal(drafted.length, 1, `saving the HTML file made it a shelf app under its leaf name: ${JSON.stringify(catalog).slice(0, 300)}`);
  assert.equal(drafted[0].title, "draft.html", "the shelf app is named by the LEAF, which is what the request asked for");
  assert.equal(drafted[0].slug, "draft", "and its slug is derived from that leaf, not from the folder path");
  // ONE app, not two: the m4no defect was the server basename-rewriting the folder-joined path into a second,
  // misnamed record at the root. (The listing's own `fileName` for a workspace-sourced app IS the workspace
  // path — that is how the record proves which workspace file it came from, docs/17 — so the NAME assertions
  // above are the ones that speak to the defect, not a scan of the whole record for the path.)
  assert.deepEqual(
    (catalog.miniApps ?? catalog.apps ?? []).map((app) => app.slug).sort(),
    ["draft"],
    "one save inside a folder leaves exactly one app, under one slug",
  );

  // ── 2. NEGATIVE CONTROL: A NON-HTML SAVE SYNCS NOTHING ───────────────────────────────────────────
  await page.reload();
  await page.waitFor(() => document.querySelectorAll("#files .file-open").length >= 2, { label: "the workspace listing after reload" });
  const postsBeforeTxt = syncPosts().length;
  await page.evaluate(() => document.querySelector('#files button.file-open[data-path="notes.txt"]').click());
  await page.waitFor(() => document.getElementById("reader-title")?.textContent?.includes("notes.txt"), { label: "the reader to open notes.txt" });
  await clickWhenEnabled("#file-edit");
  await page.waitFor(() => document.getElementById("reader")?.dataset.editing === "true", { label: "editing mode for notes.txt" });
  await page.evaluate(() => {
    document.getElementById("file-editor").value = "still not html";
  });
  await clickWhenEnabled("#file-save");
  // The save path is fire-and-forget, so give it the same window the HTML save was given, and then require
  // that NOTHING arrived: a counter that fires for every save would pass arm 1 while being wrong here.
  await until(
    async () =>
      (await page.evaluate(() => fetch("/api/file?name=notes.txt").then((r) => r.json()))).content === "still not html",
    "the text file's own save to land",
  );
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(
    syncPosts().length,
    postsBeforeTxt,
    "saving a non-HTML file must not sync a mini-app: the shape guard runs on the derived name before the POST",
  );

  // ── 3. A REFUSED SYNC IS NAMED, AND THE FILE SAVE STILL STANDS ───────────────────────────────────
  await page.reload();
  await page.waitFor(() => document.querySelectorAll("#files .file-open").length >= 2, { label: "the workspace listing before the refusal arm" });
  const warnsBefore = page.events("Runtime.consoleAPICalled").length;
  await walkInAndSave("proposals/draft.html", "<!doctype html><p>draft v3 — refused sync</p>", { refuseSync: true });

  const warning = await until(
    () =>
      page
        .events("Runtime.consoleAPICalled")
        .slice(warnsBefore)
        .filter((event) => event.type === "warning")
        .map((event) => event.args.map((arg) => String(arg.value ?? arg.description ?? "")).join(" "))
        .find((text) => text.includes("mini-app-sync")),
    "the page to NAME the refused sync",
  );
  assert.match(warning, /shelf sync for 'draft\.html' was refused \(400\)/, `the warning names the file and the status: ${warning}`);
  assert.match(warning, /the file itself was saved/, `and it says the SAVE succeeded, only the sync failed: ${warning}`);

  const afterRefusal = await page.evaluate(() => fetch("/api/file?name=proposals/draft.html").then((r) => r.json()));
  assert.ok(
    String(afterRefusal.content).includes("refused sync"),
    "the refusal is about the shelf copy only: the file inside the folder still holds what was saved",
  );

  // ── 4. THE OPFS ROOM-FOLDER SAVE PATH POSTS THE LEAF NAME (voicebox-beads-kxts) ───────────────
  // A room folder (OPFS) has its own write path (writeRoomFile) in fused.js. This arm drives that
  // path for a nested HTML file, proving that saving a file inside an adopted folder also syncs the
  // leaf name to /api/mini-apps. Deleting the OPFS sync call (public/fused.js:2337) turns this arm RED.
  await page.evaluate(() => {
    if (window.__realFetchForSyncTest) {
      window.fetch = window.__realFetchForSyncTest;
      delete window.__realFetchForSyncTest;
    }
  });

  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle("opfs-save-sync-test", { create: true });
    const sub = await dir.getDirectoryHandle("nested", { create: true });
    const fh = await sub.getFileHandle("widget.html", { create: true });
    const w = await fh.createWritable();
    await w.write("<!doctype html><p>opfs v1</p>");
    await w.close();
    await window.__voiceboxAdoptFolder(dir);
  });

  await page.click("#sqeh-files-bubble");
  await page.waitFor(() => document.body.dataset.sqehState === "files", { label: "files popover open" });

  await page.waitFor(() => document.querySelector('#files .file-open[data-file="nested"]'), { label: "nested folder in room folder listing" });
  await page.click('#files .file-open[data-file="nested"]');

  await page.waitFor(() => document.querySelector('#files .file-open[data-file="widget.html"]'), { label: "widget.html in nested folder listing" });
  await page.click('#files .file-open[data-file="widget.html"]');

  await page.waitFor(() => document.getElementById("reader")?.dataset.state === "ready", { label: "reader ready for widget.html" });

  await clickWhenEnabled("#file-edit");
  await page.waitFor(() => document.getElementById("reader")?.dataset.editing === "true", { label: "reader editing mode for widget.html" });
  await page.evaluate(() => {
    document.getElementById("file-editor").value = "<!doctype html><p>opfs v2 — edited in room folder</p>";
  });

  const postsBeforeOpfs = syncPosts().length;
  await clickWhenEnabled("#file-save");

  const opfsPost = await until(
    () => (syncPosts().length > postsBeforeOpfs ? syncPosts()[syncPosts().length - 1] : null),
    "the OPFS save to POST to /api/mini-apps",
  );
  const opfsBody = JSON.parse(opfsPost.request.postData);
  assert.equal(opfsBody.fileName, "widget.html", "the OPFS save sync asks for the LEAF name");
  assert.equal(opfsBody.title, "widget.html", "and the title is that same leaf name");
  assert.ok(String(opfsBody.html).includes("edited in room folder"), "and the body carries what was just saved");
  assert.ok(!JSON.stringify(opfsBody).includes("nested/widget.html"), "the shown path never reaches the request body");
});
