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
//   5. THE LIVE LEG (with a key): a live tool call routes the same way — and its READ half is proved by
//      words only the disk and the test know, asked for by a plain file name, with bounded re-asks whose
//      count is in the failure message (voicebox-beads-k6uu: the model, not the route, is the variable).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { startServer } from "./lib/server.mjs";
import { launch } from "./lib/cdp.mjs";
import { setTimeout as sleep } from "node:timers/promises";

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

// ── 5. the live leg: a VOICE turn routes to the page ────────────────────────
const HAVE_KEY = Boolean(process.env.GEMINI_API_KEY);

/**
 * THE MODEL IS NOT THE THING UNDER TEST (voicebox-beads-k6uu). This leg proves a ROUTE: a live tool call
 * leaves the server, is performed by the PAGE that owns the root, and its answer comes back. The model in
 * the middle is nondeterministic — on its own mood, or on a loaded box, it can answer a read request out of
 * the conversation instead of calling `read_file` — and the first version of this test let exactly that
 * happen SILENTLY: it waited for the model to SAY the content, which the model already knew from the turn
 * that wrote it, and then asserted a tool call that was never made. Re-run alone it passed 4/4 (the model
 * happened to call the tool), inside the serial lane it went red — a flake was measured, and the test was
 * the instrument at fault for accepting proof that did not exist.
 *
 * Two changes fix that, and neither of them weakens the claim:
 *   1. THE MODEL MUST READ SOMETHING IT HAS NEVER SEEN. The test writes a second file at the project root
 *      through the product's own write route with a random phrase, and asks the model to read THAT. A
 *      spoken match is then structural proof of a routed read — an answer from context cannot produce words
 *      the model was never told. The phrase is WORDS, not a token (`read-back-50rel8n` came back from the
 *      live session's own speech transcription as "read back a fifty r e l eight n", which is a mangled
 *      match, not a missing read — the model's audio is transcribed and a random string is exactly what a
 *      transcriber mangles). Two of the three words is the bar: the model was told none of them, and one
 *      may be misheard. The name is PLAIN, no directories, because that is the tool contract
 *      (`write_file`: "Use a plain file name, no directories") — a fixture at `assets/…` made the model
 *      refuse three asks running for a reason that was the product working, not the route failing.
 *   2. A SKIPPED TOOL CALL IS ASKED AGAIN, BOUNDED AND RECORDED. If the model answers without calling the
 *      tool, the request is repeated in a CORRECTED form (up to three asks, each bounded) — a model that
 *      reached for the wrong verb rarely reaches for the right one when asked the same way twice — because
 *      that failure class is "a language model declined to use a tool", not "the route broke". A route that
 *      is actually broken fails every ask and is still red, and the message names how many asks were spent,
 *      so a reviewer can tell a flake from a regression (which a lane-level retry of the whole FILE could
 *      not: it would re-run every earlier check and could hide a real one).
 */
const LIVE_ASKS = 3;
const LIVE_ASK_MS = 15000;

/** Words a speech transcriber handles, and a model reading a file cannot guess. */
const READ_WORDS = ["saffron", "pelican", "quartz", "walnut", "lantern", "cobalt", "tundra", "meadow", "harbour", "marble"];
const pickWords = (count) => {
  const pool = [...READ_WORDS];
  const picked = [];
  while (picked.length < count) picked.push(...pool.splice(Math.floor(Math.random() * pool.length), 1));
  return picked;
};

/**
 * One live text turn, waited on for a NAMED condition ("the tool was called", "the secret was spoken").
 * The condition is the caller's, and it is re-read on every frame-bearing poll: `ws.onmessage` fills the
 * shared arrays, so a bounded predicate over them is the whole wait.
 */
async function liveAsk(ws, text, settled, ms = LIVE_ASK_MS) {
  ws.send(JSON.stringify({ type: "text", text }));
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    await sleep(200);
    if (settled()) return true;
  }
  return settled();
}

test("the live leg: a spoken write into a page-owned root lands through the channel", { skip: !HAVE_KEY && "GEMINI_API_KEY not set", timeout: 180000 }, async () => {
  // The shape under test: page (OPFS project) ⇄ /channel ⇄ server ⇄ /live ⇄ Gemini Live.
  // The live tool call hits the SAME execute() as the REST turn, so the dispatch routes it —
  // this test proves that rather than assuming it from the code path.
  const opened = await page.evaluate(async () => await window.e1m0.send({ type: "openProject", name: "live-routed" }));
  assert.equal(opened.ok, true, JSON.stringify(opened));
  await declareAsHost("live-routed", { kind: "opfs", path: "v1/projects/live-routed" });

  // The local-origin claim, as the served page makes it: this client talks to the server the
  // test just started, and the hello gate asks who is calling before it spends a session.
  const ws = new WebSocket(`${BASE.replace("http", "ws")}/live`, { headers: { origin: BASE } });
  const states = [];
  const tools = [];
  const texts = [];
  ws.onmessage = (e) => {
    if (typeof e.data !== "string") return;
    const m = JSON.parse(e.data);
    if (m.type === "state") states.push(m);
    if (m.type === "tool") tools.push(m);
    if (m.type === "text") texts.push(m);
  };
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  for (let i = 0; i < 100 && !states.some((s) => s.state === "ready"); i++) await sleep(200);
  assert(states.some((s) => s.state === "ready"), "the live session never became ready");

  // THE WRITE LEG: the model creates the file through the route. A skipped tool call is asked again
  // (bounded), and the second ask states the EXACT call rather than repeating the sentence — a model that
  // reached for the wrong verb does not usually reach for the right one because it was asked the same way
  // twice.
  const writeCall = () => tools.flatMap((t) => t.calls).find((c) => c.name === "write_file");
  const writePrompt = (attempt) => attempt === 0
    ? "Please create a file called voice-wrote-this.txt with the exact content: spoken and routed"
    : 'Call the write_file tool with name "voice-wrote-this.txt" and content "spoken and routed" — create the file itself.';
  let writeAsks = 0;
  for (; writeAsks < LIVE_ASKS && !writeCall(); writeAsks++) await liveAsk(ws, writePrompt(writeAsks), () => Boolean(writeCall()));
  assert(writeCall(), `the model did not call write_file in ${writeAsks} ask(s)`);
  assert.equal(writeCall().ok, true, `the routed write was refused: ${JSON.stringify(writeCall())}`);
  assert.match(writeCall().action ?? "", /observed by the page/, "the tool result does not name whose observation it quotes");

  // The bytes, read back through the page's OWN door — the route's report is not the witness:
  const direct = await page.evaluate(async () => await window.e1m0.send({ type: "readFile", path: "voice-wrote-this.txt" }));
  assert.equal(direct.ok, true, JSON.stringify(direct));
  assert.equal(direct.text, "spoken and routed", "the file in the page's root does not match the spoken write, byte for byte");

  // ── THE READ LEG: A FILE ONLY THE DISK AND THIS TEST KNOW ──────────────────────
  // The fixture is written through the PRODUCT's own route — a REST turn, which the server routes to the
  // page that owns the root — and it is named as a PLAIN FILE NAME, because that is the tool contract:
  // `write_file`'s own description says "Use a plain file name, no directories" (lib/commands.mjs). A model
  // handed `assets/routed-read.txt` refused it three asks running — "I am restricted to using plain
  // filenames without any directory paths" — which is the model obeying the product, not the route failing.
  // The first version of this fixture fought that instruction; the words are the test's own, so nothing in
  // the live conversation has ever contained them.
  const [wordA, wordB, wordC] = pickWords(3);
  const fixtureName = "routed-read.txt";
  const seeded = await turn(`create a file called ${fixtureName} with the phrase ${wordA} ${wordB} ${wordC}`);
  assert.equal(seeded.result?.ok, true, `the read fixture did not land through the routed write: ${JSON.stringify(seeded.result)}`);
  assert.equal(seeded.result?.via, "page", "the fixture must be written by the page that owns the root, not by the machine");
  const fixture = await page.evaluate(async (name) => await window.e1m0.send({ type: "readFile", path: name }), fixtureName);
  assert.equal(fixture.ok, true, `the fixture is not readable in the page's root: ${JSON.stringify(fixture)}`);
  assert.equal(fixture.text, `the phrase ${wordA} ${wordB} ${wordC}`, "the fixture's bytes are not what the routed write was told to write");

  const readCall = () => tools.flatMap((t) => t.calls).find((c) => c.name === "read_file" && c.ok);
  const heard = () => texts.map((t) => t.text).join(" ").replace(/\s+/g, " ");
  const heardWords = () => [wordA, wordB, wordC].filter((w) => new RegExp(`\\b${w}\\b`, "i").test(heard()));
  // A CORRECTED ASK, NOT A REPEAT. A model that read the wrong name reads the wrong name again if it is
  // simply asked the same way — its OWN refusal is the most useful sentence to hand back, and the name is
  // restated plainly, because a path with directories in it is refused by the tool's own instruction.
  const readPrompt = (attempt) => {
    if (attempt === 0) return `Read ${fixtureName} with the read_file tool and tell me exactly what it says — do not guess.`;
    const refused = tools.flatMap((t) => t.calls).filter((c) => c.name === "read_file" && !c.ok).at(-1);
    return refused
      ? `The read_file call for ${fixtureName} was refused (${refused.action ?? "refused"}). Call read_file with the plain file name "${fixtureName}" — and tell me what the file says.`
      : `Call the read_file tool with the plain file name "${fixtureName}" — and tell me what the file says.`;
  };
  const answered = () => Boolean(readCall()) && heardWords().length >= 2;
  let readAsks = 0;
  for (; readAsks < LIVE_ASKS && !answered(); readAsks++) await liveAsk(ws, readPrompt(readAsks), answered);
  // The spoken words are the WITNESS, not the model's sentence: they cannot be produced without a routed
  // read of the file the page wrote, so a regression in the route shows up here as words that never came.
  assert(
    heardWords().length >= 2,
    `the model spoke ${heardWords().length} of the fixture's own words after ${readAsks} ask(s), so no routed read can be claimed (wanted 2+) — heard: ${heard().slice(-200)}`,
  );
  assert(readCall(), `the model did not call read_file with an ok answer in ${readAsks} ask(s) — calls seen: ${JSON.stringify(tools.flatMap((t) => t.calls).map((c) => [c.name, c.ok]))}`);

  ws.close();
  await undeclare();
});
