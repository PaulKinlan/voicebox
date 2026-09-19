// tests/explorer.test.mjs — the file explorer over three roots (bead voicebox-beads-7cd).
//
//   node --test tests/explorer.test.mjs
//
// The design line the coordinator asked to be held: the three views have genuinely different
// authority and must not be presented as one list. OPFS is origin-private with implicit access;
// a picked folder is the user's REAL filesystem, granted once and re-grantable only on a gesture;
// the server view is a real directory and the only one of the three that survives the tab closing.
// A person who cannot tell which one they are looking at cannot reason about what persists or who
// can see it — so every panel names its root, and the record it renders from can actually say it.
//
// The second line: a listing is ONE bounded message. It never walks a tree and never issues a read
// per entry. The page that listed files by posting a `read <name>` turn per name is exactly the
// defect this shape prevents, so the check counts the host's own message and read counters.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { launch } from "./lib/cdp.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8833;
const BASE = `http://127.0.0.1:${PORT}`;
const CROWDED = 300; // more files than one listing shows, so "bounded" is measurable
const LIMIT = 200;

let server;
let page;
let folder;
let folderName;

const send = (message) => page.evaluate((m) => window.e1m0.send(m), message);
const stats = () => send({ type: "stats" });

test.before(async () => {
  const parent = mkdtempSync(path.join(os.tmpdir(), "voicebox-explorer-"));
  folder = path.join(parent, "crowded-root");
  mkdirSync(folder);
  mkdirSync(path.join(folder, "subdir"));
  for (let i = 0; i < CROWDED; i++) {
    writeFileSync(path.join(folder, `file-${String(i).padStart(3, "0")}.txt`), `${i}`);
  }
  folderName = path.basename(folder);

  server = spawn(process.execPath, [path.join(ROOT, "server.mjs")], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT) },
    stdio: "ignore",
    detached: true,
  });
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`${BASE}/api/health`)).ok) break;
    } catch {}
    await sleep(100);
  }
  page = await launch();
  await page.goto(`${BASE}/environment.html`);
  await page.waitFor(() => window.e1m0 !== undefined, { label: "the page's host API" });
  await page.evaluate(() => window.e1m0.send({ type: "openProject", name: "atlas" }));
  await page.dropFolder("#dropzone", folder);
  await page.waitFor(
    async (expected) => {
      const reply = await window.e1m0.send({ type: "listProjects" });
      return (reply.projects ?? []).some((p) => p.name === expected && p.rootKind === "handle");
    },
    { args: [folderName], label: "the crowded folder to be adopted" },
  );
});

test.after(async () => {
  await page?.close();
  if (server?.pid) {
    try {
      process.kill(-server.pid, "SIGKILL");
    } catch {}
  }
  rmSync(path.dirname(folder), { recursive: true, force: true });
});

// 1 ------------------------------------------------------------------------------------------
test("7cd.1 Three views, three authorities, and each one says which root it is showing", { timeout: 90000 }, async () => {
  await send({ type: "openProject", name: folderName });
  const opfs = await send({ type: "listView", view: "opfs", limit: LIMIT });
  const picked = await send({ type: "listView", view: "picked", limit: LIMIT });
  const server = await send({ type: "listView", view: "server", limit: LIMIT });

  for (const [name, reply] of [["opfs", opfs], ["picked", picked], ["server", server]]) {
    assert.equal(reply.ok, true, `the ${name} view failed: ${JSON.stringify(reply)}`);
    assert.ok(reply.authority?.where, `the ${name} view does not say where its files are`);
    assert.ok(reply.authority?.whoCanSee, `the ${name} view does not say who can see its files`);
    assert.equal(typeof reply.root, "string");
    assert.ok(reply.root.length > 0, `the ${name} view does not name its root`);
  }

  // Different roots, different authorities, and different answers to "does this need a gesture".
  assert.equal(new Set([opfs.root, picked.root, server.root]).size, 3, "two views claim the same root");
  assert.equal(opfs.authority.needsGesture, false, "OPFS needs no gesture and must say so");
  assert.equal(picked.authority.needsGesture, true, "a picked folder may need a gesture and must say so");
  assert.equal(server.authority.survivesTabClose, true, "the server view is the one that outlives the tab");
  assert.match(opfs.authority.whoCanSee, /nothing outside this origin/);
  assert.match(picked.authority.whoCanSee, /anything on this machine/);

  // And the page renders all three with those words, from three separate panels.
  await page.evaluate(async () => {
    await window.e1m0.renderView("opfs");
    await window.e1m0.renderView("picked");
    await window.e1m0.renderView("server");
  });
  const panels = await page.evaluate(() => ({
    opfs: document.getElementById("view-opfs").textContent,
    picked: document.getElementById("view-picked").textContent,
    server: document.getElementById("view-server").textContent,
  }));
  assert.match(panels.opfs, /origin storage|origin/i);
  assert.match(panels.picked, new RegExp(folderName), "the picked panel does not name the folder it shows");
  assert.match(panels.server, /workspace/);
  assert.notEqual(panels.opfs, panels.picked, "two panels render the same thing");
});

// 2 ------------------------------------------------------------------------------------------
test("7cd.2 A view with nothing behind it refuses by name, never with an empty list", { timeout: 90000 }, async () => {
  await send({ type: "openProject", name: "atlas" }); // an OPFS project: there is no picked folder
  const reply = await send({ type: "listView", view: "picked" });
  assert.equal(reply.ok, false, "a picked view was offered for a project that has no picked root");
  assert.equal(reply.code, "not-a-project", `expected not-a-project, saw ${JSON.stringify(reply)}`);
  assert.match(reply.why, /OPFS project/, "the refusal does not say what this project actually is");

  // The page shows the refusal, not an empty list that looks like an empty folder.
  await page.evaluate(() => window.e1m0.renderView("picked"));
  const panel = await page.evaluate(() => document.getElementById("view-picked").textContent);
  assert.match(panel, /not-a-project/);
  assert.match(panel, /OPFS project/);
});

// 3 ------------------------------------------------------------------------------------------
test("7cd.3 The three failure modes are distinguishable and named", { timeout: 90000 }, async () => {
  await send({ type: "openProject", name: folderName });

  // (a) the state a browser puts a real folder in until a gesture restores it
  const permission = await send({ type: "createAsset", args: { name: "x.txt", kind: "text", body: "x" } });
  // (b) a handle this browser does not hold at all
  const gone = await send({ type: "handleState", name: "a-folder-picked-in-another-profile" });
  // (c) a root that is not there any more
  const missing = await send({ type: "listView", view: "picked", path: "not-a-real-directory" });

  assert.equal(permission.code, "needs-gesture");
  assert.equal(gone.code, "handle-gone");
  assert.equal(missing.ok, false, "listing a directory that does not exist succeeded");
  assert.equal(new Set([permission.code, gone.code, missing.code]).size, 3, "two failure modes share one code");

  for (const [label, reply] of [["permission", permission], ["handle", gone], ["missing", missing]]) {
    assert.ok(reply.why && reply.why.length > 20, `the ${label} failure does not explain itself`);
    assert.doesNotMatch(reply.why, /internal error/i, `the ${label} failure is generic`);
  }

  // The root that is genuinely unreachable — the folder deleted from under the handle — is its
  // own fact, and it arrives with the platform's own words attached.
  rmSync(folder, { recursive: true, force: true });
  const unreachable = await send({ type: "listView", view: "picked" });
  assert.equal(unreachable.code, "root-unreachable", `expected root-unreachable, saw ${JSON.stringify(unreachable)}`);
  assert.ok(unreachable.detail || unreachable.why, "root-unreachable arrived with nothing to act on");
});

// 4 ------------------------------------------------------------------------------------------
test("7cd.4 One bounded listing: no tree walk, no read per entry", { timeout: 90000 }, async () => {
  // The folder was deleted by check 3; a fresh one is dropped so this check stands on its own.
  const parent = mkdtempSync(path.join(os.tmpdir(), "voicebox-explorer-again-"));
  const again = path.join(parent, "crowded-root");
  mkdirSync(again);
  for (let i = 0; i < CROWDED; i++) writeFileSync(path.join(again, `file-${String(i).padStart(3, "0")}.txt`), `${i}`);
  await page.dropFolder("#dropzone", again);
  await page.waitFor(
    async (expected) => {
      const reply = await window.e1m0.send({ type: "listProjects" });
      return (reply.projects ?? []).some((p) => p.name === expected && p.rootKind === "handle");
    },
    { args: ["crowded-root"], label: "the replacement folder" },
  );

  const before = await stats();
  const listing = await page.evaluate(async (limit) => {
    const reply = await window.e1m0.send({ type: "listView", view: "picked", limit });
    return { ok: reply.ok, count: (reply.entries ?? []).length, truncated: reply.truncated };
  }, LIMIT);
  const after = await stats();

  assert.equal(listing.ok, true);
  assert.equal(listing.count, LIMIT, `a bounded listing returned ${listing.count} entries for a limit of ${LIMIT}`);
  assert.equal(listing.truncated, true, "a truncated listing did not say it was truncated");

  // One message for the listing, and not one read: the entries' names and sizes came from the
  // single directory iteration rather than from opening 300 files.
  assert.equal(after.messages - before.messages, 1, "rendering a listing took more than one message");
  assert.equal(after.listings - before.listings, 1, "rendering a listing took more than one listing");
  assert.equal(after.reads - before.reads, 0, "rendering a listing read files it did not need to read");

  rmSync(parent, { recursive: true, force: true });
});
