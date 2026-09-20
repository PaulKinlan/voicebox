// tests/root-seam.test.mjs — ONE ROOT: the loop writes into the active project's root.
//
//   node --test tests/root-seam.test.mjs
//
// The gap Paul named: the environment page had projects and the loop wrote loose files into a
// hard-coded `workspace/` — "projects exist" on one page and a flat directory on another, which is a
// demo standing beside the product. The root is now DATA (core/root.ts) that both sides read, with
// one containment entry, and the loop refuses by NAME when the active root is one it cannot reach
// rather than quietly writing somewhere else.
//
// Driven against the real server as a subprocess: every assertion is about bytes on disk, HTTP
// responses, or the root's own log — never about the server's account of itself.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { startServer } from "./lib/server.mjs";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let server;
let BASE;
let scratch;
let serverCwd;
let defaultRoot;
let otherRoot;
let picked;

const turn = (transcript) =>
  fetch(`${BASE}/api/turn`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ transcript }),
  }).then((r) => r.json());

// The suite SPAWNS the server, so it is the host: declaring a root takes the host token, exactly as a
// person's shell does it (voicebox-beads-cfn). A suite that declared without it was modelling the page.
const declare = (project, root) =>
  fetch(`${BASE}/api/root`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-voicebox-host-token": server.hostToken },
    body: JSON.stringify({ project, root }),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));

const rootInfo = () => fetch(`${BASE}/api/root`).then((r) => r.json());
const files = () => fetch(`${BASE}/api/files`).then((r) => r.json());
const audit = () => fetch(`${BASE}/api/audit`).then((r) => r.json());

test.before(async () => {
  scratch = mkdtempSync(path.join(os.tmpdir(), "voicebox-seam-"));
  // The server runs in a scratch cwd, so a path that is wrongly treated as relative lands somewhere
  // this suite can SEE. That is how the committed-artefact defect was found: the loop wrote a
  // virtual root string ("v1/projects/atlas") through `path.join`, and it landed in the process's
  // working directory — which was the repository.
  serverCwd = path.join(scratch, "server-cwd");
  mkdirSync(serverCwd);
  defaultRoot = path.join(scratch, "default-root");
  otherRoot = path.join(scratch, "other-root");
  picked = path.join(scratch, "picked-root");
  for (const dir of [defaultRoot, otherRoot, picked]) mkdirSync(dir);
  server = await startServer({
    cwd: ROOT,
    env: { VOICEBOX_WORKSPACE: defaultRoot, VOICEBOX_INSTANCE: "machine-test" },
  });
  BASE = server.base;
});

test.after(async () => {
  await server?.stop();
  rmSync(scratch, { recursive: true, force: true });
});

test("the seam: the loop's root is the active project's root, and this process says whether it can act on it", async () => {
  const info = await rootInfo();
  assert.equal(info.ok, true);
  assert.equal(info.root.kind, "machine", `the default root is not a machine root: ${JSON.stringify(info.root)}`);
  assert.equal(info.root.path, defaultRoot, "the default root is not the declared workspace");
  assert.deepEqual(info.facts.reachableFrom, ["machine"], "the facts do not say who can act on a machine root");
  assert.equal(info.facts.containment, "realpath", "the machine kind must declare its realpath pass");
  assert.equal(info.reachableFromThisProcess, true);
});

test("a file written through the loop lands inside the active root, and the root's log records it", async () => {
  const reply = await turn("create a file called from-the-loop.txt with hello from the loop");
  assert.equal(reply.result?.ok, true, `the loop did not write: ${JSON.stringify(reply.result)}`);
  assert.equal(reply.result.root.path, defaultRoot, "the act did not report the active root");

  const landed = path.join(defaultRoot, "from-the-loop.txt");
  assert.equal(existsSync(landed), true, "the file is not in the active root");
  assert.equal(readFileSync(landed, "utf8"), "hello from the loop", "the bytes are not the ones asked for");

  // The loop is a WRITER of this root's log — one file per (root, writer) — and `observed` comes from
  // the world rather than from the write's own report.
  const log = await audit();
  assert.equal(log.ok, true);
  assert.deepEqual(log.files.length, 1, `expected one writer's file: ${JSON.stringify(log.files)}`);
  const entry = log.entries.filter((e) => e.act?.target === "from-the-loop.txt").pop();
  assert.ok(entry, "the write is not in the root's log");
  assert.equal(entry.kind, "act");
  assert.equal(entry.decision, "allow");
  assert.equal(entry.rule, "writes-inside");
  assert.equal(entry.root, `machine:${defaultRoot}`, "the log labels the root by the machine that owns it");
  assert.equal(entry.observed.exists, true);
  assert.equal(entry.observed.bytes, Buffer.byteLength("hello from the loop"), "observed bytes do not match the world");
});

test("declaring another machine root MOVES the loop: the same act lands there instead", async () => {
  const declared = await declare("other-project", { kind: "machine", path: otherRoot });
  assert.equal(declared.body.ok, true, JSON.stringify(declared.body));
  assert.equal(declared.body.root.path, otherRoot);
  assert.equal(declared.body.reachableFromThisProcess, true);

  const reply = await turn("create a file called moved.txt with second root");
  assert.equal(reply.result?.ok, true, JSON.stringify(reply.result));
  assert.equal(existsSync(path.join(otherRoot, "moved.txt")), true, "the write did not land in the newly declared root");
  assert.equal(existsSync(path.join(defaultRoot, "moved.txt")), false, "the write also landed in the old root — two roots, one product");

  // And the listing follows the active root rather than showing the previous project's files.
  const listing = await files();
  assert.equal(listing.ok, true);
  assert.deepEqual(listing.entries.map((e) => e.name), ["moved.txt"], `the listing is not the active root: ${JSON.stringify(listing.entries)}`);
  assert.equal(listing.root.path, otherRoot);
});

test("containment still bites, for both passes: '..' at any depth, and a symlink out", async () => {
  // (a) the lexical pass — shared with every other placement
  const escaped = await turn("create a file called ../escape.txt with nope");
  assert.equal(escaped.result?.ok, false);
  assert.equal(escaped.result.refused, "outside-root", JSON.stringify(escaped.result));
  assert.match(escaped.result.why, /'\.\.' segment/, "the refusal does not use the mechanism's own words");
  assert.equal(existsSync(path.join(otherRoot, "..", "escape.txt")), false, "a file escaped the root");

  const deep = await turn("create a file called ../a/../../escape2.txt with nope");
  assert.equal(deep.result?.refused, "outside-root", "'..' must be refused at any depth");

  // (b) the machine placement's addition — a realpath check, because a lexical check follows a
  // symlink out and this is the defect the design already recorded
  symlinkSync(scratch, path.join(otherRoot, "link-out"));
  const throughLink = await turn("create a file called link-out/through-link.txt with nope");
  assert.equal(throughLink.result?.ok, false, "a write through a symlink out of the root was allowed");
  assert.equal(throughLink.result.refused, "outside-root");
  assert.equal(existsSync(path.join(scratch, "through-link.txt")), false, "the symlink carried the write outside the root");

  // (c) refusals are entries: a log of successes cannot answer "what did it try"
  const log = await audit();
  const refusals = log.entries.filter((e) => e.decision === "refuse");
  assert.ok(refusals.length >= 3, `refusals are not recorded: ${JSON.stringify(refusals.map((r) => r.act?.target))}`);
  assert.ok(refusals.every((r) => r.rule === "outside-root"), "a refusal did not name its rule");
  assert.ok(refusals.every((r) => r.result === "refused"));
});

test("a root this process cannot reach is REFUSED BY NAME, and the listing refuses with it", async () => {
  // The page's roots: an OPFS path, and a picked folder named by its handle id. Both are legitimate
  // active roots for the project — and neither is writable from here, which is the fact to report.
  for (const root of [{ kind: "opfs", path: "v1/projects/atlas" }, { kind: "handle", id: "atlas" }]) {
    const declared = await declare("page-project", root);
    assert.equal(declared.body.ok, true, `declaring a ${root.kind} root was refused: ${JSON.stringify(declared.body)}`);
    assert.equal(declared.body.reachableFromThisProcess, false, `this process claimed to reach a ${root.kind} root`);
    assert.equal(declared.body.refused, "root-not-reachable-from-here");
    assert.match(declared.body.why, /page/, "the refusal does not name who CAN act on it");

    const write = await turn("create a file called nowhere.txt with nope");
    assert.equal(write.result?.ok, false, `the loop wrote into a ${root.kind} root it cannot reach`);
    assert.equal(write.result.refused, "root-not-reachable-from-here", JSON.stringify(write.result));
    assert.match(write.result.why, /only the page/, "the refusal does not say who can act");

    // And the listing refuses too: showing files from the last machine root would be the two-root
    // bug again, one panel at a time.
    const listing = await files();
    assert.equal(listing.ok, false, `the listing served a ${root.kind} root from the machine: ${JSON.stringify(listing)}`);
    assert.equal(listing.refused, "root-not-reachable-from-here");
    assert.deepEqual(listing.entries, []);
  }
});

test("an unreachable root is refused by name, NOT logged, and nothing lands in the process's cwd", async () => {
  // The declaration is legitimate — the page owns this root — and the act belongs to the page. What
  // matters here is the other half: the loop must not write an entry for a root it cannot reach,
  // because the log's path for a virtual root ("v1/projects/atlas") is not a filesystem path, and
  // `path.join` on it produced a real directory relative to whatever cwd the process had.
  const declared = await declare("page-project", { kind: "opfs", path: "v1/projects/atlas" });
  assert.equal(declared.body.ok, true);

  const write = await turn("create a file called nowhere.txt with nope");
  assert.equal(write.result?.refused, "root-not-reachable-from-here", JSON.stringify(write.result));
  assert.equal(write.result.logged, null, "the loop claims to have written an entry for a root it cannot reach");
  assert.equal(write.result.logRefused, "root-not-reachable-from-here", "the missing entry is not reported");

  // And the tree: the cwd the server ran in is still empty — no v1/, no .audit/, nothing.
  assert.deepEqual(readdirSync(serverCwd), [], `the loop wrote into its own working directory: ${JSON.stringify(readdirSync(serverCwd))}`);
});

test("with NO root declared the loop refuses by name and writes nothing anywhere", async () => {
  // A second server, no declaration at all: no default to fall back to, and no act performed.
  const bareCwd = path.join(scratch, "bare-cwd");
  mkdirSync(bareCwd);
  const bare = await startServer({ cwd: bareCwd, env: { VOICEBOX_WORKSPACE: undefined, VOICEBOX_INSTANCE: "machine-bare" } });
  const base = bare.base;
  try {

    const info = await fetch(`${base}/api/root`).then((r) => r.json());
    assert.equal(info.declared, false, "a root was reported as declared with no declaration");
    assert.equal(info.refused, "root-not-declared", JSON.stringify(info));
    assert.match(info.why, /environment declares one/, "the refusal does not say whose job declaring is");

    const write = await fetch(`${base}/api/turn`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ transcript: "create a file called nowhere.txt with nope" }),
    }).then((r) => r.json());
    assert.equal(write.result?.ok, false, `the loop wrote with no root declared: ${JSON.stringify(write.result)}`);
    assert.equal(write.result.refused, "root-not-declared");
    assert.equal(write.result.logged, null);

    const files = await fetch(`${base}/api/files`).then((r) => r.json());
    assert.equal(files.refused, "root-not-declared", "the listing answered with no root declared");

    assert.deepEqual(readdirSync(bareCwd), [], `an undeclared loop wrote into its working directory: ${JSON.stringify(readdirSync(bareCwd))}`);
  } finally {
    await bare.stop();
  }
});

test("a bad declaration is refused by name, not by silence", async () => {
  // Whatever the active root is at this point, a refused declaration must leave it exactly that.
  const before = await rootInfo();
  const missing = await declare("p", { kind: "machine", path: path.join(scratch, "does-not-exist") });
  assert.equal(missing.body.refused, "path-missing");
  assert.match(missing.body.why, /does not exist/);

  const aFile = path.join(scratch, "a-file.txt");
  writeFileSync(aFile, "x");
  const notDir = await declare("p", { kind: "machine", path: aFile });
  assert.equal(notDir.body.refused, "not-a-directory");
  assert.match(notDir.body.why, /is a file/);

  const unknown = await declare("p", { kind: "bucket", path: "/tmp" });
  assert.equal(unknown.body.refused, "unknown-root-kind", JSON.stringify(unknown.body));
  assert.match(unknown.body.why, /opfs/, "the refusal does not say which kinds exist");

  const empty = await declare("p", { kind: "machine", path: "" });
  assert.equal(empty.body.refused, "bad-request");

  // A refusal leaves the active root alone: the loop keeps writing where it was.
  const after = await rootInfo();
  assert.deepEqual(after.root, before.root, "a refused declaration changed the active root");
  assert.equal(after.project, before.project, "a refused declaration changed the active project");
});

test("the old root is not a second root: nothing writes to a folder nobody declared", async () => {
  await declare("back-to-machine", { kind: "machine", path: defaultRoot });
  await turn("create a file called back.txt with back");
  assert.equal(existsSync(path.join(defaultRoot, "back.txt")), true);
  // The other root still holds exactly what was written while it was active — no act leaked into it.
  // (`link-out` is this suite's own symlink fixture, created by the containment check.)
  assert.deepEqual(
    readdirSync(otherRoot).filter((f) => !f.startsWith(".") && f !== "link-out").sort(),
    ["moved.txt"],
    "an act leaked into a root that is not the active one",
  );
});

// ── the two states that must never be silent, and must never hold the caller ─────────────────────

test("a VANISHED root refuses by name, with the remedy, and answers instead of hanging", async () => {
  // Measured before the fix, on a live server: declare, delete the directory, act → the request was
  // never answered (an unawaited async route threw ENOENT and nothing wrote a response). A hang is
  // the one behaviour this whole refusal vocabulary exists to prevent.
  const doomed = path.join(scratch, "doomed-root");
  mkdirSync(doomed);
  assert.equal((await declare("doomed", { kind: "machine", path: doomed })).body.ok, true);
  writeFileSync(path.join(doomed, "was-here.txt"), "x"); // it worked a moment ago

  rmSync(doomed, { recursive: true, force: true });

  // The request must ANSWER. A timer racing the fetch is the assertion: the defect was silence, so
  // "it replied quickly" is the property, not merely "it replied correctly".
  const answered = await Promise.race([
    turn("create a file called after-vanish.txt with hi"),
    sleep(5000).then(() => ({ timedOut: true })),
  ]);
  assert.equal(answered.timedOut, undefined, "the server held the request instead of refusing it");
  assert.equal(answered.result?.ok, false, `an act on a vanished root succeeded: ${JSON.stringify(answered.result)}`);
  assert.equal(answered.result.refused, "root-vanished", JSON.stringify(answered.result));
  assert.match(answered.result.why, /is not there any more/, "the refusal does not say what happened");
  assert.match(answered.result.why, /declare it again|re-declare/, "the refusal does not state the remedy");
  assert.equal(answered.result.logged, null, "a vanished root claims to have written a log entry");

  // The read side refuses with the same name rather than an empty listing (which would look like an
  // empty folder) or a 500.
  const files = await fetch(`${BASE}/api/files`).then((r) => r.json());
  assert.equal(files.refused, "root-vanished", JSON.stringify(files));
  assert.deepEqual(files.entries, []);
  const log = await audit();
  assert.equal(log.refused, "root-vanished");

  // And the remedy works: re-declare a path that exists and the loop acts again.
  mkdirSync(doomed);
  assert.equal((await declare("doomed-again", { kind: "machine", path: doomed })).body.ok, true);
  const after = await turn("create a file called after-redeclare.txt with hi");
  assert.equal(after.result?.ok, true, `re-declaring did not restore the loop: ${JSON.stringify(after.result)}`);
  assert.equal(existsSync(path.join(doomed, "after-redeclare.txt")), true);
});

test("UN-DECLARE returns to root-not-declared, and the state is reachable twice in one process", async () => {
  // `root-not-declared` is a contract the acceptance gate asserts positively. A state you cannot
  // return to is one you can only test once per process — and for a person, "close the project" has
  // to have an expression that is not "restart the server".
  const before = await rootInfo();
  assert.equal(before.declared, true, "this check needs a declared root to un-declare");

  const removed = await fetch(`${BASE}/api/root`, { method: "DELETE", headers: { "x-voicebox-host-token": server.hostToken } }).then((r) => r.json());
  assert.equal(removed.ok, true);
  assert.equal(removed.declared, false, "un-declare did not report the state it left");
  assert.equal(removed.refused, "root-not-declared");
  assert.equal(removed.unDeclared.root.path, before.root.path, "un-declare did not say what it removed");

  const after = await rootInfo();
  assert.equal(after.declared, false);
  assert.equal(after.refused, "root-not-declared");

  const act = await turn("create a file called nowhere.txt with nope");
  assert.equal(act.result?.refused, "root-not-declared", JSON.stringify(act.result));
  assert.match(act.result.why, /environment declares one/, "the refusal does not say whose job declaring is");

  // Declare again: the state machine goes back, and forward.
  assert.equal((await declare("back", { kind: "machine", path: defaultRoot })).body.ok, true);
  const again = await turn("create a file called back-again.txt with hi");
  assert.equal(again.result?.ok, true, JSON.stringify(again.result));
  assert.equal(existsSync(path.join(defaultRoot, "back-again.txt")), true);
});

test("the ordering lesson: restore the previous state BEFORE removing your own", async () => {
  // The harness that found the hang deleted its scratch directory first and restored the root after,
  // leaving a live server holding a declaration pointing at nothing. Both orders now end in a named
  // answer, but the harness's own discipline is asserted here too: a suite that removes its scratch
  // tree while a server still points at it is the shape that produced a silent hang.
  const scratchRoot = path.join(scratch, "ordering-root");
  mkdirSync(scratchRoot);
  await declare("ordering", { kind: "machine", path: scratchRoot });

  // Remove my own state first, THEN the directory — the correct order.
  await fetch(`${BASE}/api/root`, { method: "DELETE", headers: { "x-voicebox-host-token": server.hostToken } });
  rmSync(scratchRoot, { recursive: true, force: true });

  const after = await Promise.race([
    turn("create a file called after-ordering.txt with hi"),
    sleep(5000).then(() => ({ timedOut: true })),
  ]);
  assert.equal(after.timedOut, undefined, "the server held the request after a correct teardown order");
  assert.equal(after.result.refused, "root-not-declared", JSON.stringify(after.result));

  // Leave the suite where it found it.
  await declare("back", { kind: "machine", path: defaultRoot });
});
