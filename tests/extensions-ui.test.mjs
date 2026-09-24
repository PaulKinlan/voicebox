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
import { setTimeout as sleep } from "node:timers/promises";
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

const openExts = async () => {
  // The dialog light-dismisses on backdrop clicks, and a CDP click on a button BEHIND the modal
  // lands on the backdrop — so opening is only attempted when actually closed.
  const alreadyOpen = await page.evaluate(() => document.getElementById("exts")?.open ?? false);
  if (!alreadyOpen) {
    await page.click("#exts-open");
    await page.waitFor(() => document.getElementById("exts")?.open, { label: "the extensions dialog" });
  }
  await page.waitFor(() => document.getElementById("exts")?.open, { label: "the extensions dialog" });
  await sleep(350); // the render fetches the registry
  return page.evaluate(() => ({
    count: document.getElementById("exts-count")?.textContent,
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
  server = await startServer({
    cwd: ROOT,
    env: { VOICEBOX_INSTANCE: "ext-ui-test", ...PINNED_ENV, VOICEBOX_EXTENSIONS_DIR: extDir },
  });
  hostToken = (await import("node:fs")).readFileSync(path.join(extDir, ".host-token"), "utf8").trim();
  page = await launch();
  await page.goto(`${server.base}/`);
  await page.waitFor(() => document.getElementById("exts-open") !== null, { label: "the room" });
});

test.after(async () => {
  await page?.close();
  await server?.stop();
  rmSync(scratch, { recursive: true, force: true });
});

const INTERNAL_VOCAB = /present-not-admitted|environment-unreachable|host-token-required|unknown-environment|environment-list-unreadable|pairing-list-unreadable|not-admitted\b/;

test("a clean machine shows four honest empty sections and no internal vocabulary", async () => {
  const view = await openExts();
  assert.match(view.count, /Extensions · 0 running · 0 waiting/);
  assert.match(view.running[0].text, /Nothing running yet\./);
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
  await page.evaluate((id) => {
    const li = [...document.querySelectorAll("#ext-catalogue .env-item")]
      .find((x) => x.querySelector(".env-label")?.textContent === "Web Search");
    li.querySelector("button").click();
  }, row?.name);
  await sleep(700);
  await page.click("#exts-close");
  await sleep(150);
  await page.click("#exts-open");
  await sleep(600);
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
  await sleep(150);
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
  await sleep(120);
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
  await sleep(120);
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
  await sleep(150);
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

  // Verify on the server that the extension is revoked
  const inv = await fetch(`${server.base}/api/extensions`).then((r) => r.json());
  assert.equal(inv.extensions.length, 0);
});
