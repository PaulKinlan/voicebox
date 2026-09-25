// tests/extensions-root.test.mjs — voicebox-beads-gto, qwen2's driven finding, closed:
// an admitted tool's act lands in the DECLARED root, never in a workspace of its own.
//
// qwen2's drive, reproduced as the acceptance: two scratch roots deliberately distinct;
// declare one, admit a tool, call it — the act and its record belong to the declared root.
//
//   node --test tests/extensions-root.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { startServer } from "./lib/server.mjs";

const SCRATCH = realpathSync(mkdtempSync(path.join(os.tmpdir(), "voicebox-gto-")));
const WORKSPACE = path.join(SCRATCH, "workspace");
const PROJECT = path.join(SCRATCH, "project"); // the DECLARED root — deliberately not WORKSPACE
mkdirSync(WORKSPACE, { recursive: true });
mkdirSync(PROJECT, { recursive: true });
writeFileSync(path.join(PROJECT, "hello.txt"), "hi");
writeFileSync(path.join(WORKSPACE, "decoy.txt"), "the file the bug used to list");

let server;
let BASE;
let HOST;

test.before(async () => {
  server = await startServer({
    env: { VOICEBOX_WORKSPACE: WORKSPACE, VOICEBOX_EXTENSIONS_DIR: path.join(SCRATCH, "extensions") },
  });
  BASE = server.base;
  HOST = server.hostToken;
});

test.after(async () => {
  await server?.stop();
  rmSync(SCRATCH, { recursive: true, force: true });
});

const post = (p, body) =>
  fetch(`${BASE}${p}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-voicebox-host-token": HOST },
    body: JSON.stringify(body),
  }).then((r) => r.json());
const turn = (transcript) => post("/api/turn", { transcript });

test("an admitted tool acts in the DECLARED root — qwen2's drive, reproduced", async () => {
  // Declare the project root (the host's act):
  const declared = await post("/api/root", { project: "qwen2-project", root: { kind: "machine", path: PROJECT } });
  assert.equal(declared.ok, true, JSON.stringify(declared));

  // The model's door: propose a list-files tool, host admits it (the same flow the review drove).
  const proposed = await turn("create a tool called peek that lists files");
  assert.equal(proposed.result?.ok, true, JSON.stringify(proposed.result));
  const admitted = await post("/api/extensions/admit", { id: "peek-tool", confirm: true, decision: "admit" });
  assert.equal(admitted.decision, "admitted", JSON.stringify(admitted));

  // THE FINDING'S ASSERTION, INVERTED: the tool lists the DECLARED root's files.
  const call = await turn("run the tool peek");
  assert.equal(call.result?.ok, true, JSON.stringify(call.result));
  assert.deepEqual(call.result.files, ["hello.txt"], `the tool listed the wrong root: ${JSON.stringify(call.result.files)}`);

  // And the act's RECORD lives with the root it hit — not in the boot workspace's ledger.
  const actLog = path.join(PROJECT, ".audit", "extensions.jsonl");
  assert(existsSync(actLog), "the act was not recorded in the declared root's audit");
  const entry = readFileSync(actLog, "utf8").trim().split("\n").map((l) => JSON.parse(l)).find((e) => e.act?.tool === "peek");
  assert(entry, "the declared root's audit has no entry for the tool's act");
  assert.equal(entry.root, `machine:${PROJECT}`);
  assert.equal(entry.result, "ok");

  // The boot workspace is untouched by the act (its decoy was not listed; no act entry there):
  assert(!existsSync(path.join(WORKSPACE, "audit.jsonl")) || !readFileSync(path.join(WORKSPACE, "audit.jsonl"), "utf8").includes('"peek"'), "the act leaked into the boot workspace's ledger");
});

test("a write-file tool writes into the DECLARED root, byte for byte", async () => {
  const proposed = await turn("create a tool called scribe that writes note.txt with tool-written content");
  assert.equal(proposed.result?.ok, true, JSON.stringify(proposed.result));
  const admitted = await post("/api/extensions/admit", { id: "scribe-tool", confirm: true, decision: "admit" });
  assert.equal(admitted.decision, "admitted", JSON.stringify(admitted));

  const call = await turn("run the tool scribe");
  assert.equal(call.result?.ok, true, JSON.stringify(call.result));
  // The bytes, checked against the world:
  assert.equal(readFileSync(path.join(PROJECT, "note.txt"), "utf8"), "tool-written content");
  assert(!existsSync(path.join(WORKSPACE, "note.txt")), "the write leaked into the boot workspace");
});

test("a tool on a PAGE-OWNED root routes the same way a turn does — and names the page when it is absent", async () => {
  const declared = await post("/api/root", { project: "page-project", root: { kind: "opfs", path: "v1/projects/page-project" } });
  assert.equal(declared.ok, true);
  assert.equal(declared.actsVia, "page");

  const call = await turn("run the tool peek");
  assert.equal(call.result?.ok, false, `the tool claimed to act on a root nobody was holding: ${JSON.stringify(call.result)}`);
  assert.equal(call.result?.via, "page", "the tool's act took the page route");
  assert.equal(call.result?.refused, "no-page", JSON.stringify(call.result));

  // Restore the machine root for any later test.
  await post("/api/root", { project: "qwen2-project", root: { kind: "machine", path: PROJECT } });
});
