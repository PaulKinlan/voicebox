// tests/write-validation.test.mjs — the two shared-validation holes from astra's
// live-tools review (2026-09-20), pinned as two facts each:
//
//   1. a write with ABSENT content is refused BY NAME — and the file on disk is
//      UNTOUCHED (it used to be emptied while the result said ok:true — the
//      single worst outcome this system can produce).
//   2. a read of a missing file is a NAMED REFUSAL — not a throw into the route
//      (a throw in a batch swallowed every sibling's response).
//
//   node --test tests/write-validation.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { startServer } from "./lib/server.mjs";

const SCRATCH = mkdtempSync(path.join(os.tmpdir(), "voicebox-writeval-"));
const WORKSPACE = path.join(SCRATCH, "workspace");
mkdirSync(WORKSPACE, { recursive: true });

let server;
let BASE;

test.before(async () => {
  server = await startServer({ env: { VOICEBOX_WORKSPACE: WORKSPACE, VOICEBOX_RESOLVER: "script" } });
  BASE = server.base;
});

test.after(async () => {
  await server?.stop();
  rmSync(SCRATCH, { recursive: true, force: true });
});

// Drive the executor over HTTP. Note: on this base the transcript resolver always
// supplies content, so the ABSENT-content refusal (the review's defect 1) is pinned
// where a door can carry it — feat/live-tools' /api/execute and the live tool path.
// What this base pins: the refusal's existence in the executor (via the read path's
// sibling fix), explicit-empty validity, and byte-exactness.
const post = async (p, payload) =>
  fetch(`${BASE}${p}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  }).then((r) => r.json());

test("the transcript path: content that IS present writes byte-exact, and empty string is a VALID empty file", async () => {
  const created = await post("/api/turn", { transcript: "create a file called present.txt with the content is here" });
  assert.equal(created.result?.ok, true);
  assert.equal(readFileSync(path.join(WORKSPACE, "present.txt"), "utf8"), "the content is here");

  // Explicit empty: `with` and nothing after it is an intentional empty file, not a missing
  // argument — the distinction the missing-content refusal keeps (absent ≠ empty).
  const emptied = await post("/api/turn", { transcript: "create a file called blank.txt with " });
  assert.equal(emptied.result?.ok, true, `an explicit empty write was refused: ${JSON.stringify(emptied.result)}`);
  assert.equal(readFileSync(path.join(WORKSPACE, "blank.txt"), "utf8"), "");
});

test("a read of a MISSING file is a named refusal, and the process keeps serving", async () => {
  const missing = await post("/api/turn", { transcript: "read never-was.txt" });
  assert.equal(missing.result?.ok, false, `a missing read reported success: ${JSON.stringify(missing.result)}`);
  assert.equal(missing.result?.refused, "not-found", JSON.stringify(missing.result));
  assert.match(missing.result?.why ?? "", /never-was\.txt/);
  // The refusal is recorded, like every other refusal:
  assert.notEqual(missing.result?.logged, null, "a refused read must leave an audit entry");
  // And the host is still here:
  const health = await fetch(`${BASE}/api/health`);
  assert.equal(health.status, 200);
});
