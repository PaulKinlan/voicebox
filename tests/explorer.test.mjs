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
import { startServer } from "./lib/server.mjs";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { launch } from "./lib/cdp.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CROWDED = 300; // more files than one listing shows, so "bounded" is measurable
const LIMIT = 200;

let server;
let BASE;
let page;
let folder;
let folderName;
let emptyFolder;
let machineRoot;

const send = (message) => page.evaluate((m) => window.e1m0.send(m), message);

/** Declare a root AS THE HOST (the token lives in the host's own directory — voicebox-beads-cfn). */
const declareAsHost = (project, root) =>
  fetch(`${BASE}/api/root`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-voicebox-host-token": server.hostToken },
    body: JSON.stringify({ project, root }),
  }).then((r) => r.json());
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
  emptyFolder = path.join(path.dirname(folder), "empty-root");
  machineRoot = path.join(path.dirname(folder), "machine-root");
  mkdirSync(machineRoot);
  server = await startServer({
    cwd: ROOT,
    env: { VOICEBOX_WORKSPACE: undefined, VOICEBOX_INSTANCE: "explorer" },
  });
  BASE = server.base;
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
  await server?.stop();
  rmSync(path.dirname(folder), { recursive: true, force: true }); // takes empty-root with it
});

// 1 ------------------------------------------------------------------------------------------
test("7cd.1 Three views, three authorities, and each one names the root it is showing — or refuses by name", { timeout: 90000 }, async () => {
  // (a) a project whose root the PAGE owns: the origin view and the picked view are real, and the
  // machine view refuses by name rather than listing some other folder under a machine heading.
  await send({ type: "openProject", name: folderName });
  // The HOST declares this page-owned root. Since voicebox-beads-fqq the PAGE may also declare a root
  // only the page can act on, so the host is kept as the declarer here to keep the two acts
  // distinguishable — which is what makes "the machine cannot reach this root" a fact the server can
  // report rather than a guess.
  assert.equal((await declareAsHost(folderName, { kind: "handle", id: folderName })).ok, true);
  const opfs = await send({ type: "listView", view: "opfs", limit: LIMIT });
  const picked = await send({ type: "listView", view: "picked", limit: LIMIT });
  for (const [name, reply] of [["opfs", opfs], ["picked", picked]]) {
    assert.equal(reply.ok, true, `the ${name} view failed: ${JSON.stringify(reply)}`);
    assert.ok(reply.authority?.where, `the ${name} view does not say where its files are`);
    assert.ok(reply.authority?.whoCanSee, `the ${name} view does not say who can see its files`);
    assert.ok(reply.root.length > 0, `the ${name} view does not name its root`);
  }
  assert.equal(opfs.authority.needsGesture, false, "OPFS needs no gesture and must say so");
  assert.equal(picked.authority.needsGesture, true, "a picked folder may need a gesture and must say so");
  assert.match(opfs.authority.whoCanSee, /nothing outside this origin/);
  assert.match(picked.authority.whoCanSee, /anything on this machine/);

  const machineBefore = await send({ type: "listView", view: "server" });
  assert.equal(machineBefore.ok, false, `the machine view served a page-owned root: ${JSON.stringify(machineBefore)}`);
  assert.equal(machineBefore.code, "root-not-reachable-from-here");
  assert.match(machineBefore.why, /page/, "the refusal does not name who can act on this root");

  // (b) the same project declares a root on the machine: now the machine view is the real one, it
  // names the folder, and the picked view refuses by name — the pair, from both sides.
  // The HOST declares it (the page declares its own roots too since voicebox-beads-fqq; the host's act
  // is the one that makes the SERVER the actor, which is the authority this half is about).
  await fetch(`${BASE}/api/root`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-voicebox-host-token": server.hostToken },
    body: JSON.stringify({ project: "explorer", root: { kind: "machine", path: machineRoot } }),
  });
  const machine = await send({ type: "listView", view: "server", limit: LIMIT });
  const pickedAfter = await send({ type: "listView", view: "picked", limit: LIMIT });
  assert.equal(machine.ok, true, `the machine view failed after declaring its root: ${JSON.stringify(machine)}`);
  assert.equal(machine.root, machineRoot, "the machine view does not name the root it is showing");
  assert.match(machine.authority.where, /a folder on this machine/);
  assert.match(machine.authority.whoCanSee, /anything on that machine/);
  // The picked view still answers for the PAGE's own project: the host's machine root is a different
  // actor's fact now that the page cannot declare (voicebox-beads-cfn). Three views, three authorities,
  // all answering, each naming its own root — which is what this check is named for.
  assert.equal(pickedAfter.ok, true, `the picked view failed: ${JSON.stringify(pickedAfter)}`);
  assert.notEqual(pickedAfter.root, machine.root, "the picked view reports the machine root");

  // Three roots, three authorities, and no two of them the same thing.
  assert.equal(new Set([opfs.root, picked.root, machine.root]).size, 3, "two views claim the same root");

  // And the page renders all three: the two that answer name their root, the third shows its refusal.
  // ORDER MATTERS NOW (voicebox-beads-fqq): `e1m0.open` makes the page DECLARE its own project, which the
  // page may do since fqq — so the host's machine declaration has to come AFTER it, or the machine root
  // would no longer be the active one and the machine panel would refuse (correctly) instead of naming
  // it. Three authorities, unchanged; only who declared last is.
  await page.evaluate(async (name) => {
    await window.e1m0.open(name); // the project the page owns, so the picked panel has something real to show
  }, folderName);
  await fetch(`${BASE}/api/root`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-voicebox-host-token": server.hostToken },
    body: JSON.stringify({ project: "explorer", root: { kind: "machine", path: machineRoot } }),
  });
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
  assert.match(panels.opfs, /v1/, "the origin panel does not name its root");
  assert.match(panels.picked, /a real folder on this machine/, "the picked panel does not name its authority");
  assert.match(panels.server, new RegExp(machineRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "the machine panel does not name the root it is showing");
  assert.notEqual(panels.opfs, panels.picked, "two panels render the same thing");
});

// 2 ------------------------------------------------------------------------------------------
test("7cd.2 'You are not pointing at a project' and 'your project is empty' are different answers", { timeout: 90000 }, async () => {
  // (a) nothing behind the view: a named refusal, because an empty list here would look exactly
  // like an empty folder and the person could not tell which one they are in.
  await send({ type: "openProject", name: "atlas" }); // an OPFS project: there is no picked folder
  const refused = await send({ type: "listView", view: "picked" });
  assert.equal(refused.ok, false, "a picked view was offered for a project that has no picked root");
  assert.equal(refused.code, "not-a-project", `expected not-a-project, saw ${JSON.stringify(refused)}`);
  assert.match(refused.why, /OPFS project/, "the refusal does not say what this project actually is");

  // The page shows the refusal, not an empty list that looks like an empty folder.
  await page.evaluate(() => window.e1m0.renderView("picked"));
  const panel = await page.evaluate(() => document.getElementById("view-picked").textContent);
  assert.match(panel, /not-a-project/);
  assert.match(panel, /OPFS project/);

  // (b) a genuinely empty project: a SUCCESS with zero entries — the other side of the pair, and
  // the side that would otherwise collapse into (a) without anything failing.
  mkdirSync(emptyFolder);
  await page.dropFolder("#dropzone", emptyFolder);
  await page.waitFor(
    async (expected) => {
      const reply = await window.e1m0.send({ type: "listProjects" });
      return (reply.projects ?? []).some((p) => p.name === expected && p.rootKind === "handle");
    },
    { args: ["empty-root"], label: "the empty folder to be adopted" },
  );
  const empty = await send({ type: "listView", view: "picked" });
  assert.equal(empty.ok, true, `an empty root must list successfully, saw ${JSON.stringify(empty)}`);
  assert.deepEqual(empty.entries, [], "an empty folder returned entries");
  assert.equal(empty.truncated, false, "an empty folder claimed to be truncated");
  assert.notEqual(empty.ok, refused.ok, "'no project' and 'empty project' answered the same way");

  // (c) the machine's root is not this root: the explorer's server panel refuses BY NAME when the
  // active root belongs to the page, instead of listing some other folder under a machine heading.
  await send({ type: "openProject", name: "atlas" });
  // The HOST declares the page-owned root: that is what makes "the machine cannot reach this root" a
  // fact the server can report rather than a guess (the page cannot declare it any more).
  assert.equal((await declareAsHost("atlas", { kind: "opfs", path: "v1/projects/atlas" })).ok, true);
  const server = await send({ type: "listView", view: "server" });
  assert.equal(server.ok, false, `the machine panel served a page-owned root: ${JSON.stringify(server)}`);
  assert.equal(server.code, "root-not-reachable-from-here");
  assert.match(server.why, /page/, "the refusal does not name who can act on this root");
  await page.evaluate(() => window.e1m0.renderView("server"));
  const refusedPanel = await page.evaluate(() => document.getElementById("view-server").textContent);
  assert.match(refusedPanel, /root-not-reachable-from-here/, "the panel does not show the refusal");
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
