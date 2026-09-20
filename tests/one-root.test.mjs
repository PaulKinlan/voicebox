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

test("the page declares a machine root, the loop writes there, and the page says who acts on it", { timeout: 120000 }, async () => {
  // Through the page's own controls: type the path, submit the form.
  await page.type("#machine-path", machineRoot);
  await page.click("#machine-form button");

  // The declaration is the page's act, so it is asserted from the SERVER's side rather than from the
  // page's own report of having sent it.
  const info = await waitForRoot((i) => i.root?.path === machineRoot, "the loop to be told about the machine root");
  assert.equal(info.root.kind, "machine", `the loop's root is not the declared one: ${JSON.stringify(info.root)}`);
  assert.equal(info.reachableFromThisProcess, true);

  // The header names the kind and WHO acts on it — a fact, not something the user discovers by failing.
  const header = await page.evaluate(() => document.getElementById("project").textContent);
  assert.match(header, /a folder on this machine/, "the page does not name the machine folder kind");
  assert.match(header, /acts come from/, "the page does not say who acts on this root");
  assert.match(header, /the loop \(a machine process\)/, "the page does not name the loop as the actor");

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

  // THE REFUSAL THAT MAKES IT ONE ROOT: the page cannot write into a machine root, and it says who can.
  const localAct = await send({ type: "createAsset", args: { name: "from-the-page.txt", kind: "text", body: "page" } });
  assert.equal(localAct.ok, false, `the page wrote into a root it does not own: ${JSON.stringify(localAct)}`);
  assert.equal(localAct.code, "root-not-reachable-from-here", JSON.stringify(localAct));
  assert.match(localAct.why, /machine/, "the refusal does not name the placement that can act");
  assert.equal(existsSync(path.join(machineRoot, "from-the-page.txt")), false, "a refused write still wrote");

  // And the containment refusal still bites on the loop's side of this root.
  const escape = await turn("create a file called ../escape.txt with nope");
  assert.equal(escape.result?.refused, "outside-root", JSON.stringify(escape.result));
  assert.equal(existsSync(path.join(scratch, "escape.txt")), false, "a file escaped the machine root");
});

test("a picked folder is declared the same way, and the loop refuses it by name", { timeout: 120000 }, async () => {
  // The page adopts a real folder the way a person does — by dropping it.
  await page.dropFolder("#dropzone", pickedFolder);
  await page.waitFor(
    async (expected) => {
      const reply = await window.e1m0.send({ type: "listProjects" });
      return (reply.projects ?? []).some((p) => p.name === expected && p.rootKind === "handle");
    },
    { args: ["picked-folder"], label: "the picked folder to be adopted" },
  );
  // Re-opening it runs the page's declaration path for a handle root.
  await page.evaluate(async () => { await window.e1m0.open("picked-folder"); });

  const info = await rootInfo();
  assert.equal(info.root.kind, "handle", `the page did not declare its picked root: ${JSON.stringify(info.root)}`);
  assert.equal(info.reachableFromThisProcess, false, "the machine claimed to reach a picked folder");
  assert.equal(info.refused, "root-not-reachable-from-here");
  assert.match(info.why, /page/, "the refusal does not name the page as the actor");

  // The loop refuses by name — it does not fall back to a root of its own.
  const loopWrite = await turn("create a file called from-the-loop.txt with nope");
  assert.equal(loopWrite.result?.ok, false, `the loop wrote into a picked root: ${JSON.stringify(loopWrite.result)}`);
  assert.equal(loopWrite.result.refused, "root-not-reachable-from-here");
  assert.match(loopWrite.result.why, /only the page/, "the refusal does not say who can act");
  assert.equal(existsSync(path.join(pickedFolder, "from-the-loop.txt")), false, "the loop wrote into the picked folder anyway");

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

  const pageWrite = await send({ type: "createAsset", args: { name: "from-the-page.txt", kind: "text", body: "the page wrote this" } });
  assert.equal(pageWrite.ok, true, `the page could not write into its own handle root: ${JSON.stringify(pageWrite)}`);
  assert.equal(pageWrite.observed.exists, true, "the world does not agree the page wrote it");

  // The loop refuses the same root by name, and lands nothing.
  const loopAgain = await turn("create a file called loop-again.txt with nope");
  assert.equal(loopAgain.result?.refused, "root-not-reachable-from-here", JSON.stringify(loopAgain.result));
  assert.match(loopAgain.result.why, /only the page/);

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
  await page.evaluate(async (dir) => { await window.e1m0.useMachineRoot(dir, "doomed"); }, doomed);
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
  await page.evaluate(async () => { await window.e1m0.open("origin-project"); });
  const info = await waitForRoot((i) => i.declared && i.root?.kind === "opfs", "the page to declare its OPFS project");
  assert.equal(info.reachableFromThisProcess, false, "an OPFS root must report itself unreachable from the server");

  const transcript = await page.evaluate(() => document.getElementById("transcript").textContent);
  assert.match(transcript, /the loop cannot write here/, "the page does not say the loop cannot write there");
  assert.match(transcript, /Use this folder for the loop/, "the refusal names no route to a root that works");
  assert.match(transcript, /journal-2cf/, "the sentence does not say where the asymmetry goes away");

  const header = await page.evaluate(() => document.getElementById("project").textContent);
  assert.match(header, /turns cannot write into this kind yet/, "the header hides which kinds turns can write into");

  // And the machine-folder route really does change it: same project, a kind turns can write into.
  await page.evaluate(async (dir) => { await window.e1m0.useMachineRoot(dir, "origin-project"); }, machineRoot);
  const machine = await waitForRoot((i) => i.root?.kind === "machine", "the machine declaration");
  assert.equal(machine.reachableFromThisProcess, true);
  const afterHeader = await page.evaluate(() => document.getElementById("project").textContent);
  assert.match(afterHeader, /turns DO write here/, "the header does not say that turns write into this root");
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
  assert.equal(body.error, undefined,
    "an `error` label here would shadow the why in any reader that takes the label first");

  chmodSync(unreadable, 0o600); // so the scratch directory can be removed
});
