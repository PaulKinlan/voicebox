// tests/confirm-gate.test.mjs — the tier-2 gate is a modal, and a close without an answer is a NO.
//
//   node --test tests/confirm-gate.test.mjs
//
// WHY THIS EXISTS, from the surface sweep: the gate was a `<div hidden>` in the document flow. Measured
// on the running page, it appeared at y=1419 on an 820px viewport and y=2049 on a phone — two and a
// half screens below the fold, with nothing scrolling to it. So a person asked for a delete, the page
// recorded "asked, not yet performed" in the audit, and the question itself was off-screen. That is a
// worse shape of the settings defect: a gate nobody can see.
//
// The gate is also the one place where "closed without an answer" must not be ambiguous, so these
// checks pin the mapping: Esc and a click outside mean NO (the act does not happen), and the audit
// records the answer rather than leaving the act in limbo.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { startServer } from "./lib/server.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { launch } from "./lib/cdp.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let server;
let BASE;
let page;

const send = (message) => page.evaluate((m) => window.e1m0.send(m), message);

const gate = () =>
  page.evaluate(() => {
    const dialog = document.getElementById("confirm");
    const rect = dialog.getBoundingClientRect();
    return {
      open: dialog.open,
      modal: dialog.matches(":modal"),
      rect: { top: rect.top, bottom: rect.bottom, height: rect.height },
      fullyVisible: rect.top >= 0 && rect.bottom <= window.innerHeight,
      viewportHeight: window.innerHeight,
      scrollY: window.scrollY,
      activeInside: dialog.contains(document.activeElement),
      htmlOverflow: getComputedStyle(document.documentElement).overflowY,
      backdropFilter: getComputedStyle(dialog, "::backdrop").backdropFilter,
      buttons: [...dialog.querySelectorAll("button")].map((b) => b.textContent.trim()),
      plan: document.getElementById("confirm-plan").textContent,
    };
  });

/** Create an asset and ask for its deletion: the smallest way to drive the tier-2 gate. */
async function askForADelete(name) {
  await page.evaluate(async (assetName) => {
    await window.e1m0.create(assetName, "text", "a file worth confirming about");
    const card = [...document.querySelectorAll("figure.asset")].find((el) => el.dataset.name === assetName);
    card.querySelector("button.delete").click();
  }, name);
  await page.waitFor(() => document.getElementById("confirm").open === true, { label: "the gate to open" });
}

const assetExists = (name) =>
  page.evaluate(async (assetName) => {
    const reply = await window.e1m0.send({ type: "openProject", name: "atlas" });
    return (reply.assets ?? []).includes(assetName);
  }, name);

const lastAnswer = () =>
  page.evaluate(async () => {
    const reply = await window.e1m0.send({ type: "audit" });
    return reply.entries.filter((e) => e.decision === "confirm" && e.act?.kind === "delete").slice(-1)[0] ?? null;
  });

test.before(async () => {
  server = await startServer({
    cwd: ROOT,
    env: { VOICEBOX_WORKSPACE: undefined, VOICEBOX_INSTANCE: "gate-test" },
  });
  BASE = server.base;
  page = await launch();
  await page.goto(`${BASE}/environment.html`);
  await page.waitFor(() => window.e1m0 !== undefined, { label: "the environment page" });
  await page.evaluate(async () => {
    await window.e1m0.open("atlas");
    // make the page long enough that "off-screen" is a real possibility, as it was in the measurement
    const filler = document.createElement("div");
    filler.style.height = "150vh";
    document.body.appendChild(filler);
  });
});

test.after(async () => {
  await page?.close();
  await server?.stop();
});

test("the gate opens where the person is looking: fully visible, no scrolling, focus inside", { timeout: 90000 }, async () => {
  await askForADelete("gate-visible.txt");
  const view = await gate();

  assert.equal(view.open, true, "the gate did not open for a tier-2 act");
  assert.equal(view.modal, true, "the gate is not modal — it is a decision, not a notice");
  assert.equal(view.scrollY, 0, "answering the gate needed a scroll");
  assert.equal(view.fullyVisible, true, `the gate is not on screen: ${JSON.stringify(view.rect)} of ${view.viewportHeight}px`);
  assert.equal(view.activeInside, true, "focus is not in the gate that is asking the question");
  assert.equal(view.htmlOverflow, "hidden", "the page behind the gate can still scroll");
  assert.match(view.backdropFilter, /blur\(/, "the gate has no frosted backdrop");
  assert.deepEqual(view.buttons, ["Yes, delete it", "No"]);
  assert.match(view.plan, /delete .*gate-visible\.txt — .*\(rule: delete\)/, `the plan is not the resolved one: ${view.plan}`);

  // Close this gate before the next assertion: a second question while one is open would be the
  // page's own bug, and it is not what this check is about.
  await page.press("Escape");
  await page.waitFor(() => document.getElementById("confirm").open === false, { label: "the gate to close" });

  // The gate is only for a tier-2 act: an ordinary write raises no question at all.
  await page.evaluate(async () => { await window.e1m0.create("no-gate-here.txt", "text", "written without asking"); });
  const afterWrite = await gate();
  assert.equal(afterWrite.open, false, "an ordinary write raised the gate");
});

test("'No' keeps the file, and the audit records the answer", { timeout: 90000 }, async () => {
  await askForADelete("gate-no.txt");
  await page.click("#confirm-no");
  await page.waitFor(() => document.getElementById("confirm").open === false, { label: "the gate to close" });

  assert.equal(await assetExists("gate-no.txt"), true, "'No' deleted the file anyway");
  const answer = await lastAnswer();
  assert.ok(answer, "the answer was not recorded");
  assert.equal(answer.result, "refused", `the declined answer was recorded as '${answer.result}'`);
  assert.equal(answer.rule, "delete");
});

test("Esc — and a click outside — mean NO: an unanswered gate is never a yes", { timeout: 90000 }, async () => {
  await askForADelete("gate-esc.txt");
  await page.press("Escape");
  await page.waitFor(() => document.getElementById("confirm").open === false, { label: "Esc to close the gate" });
  assert.equal(await assetExists("gate-esc.txt"), true, "Esc deleted the file");
  const afterEsc = await lastAnswer();
  assert.equal(afterEsc.result, "refused", "Esc did not record a declined answer");
  assert.equal(afterEsc.act.target.endsWith("gate-esc.txt"), true);

  // The same for the backdrop: it is a close request, so it is an answer.
  await askForADelete("gate-outside.txt");
  await page.clickAt(8, 8);
  await page.waitFor(() => document.getElementById("confirm").open === false, { label: "the backdrop click to close the gate" });
  assert.equal(await assetExists("gate-outside.txt"), true, "a backdrop click deleted the file");
  const afterOutside = await lastAnswer();
  assert.equal(afterOutside.result, "refused");
  assert.equal(afterOutside.act.target.endsWith("gate-outside.txt"), true);
});

test("'Yes' deletes it, once — and the tally says what happened", { timeout: 90000 }, async () => {
  await askForADelete("gate-yes.txt");
  await page.click("#confirm-yes");
  await page.waitFor(() => document.getElementById("confirm").open === false, { label: "the gate to close" });
  await page.waitFor(async () => !(await window.e1m0.send({ type: "openProject", name: "atlas" })).assets.includes("gate-yes.txt"), { label: "the file to be deleted" });

  assert.equal(await assetExists("gate-yes.txt"), false, "'Yes' did not delete the file");
  const answer = await lastAnswer();
  assert.equal(answer.result, "ok", `the approved answer was recorded as '${answer.result}'`);
  assert.deepEqual(answer.observed, { exists: false }, "the audit does not record the world after the delete");

  // Exactly ONE ANSWER per gate: the close listener must not answer a second time. Counted by what
  // the entries ARE (a confirm decision about this file, with a result) rather than by the log's
  // length — an `openProject` in this check legitimately appends presence entries of its own, so a
  // raw delta would measure my own reads.
  const answers = await page.evaluate(async () => {
    const reply = await window.e1m0.send({ type: "audit" });
    const aboutThisFile = reply.entries.filter((e) => e.decision === "confirm" && e.act?.target?.endsWith("gate-yes.txt"));
    return { total: aboutThisFile.length, answered: aboutThisFile.filter((e) => e.result === "ok" || e.result === "refused").length, asks: aboutThisFile.filter((e) => e.result === "refused" && e.observed !== null).length };
  });
  assert.equal(answers.total, 2, `expected one ask and one answer for this file, saw ${answers.total}`);
  assert.equal(answers.answered, 2, "the approval was not recorded exactly once");
});

test("it fits a phone too — the gate a person answers with a thumb", { timeout: 90000 }, async () => {
  await page.emulateViewport({ width: 390, height: 844, mobile: true });
  await page.goto(`${BASE}/environment.html`);
  await page.waitFor(() => window.e1m0 !== undefined, { label: "the environment page (mobile)" });
  await page.evaluate(async () => {
    await window.e1m0.open("atlas");
    const filler = document.createElement("div");
    filler.style.height = "150vh";
    document.body.appendChild(filler);
  });
  await askForADelete("gate-mobile.txt");
  const view = await gate();
  assert.equal(view.fullyVisible, true, `the gate runs off the phone screen: ${JSON.stringify(view.rect)} of ${view.viewportHeight}`);
  assert.ok(view.rect.height <= view.viewportHeight * 0.86, `the gate takes the whole phone screen (${view.rect.height}px)`);
  await page.press("Escape");
  await page.waitFor(() => document.getElementById("confirm").open === false, { label: "the gate to close" });
  await page.clearViewport();
});
