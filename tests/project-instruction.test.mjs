import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readProjectInstruction } from "../lib/project-instruction.mjs";

function fixture(t, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "voicebox-proj-instr-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

test("AGENT.md is preferred over AGENTS.md when both exist, and the reader names which file it read", (t) => {
  const dir = fixture(t, { "AGENT.md": "agent first", "AGENTS.md": "agents second" });
  const r = readProjectInstruction(dir);
  assert.equal(r.file, "AGENT.md");
  assert.equal(r.text, "agent first");
  assert.equal(r.truncated, false);
});

test("AGENTS.md is read when AGENT.md is absent", (t) => {
  const dir = fixture(t, { "AGENTS.md": "the repo convention" });
  const r = readProjectInstruction(dir);
  assert.equal(r.file, "AGENTS.md");
  assert.equal(r.text, "the repo convention");
});

test("no instruction file: named, not invented", (t) => {
  const dir = fixture(t, { "README.md": "not an instruction file" });
  const r = readProjectInstruction(dir);
  assert.equal(r.file, null);
  assert.match(r.reason, /no AGENT\.md or AGENTS\.md at the project root/);
});

test("no root declared: named, not invented", () => {
  const r = readProjectInstruction(undefined);
  assert.equal(r.file, null);
  assert.match(r.reason, /no project root is declared/);
});

test("unreadable file is named rather than silently omitted", (t) => {
  const dir = fixture(t, { "AGENT.md": "secret" });
  fs.chmodSync(path.join(dir, "AGENT.md"), 0o000);
  try {
    const r = readProjectInstruction(dir);
    assert.equal(r.file, "AGENT.md", "the file is named even when unreadable — the refusal says which one");
    assert.equal(r.text, null);
    assert.match(r.reason, /unreadable/);
  } finally {
    fs.chmodSync(path.join(dir, "AGENT.md"), 0o644);
  }
});

test("oversized instruction is bounded and the truncation is named", (t) => {
  const dir = fixture(t, { "AGENT.md": "x".repeat(40000) });
  const r = readProjectInstruction(dir);
  assert.equal(r.file, "AGENT.md");
  assert.equal(r.truncated, true);
  assert.ok(Buffer.byteLength(r.text, "utf8") <= 32768);
});

test("an escape attempt through the instruction name is not followed", (t) => {
  // a file OUTSIDE the root is never read, even when the name tries to leave
  const outside = path.join(os.tmpdir(), `voicebox-proj-instr-escape-${Date.now()}.md`);
  fs.writeFileSync(outside, "outside the root");
  t.after(() => fs.rmSync(outside, { force: true }));
  const dir = fixture(t, { "../escape.md": "should never be read" });
  const r = readProjectInstruction(dir);
  assert.equal(r.file, null);
});
