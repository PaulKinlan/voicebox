// tests/n20-picked-root.test.mjs — N20's five checks, driven.
//
//   node --test tests/n20-picked-root.test.mjs
//
// N20: "it's not just OPFS, but also directory handles that are persistent". The checks below are
// the five the coordinator asked for on top of E1-M0's eight: a picked root as a REAL root kind,
// a handle that survives a reload with no re-pick and no gesture, containment that holds exactly
// as it does for OPFS, a record that can say which kind of root it has, and a permission failure
// that says which permission problem it is.
//
// THE HONEST LIMIT, stated here rather than buried: headless Chrome cannot GRANT write permission
// on a real folder. `queryPermission({mode:"readwrite"})` returns "prompt" for a folder that was
// dropped, and an attempt in that state does not fail — it waits for a dialog no script can
// answer (measured, docs/evidence/picked-root-20260919/). So the real folder is driven for
// everything that does not need the grant (adoption, persistence, listing, reading, containment,
// the named permission failure), and the handle-kind WRITE path is driven through a handle that
// has implicit permission — the origin's own directory handle — through the same code path.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { startServer } from "./lib/server.mjs";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { launch } from "./lib/cdp.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let server;
let BASE;
let page;
let folder;
let folderName;

const send = (message) => page.evaluate((m) => window.e1m0.send(m), message);
// Reopening through the PAGE, not the worker: the header, the root kind and the recovery action
// are the UI's job, and a check that talks to the worker directly would not test the page at all.
const reopen = (name) =>
  page.evaluate(async (n) => {
    const reply = await window.e1m0.open(n);
    return { ok: reply.ok, code: reply.code, rootKind: reply.project?.rootKind, permission: reply.project?.durability?.permission };
  }, name);
// Dropping the folder again is the gesture that restores access — and it is a real user act, so
// it is the honest way to get back to a readable state for the checks that follow the reload.
const restoreAccess = () => page.dropFolder("#dropzone", folder);
const waitForHandleProject = (name) =>
  page.waitFor(
    async (expected) => {
      const reply = await window.e1m0.send({ type: "listProjects" });
      return (reply.projects ?? []).some((p) => p.name === expected && p.rootKind === "handle");
    },
    { args: [name], label: `the picked project '${name}'` },
  );

test.before(async () => {
  // A lowercase name on purpose: the page derives the project name from the folder, and a test
  // that compares against a mixed-case name would be testing the sanitiser instead of the root.
  const parent = mkdtempSync(path.join(os.tmpdir(), "voicebox-n20-"));
  folder = path.join(parent, "picked-folder");
  mkdirSync(folder);
  folderName = path.basename(folder);
  writeFileSync(path.join(folder, "real.txt"), "hello from the real filesystem\n");
  mkdirSync(path.join(folder, "notes"));
  writeFileSync(path.join(folder, "notes", "deep.txt"), "nested\n");
  server = await startServer({
    cwd: ROOT,
    env: { ...process.env, VOICEBOX_INSTANCE: "n20-picked" },
  });
  BASE = server.base;
  page = await launch();
  await page.goto(`${BASE}/environment.html`);
  await page.waitFor(() => window.e1m0 !== undefined, { label: "the page's host API" });
});

test.after(async () => {
  await page?.close();
  await server?.stop();
  rmSync(folder, { recursive: true, force: true });
});

// 1 ------------------------------------------------------------------------------------------
test("N20.1 A project whose root IS a picked directory", { timeout: 90000 }, async () => {
  await page.dropFolder("#dropzone", folder);
  await waitForHandleProject(folderName);

  const projects = await send({ type: "listProjects" });
  const record = projects.projects.find((p) => p.name === folderName);
  assert.ok(record, `the dropped folder did not become a project: ${JSON.stringify(projects.projects.map((p) => p.name))}`);
  assert.equal(record.rootKind, "handle", "the project's root is not a picked directory");
  assert.equal(record.root, `picked:${folderName}`, "a handle root needs a virtual root string");

  const listing = await send({ type: "listView", view: "picked" });
  assert.equal(listing.ok, true, JSON.stringify(listing));
  const names = listing.entries.map((e) => e.name);
  assert.deepEqual(names.sort(), readdirSync(folder).sort(), "the listing does not match the folder on disk");

  const read = await send({ type: "readFile", path: "real.txt" });
  assert.equal(read.ok, true, "a file in the picked folder could not be read");
  assert.equal(read.text, readFileSync(path.join(folder, "real.txt"), "utf8"), "the read did not come from the folder");
});

// 2 ------------------------------------------------------------------------------------------
test("N20.2 The handle survives a reload: no re-pick, and the state is queried rather than assumed", { timeout: 90000 }, async () => {
  await page.reload();
  await page.waitFor(() => window.e1m0 !== undefined, { label: "the host API after reload" });

  const after = await page.evaluate(async (name) => {
    await window.e1m0.ready;
    const state = await window.e1m0.send({ type: "handleState", name });
    const opened = await window.e1m0.send({ type: "openProject", name });
    const read = await window.e1m0.send({ type: "readFile", path: "real.txt" });
    return {
      activation: navigator.userActivation.isActive,
      everActivated: navigator.userActivation.hasBeenActive,
      handle: state,
      opened: opened.ok,
      rootKind: opened.project?.rootKind,
      permission: opened.project?.durability?.permission,
      auditLocation: opened.project?.auditLocation,
      readCode: read.code,
      readWhy: read.why,
      readText: read.text,
    };
  }, folderName);

  assert.equal(after.activation, false, "the check used a user gesture it was not allowed to use");
  assert.equal(after.everActivated, false, "a gesture happened earlier in this profile");

  // The handle came back WITHOUT a picker: it is in IndexedDB, and the browser still knows which
  // folder it names. That is the N20 requirement — "a reload must not ask the user to find their
  // folder again" — and it is the thing OPFS gets for free and this shape has to earn.
  assert.equal(after.handle.ok, true, "the persisted handle could not be read back");
  assert.equal(after.handle.name, folderName, "the persisted handle names a different folder");

  // The permission is QUERIED, never assumed: this browser drops a real folder's access on reload
  // and requires a gesture to restore it (measured — the receipt has the numbers). So the honest
  // result is the named state, not a silent failure and not a fake success.
  assert.equal(after.opened, true, "the picked project could not be reopened after a reload");
  assert.equal(after.rootKind, "handle");
  assert.equal(after.permission, "prompt", `expected the queried state to be 'prompt', saw '${after.permission}'`);
  assert.match(after.auditLocation, /origin/, "the record does not say where a read-only root's log lives");
  assert.equal(after.readCode, "needs-gesture", `expected a named gesture failure, saw ${after.readCode}`);
  assert.match(after.readWhy, /click/, "the failure does not say what would restore access");
  assert.equal(after.readText ?? null, null, "a refused read returned content anyway");
});

// 3 ------------------------------------------------------------------------------------------
test("N20.3 Containment holds for a picked root exactly as for OPFS", { timeout: 90000 }, async () => {
  await restoreAccess();
  assert.equal((await reopen(folderName)).ok, true, "the picked project could not be reopened");

  const refused = await send({ type: "createAsset", args: { name: "../escape.svg", kind: "svg", body: "<svg/>" } });
  assert.equal(refused.refused, true, `the escape was not refused: ${JSON.stringify(refused)}`);
  assert.equal(refused.rule, "outside-root", "the refusal does not name the containment rule");
  assert.match(refused.why, /'\.\.' segment/, "the refusal does not say why in the mechanism's own words");
  // The world, not the report: nothing appeared outside the picked folder.
  assert.equal(existsSync(path.join(path.dirname(folder), "escape.svg")), false, "a file escaped the picked root");

  // The positive control, on the same root: a sibling name resolves and reads.
  const sibling = await send({ type: "readFile", path: "notes/deep.txt" });
  assert.equal(sibling.ok, true, "a sibling path inside the picked root was not accepted");

  const resolver = await page.evaluate(async () => {
    const { resolveInsideRoot } = await import("/core/paths.ts");
    return {
      escape: resolveInsideRoot("picked:x", ".."),
      dotdotDeep: resolveInsideRoot("picked:x", "a/../../b"),
      inside: resolveInsideRoot("picked:x", "notes/deep.txt"),
    };
  });
  assert.equal(resolver.escape.ok, false);
  assert.equal(resolver.dotdotDeep.ok, false, "'..' must be refused at any depth");
  assert.equal(resolver.inside.ok, true);
  assert.equal(resolver.inside.path, "picked:x/notes/deep.txt");
});

// 4 ------------------------------------------------------------------------------------------
test("N20.4 The record can say which kind of root it has", { timeout: 90000 }, async () => {
  const projects = await send({ type: "listProjects" });
  const picked = projects.projects.find((p) => p.name === folderName);
  const opfs = projects.projects.find((p) => p.name === "atlas");

  assert.equal(picked.rootKind, "handle", "the record does not say which kind of root it has");
  assert.equal(picked.location.kind, "handle");
  assert.equal(picked.location.label, folderName, "the record lost the folder's own label");
  assert.equal(picked.durability.kind, "handle");
  assert.ok(["granted", "prompt", "denied"].includes(picked.durability.permission), "the permission state is not recorded");
  assert.equal(picked.undoKind, "written-file-list");

  assert.equal((await reopen(folderName)).ok, true, "the picked project could not be opened through the page");
  const header = await page.evaluate(() => document.getElementById("project").textContent);
  assert.match(header, /a folder you picked in this browser/, "the page does not say which kind of folder the project has");
  assert.match(header, /picked:/, "the page does not show the root");
  assert.match(header, /handle is persisted in IndexedDB/, "the page does not state the recovery story");
  assert.match(header, /permission is prompt/, "the page does not report the permission it queried");

  // And the fallback is not a failure: an OPFS project still exists, and says so.
  const opfsRecord = opfs ?? (await send({ type: "openProject", name: "atlas" })).project;
  assert.equal(opfsRecord.rootKind, "opfs", "the OPFS root kind is not recorded");
});

// 5 ------------------------------------------------------------------------------------------
test("N20.5 The permission failure path says WHY, by name", { timeout: 90000 }, async () => {
  await restoreAccess();
  assert.equal((await reopen(folderName)).ok, true, "the picked project could not be reopened");

  // (a) A write with permission at 'prompt' is refused in words — the state the platform is
  // actually in, and the one that only a click can change.
  const write = await send({ type: "createAsset", args: { name: "from-the-tool.txt", kind: "text", body: "x" } });
  assert.equal(write.ok, false);
  assert.equal(write.code, "needs-gesture", `expected a named gesture failure, saw ${JSON.stringify(write)}`);
  assert.match(write.why, /prompt/, "the failure does not name the permission state");
  assert.match(write.why, /click/, "the failure does not say what would restore access");
  assert.match(write.why, /OPFS needs no such thing/, "the failure does not distinguish the two root kinds");
  assert.equal(existsSync(path.join(folder, "from-the-tool.txt")), false, "a refused write still wrote");

  const audit = await send({ type: "audit" });
  const refusal = audit.entries.filter((e) => e.rule === "needs-gesture").pop();
  assert.ok(refusal, "the refusal was not recorded in the audit");
  assert.equal(refusal.result, "refused");

  // The page offers the one thing that can change the state, and says so.
  const regrantVisible = await page.evaluate(() => !document.getElementById("regrant").hidden);
  assert.equal(regrantVisible, true, "the page does not offer to restore access");

  // (b) A handle that this browser does not hold is a different fact, with its own name.
  const gone = await send({ type: "handleState", name: "picked-in-another-profile" });
  assert.equal(gone.code, "handle-gone", `expected handle-gone, saw ${JSON.stringify(gone)}`);
  assert.match(gone.why, /profile/, "handle-gone does not explain where the handle could be");

  // (c) A root that is gone from the disk is a third fact — and it is what a deleted folder is,
  // not an empty folder.
  rmSync(folder, { recursive: true, force: true });
  const unreachable = await send({ type: "listView", view: "picked" });
  assert.equal(unreachable.code, "root-unreachable", `expected root-unreachable, saw ${JSON.stringify(unreachable)}`);
  assert.match(unreachable.why, /gone, renamed, or on a volume/, "root-unreachable does not say what it means");

  const codes = new Set([write.code, gone.code, unreachable.code]);
  assert.equal(codes.size, 3, "the three failure modes are not distinguishable");
  for (const code of codes) assert.notEqual(code, undefined, "a failure arrived with no code at all");
});

// 6 — the handle-kind WRITE path, through a handle that has implicit permission
test("N20.6 A handle root can be written through, when the grant exists", { timeout: 90000 }, async () => {
  const adopted = await page.evaluate(async () => {
    const origin = await navigator.storage.getDirectory();
    const dir = await origin.getDirectoryHandle("n20-handle-root", { create: true });
    return await window.e1m0.adopt(dir);
  });
  assert.equal(adopted.ok, true, `adopting an origin directory handle failed: ${JSON.stringify(adopted)}`);
  assert.equal(adopted.project.rootKind, "handle", "the adopted root is not a handle root");

  const written = await send({ type: "createAsset", args: { name: "through-a-handle.txt", kind: "text", body: "written through a handle root" } });
  assert.equal(written.ok, true, `the write through a handle root failed: ${JSON.stringify(written)}`);
  assert.equal(written.observed.exists, true);

  const audit = await send({ type: "audit" });
  const entry = audit.entries.filter((e) => e.act?.target.endsWith("through-a-handle.txt")).pop();
  assert.equal(entry.decision, "allow");
  assert.equal(entry.rule, "writes-inside");
  assert.equal(entry.root, "picked:n20-handle-root", "the audit does not record the virtual root of the handle");

  const read = await send({ type: "readFile", path: "assets/through-a-handle.txt" });
  assert.equal(read.text, "written through a handle root");
});
