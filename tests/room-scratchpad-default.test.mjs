// tests/room-scratchpad-default.test.mjs — voicebox-beads-vnos: a file-creation turn with no folder open
// lands in the browser's own scratchpad (OPFS), and the room says so.
//
//   node --test tests/room-scratchpad-default.test.mjs
//
// THE DEFECT this pins: `send()` in public/fused.js handled "create a file called X with Y" ONLY inside the
// room-folder branch. With no folder open — and, on a fresh instance, no root declared at all — the command
// fell through to the server, which has no folder to write into and refuses with `root-not-declared`. So the
// one affordance the page can always honour, the browser storage the scratchpad button already opens, was
// not where the command reached: in the state the room OPENS IN, no file could be made at all.
//
// WHAT IS ASSERTED, in the room a person uses:
//   1. the CONTROL first, in the bug's own state: a turn that is not a file command still goes to the server
//      and refuses by name — so the fallback is specific rather than a page that swallows every turn;
//   2. the typed create turn settles with the room's own line — wrote <name> (<n> bytes observed) in
//      Browser Scratchpad (OPFS);
//   3. the DRAWER shows it: the card in #files and the count in #file-count, because a write into a folder
//      the page is not showing is a write the person cannot see;
//   4. the bytes are really there — read straight out of OPFS by the test, not through the room's reporter;
//   5. the view line above the list does not call a folder it just wrote into a read-only view;
//   6. the empty state teaches the command that works (and hides the one that cannot land), instead of
//      telling a person nothing can be written.
import test from "node:test";
import assert from "node:assert/strict";
import { startServer } from "./lib/server.mjs";
import { launch } from "./lib/cdp.mjs";

let server;
test.before(async () => { server = await startServer({ env: { VOICEBOX_INSTANCE: "scratchpad-default" } }); });
test.after(async () => { await server?.stop?.(); });

/**
 * Type a turn into the composer and wait for it to SETTLE — its own line heads the session log and Send
 * reads "Send" again, which `send()` restores only in its `finally`, after the post-write re-listing.
 * Outcome-blind on purpose: a refusal settles too, and the callers below report what the line said.
 */
const say = (page, said) =>
  page.evaluate(async (text) => {
    const until = async (label, ready, ms = 25000) => {
      const deadline = Date.now() + ms;
      while (!ready()) {
        if (Date.now() > deadline) throw new Error(`timed out after ${ms}ms waiting for ${label}`);
        await new Promise((r) => setTimeout(r, 40));
      }
    };
    const input = document.getElementById("utterance");
    input.value = text;
    document.getElementById("text-form").requestSubmit();
    await until(`the turn “${text}” to settle`, () =>
      (document.querySelector("#session-log li .said")?.textContent ?? "").includes(text) &&
      document.getElementById("send")?.textContent === "Send");
    return {
      line: document.querySelector("#session-log li .did")?.textContent ?? "",
      log: document.getElementById("session-log")?.textContent ?? "",
      cards: [...document.querySelectorAll("#files .file-open")].map((b) => b.dataset.file),
      count: document.getElementById("file-count")?.textContent?.trim() ?? "",
      listing: document.getElementById("listing-root")?.textContent?.trim() ?? "",
    };
  }, said);

test("no folder open: a create turn lands in the browser scratchpad, the drawer shows it, and the bytes are there", { timeout: 120000 }, async () => {
  const page = await launch({ width: 1280, height: 900 });
  try {
    await page.goto(`${server.base}/`);
    await page.waitFor(() => document.getElementById("files") && document.getElementById("send"), { label: "the room" });

    // THE STATE THE BUG LIVES IN: nothing declared. The room's own chip is the witness.
    await page.waitFor(() => /no folder chosen/i.test(document.getElementById("root-kind")?.textContent ?? ""), { label: "the room to report that no root is declared" });

    // ── THE EMPTY STATE MUST NOT DENY THE AFFORDANCE IT HAS ───────────────────
    const empty = await page.evaluate(() => ({
      next: document.getElementById("empty-next")?.textContent?.trim() ?? "",
      samples: [...document.querySelectorAll("#samples li")].filter((li) => !li.hidden).map((li) => li.textContent.trim()),
    }));
    assert.match(empty.next, /scratchpad/i, `the empty state does not name the one command that lands with nothing declared: "${empty.next}"`);
    assert.ok(empty.samples.some((s) => /create a file called/i.test(s)), `the file-making samples are hidden in the state that can honour them: ${JSON.stringify(empty.samples)}`);
    assert.ok(!empty.samples.some((s) => /^list files$/i.test(s)), `a command the room will refuse is offered as a sample: ${JSON.stringify(empty.samples)}`);

    // ── THE CONTROL, BEFORE ANY FOLDER EXISTS: the server still answers everything else ──
    const asked = await say(page, "list files");
    assert.doesNotMatch(asked.line, /Browser Scratchpad/i, `a non-file turn was answered by the browser instead of the server: ${JSON.stringify(asked.line)}`);
    assert.match(asked.line, /nothing to write into|no project root/i, `the server's own refusal is missing from the control turn: ${JSON.stringify(asked.line)}`);
    assert.equal(asked.count, "", `a refused turn changed the drawer's count: ${JSON.stringify(asked.count)}`);

    // ── THE CREATE TURN, TYPED INTO THE COMPOSER ──────────────────────────────
    const settled = await say(page, "create a file called scratch-proof.txt with written by the room");
    assert.match(settled.line, /wrote scratch-proof\.txt \(\d+ bytes? observed\) in Browser Scratchpad \(OPFS\)/, `the write line does not name the scratchpad or quote the observed size: ${JSON.stringify(settled.line)}`);
    assert.ok(settled.cards.includes("scratch-proof.txt"), `the drawer does not list the file that was just written: ${JSON.stringify(settled.cards)}`);
    assert.equal(settled.count, "1 file", `the count does not follow the drawer: ${JSON.stringify(settled.count)}`);
    assert.doesNotMatch(settled.listing, /read-only/i, `a folder the room just wrote into is labelled read-only: ${JSON.stringify(settled.listing)}`);
    assert.match(settled.listing, /turns save here/i, `the view line does not say this folder is the writer: ${JSON.stringify(settled.listing)}`);

    // ── THE BYTES, read by this test out of OPFS — not through the room's own report ──
    const bytes = await page.evaluate(async () => {
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle("scratchpad");
      return await (await (await dir.getFileHandle("scratch-proof.txt")).getFile()).text();
    });
    assert.equal(bytes, "written by the room", "the file in the browser's storage does not hold what the turn said");
  } finally {
    await page.close();
  }
});
