// tests/opfs-scratch-room.test.mjs — voicebox-beads-fqq: a browser-stored project, made from the page
// with NO host token and NO path, listed and read by the ROOM, and surviving a reload.
//
//   node --test tests/opfs-scratch-room.test.mjs
//
// The defect this pins: declaring a root required the host token, and the page cannot hold one — so a
// browser-stored project could never be declared, so a fresh room could not list or write anything.
// The fix has two halves, and BOTH are asserted here because either alone is a hole:
//
//   1. the page may declare what only the page can act on (a page-owned root grants the server no
//      file-route power: core/root.ts reachableFrom ["page"], and browser/acts.ts refuses a root that
//      is not the page's own), authorized by the SAME rule /channel uses — Origin is this server's own;
//   2. with NO root declared at all, the room's listing and read route to the page, which answers for
//      the project it holds. Nothing is stored server-side; the answer says via:"page" and names the root.
//
// And the boundary is asserted in the negative, because "an unnamed root means my own project" must not
// become "any root is fine": a call naming a root the page does not hold is still root-not-mine, and a
// machine root still needs the host token.
import { test } from "node:test";
import assert from "node:assert/strict";
import { startServer } from "./lib/server.mjs";
import { launch } from "./lib/cdp.mjs";
import { setTimeout as sleep } from "node:timers/promises";

let server;
const readRoot = (s) => fetch(`${s.base}/api/root`).then((r) => r.json());
const declare = (s, body, headers = {}) =>
  fetch(`${s.base}/api/root`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() }));

test.before(async () => { server = await startServer({ env: { VOICEBOX_INSTANCE: "opfs-fqq" } }); });
test.after(async () => { await server?.stop?.(); });

test("a fresh room, a browser project made from the page, and a room that lists it with nothing declared", { timeout: 120000 }, async () => {
  // ── a fresh server: no root declared, and no host token used anywhere in this test ──
  const fresh = await readRoot(server);
  assert.equal(fresh.declared, false, "the server starts with no root declared");
  assert.equal(fresh.root, null, "and no root object to describe");

  const page = await launch({ width: 1200, height: 900 });
  try {
    await page.goto(`${server.base}/environment.html`);
    await page.waitFor(() => window.e1m0 !== undefined, { label: "the environment page's host API" });
    await sleep(800);

    // ── THE AFFORDANCE: a control a person uses, with no token and no path ──
    await page.type("#project-name", "scratch-fqq-test");
    await page.click('#open-form button[type="submit"]');
    await page.waitFor(() => /made\s+scratch-fqq-test/i.test(document.body.textContent ?? ""), { label: "the page says it MADE the project" });

    // ── the page declared it, and the server accepted it WITHOUT a host token ──
    const declared = await readRoot(server);
    assert.equal(declared.ok, true, "the declaration was accepted");
    assert.equal(declared.actsVia, "page", "a browser-stored root is acted on by the page");
    assert.equal(declared.root.kind, "opfs", "and its kind is opfs");
    assert.equal(declared.reachableFromThisProcess, false, "the server still cannot act on it");
    const post = await declare(server, { project: "scratch-fqq-test", root: { kind: "opfs", path: "v1/projects/scratch-fqq-test" } }, { origin: server.base });
    assert.equal(post.status, 200, "and a POST from the page's own origin is accepted without the token");
    assert.equal(post.body.declaredBy, "page", "the answer says the PAGE declared it, not the host");

    // ── a file written through the page's own write path ──
    await page.type("#asset-name", "hello-from-the-browser.txt");
    await page.type("#asset-body", "written by the page, in this browser's storage\n");
    await page.click('#asset-form button[type="submit"]');
    await page.waitFor(() => /hello-from-the-browser\.txt/.test(document.body.textContent ?? ""), { label: "the page reports writing the file" });

    const listing = await fetch(`${server.base}/api/files`).then((r) => r.json());
    assert.equal(listing.ok, true, "the room can list the project");
    assert.equal(listing.via, "page", "and the listing says whose it is");
    assert.equal(listing.root.kind, "opfs", "against the page's own root");
    assert.ok(listing.files.includes("assets"), `the page writes assets into assets/ by design; the root lists that folder — got ${JSON.stringify(listing.files)}`);

    const read = await fetch(`${server.base}/api/file?name=${encodeURIComponent("assets/hello-from-the-browser.txt")}`).then((r) => r.json());
    assert.equal(read.ok, true, "and the room READS the file through the page");
    assert.match(read.content, /written by the page/, "with the bytes the page wrote");
    assert.equal(read.via, "page", "attributed to the page");
  } finally { await page.close(); }
});

test("with NO root declared, the page is still the source — and a page that holds no project says so by name", { timeout: 60000 }, async () => {
  // A NEW server, so nothing is declared at all: this is the fqq state itself, and it is the state the
  // room hits after a restart (the page keeps holding its project; the server holds nothing).
  const s = await startServer({ env: { VOICEBOX_INSTANCE: "opfs-fqq-fresh" } });
  try {
    assert.equal((await readRoot(s)).declared, false, "nothing is declared on this instance");
    const page = await launch({ width: 1200, height: 900 });
    try {
      await page.goto(`${s.base}/environment.html`);
      await page.waitFor(() => window.e1m0 !== undefined, { label: "the environment page" });
      await sleep(600);

      // The page is connected but holds NO project: the listing is a NAMED refusal with a route, not an
      // empty folder that looks like a project with nothing in it.
      const empty = await fetch(`${s.base}/api/files`).then((r) => r.json());
      assert.equal(empty.ok, false, "a page with no project cannot list one");
      assert.equal(empty.refused, "no-project", `named refusal expected, got ${JSON.stringify(empty)}`);
      assert.match(String(empty.why), /environment page/, "and the refusal names where to open one");

      // Now the page makes a project WITHOUT declaring it to the server at all: open it through the
      // worker directly (e1m0.send), so the server never hears about a root — the pure fqq case.
      await page.evaluate(() => window.e1m0.send({ type: "openProject", name: "undeclared-room" }));
      await sleep(600);
      await page.evaluate(() => window.e1m0.create("nothing-declared.txt", "text", "this file exists with no root declared anywhere\n"));
      await sleep(800);
      assert.equal((await readRoot(s)).declared, false, "the server STILL has nothing declared");

      const listing = await fetch(`${s.base}/api/files`).then((r) => r.json());
      assert.equal(listing.ok, true, "yet the room can list the page's project");
      assert.equal(listing.declared, false, "the answer says no root was declared");
      assert.equal(listing.via, "page", "and that the page is the source");
      assert.ok(listing.files.includes("assets"), `the page's assets folder is listed — got ${JSON.stringify(listing.files)}`);

      const read = await fetch(`${s.base}/api/file?name=${encodeURIComponent("assets/nothing-declared.txt")}`).then((r) => r.json());
      assert.equal(read.ok, true, "and the file reads back with nothing declared");
      assert.match(read.content, /no root declared anywhere/, "with its bytes");
    } finally { await page.close(); }
  } finally { await s.stop?.(); }
});

test("the boundary holds: a machine root still needs the host token, and a foreign origin cannot declare", { timeout: 60000 }, async () => {
  const s = await startServer({ env: { VOICEBOX_INSTANCE: "opfs-fqq-boundary" } });
  try {
    // A machine root re-points the server's OWN file routes, so the token is what stops a stranger
    // aiming the loop at any file the process can read. Unchanged by this bead.
    const machine = await declare(s, { project: "m", root: { kind: "machine", path: "/tmp" } }, { origin: s.base });
    assert.equal(machine.status, 403, "a machine root without the token is refused");
    assert.equal(machine.body.refused, "host-token-required", "by name");

    // A page-owned root is a different act — but only THIS server's own page may declare one. A request
    // from another origin is refused, and the refusal says which rule it failed.
    const foreign = await declare(s, { project: "x", root: { kind: "opfs", path: "v1/projects/x" } }, { origin: "http://evil.example" });
    assert.equal(foreign.status, 403, "a page-owned root from a foreign origin is refused");
    assert.equal(foreign.body.refused, "host-token-required", "also by name");
    assert.match(String(foreign.body.why), /own origin/, "and the why names the rule that would have allowed it");

    // And with the host token, a machine root still declares exactly as before.
    const withToken = await declare(s, { project: "m", root: { kind: "machine", path: "/tmp" } }, { "x-voicebox-host-token": s.hostToken });
    assert.equal(withToken.status, 200, "the host may still declare a machine root");
    assert.equal(withToken.body.actsVia, "server", "which the server acts on");
  } finally { await s.stop?.(); }
});

test("a call naming a root the page does not hold is STILL refused — an unnamed root is not a wildcard", { timeout: 60000 }, async () => {
  const s = await startServer({ env: { VOICEBOX_INSTANCE: "opfs-fqq-notmine" } });
  try {
    const page = await launch({ width: 1200, height: 900 });
    try {
      await page.goto(`${s.base}/environment.html`);
      await page.waitFor(() => window.e1m0 !== undefined, { label: "the environment page" });
      await page.evaluate(() => window.e1m0.send({ type: "openProject", name: "mine" }));
      await sleep(600);

      // The HOST declares a page-owned root with a path this page does NOT hold. The server will name it
      // when it routes the act, and the page must refuse — that check is what stops the server aiming the
      // page at storage it does not own, and allowing an UNNAMED root must not have loosened it.
      const notMine = await declare(s, { project: "not-mine", root: { kind: "opfs", path: "v1/projects/something-else" } }, { "x-voicebox-host-token": s.hostToken });
      assert.equal(notMine.status, 200, "the host can declare it (the declaration itself grants nothing)");
      const listing = await fetch(`${s.base}/api/files`).then((r) => r.json());
      assert.equal(listing.ok, false, "but the listing through the page is refused");
      assert.equal(listing.refused, "root-not-mine", `the page refuses a root it does not hold — got ${JSON.stringify(listing)}`);
    } finally { await page.close(); }
  } finally { await s.stop?.(); }
});
