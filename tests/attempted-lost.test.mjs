// tests/attempted-lost.test.mjs — the attempted-and-lost drive (voicebox-beads-y69).
//
// THE PROPERTY: every act that passes pre-flight is recorded BEFORE it applies, and the
// question "did my edit land?" is answerable after the fact — carried (allow + observed),
// refused (named), or LOST (the process ended between the attempt and any outcome, and the
// next boot says so by name). A log of successes and refusals cannot answer "what did it try".
//
// The crash case is simulated by its exact state, not by timing: a dangling ATTEMPT entry
// written by a previous process generation is what a kill mid-act leaves behind, and the
// sweep is driven against that state deterministically.
//
//   node --test tests/attempted-lost.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { startServer } from "./lib/server.mjs";
import { sweepLostAttempts, parseEntry } from "../core/audit.ts";

let scratch;
let local;

const ROOT_DIR = () => path.join(scratch, "ws"); // the declared root — the audit lives with it
const AUDIT_FILE = () => path.join(ROOT_DIR(), ".audit", readdirSync(path.join(ROOT_DIR(), ".audit")).find((f) => f.endsWith(".jsonl")) ?? "");
const auditEntries = () =>
  readFileSync(AUDIT_FILE(), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const last = (arr) => arr[arr.length - 1];

test.before(async () => {
  scratch = mkdtempSync(path.join(os.tmpdir(), "voicebox-attempted-lost-"));
  mkdirSync(path.join(scratch, "ws"), { recursive: true });
  local = await startServer({ env: { VOICEBOX_WORKSPACE: path.join(scratch, "ws") }, cwd: scratch });
});

test.after(async () => {
  await local.stop();
  rmSync(scratch, { recursive: true, force: true });
});

const turn = (transcript) =>
  fetch(`${local.base}/api/turn`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ transcript }),
  }).then((r) => r.json());

test("a write is recorded TWICE: the attempt before it applies, and the carried outcome linked to it", async () => {
  const j = await turn("create a file called landed.txt with carried");
  assert.equal(j.result?.ok, true);
  const entries = auditEntries();
  const attempt = entries.find((e) => e.decision === "attempt");
  assert(attempt, "no attempt entry — the trying was not recorded");
  assert.equal(attempt.result, "pending");
  assert.ok(attempt.boot, "the attempt does not name the generation that wrote it");
  const outcome = entries.find((e) => e.attempt === attempt.seq);
  assert(outcome, "no outcome entry claims the attempt");
  assert.equal(outcome.decision, "allow");
  assert.equal(outcome.result, "ok");
  assert.equal(outcome.observed?.exists, true, "the carried outcome carries observed facts");
  // And the question the bead asks is answerable from the file alone:
  assert.equal(outcome.attempt, attempt.seq);
});

test("ATTEMPTED AND LOST: a dangling attempt from a dead generation is completed by name on the next boot", async () => {
  // The exact state a kill mid-act leaves: an attempt, pending, from a generation that is gone.
  const file = AUDIT_FILE();
  const dangling = {
    instance: "machine",
    seq: 999,
    at: new Date(Date.now() - 60_000).toISOString(),
    project: "sweep",
    root: "machine:" + ROOT_DIR(),
    act: { kind: "write", target: "lost.txt", tool: "turn" },
    decision: "attempt",
    rule: "attempted",
    result: "pending",
    observed: null,
    turn: null,
    boot: "the-dead-generation",
  };
  const { appendFileSync } = await import("node:fs");
  appendFileSync(file, JSON.stringify(dangling) + "\n");
  // Any logged act resumes the log — the sweep runs there.
  await turn("read landed.txt");
  const entries = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const lost = entries.find((e) => e.decision === "lost");
  assert(lost, "no lost completion was recorded for the dangling attempt");
  assert.equal(lost.attempt, 999, "the lost completion does not name the attempt it completes");
  assert.equal(lost.result, "lost");
  assert.match(lost.rule, /attempted-and-lost/);
  // THE ANSWER, from the file alone: the op was tried, and whether it landed is UNKNOWN —
  // named, not silently read as success or refusal.
  const pure = await import("../core/audit.ts");
  assert.equal(pure.sweepLostAttempts(entries, "another-generation").length, 0,
    "once the lost completion exists, the attempt is RESOLVED — the sweep does not re-report it");
});

test("the sweep is IDEMPOTENT: a completed attempt is never reported lost twice", async () => {
  // After the lost completion exists, a new generation's sweep finds nothing dangling:
  const file = AUDIT_FILE();
  const entries = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const pure = await import("../core/audit.ts");
  const before = pure.sweepLostAttempts(entries, "gen-next").length;
  await turn("read landed.txt"); // more acts, more log — the completed attempt stays completed
  const entries2 = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(pure.sweepLostAttempts(entries2, "gen-next").length, before,
    "the sweep re-reports a completed attempt");
});

test("a PRE-FLIGHT refusal produces a refusal entry and NO attempt — the act never entered the applying phase", async () => {
  const j = await turn("create a file called .hidden with nope");
  assert.equal(j.result?.refused, "dotfile-refused");
  const entries = auditEntries();
  const dotAttempt = entries.find((e) => e.decision === "attempt" && e.act?.target === ".hidden");
  assert.equal(dotAttempt, undefined, "a pre-flight refusal was recorded as an attempt");
  const refusal = entries.find((e) => e.decision === "refuse" && e.rule === "dotfile-refused");
  assert(refusal, "the refusal itself is not in the log");
});

test("CONTINUITY: an unreadable audit log refuses by name (audit-unreadable) — the sequence is never silently reset", async () => {
  // First write creates the log. Then the log becomes unreadable (mode 000 — the class of
  // failure the old catch swallowed and resequenced under fresh numbers):
  const first = await turn("create a file called cont.txt with one");
  assert.equal(first.result?.ok, true);
  const auditDir = path.join(ROOT_DIR(), ".audit");
  const logFile = path.join(auditDir, readdirSync(auditDir).find((f) => f.endsWith(".jsonl")));
  const before = JSON.parse(readFileSync(logFile, "utf8").trim().split("\n").pop()).seq;
  chmodSync(logFile, 0o000);
  try {
    const second = await turn("create a file called cont.txt with two");
    // The act's fate is visible either way, but the RECORD refusal is named:
    assert.equal(second.result?.logged ?? null, null, "an unreadable log cannot honestly report a seq");
    assert.equal(second.result?.logRefused, "audit-unreadable");
  } finally {
    chmodSync(logFile, 0o600);
  }
  // After the mode is restored, continuity resumes FROM the log's own last seq — not from zero:
  const lastOnDisk = JSON.parse(readFileSync(logFile, "utf8").trim().split("\n").pop()).seq;
  const third = await turn("create a file called cont.txt with three");
  assert.ok(third.result?.logged > lastOnDisk, `the sequence continued past the log (${third.result?.logged} > ${lastOnDisk}) — not reset from zero`);
  const entries = readFileSync(logFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const seqs = entries.map((e) => e.seq);
  assert.equal(new Set(seqs).size, seqs.length, "duplicate seqs in one instance's log — the order is corrupted");
});
