// tests/room-page-owned-root.test.mjs — WHAT THE ROOM SAYS ABOUT A FOLDER THE TAB OWNS.
//
// The room used to answer one question with another question's words: it read `reachableFromThisProcess`
// (can the SERVER act?) and told a person "Turns cannot save into this folder" — about a folder the tab
// in front of them could write into perfectly well once the act was ROUTED to it. The router landed
// (`actsVia` + `executor` from the page-writes seam), so the sentences were rewritten and this file is
// the falsifier for them: not the payload shape, but what a person actually sees in the two states.
//
//   node --test tests/room-page-owned-root.test.mjs
//
// One driven story, both halves of the same fact: a real server, a real environment page holding a real
// OPFS project (so the tab really is the writer), the room loaded against it, and then the tab closed.
import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { startServer } from "./lib/server.mjs";
import { launch } from "./lib/cdp.mjs";

let server, BASE;

test.before(async () => { server = await startServer({ env: { VOICEBOX_INSTANCE: "room-page-owned" } }); BASE = server.base; });
test.after(async () => { await server?.stop(); });

async function until(check, label, ms = 15000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { const r = await check(); if (r) return r; await sleep(50); }
  assert.fail(`no ${label} within ${ms}ms`);
}

const declareAsHost = (project, root) =>
  fetch(`${BASE}/api/root`, { method: "POST", headers: { "content-type": "application/json", "x-voicebox-host-token": server.hostToken }, body: JSON.stringify({ project, root }) }).then((r) => r.json());

/** The room's own words, as a person reads them. */
const readRoom = (page) => page.evaluate(() => ({
  headline: document.getElementById("empty-headline")?.textContent?.trim() ?? "",
  next: document.getElementById("empty-next")?.textContent?.trim() ?? "",
  why: document.getElementById("empty-why")?.textContent?.trim() ?? "",
  whyShown: document.getElementById("empty-why")?.hidden === false,
  whyTitle: document.getElementById("empty-why")?.title ?? "",
  link: document.getElementById("empty-link")?.textContent?.trim() ?? "",
  // THE COMPOSER'S REFUSAL SIGNAL IS THE TOOLTIP, NOT THE SEND BUTTON: #send is disabled whenever the
  // box is empty (that is text state, not capability state), so asserting on it would have called a
  // working room broken. `title` is set to "a turn would be refused here: <why>" only when the room
  // believes a turn cannot land — which is the fact under test.
  composerRefusalTitle: document.getElementById("utterance")?.title ?? "",
  composerPlaceholder: document.getElementById("utterance")?.placeholder ?? "",
  // The drawer's facts live in #about-facts inside the settings dialog's <details class="about"> — not in
  // an element called #about. (First version of this file read #about, got null, and reported an empty
  // drawer as a defect: the instrument was wrong, not the page.)
  about: document.getElementById("about-facts")?.textContent?.trim() ?? "",
  rootChip: document.getElementById("root-kind")?.textContent?.trim() ?? "",
}));

test("a page-owned root: usable while the tab holds it, and a refusal that names the tab once it is gone", { timeout: 90000 }, async () => {
  // ── the real thing: a page, an OPFS project, the host declaring it ──────────────
  const envPage = await launch();
  const roomPage = await launch();
  try {
    await envPage.goto(`${BASE}/environment.html`);
    await envPage.waitFor(() => window.e1m0 !== undefined, { label: "the page's host API" });
    await envPage.evaluate(() => window.e1m0.ready);
    const opened = await envPage.evaluate(async () => await window.e1m0.send({ type: "openProject", name: "roomowned" }));
    assert.equal(opened.ok, true, JSON.stringify(opened));
    assert.equal(opened.project.rootKind, "opfs", "this test is about a root only the page can act on");

    const declared = await declareAsHost("roomowned", { kind: "opfs", path: "v1/projects/roomowned" });
    assert.equal(declared.ok, true, JSON.stringify(declared));
    assert.equal(declared.actsVia, "page", "the declaration must say who performs the act");
    assert.equal(declared.executor?.connected, true, "the environment page is connected");
    assert.equal(declared.reachableFromThisProcess, false, "the SERVER still cannot act on this root — the two questions differ, which is the whole point");

    // ── THE ROOM WHILE THE TAB HOLDS IT: no refusal, and the drawer names the writer ──
    await roomPage.goto(`${BASE}/`);
    const held = await until(async () => {
      const r = await readRoom(roomPage);
      return r.headline ? r : null;
    }, "the room to render its root state");

    assert.doesNotMatch(held.headline, /cannot save/i, `the room refused a folder the tab is holding: "${held.headline}"`);
    assert.doesNotMatch(held.next, /is not somewhere the server can save/i, `the room explained a server limitation for a folder the tab can write: "${held.next}"`);
    assert.match(held.headline, /Say or type something that names a file/i, `the usable state's headline is missing: "${held.headline}"`);
    assert.equal(held.composerRefusalTitle, "", `the composer says a turn would be refused for a root the tab can route: "${held.composerRefusalTitle}"`);
    assert.match(held.about, /written by the tab that holds it/i, `the drawer does not say who writes: "${held.about}"`);

    // The listing and a read carry the page as their source, and the reader says whose bytes they are.
    const files = await fetch(`${BASE}/api/files`).then((r) => r.json());
    assert.equal(files.via, "page", "the listing must name its source");

    // ── THE SAME ROOT WITH THE TAB GONE ──────────────────────────────────────────
    await envPage.close();
    const gone = await until(async () => {
      const info = await fetch(`${BASE}/api/root`).then((r) => r.json());
      return info.executor?.connected === false ? info : null;
    }, "the server to notice the executor is gone");
    assert.equal(gone.actsVia, "page", "the act still belongs to the page — it is the page's absence that is the problem");

    await roomPage.goto(`${BASE}/`);
    const without = await until(async () => {
      const r = await readRoom(roomPage);
      return r.headline ? r : null;
    }, "the room to render the refusal");

    assert.match(without.headline, /tab that holds this folder is not open/i, `the refusal does not name the cause: "${without.headline}"`);
    // The visible detail must be plain: "placement" is the owner's named example of jargon.
    assert.doesNotMatch(without.why, /placement/i, `the detail line shows the router's own vocabulary: "${without.why}"`);
    assert.match(without.why, /tab/i, `the detail line does not mention the tab: "${without.why}"`);
    assert.match(without.whyTitle, /placement|act belongs|only the page can act/i, "the seam's own sentence should still be reachable on the title");
    assert.match(without.next, /Open the tab that holds this folder/i, `the remedy is missing: "${without.next}"`);
    assert.match(without.composerRefusalTitle, /a turn would be refused here/i, "the composer does not warn that a turn cannot land");
    assert.match(without.composerRefusalTitle, /tab that holds this folder is not connected/i, `the composer's reason is not the tab's absence: "${without.composerRefusalTitle}"`);
    assert.doesNotMatch(without.headline, /cannot save into this folder\.$/i, "the room fell back to the server's limitation, which is a different cause");
  } finally {
    await envPage.close().catch(() => {});
    await roomPage.close().catch(() => {});
  }
});
