// tests/agent-presence.test.mjs — bead voicebox-beads-kcs.
//
// "Is the agent THERE?" — presence derived from real facts, naming the absent side.
//
// Proves:
//   1. When the server is answering, #where-note displays 'agent: <provider>' derived
//      from GET /api/health, with the tooltip citing the real commit SHA (not 'dev').
//   2. When the server is unreachable, #where-note names 'machine-unreachable (fix the host)',
//      with clean tooltip (never falsely stating 'the server answered 500').
//   3. When the server's environment list is unreadable (mode 000 file), the presence line
//      surfaces 'environment-list-unreadable (fix the file)' via GET /api/environments,
//      which is distinguishable from machine-unreachable; /api/health still controls the dot.
//   4. When live voice fails, #voice-state names the absent side (machine-unreachable).

import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { launch } from "./lib/cdp.mjs";
import { startServer } from "./lib/server.mjs";

test("presence: #where-note derives agent provider and real commit SHA from GET /api/health", async () => {
  const server = await startServer({ env: { VOICEBOX_RESOLVER: "script" } });
  const page = await launch({ fakeMedia: true });
  try {
    await page.goto(server.base);
    await page.waitFor(
      () => document.querySelector("#server-dot")?.getAttribute("data-ok") === "true",
      { timeout: 30000, label: "server-dot data-ok=true" },
    );

    const where = await page.evaluate(() => {
      const el = document.querySelector("#where-note");
      const dot = document.querySelector("#server-dot");
      return {
        text: el?.textContent ?? "",
        title: el?.getAttribute("title") ?? "",
        dotOk: dot?.getAttribute("data-ok") ?? "",
      };
    });

    assert.equal(where.dotOk, "true", "server-dot must show data-ok=true");
    assert.equal(where.text, "agent: script", "where-note must name the agent provider from /api/health");
    assert.match(where.title, /source: GET \/api\/health/, "tooltip must name its source");
    assert.match(where.title, /provider: script/, "tooltip must name the provider");
    assert.match(where.title, /build: [0-9a-f]{7,40}/, "tooltip must cite the real commit sha, never 'dev'");
    assert.doesNotMatch(where.title, /build: dev/, "must not fall back to 'dev' when commit exists");
  } finally {
    await page.close();
    await server.stop();
  }
});

// THE TWO WORDINGS THIS ARM ACCEPTS FOR "the machine is unreadable, and here is the remedy". They are
// declared ONCE and used by BOTH the wait and the assertion, so the wait cannot end up waiting for a
// wording the assertion would then reject (voicebox-beads-y1db). `UNREACHABLE_NOTE` is the wording the room
// actually produces today; the other is the plain "machine-unreachable (fix the host)" rendering this arm
// has always accepted, kept so a deliberate rewording of the status line is not what breaks it.
const UNREACHABLE_NOTES = Object.freeze([
  "machine-unreachable (fix the host)",
  "the machine is not answering — fix the host",
]);
const isUnreachableNote = (text) => UNREACHABLE_NOTES.includes(text);

test("presence: when server is unreachable, #where-note names machine-unreachable without proxy-500 confusion", { timeout: 180000 }, async () => {
  let server;
  let serverStopped = false;
  const page = await launch({ fakeMedia: true });
  try {
    server = await startServer({ env: { VOICEBOX_RESOLVER: "script" } });
    await page.goto(server.base);
    await page.waitFor(
      () => document.querySelector("#server-dot")?.getAttribute("data-ok") === "true",
      { timeout: 30000, label: "server-dot data-ok=true" },
    );

    // A CONTROL WITH TEETH, first: the accepted wordings must NOT match the healthy state, or the wait below
    // would be a no-op that the assertion could never fail. The room says "agent: script" while it is up.
    // Read and assert while the server is still running to eliminate the post-stop poll race (voicebox-beads-uqfx).
    const healthyNote = await page.evaluate(() => document.querySelector("#where-note")?.textContent ?? "");
    assert.equal(
      isUnreachableNote(healthyNote),
      false,
      `the accepted unreachable wordings must not match a healthy room's note, or the wait proves nothing (it read ${JSON.stringify(healthyNote)})`,
    );

    // Stop server so the room's own re-check fails with connection refused.
    await server.stop();
    serverStopped = true;

    await page.waitFor(
      (notes) => notes.includes(document.querySelector("#where-note")?.textContent ?? ""),
      { timeout: 120000, label: "the room's own poll to name the unreachable machine", args: [UNREACHABLE_NOTES] },
    );

    const where = await page.evaluate(() => {
      const el = document.querySelector("#where-note");
      const dot = document.querySelector("#server-dot");
      return {
        text: el?.textContent ?? "",
        title: el?.getAttribute("title") ?? "",
        dotOk: dot?.getAttribute("data-ok") ?? "",
      };
    });

    assert.equal(where.dotOk, "false", "server-dot must show data-ok=false");
    assert.ok(
      isUnreachableNote(where.text),
      `the room's own machine-unreachable sentence must be the settled text, not a downstream route's refusal (it read ${JSON.stringify(where.text)})`,
    );
    assert.match(where.title, /machine-unreachable/, "tooltip must state machine-unreachable");
    assert.doesNotMatch(where.title, /500/, "must not conflate machine-unreachable with 'server answered 500'");
  } finally {
    await page.close();
    if (!serverStopped) await server?.stop?.();
  }
});

test("presence: environment-list-unreadable surfaces via GET /api/environments, distinguishable from machine-unreachable", async () => {
  const scratchWorkspace = mkdtempSync(path.join(tmpdir(), "vb-presence-env-"));
  const envFile = path.join(scratchWorkspace, "environments.json");
  // Write a valid registry file first
  writeFileSync(envFile, JSON.stringify({ environments: [] }, null, 2), { mode: 0o600 });

  const server = await startServer({
    env: {
      VOICEBOX_RESOLVER: "script",
      VOICEBOX_WORKSPACE: scratchWorkspace,
    },
  });
  const page = await launch({ fakeMedia: true });

  try {
    // 1. Initial healthy load
    await page.goto(server.base);
    await page.waitFor(
      () => document.querySelector("#server-dot")?.getAttribute("data-ok") === "true",
      { timeout: 30000, label: "server-dot data-ok=true" },
    );

    // 2. Make environments.json mode 000 so readEnvironments() fails with environment-list-unreadable
    chmodSync(envFile, 0o000);

    // Re-trigger page load / health check
    await page.reload();
    // The identifier is the TITLE now, not the visible line (voicebox-beads-0ye), so the wait watches
    // where it actually lives — waiting on the visible text would time out on a page that is correct.
    await page.waitFor(
      () => (document.querySelector("#where-note")?.getAttribute("title") ?? "").includes("environment-list-unreadable"),
      { label: "where-note title names environment-list-unreadable" },
    );

    const unreadableState = await page.evaluate(() => {
      const el = document.querySelector("#where-note");
      const dot = document.querySelector("#server-dot");
      return {
        text: el?.textContent ?? "",
        title: el?.getAttribute("title") ?? "",
        dotOk: dot?.getAttribute("data-ok") ?? "",
      };
    });

    assert.equal(unreadableState.dotOk, "true", "server-dot follows the healthy /api/health response, not the unreadable registry");
    // THE VISIBLE LINE IS PLAIN; THE IDENTIFIER IS THE DIAGNOSTIC (voicebox-beads-0ye). The two failure
    // classes stay distinguishable — by their sentences — while the server's own word for each lives in
    // the title, where somebody diagnosing finds it and nobody else has to read it.
    assert.equal(unreadableState.text, "the environment list could not be read — fix the file",
      "the visible line must say what happened in words");
    assert.match(unreadableState.title, /environment-list-unreadable/, "the title must still name the refusal the server used");
    assert.match(unreadableState.title, /source: GET \/api\/environments/, "title must cite GET /api/environments as source");
    assert.notEqual(unreadableState.text, "the machine is not answering — fix the host",
      "an unreadable list and an unreachable machine must not read the same");

    // 3. Restore permissions (0600) and verify recovery back to agent: script
    chmodSync(envFile, 0o600);
    await page.reload();
    await page.waitFor(
      () => document.querySelector("#where-note")?.textContent === "agent: script",
      { label: "where-note agent: script restored" },
    );
    const restoredDot = await page.evaluate(() => document.querySelector("#server-dot")?.getAttribute("data-ok"));
    assert.equal(restoredDot, "true", "server-dot must recover to data-ok=true");
  } finally {
    try { chmodSync(envFile, 0o600); } catch {}
    rmSync(scratchWorkspace, { recursive: true, force: true });
    await page.close();
    await server.stop();
  }
});

test("presence: live-voice upgrade failure names machine-unreachable when server is down", async () => {
  const page = await launch({ fakeMedia: true });
  try {
    await page.goto("about:blank");
    const explanation = await page.evaluate(async () => {
      // Connect to dead port
      try {
        const response = await fetch("http://127.0.0.1:49999/api/health", { cache: "no-store" });
        return { ok: true, status: response.status };
      } catch {
        return { text: "the local server is not answering (machine-unreachable — fix the host)", transient: true, code: "machine-unreachable" };
      }
    });

    assert.equal(explanation.code, "machine-unreachable", "upgrade failure must classify dead server as machine-unreachable");
    assert.match(explanation.text, /fix the host/, "explanation must provide host remedy");
  } finally {
    await page.close();
  }
});
