// tests/project-instruction-browser.test.mjs — the PAGE half of voicebox-beads-0zi4.
//
// The unit tests prove the reader and the framing; the live tests prove the route and the vendor
// frames. This one proves the piece in between: the page the person actually navigates REPORTS the
// folder it is showing — on the real socket wiring, not through an exported helper — and for a room
// folder it reads the file itself, because the machine cannot see opfs/handles.
//
// The socket is faked in the page (a recorder), so no provider is dialled and no key is needed; every
// other part is the real page: fused.js owns `listingDir`, live-voice.js registers the sender when the
// socket opens, and the report is triggered by the same navigation a person performs.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { startServer } from "./lib/server.mjs";
import { launch } from "./lib/cdp.mjs";

async function until(check, label, ms = 8000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await sleep(50);
  }
  assert.fail(`No ${label} within ${ms}ms`);
}

test("the page reports the folder it is showing, and reads a room folder's AGENTS.md itself (voicebox-beads-0zi4)", async (t) => {
  const scratch = mkdtempSync(path.join(os.tmpdir(), "vb-projinstr-page-"));
  const workspace = path.join(scratch, "workspace");
  const host = path.join(scratch, "host");
  mkdirSync(path.join(workspace, "packages", "api"), { recursive: true });
  mkdirSync(host);
  writeFileSync(path.join(workspace, "AGENTS.md"), "root rules");
  writeFileSync(path.join(workspace, "packages", "api", "AGENTS.md"), "api rules");

  let server;
  let page;
  t.after(async () => {
    await page?.close().catch(() => {});
    if (server?.child.exitCode === null && server.child.signalCode === null) await server.stop();
    rmSync(scratch, { recursive: true, force: true });
  });

  server = await startServer({
    env: {
      VOICEBOX_WORKSPACE: workspace,
      VOICEBOX_EXTENSIONS_DIR: host,
      VOICEBOX_RESOLVER: "script",
    },
  });

  page = await launch({ width: 1100, height: 900, fakeMedia: true });
  await page.goto(`${server.base}/`);
  // The voice page's own readiness: the microphone and a rendered listing. (The `e1m0` host API lives
  // on environment.html, which is not the page whose navigation this test drives.)
  await page.waitFor(
    () => !!document.getElementById("mic") && document.querySelectorAll("#files li").length > 0,
    { label: "the explorer and the microphone" },
  );

  // A recorder in place of the live socket. It answers the same calls the adapters make
  // (addEventListener/send/close), and fires `open` so live-voice.js registers its sender.
  await page.evaluate(() => {
    window.__sentFrames = [];
    class RecordingSocket {
      constructor(url) {
        this.url = url;
        this.readyState = 1; // OPEN
        this.binaryType = "arraybuffer";
        this.listeners = { message: [], close: [], error: [], open: [] };
        window.__recordingSocket = this;
        setTimeout(() => { this.onopen?.({}); for (const fn of this.listeners.open) fn({}); }, 0);
      }
      send(data) { if (typeof data === "string") window.__sentFrames.push(data); }
      close() { this.readyState = 3; }
      addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
      // The static constants are part of the interface the page uses (`socket.readyState === WebSocket.OPEN`),
      // so a fake without them silently drops every frame a real socket would send.
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;
      removeEventListener(type, fn) {
        this.listeners[type] = (this.listeners[type] ?? []).filter((f) => f !== fn);
      }
    }
    window.WebSocket = RecordingSocket;
  });

  // Press the microphone: the real startLive() path opens the (recording) socket and registers the
  // project-context sender. Nothing else about this test is stubbed.
  await page.evaluate(() => {
    window.__pageErrors = [];
    window.addEventListener("error", (e) => window.__pageErrors.push(String(e.message)));
    window.addEventListener("unhandledrejection", (e) => window.__pageErrors.push(String(e.reason?.message ?? e.reason)));
    document.getElementById("mic")?.click();
  });
  const frames = () => page.evaluate(() => window.__sentFrames.map((f) => { try { return JSON.parse(f); } catch { return { type: "unparseable" }; } }));

  // 1. The first report happens as soon as the socket is up: the machine root, at its root folder.
  await until(async () => (await frames()).some((f) => f.type === "folder"), "the first folder report").catch(async (error) => {
    console.error("[diagnostic] page state:", JSON.stringify(await page.evaluate(() => ({
      socketCreated: !!window.__recordingSocket,
      frames: window.__sentFrames,
      live: !!window.__voiceboxLive,
      errors: window.__pageErrors,
      voiceState: document.getElementById("voice-state")?.textContent,
    })), null, 2));
    throw error;
  });
  const first = (await frames()).find((f) => f.type === "folder");
  assert.equal(first.dir, "", "the root of the declared machine root is reported as ''");

  // 2. A person's navigation: into packages, then into api.
  await page.waitFor(
    () => [...document.querySelectorAll("button.file-open[data-kind='directory']")].some((b) => b.dataset.file === "packages"),
    { label: "the packages folder row" },
  );
  await page.evaluate(() => {
    const row = [...document.querySelectorAll("button.file-open[data-kind='directory']")]
      .find((b) => b.dataset.file === "packages");
    row?.click();
  });
  await until(async () => (await frames()).some((f) => f.type === "folder" && f.dir === "packages"), "the packages report");
  // The listing that CONTAINS api renders after the packages report (the report is optimistic and the
  // listing is a request), so wait for the row rather than clicking into a list that is not there yet.
  await page.waitFor(
    () => [...document.querySelectorAll("button.file-open[data-kind='directory']")].some((b) => b.dataset.file === "api"),
    { label: "the api folder row" },
  );
  await page.evaluate(() => {
    [...document.querySelectorAll("button.file-open[data-kind='directory']")]
      .find((b) => b.dataset.file === "api")?.click();
  });
  const deep = await until(async () => (await frames()).find((f) => f.type === "folder" && f.dir === "packages/api"), "the packages/api report");
  assert.equal(deep.type, "folder", "a machine root reports the PATH; the server reads the file");
  assert.equal(Object.hasOwn(deep, "text"), false, "the page does not send text it cannot read");

  // 3. A room folder: OPFS scratchpad with its own AGENTS.md. The page holds the handle, so IT reads
  //    the file and sends the text — the machine has no way to see this folder at all.
  // Seed the scratchpad BEFORE adopting it: the page lists a folder when it is opened, so a file
  // written after that listing would need a second re-list to show up (and the test would be measuring
  // the harness's timing rather than the report).
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const scratchpad = await root.getDirectoryHandle("scratchpad", { create: true });
    const docs = await scratchpad.getDirectoryHandle("docs", { create: true });
    const writable = await (await docs.getFileHandle("AGENTS.md", { create: true })).createWritable();
    await writable.write("opfs rules");
    await writable.close();
    document.getElementById("open-opfs-folder")?.click();
  });
  await page.waitFor(
    () => document.getElementById("room-folder-hint")?.textContent?.includes("scratchpad") ||
      [...document.querySelectorAll("button.file-open[data-kind='directory']")].some((b) => b.dataset.file === "docs"),
    { label: "the scratchpad adopted" },
  );

  // Navigating INTO the docs folder re-lists the room and re-reports it (the report follows the folder).
  await page.waitFor(
    () => [...document.querySelectorAll("button.file-open[data-kind='directory']")].some((b) => b.dataset.file === "docs"),
    { label: "the docs folder row inside the scratchpad" },
  );
  await page.evaluate(() => {
    [...document.querySelectorAll("button.file-open[data-kind='directory']")]
      .find((b) => b.dataset.file === "docs")?.click();
  });
  const roomReport = await until(
    async () => (await frames()).find((f) => f.type === "project_instruction" && f.dir === "docs"),
    "the room folder's instruction report",
  );
  assert.equal(roomReport.file, "AGENTS.md");
  assert.equal(roomReport.text, "opfs rules", "the page read the file out of its own handle and sent the text");
});
