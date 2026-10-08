// tests/jsonl.test.mjs — the reader that replaced nine copies of the same poll pattern (voicebox-beads-5427).
//
//   node --test tests/jsonl.test.mjs
//
// The defect this pins, from the gate that went red: a file created by `fs.appendFileSync` exists before
// it has a line, the old reader called `JSON.parse("")`, and a witness became a hard failure. The rule
// is that only an empty file or an unterminated final line is skipped — a complete corrupt record still
// throws, which is the half that keeps the skip from becoming a licence.
import test from "node:test";
import assert from "node:assert/strict";
import { readJsonl, readJsonlFile } from "./lib/jsonl.mjs";

test("jsonl: an empty document is no records, not a corrupt one — the gate failure, pinned", () => {
  // `existsSync` true and `readFileSync` "" is exactly the state between appendFileSync's O_CREAT and
  // its first write, and `JSON.parse("")` is the SyntaxError that reddened the full gate.
  assert.deepEqual(readJsonl(""), []);
  assert.deepEqual(readJsonl("\n"), []);
});

test("jsonl: complete records parse, with or without a trailing newline", () => {
  assert.deepEqual(readJsonl('{"a":1}\n{"a":2}\n'), [{ a: 1 }, { a: 2 }]);
  assert.deepEqual(readJsonl('{"a":1}\n{"a":2}'), [{ a: 1 }, { a: 2 }]);
});

test("jsonl: a final line still being written is not a record yet — and earlier ones are not lost", () => {
  // The mirror image of the empty file: a read that lands mid-append. The complete lines must still be
  // returned, which is how a poller stays a witness instead of a failure.
  assert.deepEqual(readJsonl('{"a":1}\n{"a":2'), [{ a: 1 }]);
  assert.deepEqual(readJsonl('{"a":1}\n{"a"'), [{ a: 1 }]);
  // THE HONEST LIMIT, asserted rather than claimed: an unterminated line that is not JSON is
  // indistinguishable from a write in flight, so it is skipped. A TERMINATED line can never be skipped
  // (next test).
  assert.deepEqual(readJsonl('{"a":1}\nnot json'), [{ a: 1 }]);
});

test("jsonl: a COMPLETE line that is corrupt still throws by name", () => {
  // The skip is only for states of a file being written. A finished line that is not JSON is a defect
  // in the writer and must not be rounded away.
  assert.throws(() => readJsonl('{"a":1}\nnot json\n'), SyntaxError);
  assert.throws(() => readJsonl("not json\n"), SyntaxError);
  assert.throws(() => readJsonl('{"a":1}\nnot json\n{"a":2}\n'), SyntaxError);
});

test("jsonl: the file reader treats absent as empty and a being-written file as its complete prefix", async () => {
  const { mkdtempSync, writeFileSync, appendFileSync, rmSync } = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = mkdtempSync(path.join(os.tmpdir(), "vb-jsonl-"));
  const file = path.join(dir, "records.jsonl");
  try {
    assert.deepEqual(readJsonlFile(file), [], "a file that does not exist yet is no records");
    writeFileSync(file, "", "utf8"); // created, nothing written: the window the gate hit
    assert.deepEqual(readJsonlFile(file), []);
    appendFileSync(file, '{"a":1}\n', "utf8");
    assert.deepEqual(readJsonlFile(file), [{ a: 1 }]);
    appendFileSync(file, '{"a":2}', "utf8"); // a complete final record whose newline has not landed
    assert.deepEqual(readJsonlFile(file), [{ a: 1 }, { a: 2 }]);
    appendFileSync(file, "\n", "utf8");
    assert.deepEqual(readJsonlFile(file), [{ a: 1 }, { a: 2 }]);
    // the same file mid-append, caught inside a record: the prefix is still readable
    writeFileSync(file, '{"a":1}\n{"a"', "utf8");
    assert.deepEqual(readJsonlFile(file), [{ a: 1 }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
