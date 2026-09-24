// tests/one-root.test.mjs — ONE ROOT, driven in the browser: the loop and the page agree about where
// this project's files are.
//
//   node --test tests/one-root.test.mjs
//
// The gap this closes, in Paul's words: "projects exist" on the environment page while the loop wrote
// loose files into a flat `workspace/`. Here the page DECLARES its root (a folder on the machine, or a
// picked folder), the loop writes into exactly that root, and each side refuses by name when the root
// belongs to the other — with the containment refusal still biting for both kinds.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { startServer } from "./lib/server.mjs";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { launch } from "./lib/cdp.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let server;
let BASE;
let page;
let scratch;
let machineRoot;
let pickedFolder;

const send = (message) => page.evaluate((m) => window.e1m0.send(m), message);

/**
 * Declare a root THE WAY THE HOST DOES — with the token only the host's own directory carries.
 *
 * This suite used to declare as the page; since voicebox-beads-cfn the page cannot (and must not),
 * because declaring a root re-points every file route. A suite that spawns the server is the host, so
 * it declares with the token and lets the PAGE part be asserted separately, as a refusal.
 */
const declareAsHost = (project, root) =>
  fetch(`${BASE}/api/root`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-voicebox-host-token": server.hostToken },
    body: JSON.stringify({ project, root }),
  }).then((r) => r.json());
const turn = (transcript) =>
  fetch(`${BASE}/api/turn`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ transcript }),
  }).then((r) => r.json());
const rootInfo = () => fetch(`${BASE}/api/root`).then((r) => r.json());

/** The declaration is the page's act and it is asynchronous, so wait for the SERVER's answer. */
const waitForRoot = async (predicate, label) => {
  for (let i = 0; i < 80; i++) {
    const info = await rootInfo();
    if (predicate(info)) return info;
    await sleep(150);
  }
  throw new Error(`timed out waiting for ${label}`);
};

test.before(async () => {
  scratch = mkdtempSync(path.join(os.tmpdir(), "voicebox-oneroot-"));
  machineRoot = path.join(scratch, "loop-root");
  pickedFolder = path.join(scratch, "picked-folder");
  mkdirSync(machineRoot);
  mkdirSync(pickedFolder);
  writeFileSync(path.join(pickedFolder, "already-there.txt"), "the user's own file\n");
  server = await startServer({
    cwd: ROOT,
    env: { VOICEBOX_WORKSPACE: machineRoot },
  });
  BASE = server.base;
  page = await launch();
  await page.goto(`${BASE}/environment.html`);
  await page.waitFor(() => window.e1m0 !== undefined, { label: "the page's host API" });
});

test.after(async () => {
  await page?.close();
  await server?.stop();
  rmSync(scratch, { recursive: true, force: true });
});

test("THE PAGE CANNOT DECLARE A ROOT (by name), and the host's declaration drives the loop", { timeout: 120000 }, async () => {
  // The page's own controls: type the path, submit the form. This is the act that used to succeed
  // without a credential, and it re-points every file route — voicebox-beads-cfn.
  await page.type("#machine-path", machineRoot);
  await page.click("#machine-form button");

  const refusal = await page.evaluate(async (dir) => {
    const r = await fetch("/api/root", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ project: "page-attempt", root: { kind: "machine", path: dir } }) });
    return { status: r.status, body: await r.json() };
  }, machineRoot);
  assert.equal(refusal.status, 403, `the page's declaration was not refused: ${JSON.stringify(refusal)}`);
  assert.equal(refusal.body.refused, "host-token-required", JSON.stringify(refusal.body));
  assert.match(refusal.body.why, /host's act|page cannot hold it/, "the refusal does not say whose act it is");

  // THE CHAIN FROM THE BEAD, closed at its first step: the page declared the host's extension directory
  // and then read the token out of it. The declaration is refused, so there is no root to read from —
  // and the read is refused by name either way rather than served.
  const chainedRead = await page.evaluate(async () => {
    const r = await fetch("/api/file?name=.host-token");
    return { status: r.status, body: await r.json() };
  });
  assert.ok(chainedRead.body.refused, `the chained read was not refused by name: ${JSON.stringify(chainedRead)}`);
  assert.equal(chainedRead.body.content, undefined, "the chained read served content");
  assert.ok(
    ["root-not-declared", "dotfile-refused"].includes(chainedRead.body.refused),
    `the chained read was refused, but not with a name this test recognises: ${chainedRead.body.refused}`,
  );

  // The page's transcript shows that refusal, so a person is told rather than left guessing.
  const transcript = await page.evaluate(() => document.getElementById("transcript").textContent);
  assert.match(transcript, /host-token-required|declaring the project root is the host's act/, "the page does not show why its declaration failed");

  // AND THE HOST CAN: the same declaration with the token, then the loop acts there.
  const declared = await declareAsHost("host-declared", { kind: "machine", path: machineRoot });
  assert.equal(declared.ok, true, JSON.stringify(declared));
  const info = await waitForRoot((i) => i.root?.path === machineRoot, "the loop to be told about the machine root");
  assert.equal(info.root.kind, "machine", `the loop's root is not the declared one: ${JSON.stringify(info.root)}`);
  assert.equal(info.reachableFromThisProcess, true);

  // The loop's own view names the kind and WHO acts on it. (The page's header used to carry this,
  // because the page used to be the declarer; now that the host declares, the page's header describes
  // the page's own project — so the assertion follows the fact to where it now lives.)
  assert.equal(info.root.kind, "machine");
  assert.deepEqual(info.facts.reachableFrom, ["machine"], "the facts do not say who acts on a machine root");
  assert.match(info.description, /machine/, "the loop does not describe the root it acts on");

  // The loop writes through its own path (a transcript turn), and it lands in THIS project's root.
  const reply = await turn("create a file called from-the-loop.txt with written by the loop");
  assert.equal(reply.result?.ok, true, `the loop did not write: ${JSON.stringify(reply.result)}`);
  assert.equal(existsSync(path.join(machineRoot, "from-the-loop.txt")), true, "the file is not in the declared root");
  assert.equal(readFileSync(path.join(machineRoot, "from-the-loop.txt"), "utf8"), "written by the loop");

  // The page sees it in the explorer's machine panel, which names the root it is showing.
  await page.evaluate(() => window.e1m0.renderView("server"));
  await page.waitFor(
    () => document.getElementById("view-server").textContent.includes("from-the-loop.txt"),
    { label: "the loop's file in the machine panel" },
  );
  const panel = await page.evaluate(() => document.getElementById("view-server").textContent);
  assert.match(panel, /the machine's root for/, "the panel does not name the root it is showing");
  assert.match(panel, new RegExp(machineRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "the panel does not show the machine path");

  // (No assertion here about the page's own write: the page cannot declare, so its own act lands on
  // whatever project IT opened locally — which the picked-folder test covers directly. The old
  // assertion only held while the page could declare a machine root, and which of the two should be
  // true is the open design question this bead surfaced: if the page may declare roots it needs a
  // bounded token-free route; if it may not, the environment page's declaration UI has to change,
  // because a sentence promising a route that now refuses is worse than no sentence.)

  // And the containment refusal still bites on the loop's side of this root.
  const escape = await turn("create a file called ../escape.txt with nope");
  assert.equal(escape.result?.refused, "outside-root", JSON.stringify(escape.result));
  assert.equal(existsSync(path.join(scratch, "escape.txt")), false, "a file escaped the machine root");
});

test("a picked folder is declared the same way, and the loop's acts ROUTE to the page that owns it", { timeout: 120000 }, async () => {
  // The page adopts a real folder the way a person does — by dropping it.
  await page.dropFolder("#dropzone", pickedFolder);
  await page.waitFor(
    async (expected) => {
      const reply = await window.e1m0.send({ type: "listProjects" });
      return (reply.projects ?? []).some((p) => p.name === expected && p.rootKind === "handle");
    },
    { args: ["picked-folder"], label: "the picked folder to be adopted" },
  );
  // The HOST declares the picked root (the page cannot). What changed (core/dispatch.ts):
  // the loop no longer refuses a picked root as a dead end — it ROUTES the act to the page
  // that owns the root, over /channel. The refusal survives only when nobody can act.
  await declareAsHost("picked-folder", { kind: "handle", id: "picked-folder" });

  const info = await rootInfo();
  assert.equal(info.root.kind, "handle", `the page did not declare its picked root: ${JSON.stringify(info.root)}`);
  assert.equal(info.reachableFromThisProcess, false, "the machine claimed to reach a picked folder");
  assert.equal(info.refused, "root-not-reachable-from-here", "the MACHINE still cannot act — that fact stays true");
  assert.match(info.why, /page/, "the refusal does not name the page as the actor");
  // The routing facts the room keys on (voicebox-ui's contract):
  assert.equal(info.actsVia, "page", "the declaration must say who performs the act");
  assert.equal(info.executor?.connected, true, "the environment page is connected and answering");

  // The ROUTED write, refused by the PAGE's own named answer: a dropped folder answers
  // 'prompt' for write, and the page says so — with the remedy (a click), from the side that
  // knows. This replaces the old dead-end refusal: the act REACHED its owner.
  const loopWrite = await turn("create a file called from-the-loop.txt with nope");
  assert.equal(loopWrite.result?.ok, false, `the loop wrote into a picked root without a grant: ${JSON.stringify(loopWrite.result)}`);
  assert.equal(loopWrite.result?.via, "page", "the act was routed to the page");
  assert.equal(loopWrite.result.refused, "needs-gesture", JSON.stringify(loopWrite.result));
  assert.match(loopWrite.result.why, /click/, "the page's refusal names the remedy");
  assert.equal(existsSync(path.join(pickedFolder, "from-the-loop.txt")), false, "a refused write still wrote");

  // The page READS its own picked root with no trouble — the user's own file is right there.
  await page.evaluate(() => window.e1m0.renderView("picked"));
  await page.waitFor(
    () => document.getElementById("view-picked").textContent.includes("already-there.txt"),
    { label: "the user's own file in the picked panel" },
  );
  const panel = await page.evaluate(() => document.getElementById("view-picked").textContent);
  assert.match(panel, /a real folder on this machine/, "the panel does not name the root authority");

  // The page's WRITE into a picked folder is the one act headless Chromium cannot grant (a dropped
  // folder answers `prompt` for write, and the grant needs a click no script can make — measured, in
  // the picked-root receipt). So the write half of this seam is driven through a handle root with
  // implicit permission: same kind, same code path, same refusal from the loop.
  const adopted = await page.evaluate(async () => {
    const origin = await navigator.storage.getDirectory();
    const dir = await origin.getDirectoryHandle("one-root-handle", { create: true });
    return await window.e1m0.adopt(dir);
  });
  assert.equal(adopted.ok, true, `could not adopt the writable handle root: ${JSON.stringify(adopted)}`);
  assert.equal(adopted.project.rootKind, "handle");
  // The page's current project changed (one-root-handle), so the active root must follow —
  // the router's root-not-mine guard is exactly what keeps a turn for the PREVIOUS root
  // from landing in the NEW one (proven above: the refusal before this line named it).
  await declareAsHost("one-root-handle", { kind: "handle", id: "one-root-handle" });

  const pageWrite = await send({ type: "createAsset", args: { name: "from-the-page.txt", kind: "text", body: "the page wrote this" } });
  assert.equal(pageWrite.ok, true, `the page could not write into its own handle root: ${JSON.stringify(pageWrite)}`);
  assert.equal(pageWrite.observed.exists, true, "the world does not agree the page wrote it");

  // THE WRITE THAT MAKES IT THE FEATURE: with a handle root the page may write, the loop's
  // turn ROUTES and lands — the page performs it and answers observed facts.
  const loopAgain = await turn("create a file called loop-again.txt with the loop wrote through the page");
  assert.equal(loopAgain.result?.ok, true, `the routed write was refused: ${JSON.stringify(loopAgain.result)}`);
  assert.equal(loopAgain.result?.via, "page", "the write was performed by the page");
  assert.match(loopAgain.result?.action ?? "", /observed by the page/, "the result names whose observation it quotes");

  // And the bytes come back through the same route — the page reads its own write, and the
  // content is byte-exact what the turn asked for.
  const readBack = await turn("read loop-again.txt");
  assert.equal(readBack.result?.ok, true, `the routed read was refused: ${JSON.stringify(readBack.result)}`);
  assert.equal(readBack.result?.content, "the loop wrote through the page", "the page's read-back does not match the write, byte for byte");

  // Containment on the routed path too: the page re-resolves, it never trusts the resolved string.
  const escapeTurn = await turn("create a file called ../escape.txt with nope");
  assert.equal(escapeTurn.result?.ok, false);
  assert.equal(escapeTurn.result?.refused, "outside-root", JSON.stringify(escapeTurn.result));
  assert.equal(escapeTurn.result?.via, "page", "the containment refusal came from the page");

  // Containment on the handle root, through the page's own tool run.
  const escape = await send({ type: "createAsset", args: { name: "../escape.svg", kind: "svg", body: "<svg/>" } });
  assert.equal(escape.refused, true, JSON.stringify(escape));
  assert.equal(escape.rule, "outside-root");
  assert.equal(existsSync(path.join(pickedFolder, "..", "escape.svg")), false, "a file escaped the root");
});

test("when the declared root vanishes, the page says so by name — with the remedy", { timeout: 120000 }, async () => {
  // The end-to-end half of the hang fix: a person whose folder disappears must see a refusal they can
  // act on, in the panel that shows that root, rather than an empty list (which looks like an empty
  // folder) or a spinner that never resolves.
  const doomed = path.join(scratch, "doomed-loop-root");
  mkdirSync(doomed);
  writeFileSync(path.join(doomed, "still-here.txt"), "x");
  await declareAsHost("doomed", { kind: "machine", path: doomed });
  await waitForRoot((i) => i.root?.path === doomed, "the loop to be told about the doomed root");

  // The loop works, the panel lists the folder, and then the folder goes away underneath it.
  const written = await turn("create a file called before-vanish.txt with hi");
  assert.equal(written.result?.ok, true, JSON.stringify(written.result));
  await page.evaluate(() => window.e1m0.renderView("server"));
  await page.waitFor(() => document.getElementById("view-server").textContent.includes("still-here.txt"), { label: "the panel to show the folder" });

  rmSync(doomed, { recursive: true, force: true });

  await page.evaluate(() => window.e1m0.renderView("server"));
  const panel = await page.waitFor(
    () => (document.getElementById("view-server").textContent.includes("root-vanished") ? document.getElementById("view-server").textContent : false),
    { label: "the panel to report the vanished root by name" },
  );
  assert.match(panel, /root-vanished/, "the panel does not name the refusal");
  assert.match(panel, /declare it again|re-declare/, "the panel does not offer the remedy");

  // And the loop refuses the same way rather than holding the request.
  const after = await Promise.race([
    turn("create a file called after-vanish.txt with hi"),
    sleep(5000).then(() => ({ timedOut: true })),
  ]);
  assert.equal(after.timedOut, undefined, "the loop held the request after its root vanished");
  assert.equal(after.result.refused, "root-vanished", JSON.stringify(after.result));
});

test("a declaration the loop cannot act on carries the ROUTE, not just the reason", { timeout: 120000 }, async () => {
  // The declaration path itself, end to end: the page TELLS the loop about the project it opened, and
  // when the kind is one turns cannot write into, the page says what to choose instead — in the place
  // the person is standing. "The loop cannot write here" on its own is true and useless, and it is the
  // same defect as the room's empty state that once named a remedy it offered no way to reach.
  // A project of its own: "atlas" was re-declared as a machine project earlier in this file, and the
  // registry remembers — which is itself the re-declaration behaviour working.
  await declareAsHost("origin-project", { kind: "opfs", path: "v1/projects/origin-project" });
  const info = await waitForRoot((i) => i.declared && i.root?.kind === "opfs", "the host to declare its OPFS project");
  assert.equal(info.reachableFromThisProcess, false, "an OPFS root must report itself unreachable from the server");

  const transcript = await page.evaluate(() => document.getElementById("transcript").textContent);
  assert.match(transcript, /the loop cannot write here/, "the page does not say the loop cannot write there");
  // The route, named with the label the button ACTUALLY has. This assertion used to demand "Use this
  // folder for the loop" — a label no control has had for a while, kept alive by the fixture while the
  // sentence it pinned said something else (voicebox-beads-fqq). A test that names a stale label is a
  // test that cannot see the drift it exists to catch.
  assert.match(transcript, /Save turns into this folder/, "the refusal names no route to a root that works");
  assert.match(transcript, /voicebox-beads-2cf/, "the sentence does not say where the asymmetry goes away");

  const header = await page.evaluate(() => document.getElementById("project").textContent);
  assert.match(header, /turns cannot write into this kind yet/, "the header hides which kinds turns can write into");

  // THE COPY CONSEQUENCE, re-driven after voicebox-beads-fqq. This block used to assert the opposite —
  // that the page's own declaration attempt ends in a refusal showing `host-token-required` — because the
  // page could not hold a token. fqq scoped the token to the act it defends (a MACHINE root re-points the
  // server's own file routes; a page-owned root grants it nothing, and only the page can act on it), so
  // the page now declares ITS OWN root and the server answers with who declared it. The rule this test
  // enforces does not change: the page must still say what turns can and cannot write into.
  const pageDeclares = await page.evaluate(async () => {
    const r = await fetch("/api/root", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project: "origin-project", root: { kind: "opfs", path: "v1/projects/origin-project" } }),
    });
    return { status: r.status, body: await r.json() };
  });
  assert.equal(pageDeclares.status, 200, `the page's own root must be declarable now: ${JSON.stringify(pageDeclares)}`);
  assert.equal(pageDeclares.body.declaredBy, "page", "and the answer must say the PAGE declared it");
  assert.equal(pageDeclares.body.actsVia, "page", "with the acts routed to the page");
  assert.equal(pageDeclares.body.reachableFromThisProcess, false, "and the server still unable to act on it");
  const afterOwnDeclaration = await page.evaluate(() => document.getElementById("transcript").textContent);
  assert.match(afterOwnDeclaration, /the loop cannot write here/, "the page stopped saying what turns cannot do");

  // And the machine-folder route really does change it — declared BY THE HOST, because the page's own
  // attempt is refused (asserted in the first test). The page's header keeps describing the page's
  // project; the LOOP's view is what flips, which is where the fact now lives.
  await declareAsHost("origin-project", { kind: "machine", path: machineRoot });
  const machine = await waitForRoot((i) => i.root?.kind === "machine", "the machine declaration");
  assert.equal(machine.reachableFromThisProcess, true);

});

// ── a read that fails for a permission reason says so ───────────────────────
// Coordinator, 2026-09-20: "a green gate says nothing about it — no test drives a
// permission error". That is exactly how the sentence drifted: the reader's
// failure line was fixed, and the SERVER kept answering a permission error with
// the generic 500 — "internal error — the turn was not executed", which is
// untrue about a file read. Drivable by the suite: chmod 000 denies the owner
// too, so the read fails with EACCES without needing another user.
test("a file the process may not read is refused by name — not as an internal error", async () => {
  const unreadable = path.join(machineRoot, "locked.txt");
  writeFileSync(unreadable, "the process may not read this\n");
  chmodSync(unreadable, 0o000);

  const listed = await fetch(`${BASE}/api/files`).then((r) => r.json());
  assert.ok(listed.files.includes("locked.txt"), "the file is not listed, so this test would be vacuous");

  const response = await fetch(`${BASE}/api/file?name=${encodeURIComponent("locked.txt")}`);
  const body = await response.json();

  assert.equal(response.status, 403, `a permission error answered ${response.status}, not 403`);
  assert.equal(body.refused, "unreadable", `the refusal is not named: ${JSON.stringify(body)}`);
  assert.match(String(body.why), /EACCES|EPERM|permission denied/, "the platform's own words are not carried");
  assert.doesNotMatch(String(body.why), /internal error|the turn was not executed/,
    "the sentence is about turns, and this is a file read");
  // The refusal may carry a short label in `error`; what matters is that `why`
  // holds the useful half and that the reader prefers it (voicebox-ui's
  // why → error → note rule, proven by driving the page). An earlier version of
  // this test demanded NO `error` field — that was the author's workaround while
  // the reader took the label first, not the property, and it went red the moment
  // the label was put back for consistency with every other refusal.
  assert.notEqual(body.why, body.error, "the label and the reason are the same string, so nothing is gained");

  chmodSync(unreadable, 0o600); // so the scratch directory can be removed
});
