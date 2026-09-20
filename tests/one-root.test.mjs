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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  assert.match(header, /a folder on the machine running the process/, "the page does not name the machine root kind");
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
