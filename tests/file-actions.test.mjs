// tests/file-actions.test.mjs — Verify destructive and editing file actions (voicebox-beads-ugb)
//
// Tests delete, edit, diff, and grep capabilities across server execution,
// resolver mapping, containment, and audit logging.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { readJsonl } from "./lib/jsonl.mjs";
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

  // 6. Subdirectory paths, deep dotfile refusal, and undo stack (voicebox-beads-il54, voicebox-beads-4g9m)
  const subWrite = await fetch(`${base}/api/file`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "src/components/Button.js", content: "export const Button = () => null;\n" }),
  });
  assert.equal(subWrite.status, 200);
  assert.equal(fs.readFileSync(path.join(workspace, "src/components/Button.js"), "utf8"), "export const Button = () => null;\n");

  // Nested dotfile is refused
  const nestedDotWrite = await fetch(`${base}/api/file`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "src/.env", content: "SECRET=1" }),
  });
  assert.equal(nestedDotWrite.status, 400);
  assert.equal((await nestedDotWrite.json()).refused, "dotfile-refused");

  // Undo last action (reverts creation of src/components/Button.js)
  const undoStatus1 = await (await fetch(`${base}/api/undo`)).json();
  assert.equal(undoStatus1.ok, true);
  assert.equal(undoStatus1.canUndo, true);
  assert.equal(undoStatus1.last.name, "src/components/Button.js");

  const undoRes1 = await fetch(`${base}/api/undo`, { method: "POST" });
  assert.equal(undoRes1.status, 200);
  const undoBody1 = await undoRes1.json();
  assert.equal(undoBody1.ok, true);
  assert.equal(undoBody1.revertedVerb, "write");
  assert.equal(fs.existsSync(path.join(workspace, "src/components/Button.js")), false);

  // Undo again (reverts delete of target.txt)
  const undoRes2 = await fetch(`${base}/api/turn`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ transcript: "undo" }),
  });
  assert.equal(undoRes2.status, 200);
  const undoBody2 = await undoRes2.json();
  assert.equal(undoBody2.result.ok, true);
  assert.equal(undoBody2.result.revertedVerb, "delete");
  assert.equal(fs.readFileSync(path.join(workspace, "target.txt"), "utf8"), "hello world\nfinal line\nthird line\n");

  // 7. Mini-app Web MCP tool registration & dispatch (voicebox-beads-7xbe)
  const regRes = await fetch(`${base}/api/mini-app/tools`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      appId: "app_test_1",
      tools: [{ name: "set_filter", description: "Filter items", inputSchema: { type: "object", properties: { q: { type: "string" } } } }],
    }),
  });
  assert.equal(regRes.status, 200);
  const toolsList = await (await fetch(`${base}/api/mini-app/tools`)).json();
  assert.equal(toolsList.tools.length, 1);
  assert.equal(toolsList.tools[0].name, "set_filter");

  const callMiniTool = await fetch(`${base}/api/turn`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: { verb: "mini_app_tool", name: "set_filter", args: { q: "urgent" } } }),
  });
  assert.equal(callMiniTool.status, 200);
  const callMiniBody = await callMiniTool.json();
  assert.equal(callMiniBody.result.ok, true);
  assert.deepEqual(callMiniBody.miniAppToolCall, { name: "set_filter", args: { q: "urgent" } });

  // 8. Verify audit log contains delete, edit, and undo entries
  const auditDir = path.join(workspace, ".audit");
  assert.ok(fs.existsSync(auditDir), "audit directory must exist");
  const auditFiles = fs.readdirSync(auditDir).filter((f) => f.endsWith(".jsonl"));
  assert.ok(auditFiles.length > 0);
  const entries = auditFiles.flatMap((f) => readJsonl(fs.readFileSync(path.join(auditDir, f), "utf8")));
  const deleteEntries = entries.filter((e) => e.act?.kind === "delete" && e.decision === "allow");
  const editEntries = entries.filter((e) => e.act?.kind === "edit" && e.decision === "allow");
  const undoEntries = entries.filter((e) => e.act?.kind === "undo" && e.decision === "allow");
  assert.ok(deleteEntries.length >= 2, "must have logged delete actions in audit");
  assert.ok(editEntries.length >= 2, "must have logged edit actions in audit");
  assert.ok(undoEntries.length >= 2, "must have logged undo actions in audit");
});
