// tests/n20-permission-denied.test.mjs — the fourth permission state, driven by a real answer.
//
//   node --test tests/n20-permission-denied.test.mjs
//
// WHY THIS SUITE EXISTS: three of the four permission outcomes were driven with distinct codes and
// distinct reasons — implicit (OPFS), `prompt` (a dropped folder) and "no handle at all" — and
// `denied` was distinct only by inspection. Coord's finding, and it was right: the one state a
// person can reach by clicking "Block" was the one no test pinned.
//
// HOW IT IS DRIVEN WITHOUT FAKING ANYTHING: Chromium's own content settings block File System
// Access for an origin, and a blocked origin's handle answers `queryPermission` with `denied` —
// the platform's answer, not a constructed one. The profile is written before the browser starts
// (the same mechanism a person's Block click ends up in), so the host takes exactly the path it
// takes for a real denial: it branches on what `queryPermission` returned and nothing else.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { startServer } from "./lib/server.mjs";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { launch } from "./lib/cdp.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let server;
let BASE;
let page;
let folder;
let folderName;

const send = (message) => page.evaluate((m) => window.e1m0.send(m), message);

/** The profile a person's "Block" click leaves behind: File System Access denied for this origin. */
function blockedProfile(port) {
  const profile = mkdtempSync(path.join(os.tmpdir(), "voicebox-blocked-"));
  mkdirSync(path.join(profile, "Default"), { recursive: true });
  const exception = { setting: 2, last_modified: String(Date.now()), expiration: "0" };
  // The origin must name the port the server actually bound — which is why the server starts first.
  const origin = `http://127.0.0.1:${port},*`;
  writeFileSync(
    path.join(profile, "Default", "Preferences"),
    JSON.stringify({
      profile: {
        content_settings: {
          exceptions: {
            file_system_write_guard: { [origin]: exception },
            file_system_read_guard: { [origin]: exception },
          },
        },
      },
    }),
  );
  writeFileSync(path.join(profile, "Local State"), JSON.stringify({ profile: { info_cache: { Default: { name: "Default" } } } }));
  return profile;
}

test.before(async () => {
  const parent = mkdtempSync(path.join(os.tmpdir(), "voicebox-denied-"));
  folder = path.join(parent, "blocked-folder");
  mkdirSync(folder);
  writeFileSync(path.join(folder, "in-there.txt"), "a file the page may not read\n");
  folderName = path.basename(folder);
  server = await startServer({
    cwd: ROOT,
    env: { VOICEBOX_WORKSPACE: undefined, VOICEBOX_INSTANCE: "n20-denied" },
  });
  BASE = server.base;
  page = await launch({ profile: blockedProfile(server.port) });
  await page.goto(`${BASE}/environment.html`);
  await page.waitFor(() => window.e1m0 !== undefined, { label: "the page's host API" });
});

test.after(async () => {
  await page?.close();
  await server?.stop();
  rmSync(path.dirname(folder), { recursive: true, force: true });
});

test("N20.7 'denied' is a state of its own: distinct code, its own reason, and it is recorded", { timeout: 90000 }, async () => {
  await page.dropFolder("#dropzone", folder);

  // The platform's answer first, so the test cannot pass by accident of our own bookkeeping:
  // `handleState` asks the handle itself, through the same `queryPermission` the host uses.
  const answers = await page.evaluate(async (expected) => {
    const reply = await window.e1m0.send({ type: "listProjects" });
    const adopted = (reply.projects ?? []).find((p) => p.name === expected);
    if (!adopted) return { adopted: false };
    const state = await window.e1m0.send({ type: "handleState", name: expected });
    return { adopted: true, state };
  }, folderName);
  assert.equal(answers.adopted, true, "the blocked folder was not adopted");
  assert.equal(answers.state.permission, "denied", `expected the platform to answer 'denied', saw '${answers.state.permission}'`);
  assert.equal(answers.state.readPermission ?? "denied", "denied", "expected read to be denied as well");

  // Now the host's answer, on the same real state.
  const read = await send({ type: "readFile", path: "in-there.txt" });
  assert.equal(read.ok, false, "a file was read through a denied handle");
  assert.equal(read.code, "permission-denied", `expected permission-denied, saw ${JSON.stringify(read)}`);
  assert.match(read.why, /declined/, "the refusal does not say the permission was declined");

  const write = await send({ type: "createAsset", args: { name: "nope.txt", kind: "text", body: "x" } });
  assert.equal(write.code, "permission-denied");
  assert.match(write.why, /declined/);

  // The three permission states are three different answers, and this one is not either neighbour.
  const gesture = await send({ type: "handleState", name: "a-name-with-no-handle" });
  assert.equal(gesture.code, "handle-gone");
  assert.notEqual(read.code, gesture.code);
  assert.notEqual(read.code, "needs-gesture");

  // Refusals are recorded, and the page reports the state rather than looking broken.
  const audit = await send({ type: "audit" });
  const refusal = audit.entries.filter((e) => e.rule === "permission-denied").pop();
  assert.ok(refusal, "the denial was not written to the audit");
  assert.equal(refusal.result, "refused");

  const project = await send({ type: "openProject", name: folderName });
  assert.equal(project.ok, true, "a denied root should still open, because its state is displayable");
  assert.equal(project.project.durability.permission, "denied", "the record does not carry the denied state");

  await page.evaluate(async (name) => {
    await window.e1m0.open(name);
    await window.e1m0.create("nope.txt", "text", "x");
  }, folderName);
  const transcript = await page.evaluate(() => document.getElementById("transcript").textContent);
  assert.match(transcript, /permission-denied/, "the page does not show the denial by name");
});
