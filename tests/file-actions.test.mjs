// tests/file-actions.test.mjs — Verify destructive and editing file actions (voicebox-beads-ugb)
//
// Tests delete, edit, diff, and grep capabilities across server execution,
// resolver mapping, containment, and audit logging.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startServer } from "./lib/server.mjs";

test("file actions: delete, edit, diff, and grep execute with audit trails and containment", async (t) => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "vb-file-actions-"));
  const workspace = path.join(scratch, "project");
  fs.mkdirSync(workspace, { recursive: true });

  const server = await startServer({
    env: {
      VOICEBOX_WORKSPACE: workspace,
      VOICEBOX_RESOLVER: "script",
    },
  });
  t.after(async () => {
    await server.stop();
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  const base = server.base;

  // Setup initial files
  fs.writeFileSync(path.join(workspace, "target.txt"), "hello world\nsecond line\nthird line\n");
  fs.writeFileSync(path.join(workspace, "duplicate.txt"), "repeat\nrepeat\n");
  fs.writeFileSync(path.join(workspace, "notes.md"), "# Project Notes\nimportant keyword here\n");

  // 1. diff_file: returns unified diff without modifying file on disk
  const diffRes = await fetch(`${base}/api/file/diff`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "target.txt", content: "hello world\nmodified line\nthird line\n" }),
  });
  assert.equal(diffRes.status, 200);
  const diffBody = await diffRes.json();
  assert.equal(diffBody.ok, true);
  assert.equal(diffBody.changed, true);
  assert.match(diffBody.diff, /-second line/);
  assert.match(diffBody.diff, /\+modified line/);
  // Verify disk file is UNCHANGED after diff
  assert.equal(fs.readFileSync(path.join(workspace, "target.txt"), "utf8"), "hello world\nsecond line\nthird line\n");

  // Identical diff returns changed: false and empty diff
  const sameDiff = await fetch(`${base}/api/file/diff`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "target.txt", content: "hello world\nsecond line\nthird line\n" }),
  });
  assert.equal((await sameDiff.json()).changed, false);

  // 2. edit_file: targeted replacement of unique text
  const editRes = await fetch(`${base}/api/file`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "target.txt", oldText: "second line", newText: "replaced line" }),
  });
  assert.equal(editRes.status, 200);
  const editBody = await editRes.json();
  assert.equal(editBody.ok, true);
  assert.equal(fs.readFileSync(path.join(workspace, "target.txt"), "utf8"), "hello world\nreplaced line\nthird line\n");

  // Edit failure: pattern not found
  const notFoundEdit = await fetch(`${base}/api/file`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "target.txt", oldText: "nonexistent text", newText: "new" }),
  });
  assert.equal(notFoundEdit.status, 400);
  assert.equal((await notFoundEdit.json()).refused, "pattern-not-found");

  // Edit failure: pattern not unique (multiple occurrences)
  const nonUniqueEdit = await fetch(`${base}/api/file`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "duplicate.txt", oldText: "repeat", newText: "unique" }),
  });
  assert.equal(nonUniqueEdit.status, 400);
  assert.equal((await nonUniqueEdit.json()).refused, "pattern-not-unique");

  // 3. grep_files: search for text pattern across files in root
  const grepRes = await fetch(`${base}/api/grep?q=keyword`);
  assert.equal(grepRes.status, 200);
  const grepBody = await grepRes.json();
  assert.equal(grepBody.ok, true);
  assert.equal(grepBody.count, 1);
  assert.equal(grepBody.matches[0].file, "notes.md");
  assert.equal(grepBody.matches[0].line, 2);
  assert.match(grepBody.matches[0].text, /important keyword here/);

  // Grep missing argument refuses
  const emptyGrep = await fetch(`${base}/api/grep?q=`);
  assert.equal(emptyGrep.status, 400);
  assert.equal((await emptyGrep.json()).refused, "missing-argument");

  // 4. delete_file: removes file and records audit
  const deleteRes = await fetch(`${base}/api/file?name=duplicate.txt`, { method: "DELETE" });
  assert.equal(deleteRes.status, 200);
  const deleteBody = await deleteRes.json();
  assert.equal(deleteBody.ok, true);
  assert.equal(fs.existsSync(path.join(workspace, "duplicate.txt")), false);

  // Delete non-existent file refuses with not-found
  const missingDelete = await fetch(`${base}/api/file?name=duplicate.txt`, { method: "DELETE" });
  assert.equal(missingDelete.status, 404);
  assert.equal((await missingDelete.json()).refused, "not-found");

  // Delete outside root refuses
  const escapeDelete = await fetch(`${base}/api/file?name=../evil.sh`, { method: "DELETE" });
  assert.equal(escapeDelete.status, 400);
  assert.equal((await escapeDelete.json()).refused, "outside-root");

  // 5. Conversational turns via POST /api/turn (script resolver)
  // Edit via turn:
  const turnEdit = await fetch(`${base}/api/turn`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ transcript: 'edit target.txt replace "replaced line" with "final line"' }),
  });
  assert.equal(turnEdit.status, 200);
  const turnEditBody = await turnEdit.json();
  assert.equal(turnEditBody.result.ok, true);
  assert.equal(fs.readFileSync(path.join(workspace, "target.txt"), "utf8"), "hello world\nfinal line\nthird line\n");

  // Delete via turn:
  const turnDelete = await fetch(`${base}/api/turn`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ transcript: "delete target.txt" }),
  });
  assert.equal(turnDelete.status, 200);
  const turnDeleteBody = await turnDelete.json();
  assert.equal(turnDeleteBody.result.ok, true);
  assert.equal(fs.existsSync(path.join(workspace, "target.txt")), false);

  // Grep via turn:
  const turnGrep = await fetch(`${base}/api/turn`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ transcript: "grep keyword" }),
  });
  assert.equal(turnGrep.status, 200);
  const turnGrepBody = await turnGrep.json();
  assert.equal(turnGrepBody.result.ok, true);
  assert.equal(turnGrepBody.result.count, 1);
  assert.equal(turnGrepBody.result.matches[0].file, "notes.md");

  // 6. Verify audit log contains delete and edit entries
  const auditDir = path.join(workspace, ".audit");
  assert.ok(fs.existsSync(auditDir), "audit directory must exist");
  const auditFiles = fs.readdirSync(auditDir).filter((f) => f.endsWith(".jsonl"));
  assert.ok(auditFiles.length > 0);
  const entries = auditFiles.flatMap((f) => fs.readFileSync(path.join(auditDir, f), "utf8").trim().split("\n").map(JSON.parse));
  const deleteEntries = entries.filter((e) => e.act?.kind === "delete" && e.decision === "allow");
  const editEntries = entries.filter((e) => e.act?.kind === "edit" && e.decision === "allow");
  assert.ok(deleteEntries.length >= 2, "must have logged delete actions in audit");
  assert.ok(editEntries.length >= 2, "must have logged edit actions in audit");
});
