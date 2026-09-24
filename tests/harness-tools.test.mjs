import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { readHarnessTools } from "../lib/harness-tools.mjs";

const ids = ["pi", "claude", "codex"];
const declared = () => ({
  source: "Host-maintained configuration snapshot, 2026-09-24",
  scope: "Declared tools for a coding setup; extensions and per-session permissions not inspected",
  tools: [{ name: "read", description: "Read a file; access still depends on the harness." }],
});
function fixture(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "vb-tool-metadata-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "tools.json");
  return { dir, file, save(data) { writeFileSync(file, JSON.stringify(data)); } };
}

test("catalogue projects only declared display metadata; empty and unknown are different", async (t) => {
  const { file, save } = fixture(t);
  const pi = declared();
  pi.privateConfig = "fixture-extra-must-not-leak";
  pi.tools[0].arguments = { token: "fixture-extra-must-not-leak" };
  save({ pi, claude: { ...declared(), tools: [] } });
  const result = await readHarnessTools(file, ids);
  assert.deepEqual(result.pi, { status: "declared", ...declared() });
  assert.equal(result.claude.status, "declared");
  assert.deepEqual(result.claude.tools, []);
  assert.equal(result.codex.status, "unknown");
  assert.equal(Object.hasOwn(result.codex, "tools"), false, "unknown is not an empty list");
  assert.ok(!JSON.stringify(result).includes("fixture-extra"));
  assert.ok(!JSON.stringify(result).includes(file));
});

test("missing, unreadable, relative and non-regular metadata stay unknown, with a remedy", async (t) => {
  const { file, dir } = fixture(t);
  const fifo = path.join(dir, "pipe");
  execFileSync("mkfifo", [fifo]);
  const link = path.join(dir, "link");
  writeFileSync(file, "{}");
  symlinkSync(file, link);
  const started = Date.now();
  for (const value of [undefined, "relative.json", path.join(dir, "missing"), dir, fifo, link]) {
    const result = await readHarnessTools(value, ids);
    assert.equal(result.pi.status, "unknown");
    assert.match(result.pi.why, /VOICEBOX_HARNESS_TOOLS/);
    assert.ok(!JSON.stringify(result).includes(dir));
  }
  assert.ok(Date.now() - started < 2000, "opening a FIFO must not wait for a writer");
  chmodSync(file, 0);
  assert.match((await readHarnessTools(file, ids)).pi.why, /Tool metadata unavailable/);
  chmodSync(file, 0o600);
});

test("invalid metadata never yields a partial or guessed catalogue", async (t) => {
  const { file, save } = fixture(t);
  const bad = [
    null, [], 3,
    { inventedHarness: declared() },
    { pi: null },
    { pi: { ...declared(), source: " " } },
    { pi: { ...declared(), source: "a".repeat(513) } },
    { pi: { ...declared(), scope: null } },
    { pi: { ...declared(), scope: "a".repeat(1025) } },
    { pi: { ...declared(), tools: {} } },
    { pi: { ...declared(), tools: Array.from({ length: 129 }, (_, i) => ({ name: `t${i}`, description: "tool" })) } },
    { pi: { ...declared(), tools: [null] } },
    { pi: { ...declared(), tools: [{ name: "", description: "tool" }] } },
    { pi: { ...declared(), tools: [{ name: "a".repeat(129), description: "tool" }] } },
    { pi: { ...declared(), tools: [{ name: "<script>", description: "tool" }] } },
    { pi: { ...declared(), tools: [{ name: "read", description: "" }] } },
    { pi: { ...declared(), tools: [{ name: "read", description: "a".repeat(4097) }] } },
    { pi: { ...declared(), tools: [{ name: "read", description: "\u001b[2J" }] } },
    { pi: { ...declared(), tools: [...declared().tools, ...declared().tools] } },
    { pi: declared(), claude: { source: "missing fields" } },
  ];
  for (const data of bad) {
    save(data);
    const result = await readHarnessTools(file, ids);
    for (const row of Object.values(result)) {
      assert.equal(row.status, "unknown", JSON.stringify(data));
      assert.match(row.why, /invalid.*catalogue format/i);
      assert.equal(Object.hasOwn(row, "tools"), false);
    }
  }
  writeFileSync(file, '{"private-parser-fragment": invalid}');
  assert.ok(!JSON.stringify(await readHarnessTools(file, ids)).includes("private-parser-fragment"));
  writeFileSync(file, " ".repeat(256 * 1024 + 1));
  assert.match((await readHarnessTools(file, ids)).pi.why, /at most 256 KiB/);
});

test("supported metadata boundaries and literal descriptions survive; later reads use corrected data", async (t) => {
  const { file, save } = fixture(t);
  const data = { ...declared(), source: "s".repeat(512), scope: "c".repeat(1024),
    tools: Array.from({ length: 128 }, (_, i) => ({ name: `${i}`.padEnd(128, "x"), description: i === 0 ? "d".repeat(4096) : "<img src=x onerror=alert(1)>\nLiteral text." })) };
  save({ pi: data });
  assert.deepEqual((await readHarnessTools(file, ids)).pi, { status: "declared", ...data });
  writeFileSync(file, "broken");
  assert.equal((await readHarnessTools(file, ids)).pi.status, "unknown");
  save({ pi: declared() });
  assert.deepEqual((await readHarnessTools(file, ids)).pi, { status: "declared", ...declared() });
});
