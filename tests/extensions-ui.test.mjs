// tests/extensions-ui.test.mjs — the extension surface as a person sees it (voicebox-beads-vwb).
//
//   node --test tests/extensions-ui.test.mjs
//
// The API tests (tests/extensions.test.mjs) prove the registry, the ledger and the gate. THIS file
// proves the page tells the same truth, because the security model is only real if a person can
// SEE it: what is running, what is waiting, what was found and never reviewed, what was refused —
// in plain language, with a present-but-unreviewed extension NEVER shown as green or running.
//
// NO AMBIENT STATE: the suite pins its whole environment (the lesson from voicebox-beads-cjk) and
// points the extension directory at its own scratch, so the rows it asserts are the rows it created.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { launch } from "./lib/cdp.mjs";
import { startServer } from "./lib/server.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const PINNED_ENV = {
  GEMINI_API_KEY: "fixture-key-presence-only",
  OPENAI_API_KEY: "fixture-key-presence-only",
  VOICEBOX_WORKSPACE: undefined, // omitted from the child env: no root arrives from the shell
  VOICEBOX_RESOLVER: "script",
};

let scratch;
let server;
let page;
let extDir;
let hostToken = "";

const hostAdmit = (id, decision = "admit") =>
  fetch(`${server.base}/api/extensions/admit`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-voicebox-host-token": hostToken },
    body: JSON.stringify({ id, confirm: true, decision }),
  }).then((r) => r.json());

// THE PANEL HAS BEEN DRAWN (voicebox-beads-g667), where 120-700ms sleeps were. Every render of the panel
// (fused.js renderExtensions: fetch the registry and the catalogue, then redraw every section) ends by
// writing #exts-count — the sections first and the count last, in one synchronous step, in the failure
// path too — so a write to the count IS a finished render, whichever way it went. The count of writes is
// zeroed just before the act that starts a render, and every render this file starts is waited for before
// the next act (the room's own boot-time render in test.before), so the write counted is that act's.
const zeroRenders = () =>
  page.evaluate(() => {
    if (!window.__extRenderObserved) {
      new MutationObserver(() => { window.__extRenders += 1; })
        .observe(document.getElementById("exts-count"), { childList: true, characterData: true, subtree: true });
      window.__extRenderObserved = true;
    }
    window.__extRenders = 0;
  });
const rendered = (label) => page.waitFor(() => window.__extRenders >= 1, { label });
const closedExts = () => page.waitFor(() => !document.getElementById("exts")?.open, { label: "the extensions dialog to close" });

const openExts = async () => {
  // The dialog light-dismisses on backdrop clicks, and a CDP click on a button BEHIND the modal
  // lands on the backdrop — so opening is only attempted when actually closed.
  const alreadyOpen = await page.evaluate(() => document.getElementById("exts")?.open ?? false);
  if (!alreadyOpen) {
    await zeroRenders();
    await page.click("#exts-open");
    await page.waitFor(() => document.getElementById("exts")?.open, { label: "the extensions dialog" });
  }
  await page.waitFor(() => document.getElementById("exts")?.open, { label: "the extensions dialog" });
  // the render fetches the registry — the one this click started (voicebox-beads-g667; a 350ms sleep was
  // here). An already-open dialog started none, and the act before it waited for its own.
  if (!alreadyOpen) await rendered("the panel render the dialog's opening started");
  return page.evaluate(() => ({
    count: document.getElementById("exts-count")?.textContent,
    shelfText: document.getElementById("ext-shelf")?.innerText ?? "",
    running: [...document.querySelectorAll("#ext-running .env-item")].map((li) => ({
      name: li.querySelector(".env-label")?.textContent,
      dot: li.querySelector(".env-dot")?.dataset.ok,
      text: li.textContent,
    })),
    waiting: [...document.querySelectorAll("#ext-waiting .env-item")].map((li) => ({
      name: li.querySelector(".env-label")?.textContent,
      dot: li.querySelector(".env-dot")?.dataset.ok,
      text: li.textContent,
    })),
    present: [...document.querySelectorAll("#ext-present .env-item")].map((li) => ({
      name: li.querySelector(".env-label")?.textContent,
      dot: li.querySelector(".env-dot")?.dataset.ok,
      text: li.textContent,
    })),
    refused: [...document.querySelectorAll("#ext-refused .env-item")].map((li) => ({
      name: li.querySelector(".env-label")?.textContent,
      dot: li.querySelector(".env-dot")?.dataset.ok,
      text: li.textContent,
    })),
    failed: [...document.querySelectorAll("#ext-failed .env-item")].map((li) => ({
      name: li.querySelector(".env-label")?.textContent,
      dot: li.querySelector(".env-dot")?.dataset.ok,
      text: li.textContent,
    })),
    catalogue: [...document.querySelectorAll("#ext-catalogue .env-item")].map((li) => ({
      name: li.querySelector(".env-label")?.textContent,
      text: li.textContent,
      hasAdd: !!li.querySelector("button"),
    })),
    visible: document.getElementById("exts")?.textContent ?? "",
  }));
};

test.before(async () => {
  scratch = mkdtempSync(path.join(os.tmpdir(), "voicebox-ext-ui-"));
  mkdirSync(path.join(scratch, "ws"), { recursive: true });
  extDir = path.join(scratch, "ext");
  mkdirSync(extDir, { recursive: true });
  const shelfDir = path.join(scratch, "shelf");
  mkdirSync(path.join(shelfDir, "assets"), { recursive: true });
  const minWasm = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
  const digest = "93a44bbb96c751218e4c00d479e4c14358122a389acca16205b1e4d0dc5f9476";
  writeFileSync(path.join(shelfDir, "assets", "hash.wasm"), minWasm);
  writeFileSync(path.join(shelfDir, "assets", "diff.wasm"), minWasm);
  writeFileSync(path.join(shelfDir, "manifest.json"), JSON.stringify({
    name: "wasm-tools",
    version: "1",
    tools: [
      { id: "hash", wasm: "assets/hash.wasm", digest, description: "Compute SHA-256 digest", capability: "compute" },
      { id: "diff", wasm: "assets/diff.wasm", digest, description: "Compute text diff", capability: "compute" },
    ],
  }));
  server = await startServer({
    cwd: ROOT,
    env: { VOICEBOX_INSTANCE: "ext-ui-test", ...PINNED_ENV, VOICEBOX_EXTENSIONS_DIR: extDir, VOICEBOX_WASM_SHELF_DIR: shelfDir },
  });
  hostToken = (await import("node:fs")).readFileSync(path.join(extDir, ".host-token"), "utf8").trim();
  page = await launch();
  await page.goto(`${server.base}/`);
  await page.waitFor(() => document.getElementById("exts-open") !== null, { label: "the room" });
  // THE ROOM'S OWN BOOT-TIME RENDER, waited out (voicebox-beads-g667): health() ends in renderExtensions,
  // and a boot render still in flight would be counted as the first act's. It ends one of three ways: the
  // panel drawn, the panel's failure written into the note, or health() itself failing (the dot reads
  // false, and no render was started).
  await page.waitFor(() =>
    document.getElementById("ext-running")?.childElementCount > 0 ||
    (document.getElementById("ext-note")?.textContent ?? "") !== "" ||
    document.getElementById("server-dot")?.dataset.ok === "false",
  { label: "the room's boot-time extension render to finish" });
});

test.after(async () => {
  await page?.close();
  await server?.stop();
  rmSync(scratch, { recursive: true, force: true });
});

const INTERNAL_VOCAB = /present-not-admitted|environment-unreachable|host-token-required|unknown-environment|environment-list-unreadable|pairing-list-unreadable|not-admitted\b/;

test("a clean machine shows five honest empty sections plus the shelf's own, and no internal vocabulary", async () => {
  // DELIBERATE CONTRACT CHANGE (voicebox-beads-ri4k, coord ruling): the host's digest-pinned
  // wasm shelf loads directly and renders as its own sixth section — callable now, never a
  // stranger awaiting review. The five review-lifecycle sections stay exactly as they were.
  const view = await openExts();
  assert.match(view.count, /Extensions · 0 running · 0 waiting/);
  assert.match(view.shelfText, /Callable now/, "the shelf section renders its callable-now rows");
  assert.match(view.running[0].text, /Nothing running yet\./);
  assert.match(view.failed[0].text, /No approved extension is failing to load\./);
  assert.match(view.waiting[0].text, /Nothing is waiting for review\./);
  assert.match(view.present[0].text, /No unreviewed files here\./);
  assert.match(view.refused[0].text, /Nothing was refused\./);
  // PLAIN LANGUAGE: the internal rule names never reach the panel.
  assert.doesNotMatch(view.visible, INTERNAL_VOCAB, "internal state names leaked into the panel");
});

test("DISCOVER: the catalogue lists strangers with a plain verdict — and the one that cannot run here says so", async () => {
  const view = await openExts();
  const byName = Object.fromEntries(view.catalogue.map((c) => [c.name, c]));
  const search = byName["Web Search"];
  assert(search, "the web-search stranger is missing from the catalogue");
  assert.match(search.text, /Would run here after review\./);
  assert.equal(search.hasAdd, true);
  const local = byName["MCP Server (local launch)"];
  assert(local, "the local MCP stranger is missing");
  assert.match(local.text, /Cannot run here/, "the refused stranger must say it cannot run, before anyone adds it");
  assert.match(local.text, /program|bounds a spawned child|start a program|the machine cannot give it what it asks for/,
    "the refusal's plain reason is missing");
});

test("SIDELOAD through the page: adding goes to WAITING, through the same review as everything else", async () => {
  const before = await openExts();
  const row = before.catalogue.find((c) => c.name === "Web Search");
  await zeroRenders();
  await page.evaluate((id) => {
    const li = [...document.querySelectorAll("#ext-catalogue .env-item")]
      .find((x) => x.querySelector(".env-label")?.textContent === "Web Search");
    li.querySelector("button").click();
  }, row?.name);
  // where a 700ms sleep was (voicebox-beads-g667): the Add answers the sideload, THEN redraws the panel
  await rendered("the Add to review to be answered and the panel redrawn");
  await page.click("#exts-close");
  await closedExts(); // where a 150ms sleep was (voicebox-beads-g667)
  await zeroRenders();
  await page.click("#exts-open");
  await rendered("the reopened panel to be drawn"); // where a 600ms sleep was (voicebox-beads-g667)
  const after = await openExts();
  assert.equal(after.count.includes("1 waiting"), true, `the waiting count did not move: ${after.count}`);
  const waitingRow = after.waiting.find((w) => w.name === "Web Search");
  assert(waitingRow, "the staged extension is not in the waiting section");
  assert.equal(waitingRow.dot, "pending", "a waiting extension must read as waiting, not as running");
  assert.match(waitingRow.text, /Waiting for the host's review/);
  // The staged extension is pending on the server too — same registry, no parallel copy:
  const inv = await fetch(`${server.base}/api/extensions`).then((r) => r.json());
  assert.equal(inv.proposals.find((p) => p.name === "Web Search")?.state, "pending");
});

test("the host admits; the page shows it RUNNING with what it may do, in plain words", async () => {
  const inv = await fetch(`${server.base}/api/extensions`).then((r) => r.json());
  const pending = inv.proposals.find((p) => p.state === "pending");
  assert(pending, "nothing pending to admit");
  const r = await hostAdmit(pending.id);
  assert.equal(r.decision, "admitted");
  await page.click("#exts-close");
  await closedExts(); // where a 150ms sleep was (voicebox-beads-g667)
  const view = await openExts();
  const row = view.running.find((x) => x.name === "Web Search");
  assert(row, "the admitted extension is not shown as running");
  assert.equal(row.dot, "true", "a running extension must be green — it is the only green in the panel");
  assert.match(row.text, /Running/);
  assert.match(row.text, /fetch from api\.duckduckgo\.com/, "the plain capability must name the hosts it may fetch");
  assert.match(row.text, /at most 5 requests/);
});

test("FOUND, NEVER RUNNING: a dropped file is visible, never green, and says it has never been reviewed", async () => {
  writeFileSync(path.join(extDir, "dropped.json"), JSON.stringify({
    id: "dropped", name: "Dropped Thing", description: "x", source: "model", runsIn: "host",
    capabilities: ["read"], bounds: {},
    tools: [{ name: "dropped_tool", description: "x", primitive: "read-file", params: { path: "notes.md" } }],
  }));
  await page.click("#exts-close");
  await closedExts(); // where a 120ms sleep was (voicebox-beads-g667)
  const view = await openExts();
  const row = view.present.find((p) => p.name === "Dropped Thing");
  assert(row, "the dropped file is invisible — a person cannot review what the page hides");
  assert.equal(row.dot, "present", "a never-reviewed file must not read as ready in any colour");
  assert.notEqual(row.dot, "true", "the never-reviewed file rendered GREEN");
  assert.match(row.text, /never reviewed/);
  assert.match(row.text, /not running/);
  // And the visible panel still carries no internal vocabulary:
  assert.doesNotMatch(view.visible, INTERNAL_VOCAB);
});

test("REFUSED: denying a present file keeps it present and never live — decided, and never green", async () => {
  const r = await hostAdmit("dropped", "deny");
  assert.equal(r.decision, "refused");
  await page.click("#exts-close");
  await closedExts(); // where a 120ms sleep was (voicebox-beads-g667)
  const view = await openExts();
  // A denied PRESENT file stays in "Found here" — the ledger records the denial, and the page
  // must still refuse to show it as running or ready:
  const row = view.present.find((x) => x.name === "Dropped Thing");
  assert(row, "the denied file vanished from the panel — the person can no longer see it");
  assert.equal(row.dot, "present");
  assert.notEqual(row.dot, "true");
  assert.match(row.text, /never reviewed|not running/);
  assert.doesNotMatch(view.visible, INTERNAL_VOCAB);
});

test("RECONFIGURE via dialog: seamless in-room authorization updates bounds without .token (voicebox-beads-5jl)", async () => {
  const view = await openExts();
  const searchRow = view.running.find((x) => x.name === "Web Search");
  assert(searchRow, "Web Search must be running");

  // Click 'Reconfigure' button on the running extension
  await page.evaluate(() => {
    const btn = document.querySelector("#ext-running .ext-reconfigure-btn");
    btn?.click();
  });
  await page.waitFor(() => document.getElementById("ext-manage-dialog")?.open, { label: "manage dialog open" });

  const modalTitle = await page.evaluate(() => document.getElementById("ext-manage-title")?.textContent);
  assert.match(modalTitle, /Reconfigure Web Search/);

  // In-room authorization avoids the undocumented .token requirement: token field is hidden
  const tokenInputType = await page.evaluate(() => document.getElementById("ext-manage-token")?.type);
  assert.equal(tokenInputType, "hidden", "host token input must not be a required visible field");

  // Submitting invalid negative bounds refuses with bounds-invalid without needing a token
  await page.evaluate(() => {
    document.getElementById("ext-manage-max-requests").value = "-15";
    document.getElementById("ext-manage-form").requestSubmit();
  });
  // where a 150ms sleep was (voicebox-beads-g667): the submit writes "Applying..." at once and the server's
  // answer when it comes, so the status moving off "Applying..." is the answer — whichever it was.
  await page.waitFor(() => !["", "Applying..."].includes(document.getElementById("ext-manage-status")?.textContent ?? ""),
    { label: "the manage dialog's answer to the invalid bounds" });
  const statusInvalidBounds = await page.evaluate(() => document.getElementById("ext-manage-status")?.textContent);
  assert.match(statusInvalidBounds, /maxRequests must be a non-negative integer|bounds-invalid/);

  // Fill in updated bounds and submit seamlessly without any host token
  await page.evaluate(() => {
    document.getElementById("ext-manage-max-requests").value = "30";
    document.getElementById("ext-manage-hosts").value = "api.duckduckgo.com, news.google.com";
    document.getElementById("ext-manage-form").requestSubmit();
  });

  await page.waitFor(() => document.getElementById("ext-manage-dialog")?.open === false, { label: "manage dialog closed" });

  // Verify the updated bounds are displayed in plain language on the running row
  await page.waitFor(() => document.querySelector("#ext-running .ext-detail")?.textContent.includes("30 requests"), {
    label: "running extension shows updated requests bound",
  });
  const updatedText = await page.evaluate(() => document.querySelector("#ext-running")?.textContent ?? "");
  assert.match(updatedText, /at most 30 requests/);
  assert.match(updatedText, /news\.google\.com/);
});

test("REMOVE via dialog: seamless in-room authorization revokes extension without .token (voicebox-beads-5jl)", async () => {
  // Click 'Remove' button on the running extension
  await page.evaluate(() => {
    const btn = document.querySelector("#ext-running .ext-remove-btn");
    btn?.click();
  });
  await page.waitFor(() => document.getElementById("ext-manage-dialog")?.open, { label: "manage dialog open in remove mode" });

  const mode = await page.evaluate(() => document.getElementById("ext-manage-mode")?.value);
  assert.equal(mode, "remove");

  const warning = await page.evaluate(() => document.getElementById("ext-manage-warning-text")?.textContent);
  assert.match(warning, /tools.*web_search.*stop being callable immediately/);

  // Submit removal seamlessly without entering any host token
  await page.evaluate(() => {
    document.getElementById("ext-manage-form").requestSubmit();
  });

  await page.waitFor(() => document.getElementById("ext-manage-dialog")?.open === false, { label: "manage dialog closed after removal" });

  // Running section now shows empty state
  await page.waitFor(() => document.querySelector("#ext-running")?.textContent.includes("Nothing running yet"), {
    label: "running section reflects removal",
  });
  const runningCount = await page.evaluate(() => document.querySelectorAll("#ext-running .env-item:not(.env-empty)").length);
  assert.equal(runningCount, 0, "no running extensions should remain");

  // Verify on the server that the extension is revoked. The DELIBERATE contract change
  // (voicebox-beads-ri4k, coord ruling): the host's own digest-pinned wasm shelf loads
  // directly into the registry, so the two shelf entries remain — everything else must be gone.
  const inv = await fetch(`${server.base}/api/extensions`).then((r) => r.json());
  const nonShelf = inv.extensions.filter((e) => e.source !== "wasm-shelf");
  assert.equal(nonShelf.length, 0, `only shelf tools may remain: ${JSON.stringify(inv.extensions.map((e) => e.id))}`);
  assert.deepEqual(inv.extensions.filter((e) => e.source === "wasm-shelf").map((e) => e.id).sort(),
    ["wasm-shelf-diff", "wasm-shelf-hash"], "the shelf's own tools stay admitted and callable");
});

test("APPROVED, NOT RUNNING: a deleted descriptor behind a live admission gets its own named row (voicebox-beads-qdo)", async () => {
  // Self-contained staging: two admissions (the first will lose its file; the second is the
  // reload trigger), then one more admission after the deletion so the reload sees the gap.
  const descriptor = (id, tool) => ({
    id, name: id, description: "init-error UI fixture", source: "model", runsIn: "host",
    capabilities: [], bounds: {},
    tools: [{ name: tool, description: "t", primitive: "now", params: {} }],
  });
  const stage = async (id, tool) => {
    const r = await fetch(`${server.base}/api/extensions/proposals`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ descriptor: descriptor(id, tool) }),
    }).then((r) => r.json());
    assert.equal(r.state, "pending", `the proposal must stage: ${JSON.stringify(r)}`);
    const adm = await hostAdmit(id);
    assert.equal(adm.decision, "admitted", `the fixture must pass the real gate: ${JSON.stringify(adm)}`);
  };
  await stage("ui-victim", "ui_victim_tool");
  await stage("ui-trigger", "ui_trigger_tool");
  rmSync(path.join(extDir, "ui-victim.json")); // the file vanishes behind a live admission
  await stage("ui-third", "ui_third_tool"); // any host act rebuilds the loaded set

  // Server truth first: the inventory must carry the named failure.
  const inv = await fetch(`${server.base}/api/extensions`).then((r) => r.json());
  const apiEntry = (inv.failedLoads ?? []).find((f) => f.id === "ui-victim");
  assert.ok(apiEntry, `the inventory must name ui-victim: ${JSON.stringify(inv.failedLoads)}`);
  assert.equal(apiEntry.refused, "descriptor-missing");

  // Force a fresh render: the dialog may be open from an earlier test, and openExts would
  // otherwise skip the click that triggers renderExtensions.
  await page.click("#exts-close");
  await closedExts(); // where a 150ms sleep was (voicebox-beads-g667)
  const view = await openExts();
  const row = view.failed.find((x) => x.name === "ui-victim");
  assert(row, "the deleted-descriptor extension must have its own row — never silence");
  assert.equal(row.dot, "false", "a failed load is never green");
  assert.match(row.text, /Approved · not running/);
  assert.match(row.text, /Next:/);
  assert.match(row.text, /restore|revoke/);
  assert.ok(!view.running.some((x) => x.name === "ui-victim"), "never mixed into Running");
  assert.doesNotMatch(view.visible, INTERNAL_VOCAB, "internal state names leaked into the panel");
});
