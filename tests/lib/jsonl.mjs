// tests/lib/jsonl.mjs — the one reader for the JSONL files the suites poll (voicebox-beads-5427).
//
// THE DEFECT IT REPLACES. The suites watch files a running fixture or server appends to and poll them
// every 20ms. `fs.appendFileSync` creates the file (O_CREAT) and then writes the first line, so between
// those two steps the file EXISTS and is EMPTY: `existsSync` answers true, `readFileSync` returns "",
// and the old `readFileSync(file, "utf8").trim().split("\n").map(JSON.parse)` called `JSON.parse("")`
// and died with `SyntaxError: Unexpected end of JSON input`. It was seen once in the whole check
// history — 2026-10-08, in a full gate on a loaded box, in a poller that was only ever a witness — and
// it went red for a reason that had nothing to do with the change under test.
// A read that lands mid-append leaves the mirror image: a final line with no newline yet.
//
// THE RULE THAT KEEPS THIS HONEST: an empty file, or a final line that is not yet a record, is skipped;
// EVERY complete (newline-terminated) record must parse, so a genuinely corrupt line throws by name
// instead of being rounded away. The tail cannot be split into "in flight" and "complete": those are
// the same bytes, so the tail is kept when it parses (a real last record) and dropped only when it does
// not (a write in flight). The product's own audit reader takes the same view of the same file —
// `parseEntry` in core/audit.ts: "a torn last line from a killed append is not a fatal read" — and this
// is the test-side equivalent, tightened to still refuse a torn line followed by a complete one.
import { readFileSync } from "node:fs";

/** The records of a JSONL document: its complete lines, plus a final record that has no newline yet. */
export function readJsonl(text) {
  const lines = text.split("\n");
  const tail = lines.pop(); // "" whenever the text ends with a newline: every remaining line is complete
  const records = lines.filter((line) => line.trim() !== "").map((line) => JSON.parse(line));
  if (tail.trim() !== "") {
    try {
      records.push(JSON.parse(tail));
    } catch {
      // a write in flight, not a record yet
    }
  }
  return records;
}

/** The same, for the file itself: absent is empty, and a file being written is read to its last complete line. */
export function readJsonlFile(file) {
  try {
    return readJsonl(readFileSync(file, "utf8"));
  } catch (err) {
    // Absent is empty — either the file is not there yet, or a teardown removed it between this call and
    // the open. Only those two mean "no records": anything else (EACCES, EMFILE, EISDIR) is a real
    // problem with the log and is thrown by name, the same rule the CDP cleanup fix follows.
    if (err?.code === "ENOENT" || err?.code === "ENOTDIR") return [];
    throw err;
  }
}
