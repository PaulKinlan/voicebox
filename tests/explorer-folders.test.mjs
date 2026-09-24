// tests/explorer-folders.test.mjs — voicebox-beads-tee: FOLDERS ARE NAVIGABLE in the room's file list.
//
//   node --test tests/explorer-folders.test.mjs
//
// Paul: "'proposals' is a folder. This list shows one level of the root, and opening folders is not
// available yet." — a sentence that was true, and a gap. This drives the replacement:
//
//   · a folder row opens the folder, in the SAME list (the listing is the navigation);
//   · the crumb bar shows the path from the root, each ancestor a button, with a parent control;
//   · the keyboard opens folders (Enter — and the row can hold focus at all);
//   · a path is NORMALISED AND BOUNDED by one shared helper: `..`, a leading slash, and dotfiles are
//     refused by name, and the root itself is answered directly (it is not a file name);
//   · it works across root kinds: a MACHINE root (the server lists) and a PAGE-OWNED root (the server
//     relays to the environment page, which lists inside the folder it holds).
//
// The page-owned half is also the picked-folder path: both are `handle`/`opfs` roots the page acts on.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { startServer } from "./lib/server.mjs";
import { launch } from "./lib/cdp.mjs";

const ROOT = "/tmp/voicebox-explorer-folders";
let server;

test.before(async () => {
  server = await startServer({ env: { VOICEBOX_INSTANCE: "folders" } });
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(`${ROOT}/proposals/drafts`, { recursive: true });
  mkdirSync(`${ROOT}/proposals/.hidden-dir`, { recursive: true });
  writeFileSync(`${ROOT}/at-the-root.txt`, "root file\n");
  writeFileSync(`${ROOT}/proposals/README.md`, "readme\n");
  writeFileSync(`${ROOT}/proposals/drafts/one.txt`, "draft one\n");
  writeFileSync(`${ROOT}/proposals/.hidden-dir/x.txt`, "secret\n");
});
test.after(async () => { await server?.stop?.(); });

const declareMachine = (s) =>
  fetch(`${s.base}/api/root`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-voicebox-host-token": s.hostToken },
    body: JSON.stringify({ project: "folders", root: { kind: "machine", path: ROOT } }),
  }).then((r) => r.json());

const list = (s, dir) => fetch(`${s.base}/api/files${dir ? `?dir=${encodeURIComponent(dir)}` : ""}`).then((r) => r.json());

test("the path helper binds and normalises what a click can name — the root is not a file name", async () => {
  await declareMachine(server);
  const root = await list(server, "");
  assert.equal(root.ok, true, `the root itself must list — got ${JSON.stringify(root).slice(0, 140)}`);
  assert.deepEqual(root.dir, "");
  assert.equal(root.parent, null, "the root has no parent");
  assert.deepEqual(root.files.sort(), ["at-the-root.txt", "proposals"]);
  assert.equal(root.entries.find((e) => e.name === "proposals").kind, "directory", "a folder must be marked as one");

  const nested = await list(server, "proposals/drafts");
  assert.equal(nested.ok, true);
  assert.equal(nested.dir, "proposals/drafts", "the answer names the folder it listed");
  assert.equal(nested.parent, "proposals", "and the folder above it");
  assert.deepEqual(nested.files, ["one.txt"]);

  // a path is normalised, not refused, when it is only sloppy
  const sloppy = await list(server, "proposals//drafts/");
  assert.equal(sloppy.ok, true);
  assert.equal(sloppy.dir, "proposals/drafts", "a doubled or trailing slash is normalised, not a different folder");

  // every way out is refused BY NAME, and the reason says which rule
  for (const [dir, refused] of [["..", "outside-root"], ["proposals/../..", "outside-root"], ["/etc", "outside-root"], [".audit", "dotfile-refused"], ["proposals/.hidden-dir", "dotfile-refused"]]) {
    const answer = await list(server, dir);
    assert.equal(answer.ok, false, `'${dir}' must be refused`);
    assert.equal(answer.refused, refused, `'${dir}' was refused as ${answer.refused}`);
    assert.ok(answer.why?.length > 10, `'${dir}' must carry a sentence, not just a code`);
  }

  // a folder that is gone is NAMED, with where it went — not an empty list
  rmSync(`${ROOT}/proposals/drafts`, { recursive: true, force: true });
  const missing = await list(server, "proposals/drafts");
  assert.equal(missing.ok, false);
  assert.equal(missing.refused, "folder-missing");
  assert.match(missing.why, /renamed or removed/, "the refusal says what may have happened to it");
  mkdirSync(`${ROOT}/proposals/drafts`, { recursive: true });
  mkdirSync(`${ROOT}/proposals/.hidden-dir`, { recursive: true });
  writeFileSync(`${ROOT}/proposals/drafts/one.txt`, "draft one\n");
});

test("a machine root: clicking a folder opens it, crumbs and the parent control lead back, Enter works", { timeout: 120000 }, async () => {
  await declareMachine(server);
  const page = await launch({ width: 1280, height: 900 });
  try {
    await page.goto(`${server.base}/`);
    await page.waitFor(() => document.querySelector("#files .file-open"), { label: "the file list" });

    const state = () => {
      const rows = [...document.querySelectorAll("#files .file-open")].map((b) => ({ name: b.dataset.file, path: b.dataset.path, dir: b.dataset.kind === "directory" }));
      const nav = document.getElementById("folder-path");
      const labels = [...nav.querySelectorAll(".crumb")].map((c) => c.textContent.trim());
      const buttons = [...nav.querySelectorAll("button.crumb")];
      return {
        rows,
        dir: labels.filter((l) => l !== "↑").slice(1).join("/"),
        // the labels WITHOUT the caret and the root label are the path from the root
        crumbs: labels.filter((l) => l !== "↑"),
        hidden: nav.hidden,
        current: nav.querySelector('.crumb[aria-current="page"]')?.textContent?.trim() ?? null,
        up: nav.querySelector(".crumb-up")?.getAttribute("aria-label") ?? null,
        ancestorButtons: buttons.filter((b) => b.textContent.trim() !== "↑").map((b) => b.textContent.trim()),
        rowHeight: Math.round(document.querySelector("#files .file-open").getBoundingClientRect().height),
        crumbHeight: buttons[0] ? Math.round(buttons[0].getBoundingClientRect().height) : 0,
      };
    };
    const atRoot = await page.evaluate(state);
    assert.deepEqual(atRoot.rows.map((r) => r.name).sort(), ["at-the-root.txt", "proposals"]);
    assert.equal(atRoot.rows.find((r) => r.name === "proposals").dir, true, "a folder must render as a folder");
    assert.equal(atRoot.hidden, true, "at the root there is nowhere to go back to, so no crumb bar");
    assert.ok(atRoot.rowHeight >= 48, `rows keep a 48px touch target — got ${atRoot.rowHeight}px`);

    await page.click('#files .file-open[data-file="proposals"]');
    await page.waitFor(() => document.querySelector('#files .file-open[data-file="README.md"]'), { label: "the folder's contents" });
    const inside = await page.evaluate(state);
    assert.equal(inside.dir, "proposals", "the crumb bar says which folder is on screen");
    assert.deepEqual(inside.rows.map((r) => r.path).sort(), ["proposals/README.md", "proposals/drafts"], "every row carries its path from the root");
    assert.equal(inside.current, "proposals", "the folder on screen is marked current, and it is not a button");
    assert.ok(inside.ancestorButtons.length >= 1, "every step above is a button");
    assert.match(inside.up ?? "", /Go up to/, "the parent control says where it goes");
    assert.ok(inside.crumbHeight >= 44, `crumbs keep a 44px touch target — got ${inside.crumbHeight}px`);

    // the keyboard opens a folder: focus must land on the row FIRST (the list re-renders after navigation)
    const focused = await page.evaluate(async () => {
      for (let i = 0; i < 20; i++) {
        const row = document.querySelector('#files .file-open[data-file="drafts"]');
        if (row) { row.focus(); if (document.activeElement === row) return row.dataset.file; }
        await new Promise((r) => setTimeout(r, 100));
      }
      return null;
    });
    assert.equal(focused, "drafts", "a folder row must be focusable — the keyboard path depends on it");
    // A REAL ENTER: keyDown needs its text, or a focused <button> never activates.
    await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r", unmodifiedText: "\r" });
    await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    await page.waitFor(() => document.querySelector('#files .file-open[data-file="one.txt"]'), { label: "Enter opening the folder" });
    const deeper = await page.evaluate(state);
    assert.equal(deeper.dir, "proposals/drafts", "Enter opened the folder");
    assert.deepEqual(deeper.crumbs, deeper.crumbs.slice(0, 1).concat(["proposals", "drafts"]), "the crumbs show the whole path");

    // back up: by the ancestor crumb, then by the parent control
    await page.evaluate(() => [...document.querySelectorAll("#folder-path button.crumb")].find((b) => b.textContent.trim() === "proposals")?.click());
    await page.waitFor(() => document.querySelector('#files .file-open[data-file="README.md"]'), { label: "the ancestor crumb going back" });
    assert.equal((await page.evaluate(state)).dir, "proposals");
    await page.evaluate(() => document.querySelector("#folder-path .crumb-up")?.click());
    await page.waitFor(() => document.getElementById("folder-path").hidden, { label: "the parent control reaching the root" });
    const backRoot = await page.evaluate(state);
    assert.equal(backRoot.dir, "", "the parent control returned to the root");
    assert.ok(backRoot.rows.some((r) => r.name === "at-the-root.txt"), "and the root's own files are listed again");
  } finally { await page.close(); }
});

test("a page-owned (OPFS) root: the same click navigates, listed through the page", { timeout: 120000 }, async () => {
  const s = await startServer({ env: { VOICEBOX_INSTANCE: "folders-opfs" } });
  const env = await launch({ width: 1280, height: 900 });
  const room = await launch({ width: 1280, height: 900 });
  try {
    await env.goto(`${s.base}/environment.html`);
    await env.waitFor(() => window.e1m0 !== undefined, { label: "the environment page" });
    await env.type("#project-name", "folders-opfs");
    await env.click('#open-form button[type="submit"]');
    await env.waitFor(() => /made\s+folders-opfs/i.test(document.body.textContent ?? ""), { label: "the project being made" });
    await env.type("#asset-name", "inside-assets.txt");
    await env.type("#asset-body", "a file inside the page's assets folder\n");
    await env.click('#asset-form button[type="submit"]');
    await sleep(1500);

    await room.goto(`${s.base}/`);
    await room.waitFor(() => document.querySelector('#files .file-open[data-file="assets"]'), { label: "the page's assets folder" });
    const listing = await fetch(`${s.base}/api/files`).then((r) => r.json());
    assert.equal(listing.via, "page", "the listing says whose it is");
    assert.equal(listing.dir, "", "and which folder of that root");
    assert.equal(listing.entries.find((e) => e.name === "assets")?.kind, "directory", "the page must report kinds, or a folder cannot be clicked");

    await room.click('#files .file-open[data-file="assets"]');
    await room.waitFor(() => document.querySelector('#files .file-open[data-file="inside-assets.txt"]'), { label: "the file inside the folder" });
    const inside = await fetch(`${s.base}/api/files?dir=assets`).then((r) => r.json());
    assert.equal(inside.ok, true, "listing INSIDE a page-owned folder works");
    assert.equal(inside.dir, "assets");
    assert.equal(inside.parent, "");
    assert.deepEqual(inside.files, ["inside-assets.txt"]);

    const read = await fetch(`${s.base}/api/file?name=${encodeURIComponent("assets/inside-assets.txt")}`).then((r) => r.json());
    assert.equal(read.ok, true, "a file inside a page-owned folder reads by its relative path");
    assert.match(read.content, /inside the page's assets folder/);
    assert.equal(read.via, "page", "and says the page performed it");

    // and the way out is the same control
    await room.evaluate(() => document.querySelector("#folder-path .crumb-up")?.click());
    await room.waitFor(() => document.getElementById("folder-path").hidden, { label: "back to the page's root" });
  } finally { await env.close(); await room.close(); await s.stop?.(); }
});
