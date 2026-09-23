// tests/page-writes.test.mjs — the routed-act path, driven end to end.
//
// Paul, 2026-09-20: "page should be able to write." Before this branch, a turn
// against a page-owned root (OPFS, a picked folder) was refused
// root-not-reachable-from-here — a room that could only look. Now the act
// ROUTES (core/dispatch.ts) over /channel to the page that owns the root.
//
//   node --test tests/page-writes.test.mjs
//
// What each check proves, and how:
//   1. NO PAGE, NAMED ANSWER — a declared page root with nobody connected
//      refuses `no-page` (the wire's absence family), never a hang.
//   2. OPFS, END TO END — a real environment page (headless Chromium, real
//      OPFS) answers a write turn; the bytes are read back through the SAME
//      route and through the page's own readFile, byte for byte; the audit
//      shows the page as the writer.
//   3. /api/files and /api/file route too — the room's panel and reader work
//      for a page-owned root, and say whose bytes they show (via: "page").
//   4. The page closing mid-flight answers page-closed, not silence.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { startServer } from "./lib/server.mjs";
import { launch } from "./lib/cdp.mjs";

const SCRATCH = mkdtempSync(path.join(os.tmpdir(), "voicebox-pagewrites-"));

let server;
let BASE;
let page;

test.before(async () => {
  server = await startServer({ env: { VOICEBOX_INSTANCE: "page-writes" } });
  BASE = server.base;
  page = await launch();
  await page.goto(`${BASE}/environment.html`);
  await page.waitFor(() => window.e1m0 !== undefined, { label: "the page's host API" });
  await page.evaluate(() => window.e1m0.ready);
});

test.after(async () => {
  await page?.close();
  await server?.stop();
  rmSync(SCRATCH, { recursive: true, force: true });
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

const undeclare = () =>
  fetch(`${BASE}/api/root`, { method: "DELETE", headers: { "x-voicebox-host-token": server.hostToken } }).then((r) => r.json());

// ── 1. the connected page does not own this root ───────────────────────────
test("a root the connected page does not own is refused BY NAME — no-project or root-not-mine, never a hang", async () => {
  // A root nobody has opened in the page: the page is connected but cannot act on it,
  // and the answer must say WHICH of those two states it is (no-project = nothing open,
  // root-not-mine = a different project is open).
  await declareAsHost("ghost-project", { kind: "opfs", path: "v1/projects/ghost" });
  const start = Date.now();
  const reply = await turn("create a file called ghost.txt with nobody home");
  const elapsed = Date.now() - start;
  assert(elapsed < 10000, `the ask hung for ${elapsed}ms — a named refusal must be immediate`);
  assert.equal(reply.result?.ok, false, `the write claimed to land: ${JSON.stringify(reply.result)}`);
  assert(["no-project", "root-not-mine"].includes(reply.result?.refused), `unexpected refusal: ${JSON.stringify(reply.result)}`);
  assert.equal(reply.result?.via, "page");
  await undeclare();
});

// ── 2 + 3. OPFS end to end, then the room's routes ────────────────────────
test("an OPFS project: the turn writes through the page, reads back byte-for-byte, and the page is the audit's writer", { timeout: 60000 }, async () => {
  // A real project, opened through the page's own host API:
  const opened = await page.evaluate(async () => await window.e1m0.send({ type: "openProject", name: "routed" }));
  assert.equal(opened.ok, true, JSON.stringify(opened));
  assert.equal(opened.project.rootKind, "opfs");

  // The host declares it (the page cannot declare — that is the seam's rule):
  const declared = await declareAsHost("routed", { kind: "opfs", path: "v1/projects/routed" });
  assert.equal(declared.ok, true, JSON.stringify(declared));
  assert.equal(declared.actsVia, "page");
  assert.equal(declared.executor?.connected, true, "the environment page is connected to /channel");

  // The turn routes and LANDS:
  const write = await turn("create a file called spoken.txt with the page wrote this down");
  assert.equal(write.result?.ok, true, `the routed write was refused: ${JSON.stringify(write.result)}`);
  assert.equal(write.result?.via, "page");
  assert.match(write.result?.action ?? "", /observed by the page/, "the result names whose observation it quotes");
  assert.notEqual(write.result?.logged, null, "the page recorded the act in the root's own log");

  // Read back through the SAME route — byte for byte:
  const read = await turn("read spoken.txt");
  assert.equal(read.result?.ok, true);
  assert.equal(read.result?.content, "the page wrote this down", "the routed read-back does not match the write");

  // And through the page's OWN door, so the wire answer is not the only witness:
  const direct = await page.evaluate(async () => await window.e1m0.send({ type: "readFile", path: "spoken.txt" }));
  assert.equal(direct.ok, true, JSON.stringify(direct));
  assert.equal(direct.text, "the page wrote this down");

  // The room's two read routes see the page's root too:
  const files = await fetch(`${BASE}/api/files`).then((r) => r.json());
  assert.equal(files.via, "page", "the listing must name its source");
  assert(files.files.includes("spoken.txt"), `the listing does not show the file: ${files.files}`);
  const file = await fetch(`${BASE}/api/file?name=spoken.txt`).then((r) => r.json());
  assert.equal(file.via, "page");
  assert.equal(file.content, "the page wrote this down");

  // The page is a WRITER in the root's log — an entry this turn made, found by target:
  const audit = await page.evaluate(async () => await window.e1m0.send({ type: "audit" }));
  const entry = (audit.entries ?? []).find((e) => e.act?.target === "spoken.txt" && e.act?.kind === "write");
  assert(entry, "the page's audit has no entry for the routed write");
  assert.equal(entry.result, "ok");
  assert.equal(entry.turn, "channel", "the entry names the routed turn");

  // And a list turn routes as well:
  const list = await turn("list files");
  assert.equal(list.result?.ok, true);
  assert.equal(list.result?.via, "page");
  assert(list.result?.files.includes("spoken.txt"));
});

// ── 4. the page is gone mid-flight ─────────────────────────────────────────
test("the page closing answers page-closed or no-page — the absence family, never silence", { timeout: 60000 }, async () => {
  // Keep a page-owned root declared, then close the tab.
  await declareAsHost("routed", { kind: "opfs", path: "v1/projects/routed" });
  await page.close();
  page = null;

  const start = Date.now();
  const reply = await turn("create a file called orphan.txt with nobody home");
  const elapsed = Date.now() - start;
  assert(elapsed < 10000, `the ask hung for ${elapsed}ms`);
  assert.equal(reply.result?.ok, false);
  assert(["no-page", "page-closed", "page-timeout"].includes(reply.result?.refused), `unexpected refusal: ${JSON.stringify(reply.result)}`);
  assert.match(reply.result?.why ?? "", /page/, "the refusal names the missing side");

  // Reopen for any later tests.
  page = await launch();
  await page.goto(`${BASE}/environment.html`);
  await page.waitFor(() => window.e1m0 !== undefined, { label: "the page's host API, reopened" });
  await undeclare();
});
