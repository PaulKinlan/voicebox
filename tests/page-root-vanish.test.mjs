// tests/page-root-vanish.test.mjs — journal-omr, the page-owned half.
//
// The machine half of this bead is covered in tests/root-seam.test.mjs and
// tests/one-root.test.mjs (`root-vanished`, answered fast, with the remedy).
// This suite covers the OTHER root kinds the bead names: a page-owned root
// whose storage disappears under a live declaration.
//
// The shape that makes this a defect rather than a nuisance: browser storage
// writes are `create: true` all the way down (browser/storage.ts), so a write
// into a cleared OPFS project does not fail — it REBUILDS the tree and reports
// success. The person's project comes back empty and the act says it landed.
// "The system knows something is wrong and does not say so" is the family the
// whole refusal vocabulary exists to stop; a vanished root must be refused by
// name, with the remedy, instead of being recreated.
//
// Driven end to end: a real server, a real environment page in headless
// Chromium, a real OPFS project, and the project folder removed through the
// browser's own storage API — the same thing an origin eviction does.
import test from "node:test";
import assert from "node:assert/strict";
import { startServer } from "./lib/server.mjs";
import { launch } from "./lib/cdp.mjs";
import { setTimeout as sleep } from "node:timers/promises";

let server;
let BASE;
let page;

test.before(async () => {
  server = await startServer({ env: { VOICEBOX_INSTANCE: "page-root-vanish" } });
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

const turn = (transcript) =>
  fetch(`${BASE}/api/turn`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ transcript }),
  }).then((r) => r.json());

const declareAsHost = (project, root) =>
  fetch(`${BASE}/api/root`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-voicebox-host-token": server.hostToken },
    body: JSON.stringify({ project, root }),
  }).then((r) => r.json());

/** Clear the project's OPFS folder through the browser API — what an eviction leaves behind. */
const clearProjectFolder = (name) =>
  page.evaluate(async (projectName) => {
    const origin = await navigator.storage.getDirectory();
    const v1 = await origin.getDirectoryHandle("v1");
    const projects = await v1.getDirectoryHandle("projects");
    await projects.removeEntry(projectName, { recursive: true });
    return true;
  }, name);

const projectFolderExists = (name) =>
  page.evaluate(async (projectName) => {
    try {
      const origin = await navigator.storage.getDirectory();
      const v1 = await origin.getDirectoryHandle("v1", { create: false });
      const projects = await v1.getDirectoryHandle("projects", { create: false });
      await projects.getDirectoryHandle(projectName, { create: false });
      return true;
    } catch {
      return false;
    }
  }, name);

test("a CLEARED OPFS root refuses by name with the remedy — never a silent rebuild, never a hold", { timeout: 120000 }, async () => {
  const opened = await page.evaluate(async () => await window.e1m0.send({ type: "openProject", name: "cleared" }));
  assert.equal(opened.ok, true, JSON.stringify(opened));

  const declared = await declareAsHost("cleared", { kind: "opfs", path: "v1/projects/cleared" });
  assert.equal(declared.ok, true, JSON.stringify(declared));
  assert.equal(declared.actsVia, "page", JSON.stringify(declared));

  // It works a moment ago: a routed write lands and reads back.
  const before = await turn("create a file called before.txt with here");
  assert.equal(before.result?.ok, true, JSON.stringify(before.result));
  assert.equal(await projectFolderExists("cleared"), true);

  // The folder goes away underneath the live declaration.
  assert.equal(await clearProjectFolder("cleared"), true);
  assert.equal(await projectFolderExists("cleared"), false, "the fixture failed to clear the folder");

  // 1. The listing refuses by name rather than showing an empty project.
  const files = await fetch(`${BASE}/api/files`).then((r) => r.json());
  assert.equal(files.ok, false, `the listing claimed success: ${JSON.stringify(files)}`);
  assert.equal(files.refused, "root-vanished", JSON.stringify(files));

  // 2. The write ANSWERS FAST and refuses by name. The defect this bead names is silence, so
  //    "it replied quickly" is the property, not merely "it replied correctly".
  const answered = await Promise.race([
    turn("create a file called after.txt with hi"),
    sleep(5000).then(() => ({ timedOut: true })),
  ]);
  assert.equal(answered.timedOut, undefined, "the server held the request after the root vanished");
  assert.equal(answered.result?.ok, false, `a write into a vanished root claimed to land: ${JSON.stringify(answered.result)}`);
  assert.equal(answered.result?.refused, "root-vanished", JSON.stringify(answered.result));
  assert.match(answered.result?.why ?? "", /open the project again|declare it again|re-declare/, "the refusal does not state the remedy");
  assert.equal(answered.result?.logged, null, "a vanished root claims to have written a log entry");

  // 3. The refusal did not rebuild the tree: no folder, no audit entry inside it.
  assert.equal(await projectFolderExists("cleared"), false, "the refusal silently recreated the cleared root");

  // 4. A read says the ROOT is gone, not that the file is missing from a project that still exists.
  const read = await turn("read before.txt");
  assert.equal(read.result?.refused, "root-vanished", JSON.stringify(read.result));

  // 5. The remedy works: re-opening the project recreates its folder and the loop acts again.
  const reopened = await page.evaluate(async () => await window.e1m0.send({ type: "openProject", name: "cleared" }));
  assert.equal(reopened.ok, true, JSON.stringify(reopened));
  const recovered = await turn("create a file called recovered.txt with back");
  assert.equal(recovered.result?.ok, true, `re-opening did not restore the loop: ${JSON.stringify(recovered.result)}`);
});
