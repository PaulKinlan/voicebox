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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8841;
const BASE = `http://127.0.0.1:${PORT}`;

let server;
let scratch;
let defaultRoot;
let otherRoot;
let picked;

const turn = (transcript) =>
  fetch(`${BASE}/api/turn`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ transcript }),
  }).then((r) => r.json());

const declare = (project, root) =>
  fetch(`${BASE}/api/root`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ project, root }),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));

const rootInfo = () => fetch(`${BASE}/api/root`).then((r) => r.json());
const files = () => fetch(`${BASE}/api/files`).then((r) => r.json());
const audit = () => fetch(`${BASE}/api/audit`).then((r) => r.json());

test.before(async () => {
  scratch = mkdtempSync(path.join(os.tmpdir(), "voicebox-seam-"));
  defaultRoot = path.join(scratch, "default-root");
  otherRoot = path.join(scratch, "other-root");
  picked = path.join(scratch, "picked-root");
  for (const dir of [defaultRoot, otherRoot, picked]) mkdirSync(dir);

  server = spawn(process.execPath, [path.join(ROOT, "server.mjs")], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), VOICEBOX_WORKSPACE: defaultRoot, VOICEBOX_INSTANCE: "machine-test" },
    stdio: "ignore",
    detached: true,
  });
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`${BASE}/api/health`)).ok) break;
    } catch {}
    await sleep(100);
  }
});

test.after(() => {
  if (server?.pid) {
    try {
      process.kill(-server.pid, "SIGKILL");
    } catch {}
  }
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

test("a bad declaration is refused by name, not by silence", async () => {
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
  const info = await rootInfo();
  assert.equal(info.root.kind, "handle", "a refused declaration changed the active root");
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
