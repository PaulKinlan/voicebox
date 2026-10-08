// tests/env-create-project.test.mjs — voicebox-beads-um5r (explain setup: what, why, the order) and
// voicebox-beads-6uzd (create a project from the main UI instead of exposed input boxes).
//
// Paul verbatim (2026-10-08): "explain more about how it works and what it's doing and why we need to
// start it setting things up then the order". The explanation and the create action have to be reachable
// in the MAIN UI's environments dialog — the standalone page stays as a direct-link fallback, but a
// person who never visits it must not have to.
//
// NON-VACUITY, on purpose: the guide is asserted against the labels of the controls that actually exist
// (so a rename breaks the test instead of silently drifting from the copy), the failure path asserts a
// refusal appears INSIDE the dialog while it stays open, and the success path asserts the project exists
// in real browser storage and is named as the active root — not merely that a status line said so.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { startServer } from "./lib/server.mjs";
import { launch } from "./lib/cdp.mjs";

let server;
let BASE;
let scratch;
let page;

const PROJECT_NAME = "review-probe-project";

const openEnvs = async () => {
  await page.goto(`${BASE}/`);
  await page.waitFor(
    () => {
      const text = document.getElementById("root-kind")?.textContent?.trim() ?? "";
      return text !== "" && text !== "checking which root…" && text !== "folder not reported";
    },
    { label: "the initial root check to settle" },
  );
  await page.click("#envs-open");
  await page.waitFor(() => document.getElementById("envs")?.hasAttribute("open"), {
    label: "the environments dialog to open",
  });
};

const createStatus = () =>
  page.evaluate(() => {
    const el = document.getElementById("env-create-project-status");
    return {
      text: (el?.textContent ?? "").trim(),
      ok: el?.dataset.ok ?? null,
      visible: Boolean(el?.checkVisibility()),
      dialogOpen: document.getElementById("envs")?.hasAttribute("open") ?? null,
    };
  });

const opfsHasFolder = (name) =>
  page.evaluate(async (folder) => {
    const root = await navigator.storage.getDirectory();
    try {
      const dir = await root.getDirectoryHandle(folder);
      return dir.kind;
    } catch {
      return null;
    }
  }, name);

test.before(async () => {
  scratch = realpathSync(mkdtempSync(path.join(os.tmpdir(), "voicebox-create-project-")));
  server = await startServer({
    env: {
      VOICEBOX_WORKSPACE: undefined,
      VOICEBOX_SANDBOX_HOMES: undefined,
      VOICEBOX_INSTANCE: "create-project-test",
    },
    cwd: scratch,
  });
  BASE = server.base;
  page = await launch({ width: 1280, height: 900 });
});

test.after(async () => {
  await page?.close();
  await server?.stop();
  rmSync(scratch, { recursive: true, force: true });
});

test("the main UI explains what setup does, why it is needed, and the order — before anything is clicked", { timeout: 60000 }, async () => {
  await openEnvs();

  const guide = await page.evaluate(() => {
    const el = document.getElementById("env-setup-guide");
    if (!el) return null;
    const list = el.querySelector(".env-setup-steps");
    const steps = list ? [...list.children] : [];
    return {
      visible: Boolean(el.checkVisibility()),
      text: el.textContent ?? "",
      listTag: list?.tagName ?? null,
      steps: steps.map((s) => ({ text: (s.textContent ?? "").trim(), visible: Boolean(s.checkVisibility()) })),
    };
  });
  assert.ok(guide, "#env-setup-guide must exist in the main UI's environments dialog");
  assert.equal(guide.visible, true, "the explanation is visible before anything is clicked, not hidden behind a control");
  assert.match(guide.text, /What it does:/, "it says what setting up does");
  assert.match(guide.text, /Why it is needed:/, "it says why it is needed");

  // ORDER IS PART OF THE CLAIM, not a detail of it: Paul asked to explain what setup does and why "then
  // the order", so the explanation has to be met BEFORE the choices it explains. The first version of
  // this block sat after the controls while its own comment claimed it came first — an independent
  // reviewer caught the contradiction, and this assertion is what makes the placement a fact rather
  // than a comment.
  const placed = await page.evaluate(() => {
    const guide = document.getElementById("env-setup-guide");
    const config = document.getElementById("env-config-block");
    const create = document.getElementById("env-create-project");
    const precedes = (a, b) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    return { guideBeforeConfig: precedes(guide, config), guideBeforeCreate: precedes(guide, create), configBeforeCreate: precedes(config, create) };
  });
  assert.equal(placed.guideBeforeConfig, true, "the reader meets the explanation before the controls that choose where files live");
  assert.equal(placed.guideBeforeCreate, true, "and before the create control step 3 talks about");
  assert.equal(placed.configBeforeCreate, true, "the order the copy states (choose, then create) is the order on the screen");

  // An <ol> is a claim about sequence, not decoration: the numbering a reader sees comes from here.
  assert.equal(guide.listTag, "OL", "the order is a real ordered list, so the numbering is the sequence");
  assert.equal(guide.steps.length, 3, "three steps, no more");
  assert.ok(
    guide.steps.every((s) => s.visible && s.text.length > 20),
    "every step is visible and says something specific without opening anything",
  );
  const at = (needle) => guide.text.indexOf(needle);
  assert.ok(at("Start Voicebox on the machine") < at("Choose where this project's files live"), "starting the server is stated before choosing where files live");
  assert.ok(at("Choose where this project's files live") < at("Create or name the project below"), "choosing where files live is stated before creating the project");

  // THE ANTI-DRIFT CHECK: the guide names the controls BY THEIR REAL LABELS, and this asserts the two
  // still agree. A rename that leaves the copy behind fails here rather than shipping a sentence about a
  // button that no longer says that.
  const labels = await page.evaluate(() => ({
    browser: document.getElementById("env-use-browser-btn")?.textContent?.trim() ?? "",
    picked: document.getElementById("env-pick-folder-btn")?.textContent?.trim() ?? "",
    machine: document.getElementById("env-declare-root-btn")?.textContent?.trim() ?? "",
  }));
  assert.equal(labels.browser, "Use browser workspace", "the browser-workspace control's label is the one the guide names");
  assert.equal(labels.machine, "Set machine root", "the machine-root control's label is the one the guide names");
  assert.ok(labels.picked.startsWith("Pick a local folder"), `the picked-folder control's label is the one the guide names, got: ${labels.picked}`);
  assert.ok(guide.text.includes(labels.browser), "the guide names the browser-workspace control");
  assert.ok(guide.text.includes("Pick a local folder"), "the guide names the picked-folder control");
  assert.ok(guide.text.includes(labels.machine), "the guide names the machine-root control");

  // THE LIMITS the code enforces are still stated: a picked folder needs the grant, and browser storage
  // needs this page connected. And the claim voicebox-beads-42ir disproved cannot come back by accident.
  assert.match(guide.text, /once you grant write access/, "the picked-folder grant is still stated");
  assert.doesNotMatch(guide.text, /cannot write here yet|cannot write into it yet|read-only for turns|page-side writes land/, "the disproved claim that turns cannot write into these destinations is back");
});

test("Create a project makes a real named project in this browser, inside the main UI", { timeout: 90000 }, async () => {
  await openEnvs();

  // NEGATIVE CONTROL before the act: nothing is shown, and the project does not exist.
  const before = await createStatus();
  assert.equal(before.text, "", "no creation status is shown before anything is attempted");
  assert.equal(await opfsHasFolder(PROJECT_NAME), null, "the project does not exist in browser storage before it is created");

  // A refusal has to be visible WHERE THE PERSON IS STANDING: inside the dialog, which stays open.
  await page.click("#env-create-project-btn");
  await page.waitFor(() => (document.getElementById("env-create-project-status")?.textContent ?? "").trim().length > 0, {
    label: "the refusal for an empty name",
  });
  const refused = await createStatus();
  assert.equal(refused.ok, "false", "an empty name is refused, not silently ignored");
  assert.equal(refused.visible, true, "the refusal is visible while the dialog is open, not behind it");
  assert.equal(refused.dialogOpen, true, "a refusal leaves the dialog open — the person stays where they were");
  assert.match(refused.text, /name/i, `the refusal says what is missing, got: ${JSON.stringify(refused.text)}`);
  const rootAfterRefusal = await page.evaluate(() => document.getElementById("env-active-root-val")?.textContent?.trim() ?? "");
  assert.equal(rootAfterRefusal, "no folder chosen yet", "a refused creation must not switch the project");
  assert.equal(await opfsHasFolder(PROJECT_NAME), null, "a refused creation must not create anything");

  // The real act.
  await page.type("#env-create-project-name", PROJECT_NAME);
  await page.click("#env-create-project-btn");
  await page.waitFor(
    () => {
      const el = document.getElementById("env-create-project-status");
      return el?.dataset.ok === "true" && (el.textContent ?? "").includes("review-probe-project");
    },
    { label: "the creation to be reported inside the dialog" },
  );

  const real = await page.evaluate((name) => {
    const chip = document.querySelector(`.folder-chip[data-folder="${name}"]`);
    return {
      active: document.getElementById("env-active-root-val")?.textContent?.trim() ?? "",
      chipText: chip?.textContent?.trim() ?? null,
      barHidden: document.getElementById("room-folders-bar")?.hidden ?? null,
    };
  }, PROJECT_NAME);
  assert.equal(await opfsHasFolder(PROJECT_NAME), "directory", "the project really exists in this browser's storage");
  assert.ok(real.active.includes(PROJECT_NAME), `the dialog's active root names the new project, got: ${JSON.stringify(real.active)}`);
  assert.ok(real.chipText !== null, "the room's folder bar shows the new project as a folder it can act on");
  assert.equal(real.barHidden, false, "the folder bar is shown once there is a folder");

  // The dialog stays open (the person is not thrown out) and the button is usable again — a control left
  // disabled after a failure is its own silent trap.
  const after = await createStatus();
  assert.equal(after.visible, true, "the success is reported where the person is standing");
  assert.equal(after.dialogOpen, true, "creating a project does not close the dialog");
  const disabled = await page.evaluate(() => document.getElementById("env-create-project-btn")?.disabled ?? null);
  assert.equal(disabled, false, "the create button is usable again after the attempt");

  // SAY WHAT IS TRUE: the same name a second time OPENS the folder that already exists rather than
  // creating it, and the status line has to say so — getDirectoryHandle(create:true) cannot tell the two
  // apart, so this is the assertion that keeps the wording honest.
  await page.click("#env-create-project-btn");
  await page.waitFor(
    () => (document.getElementById("env-create-project-status")?.textContent ?? "").startsWith("Opened"),
    { label: "the second attempt to be reported as an open, not a creation" },
  );
  const second = await createStatus();
  assert.equal(second.ok, "true", "re-opening an existing project succeeds rather than reporting an error");
  assert.equal(await opfsHasFolder(PROJECT_NAME), "directory", "and the project is still there");
});
