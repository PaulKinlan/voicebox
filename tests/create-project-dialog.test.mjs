// tests/create-project-dialog.test.mjs — voicebox-beads-6uzd (and um5r): ONE button creates a project.
//
//   node --test tests/create-project-dialog.test.mjs
//
// Paul, 2026-10-08: "the input boxes is weird for when you're creating a project. We should just have
// like a create a project button inside the environments thing or something." And, about the same
// page: "it's like a super confusing page and we need to explain more about how it works and what
// it's doing and why we need to start it setting things up then the order."
//
// This drives the replacement in a real browser: the page states the order once, visibly, and one
// button opens one dialog holding the three destinations — each showing only its own controls, each
// keeping the sentence that says who can write there. Creating a project in this browser's storage
// goes through the same `#open-form` handler as before and actually creates it.
//
// The negative control matters: submitting with an empty name must NOT create anything and must NOT
// close the dialog, or the "it made the project" assertion below could pass on a page that creates
// projects for any click at all.
import { test } from "node:test";
import assert from "node:assert/strict";
import { startServer } from "./lib/server.mjs";
import { launch } from "./lib/cdp.mjs";

let server;
let page;

test.before(async () => {
  server = await startServer({ env: { VOICEBOX_INSTANCE: "create-dialog" } });
  page = await launch({ width: 1280, height: 900 });
});

test.after(async () => {
  await page?.close();
  await server?.stop();
});

const openPage = async () => {
  await page.goto(`${server.base}/environment.html`);
  await page.waitFor(() => window.e1m0 !== undefined, { label: "the environment page" });
};

test("the page explains what setup does, why it is needed, and the order — before anything is clicked", { timeout: 60000 }, async () => {
  await openPage();

  const guide = await page.evaluate(() => {
    const box = document.querySelector(".setup-guide");
    const steps = [...document.querySelectorAll(".setup-steps li")];
    return {
      present: Boolean(box),
      visible: Boolean(box && box.checkVisibility()),
      text: box ? box.textContent : "",
      listTag: document.querySelector(".setup-steps")?.tagName ?? null,
      stepCount: steps.length,
      // Each step's own visibility, and the words it uses, in DOM order.
      steps: steps.map((li) => ({ visible: li.checkVisibility(), text: li.textContent.trim() })),
    };
  });

  assert.equal(guide.present, true, "the setup explanation exists");
  assert.equal(guide.visible, true, "the setup explanation is VISIBLE — not behind a toggle or a tooltip");
  assert.match(guide.text, /What setup does:/, "it says what setup does");
  assert.match(guide.text, /Why it is needed:/, "it says why setup is needed");
  assert.match(guide.text, /The order/, "it says the order is coming");

  // An <ol> is a claim about sequence, not just decoration: the numbers a reader sees come from here.
  assert.equal(guide.listTag, "OL", "the order is a real ordered list, so the numbering is the sequence");
  assert.equal(guide.stepCount, 3, "three steps, no more");
  assert.ok(guide.steps.every((s) => s.visible), "every step is visible without opening anything");

  const [start, create, writes] = guide.steps.map((s) => s.text);
  assert.match(start, /Start Voicebox on the machine whose files you want to use/, "step 1 is starting the server that saves the files");
  assert.match(create, /Create a project and choose where its files live/, "step 2 is creating the project and choosing where its files live");
  assert.match(writes, /the server writes there itself/, "step 3 says who writes into a machine folder");

  // voicebox-beads-42ir — the limits are the point, and so are the disproved claims. A turn DOES write
  // into browser storage and into a picked folder (the server routes the act to this page); what
  // differs is who performs it. This page used to claim the opposite, so the correction is asserted
  // here as copy, with a negative control that the old wording cannot come back.
  assert.match(guide.text, /this page has to be open and answering/, "the browser-storage limit is still stated");
  assert.match(guide.text, /Restore write access/, "the picked-folder grant is still stated");
  assert.doesNotMatch(guide.text, /cannot write here yet|cannot write into it yet|read-only for turns|page-side writes land/, "the disproved claim that turns cannot write into these destinations is back");

  // Order, not just presence: the index of each step's key phrase must ascend.
  const at = (needle) => guide.text.indexOf(needle);
  assert.ok(at("Start Voicebox on the machine") < at("Create a project and choose where"), "starting the server is stated before creating the project");
  assert.ok(at("Create a project and choose where") < at("the server writes there itself"), "creating the project is stated before who then writes");
});

test("one Create a project button opens one dialog: the boxes are not exposed, and each destination shows its own controls", { timeout: 60000 }, async () => {
  await openPage();

  const before = await page.evaluate(() => ({
    buttonVisible: Boolean(document.querySelector("#create-project")?.checkVisibility()),
    // The input boxes Paul called weird: they exist (handlers and tests depend on their ids) but they
    // must not be sitting on the page before the button is used.
    nameVisible: Boolean(document.querySelector("#project-name")?.checkVisibility()),
    machineVisible: Boolean(document.querySelector("#machine-path")?.checkVisibility()),
    dialogOpen: document.getElementById("create-project-dialog")?.open ?? null,
  }));
  assert.equal(before.buttonVisible, true, "there is a visible Create a project button");
  assert.equal(before.nameVisible, false, "the project-name box is NOT exposed on the page");
  assert.equal(before.machineVisible, false, "the machine path box is NOT exposed on the page");
  assert.equal(before.dialogOpen, false, "the dialog starts closed");

  await page.click("#create-project");
  await page.waitFor(() => document.getElementById("create-project-dialog")?.open === true, { label: "the dialog to open" });

  const opened = await page.evaluate(() => {
    const dialog = document.getElementById("create-project-dialog");
    const title = document.getElementById("create-project-title");
    const radios = [...document.querySelectorAll('input[name="dest"]')];
    const visiblePanels = ["dest-opfs", "dest-picked", "dest-machine"].filter((id) => document.getElementById(id)?.checkVisibility());
    return {
      labelledBy: dialog.getAttribute("aria-labelledby"),
      titleText: title?.textContent?.trim() ?? "",
      hadPopup: document.getElementById("create-project").getAttribute("aria-haspopup"),
      radios: radios.length,
      checked: radios.filter((r) => r.checked).map((r) => r.value),
      visiblePanels,
      // The sentence that says who can write where must survive the move.
      opfsLabel: document.querySelector('input[name="dest"][value="opfs"]')?.closest("label")?.textContent ?? "",
      pickedLabel: document.querySelector('input[name="dest"][value="picked"]')?.closest("label")?.textContent ?? "",
      machineLabel: document.querySelector('input[name="dest"][value="machine"]')?.closest("label")?.textContent ?? "",
    };
  });

  assert.equal(opened.labelledBy, "create-project-title", "the dialog is labelled by its own heading");
  assert.equal(opened.titleText, "Create a project", "the dialog is titled for the act");
  assert.equal(opened.hadPopup, "dialog", "the button announces that it opens a dialog");
  assert.equal(opened.radios, 3, "three destinations, one choice");
  assert.deepEqual(opened.checked, ["opfs"], "exactly one destination is chosen, and it is the browser's own storage");
  assert.deepEqual(opened.visiblePanels, ["dest-opfs"], "only the chosen destination's controls are shown");
  assert.match(opened.opfsLabel, /turns write via this page/, "the browser-storage choice says who performs the act");
  assert.match(opened.pickedLabel, /write needs one click/, "the picked-folder choice keeps the grant it needs");
  assert.match(opened.machineLabel, /turns can write here/, "the machine-folder choice still says turns can write here");
  // voicebox-beads-42ir: the old labels ("turns cannot write here yet", "read-only for turns") were
  // disproved by tests/page-writes.test.mjs — a turn's write into OPFS lands — so their absence is an
  // assertion, not a hope.
  assert.doesNotMatch(`${opened.opfsLabel} ${opened.pickedLabel}`, /cannot write here yet|read-only for turns/, "a label claims turns cannot write into a destination that takes routed writes");

  // Each radio brings its own controls and takes the others away.
  for (const [value, panel] of [["machine", "dest-machine"], ["picked", "dest-picked"], ["opfs", "dest-opfs"]]) {
    await page.click(`input[name="dest"][value="${value}"]`);
    await page.waitFor(
      (want) => {
        const shown = ["dest-opfs", "dest-picked", "dest-machine"].filter((id) => document.getElementById(id)?.checkVisibility());
        return shown.length === 1 && shown[0] === want;
      },
      { label: `only ${panel} to be shown`, args: [panel] },
    );
  }

  // Esc closes it and creates nothing: the dialog is a step, not a commit.
  await page.press("Escape");
  await page.waitFor(() => document.getElementById("create-project-dialog")?.open === false, { label: "Esc to close the dialog" });
  const afterEscape = await page.evaluate(() => document.body.textContent ?? "");
  assert.doesNotMatch(afterEscape, /made\s+\S+\s+in this browser/i, "closing the dialog created nothing");
});

test("creating a project in this browser goes through the dialog and really creates it", { timeout: 90000 }, async () => {
  await openPage();
  const name = "created-via-the-button";

  await page.click("#create-project");
  await page.waitFor(() => document.getElementById("create-project-dialog")?.open === true, { label: "the dialog to open" });

  // NEGATIVE CONTROL: submitting with no name must do nothing — no project, and the dialog stays open.
  // Without this, the assertion below would also pass on a page that created a project for any click.
  await page.click('#open-form button[type="submit"]');
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r())));
  const afterEmpty = await page.evaluate(() => ({
    open: document.getElementById("create-project-dialog")?.open,
    text: document.body.textContent ?? "",
  }));
  assert.equal(afterEmpty.open, true, "an empty name leaves the dialog open");
  assert.doesNotMatch(afterEmpty.text, /made\s+\S+\s+in this browser/i, "an empty name created nothing");

  // Now the real act.
  await page.type("#project-name", name);
  await page.click('#open-form button[type="submit"]');
  await page.waitFor(
    (want) => new RegExp(`made\\s+${want}\\s+in this browser`, "i").test(document.body.textContent ?? ""),
    { label: "the page to say it made the project", args: [name] },
  );
  const made = await page.evaluate(() => ({
    open: document.getElementById("create-project-dialog")?.open,
    text: document.body.textContent ?? "",
  }));
  assert.equal(made.open, false, "a successful creation closes the dialog — the act is done");
  assert.match(made.text, new RegExp(`made\\s+${name}\\s+in this browser`), "the page names the project it made");

  // And it is the project the page is now acting on, not just a sentence: the page's own registry has
  // it, with a root kind that says where the files went. (This first waited for the project's NAME in
  // the origin-storage panel, which renders the ROOT PATH and its listing — a different claim. The
  // assertion was wrong, not the page.)
  const projects = await page.evaluate(async () => ((await window.e1m0.send({ type: "listProjects" })).projects ?? []));
  const mine = projects.find((p) => p.name === name);
  assert.ok(mine, `the page's registry does not hold ${name}: ${JSON.stringify(projects)}`);
  assert.equal(mine.rootKind, "opfs", "the project was made in this browser's own storage, not on disk");
});

// Reported by an independent reviewer (voicebox-beads-6uzd), and the reason it matters: a refusal that
// only reaches #transcript sits BEHIND the modal's inert background, so a person whose attempt failed
// would see nothing until they closed the dialog — the failure would look like a button that does
// nothing. The status has to be inside the dialog, announced, and it must not pretend success.
test("a failed creation says why INSIDE the dialog, where the person is standing", { timeout: 60000 }, async () => {
  await openPage();
  await page.click("#create-project");
  await page.waitFor(() => document.getElementById("create-project-dialog")?.open === true, { label: "the dialog to open" });

  // The machine destination fails without a host token (the page cannot hold one — tests/one-root.test.mjs
  // proves the server refuses it), which makes this a deterministic refusal to observe.
  await page.click('input[name="dest"][value="machine"]');
  await page.waitFor(() => document.getElementById("dest-machine")?.hidden === false, { label: "the machine destination to be shown" });
  // NEGATIVE CONTROL before the act: no status is shown yet, so the assertion below cannot pass on a
  // dialog that always has some text in it.
  const before = await page.evaluate(() => {
    const el = document.getElementById("dest-status");
    return { hidden: el?.hidden ?? null, text: (el?.textContent ?? "").trim() };
  });
  assert.equal(before.hidden, true, "no status is shown before anything is attempted");
  assert.equal(before.text, "", "and it is empty, so a later match is this attempt's refusal");

  await page.type("#machine-path", "/nonexistent/voicebox-refusal-probe");
  await page.click("#machine-form button");
  await page.waitFor(
    () => {
      const el = document.getElementById("dest-status");
      return Boolean(el && el.hidden === false && (el.textContent ?? "").trim().length > 0);
    },
    { label: "a refusal inside the dialog" },
  );

  const shown = await page.evaluate(() => {
    const el = document.getElementById("dest-status");
    const dialog = document.getElementById("create-project-dialog");
    return {
      text: (el?.textContent ?? "").trim(),
      ok: el?.dataset.ok ?? null,
      role: el?.getAttribute("role") ?? null,
      live: el?.getAttribute("aria-live") ?? null,
      visible: Boolean(el?.checkVisibility()),
      dialogOpen: dialog?.open ?? null,
      transcript: document.getElementById("transcript")?.textContent ?? "",
    };
  });

  assert.equal(shown.visible, true, "the refusal is VISIBLE while the dialog is open, not behind an inert background");
  assert.equal(shown.dialogOpen, true, "a refusal leaves the dialog open — the person stays where they were");
  assert.equal(shown.ok, "false", "the status is marked as a failure, not as a success");
  assert.equal(shown.role, "status", "it is a status region, so it is announced");
  assert.equal(shown.live, "polite", "and announced politely rather than interrupting");
  assert.ok(shown.text.length > 10, `the refusal says something: ${JSON.stringify(shown.text)}`);
  // The transcript keeps its own record of the same refusal — asserted as the SAME text, not merely as
  // "non-empty": the transcript carries the host-ready line from page load, so a length check here would
  // be satisfied by anything (reported by an independent reviewer).
  assert.ok(shown.transcript.includes(shown.text), `the transcript does not carry the refusal: ${JSON.stringify(shown.text)}`);

  await page.press("Escape");
  await page.waitFor(() => document.getElementById("create-project-dialog")?.open === false, { label: "the dialog to close" });
});
