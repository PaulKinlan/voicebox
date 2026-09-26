// tests/extension-init-errors.test.mjs — a failed init is NEVER a silent half-loaded state
// (voicebox-beads-qdo).
//
// THE DEFECT: loadRegistry() (boot + every host act) used to handle a load failure with one
// console.error line — and inventory() rendered the extension into NO section at all. An admitted
// extension whose descriptor later broke (gate tightened, file corrupted) vanished from every
// surface: not running (it isn't), not present (it IS admitted), not waiting (nobody is reviewing).
// The person saw an admitted tool disappear and had no name for why.
//
// WHAT THIS FILE ASSERTS, per failure shape, against the REAL load path (real scratch directory,
// real admission ledger, real gate — the only synthetic thing is nothing):
//   1. admitted + gate fails at reload  → failedLoads carries gate-refused-at-load with the gate's
//      own rule (exec-absent, no-tools, bad-tool-name, duplicate-tool) and a next action
//   2. descriptor corrupt JSON          → refused "unreadable" (and ONLY parse failures say that —
//      a descriptor that parses but fails the gate keeps the gate's vocabulary)
//   3. duplicate tool names in one file → the gate's duplicate-tool rule, and NONE of the tools load
//      (the old map.set silently kept the last one — a half-loaded state nobody could see)
//   4. fixing the file recovers         → the failure entry leaves the inventory, the tool returns
//   5. every failure entry carries a non-empty refused, why and next — the contract Paul named
//
// ONE VALIDATOR, ONE VOCABULARY: the gate already names every descriptor defect, so these tests
// assert the gate's rules surface through the inventory — not a second, competing vocabulary.
//
// SEQUENCING NOTE: admission REWRITES the descriptor file for the id being admitted, so a shape is
// injected by corrupting an ALREADY-ADMITTED id, and the next admission of a DIFFERENT id is the
// reload trigger. The suite admits one fresh extension per step for exactly that reason.
//
//   node --test tests/extension-init-errors.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Scratch state BEFORE the lib loads — the suite never touches repo-owned files.
const SCRATCH = mkdtempSync(path.join(os.tmpdir(), "voicebox-ext-init-test-"));
process.env.VOICEBOX_EXTENSIONS_DIR = path.join(SCRATCH, "extensions");
process.env.VOICEBOX_WORKSPACE = path.join(SCRATCH, "workspace");

const extensions = await import("../lib/extensions.mjs");

test.after(() => rmSync(SCRATCH, { recursive: true, force: true }));

const descriptorFile = (id) => path.join(process.env.VOICEBOX_EXTENSIONS_DIR, `${id}.json`);

// A descriptor that PASSES the real gate (same shape the channel suite admits).
const validDescriptor = (id, toolName) => ({
  id,
  name: id,
  description: "init-error test extension",
  source: "model",
  runsIn: "host",
  capabilities: [],
  bounds: {},
  tools: [{ name: toolName, description: "the time", primitive: "now", params: {} }],
});

// Admission is also the reload trigger: every host act rebuilds the loaded set from the directory.
async function admitValid(id, toolName) {
  const proposed = extensions.propose(validDescriptor(id, toolName), "model");
  assert.equal(proposed.state, "pending", `the proposal must stage cleanly: ${JSON.stringify(proposed)}`);
  const adm = await extensions.admitProposal(id, "admit");
  assert.equal(adm.decision, "admitted", `admission must pass the real gate: ${JSON.stringify(adm)}`);
  return adm;
}

const failures = () => extensions.inventory().failedLoads ?? [];
const failureFor = (id) => failures().find((f) => f.id === id);
const runningIds = () => new Set(extensions.inventory().extensions.map((e) => e.id));

test("a valid admission loads and the failedLoads list is empty — the honest baseline", async () => {
  await admitValid("clock-ext", "clock");
  assert.ok(runningIds().has("clock-ext"), "the admitted extension is running");
  assert.deepEqual(failures(), [], "a healthy directory must name no failures");
});

test("admitted, then the gate tightens under it: gate-refused-at-load, rule named, next action given", async () => {
  // Corrupt the descriptor into a shape the gate refuses (exec capability without the placement
  // that allows it — the same refusal the channel suite demonstrated), then trigger a reload.
  const broken = { ...validDescriptor("clock-ext", "clock"), runsIn: "process", capabilities: ["exec"] };
  writeFileSync(descriptorFile("clock-ext"), JSON.stringify(broken));
  await admitValid("second-ext", "second_clock");

  const entry = failureFor("clock-ext");
  assert.ok(entry, "the failed load must be NAMED in the inventory, not only on stderr");
  assert.equal(entry.refused, "gate-refused-at-load");
  assert.equal(entry.rule, "exec-absent");
  assert.match(entry.why, /no longer passes the gate/);
  assert.match(entry.next, /re-admit/);
  assert.ok(!runningIds().has("clock-ext"), "the gate-failed extension must not be in the loaded set");
  assert.ok(runningIds().has("second-ext"), "one broken descriptor must not take down the others");
});

test("corrupt JSON is refused as unreadable — with the file path as the next action", async () => {
  writeFileSync(descriptorFile("second-ext"), "{ not json at all");
  await admitValid("third-ext", "third_clock");

  const entry = failureFor("second-ext");
  assert.ok(entry, "a corrupt descriptor must be named");
  assert.equal(entry.refused, "unreadable");
  assert.match(entry.why, /JSON/);
  assert.match(entry.next, /\.json/);
  assert.ok(!runningIds().has("second-ext"));
});

test("no tools at all: the gate's no-tools rule surfaces through the inventory, never 'unreadable'", async () => {
  writeFileSync(descriptorFile("third-ext"), JSON.stringify({ id: "third-ext", name: "third-ext", runsIn: "host" }));
  await admitValid("fourth-ext", "fourth_clock");

  const entry = failureFor("third-ext");
  assert.ok(entry, "the shapeless descriptor must be named");
  assert.equal(entry.refused, "gate-refused-at-load");
  assert.equal(entry.rule, "no-tools");
  assert.match(entry.why, /no longer passes the gate \(no-tools\)/);
  assert.match(entry.next, /re-admit/);
  assert.ok(!runningIds().has("third-ext"));
});

test("a tool without a usable name: the gate's bad-tool-name rule, named with a next action", async () => {
  writeFileSync(descriptorFile("fourth-ext"), JSON.stringify({
    id: "fourth-ext", name: "fourth-ext", runsIn: "host",
    tools: [{ description: "a tool with no name", primitive: "now", params: {} }],
  }));
  await admitValid("fifth-ext", "fifth_clock");

  const entry = failureFor("fourth-ext");
  assert.ok(entry, "the nameless-tool descriptor must be named");
  assert.equal(entry.refused, "gate-refused-at-load");
  assert.equal(entry.rule, "bad-tool-name");
  assert.ok(!runningIds().has("fourth-ext"));
});

test("duplicate tool names fail the WHOLE extension by the gate's duplicate-tool rule — no partial load", async () => {
  writeFileSync(descriptorFile("fifth-ext"), JSON.stringify({
    id: "fifth-ext", name: "fifth-ext", runsIn: "host", capabilities: [], bounds: {},
    tools: [
      { name: "twin", description: "first", primitive: "now", params: {} },
      { name: "twin", description: "second", primitive: "now", params: {} },
    ],
  }));
  await admitValid("sixth-ext", "sixth_clock");

  const entry = failureFor("fifth-ext");
  assert.ok(entry, "the duplicate must be named");
  assert.equal(entry.refused, "gate-refused-at-load");
  assert.equal(entry.rule, "duplicate-tool");
  assert.match(entry.why, /duplicate-tool/);
  assert.ok(!runningIds().has("fifth-ext"), "no partial load: both twins stay unloaded");
  assert.equal(extensions.lookupAdmitted("fifth-ext", "twin"), null, "the duplicated tool must not answer calls");
});

test("fixing the file recovers: the failure entry leaves the inventory and the tool returns", async () => {
  writeFileSync(descriptorFile("fifth-ext"), JSON.stringify(validDescriptor("fifth-ext", "twin")));
  await admitValid("seventh-ext", "seventh_clock");

  assert.ok(!failureFor("fifth-ext"), "a fixed descriptor is not a failure any more");
  assert.ok(runningIds().has("fifth-ext"), "the tool is live again");
});

test("an admitted id whose descriptor FILE is deleted is named too — descriptor-missing", async () => {
  // The file loop walks the DIRECTORY, so a deleted file behind a live admission used to be the
  // one state no section caught: not running, not present (the ledger still admits it), not
  // failed (there was no file to fail on). The admittedIds() diff closes it.
  await admitValid("eighth-ext", "eighth_clock");
  rmSync(descriptorFile("eighth-ext"));
  await admitValid("ninth-ext", "ninth_clock");

  const entry = failureFor("eighth-ext");
  assert.ok(entry, "the vanished descriptor must be named in the inventory");
  assert.equal(entry.refused, "descriptor-missing");
  assert.match(entry.why, /no descriptor file/);
  assert.match(entry.next, /restore .*revoke/);
  assert.ok(!runningIds().has("eighth-ext"), "a deleted descriptor keeps no tool live");
  assert.ok(runningIds().has("ninth-ext"), "the trigger extension still loads");
});

test("every failure entry honours the contract: named refused, why, and a next action", () => {
  for (const f of failures()) {
    assert.equal(typeof f.refused, "string");
    assert.ok(f.refused.length > 0, `refused must be named for ${f.id}`);
    assert.equal(typeof f.why, "string");
    assert.ok(f.why.length > 0, `why must be present for ${f.id}`);
    assert.equal(typeof f.next, "string");
    assert.ok(f.next.length > 0, `next must be present for ${f.id}`);
  }
});
