// tests/state-dirs.test.mjs — the state-directory owner's BEHAVIOURAL contract, driven.
//
// WHY (voicebox-beads-nr5h, from a test-gap station finding): tests/single-owner.test.mjs and the
// gate check lib/state-dirs.mjs STATICALLY (the variable is read only here, the default built only
// here) and its probe drives value()/declared() with a NON-EMPTY sentinel — but no test pins the
// behavioural rules the module exists to guarantee:
//
//   * EMPTY IS UNSET — `VOICEBOX_EXTENSIONS_DIR=` (set to nothing) resolves to the DEFAULT, not to
//     a path whose every child is relative. "Unset" and "set to nothing" are one state, and it is
//     the default; two callers once used `??`, which let the empty string through.
//   * CALL-TIME READS — value() reads the variable when ASKED, not at import: a test's before-hook
//     or an operator's restart is seen by the next call. A caller that stores the result in a
//     constant has taken a copy at import, and that is the caller's choice to make knowingly.
//   * THE ENV WRITE HAPPENS HERE OR NOWHERE — declareOverrides is the one place host tooling may
//     point the facts at a scratch directory; it takes only workspace and extensions, resolves
//     them to absolute paths, and leaves every other fact alone.
//
// Env hygiene: the four fact variables are snapshotted at import and restored in test.after, and
// each drive that writes a probe cleans up in a finally — because a failed assertion mid-drive must
// not leave a fact pointing at a /tmp directory for the rest of THIS file. (Neighbouring test files
// are safe by a different mechanism: node --test runs each file in its own child process, so a leak
// cannot cross a file boundary.)
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { execFile as execFileCb } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { promisify } from "node:util";
import path from "node:path";
import { pathToFileURL } from "node:url";

const execFileAsync = promisify(execFileCb);
import { FACTS, REPO, workspaceDir, workspaceDeclared, extensionsDir, wasmShelfDir, sandboxHomesDir, declareOverrides } from "../lib/state-dirs.mjs";

const NAMES = Object.values(FACTS).map((f) => f.env);
const saved = new Map();
for (const name of NAMES) {
  if (Object.prototype.hasOwnProperty.call(process.env, name)) saved.set(name, process.env[name]);
}
/** Set one fact's variable for the duration of a drive, restoring whatever was there — even on a failed assertion. */
const withProbe = (fact, value, run) => {
  const held = Object.prototype.hasOwnProperty.call(process.env, fact.env) ? process.env[fact.env] : null;
  process.env[fact.env] = value;
  try {
    return run();
  } finally {
    if (held === null) delete process.env[fact.env];
    else process.env[fact.env] = held;
  }
};

/** Run a drive with every fact variable removed, restoring whatever was there after. */
const withCleanEnv = (run) => {
  const held = new Map();
  for (const name of NAMES) {
    if (Object.prototype.hasOwnProperty.call(process.env, name)) held.set(name, process.env[name]);
    delete process.env[name];
  }
  try {
    return run();
  } finally {
    for (const [name, value] of held) process.env[name] = value;
  }
};
test.after(() => {
  for (const name of NAMES) {
    if (saved.has(name)) process.env[name] = saved.get(name);
    else delete process.env[name];
  }
});

test("EMPTY IS UNSET: a variable set to the empty string answers as the default, for every fact", () => {
  for (const fact of Object.values(FACTS)) {
    const unsetDefault = withCleanEnv(() => fact.value());
    assert.ok(typeof unsetDefault === "string" && unsetDefault.length > 0, `${fact.id}: the default is a real directory`);
    withProbe(fact, "", () => {
      assert.equal(fact.value(), unsetDefault, `${fact.id}: 'set to nothing' is ONE state with unset — the default, never a relative-everything path`);
      assert.equal(fact.declared(), null, `${fact.id}: an empty value is not an operator declaration either`);
    });
  }
});

test("CALL-TIME READS: the getter answers the variable as it is NOW, not as it was at import", () => {
  for (const fact of Object.values(FACTS)) {
    const before = withCleanEnv(() => fact.value());
    const probe = `/state-dirs-probe/${fact.id}`;
    withProbe(fact, probe, () => {
      assert.equal(fact.value(), probe, `${fact.id}: a later write is seen by the next call`);
      assert.equal(fact.declared(), probe, `${fact.id}: declared() answers the declaration, no default`);
    });
    assert.equal(fact.value(), before, `${fact.id}: and removing it returns to the default — no import-time copy survives`);
    assert.equal(fact.declared(), null, `${fact.id}: absent is null, not the default`);
  }
  // The named getters are the same call-time door (sandboxHomes' own doc: read at USE time, so a
  // test's before-hook is seen).
  const probe = "/state-dirs-probe/named";
  process.env.VOICEBOX_SANDBOX_HOMES = probe;
  assert.equal(sandboxHomesDir(), probe, "sandboxHomesDir() sees a late before-hook write");
  delete process.env.VOICEBOX_SANDBOX_HOMES;
});

test("the named getters ARE the facts — one door per fact, in BOTH states, not a second copy of the answer", () => {
  const getters = { workspace: workspaceDir, extensions: extensionsDir, wasmShelf: wasmShelfDir, sandboxHomes: sandboxHomesDir };
  // With the variable SET the getter answers it (mutation kill: a getter answering declared()
  // returns the same string here — the distinguishing state is below).
  const probes = { workspace: "/p/w", extensions: "/p/e", wasmShelf: "/p/s", sandboxHomes: "/p/h" };
  for (const [id, probe] of Object.entries(probes)) process.env[FACTS[id].env] = probe;
  try {
    for (const [id, getter] of Object.entries(getters)) assert.equal(getter(), probes[id], `${id}: the getter answers the variable when set`);
    assert.equal(workspaceDeclared(), probes.workspace);
  } finally {
    for (const id of Object.keys(probes)) delete process.env[FACTS[id].env];
  }
  // With the variable UNSET the getter answers the DEFAULT — declared() would answer null here,
  // and a caller switching doors would see every path under it become null-relative.
  for (const [id, getter] of Object.entries(getters)) {
    const unset = withCleanEnv(() => getter());
    assert.ok(typeof unset === "string" && unset.length > 0, `${id}: unset answers the DEFAULT (a real directory), not declared()'s null`);
  }
});

test("declareOverrides is the ONE env write: absolute, and only for the two facts it owns", () => {
  const sentinel = "/state-dirs-probe/untouched";
  process.env.VOICEBOX_EXTENSIONS_DIR = sentinel;
  process.env.VOICEBOX_WASM_SHELF_DIR = sentinel;
  try {
    declareOverrides({ workspace: "relative/scratch" });
    assert.equal(process.env.VOICEBOX_WORKSPACE, path.resolve("relative/scratch"), "the override is RESOLVED to an absolute path, so a relative CLI flag cannot re-point everything at cwd");
    assert.equal(process.env.VOICEBOX_EXTENSIONS_DIR, sentinel, "a fact the call did not name is untouched");
    assert.equal(process.env.VOICEBOX_WASM_SHELF_DIR, sentinel, "and a fact declareOverrides does not own is untouched too");
    declareOverrides({ extensions: "another/scratch" });
    assert.equal(process.env.VOICEBOX_EXTENSIONS_DIR, path.resolve("another/scratch"));
    assert.equal(process.env.VOICEBOX_WORKSPACE, path.resolve("relative/scratch"), "the earlier override survives its own call");
    declareOverrides({});
    assert.equal(process.env.VOICEBOX_WORKSPACE, path.resolve("relative/scratch"), "an empty override changes nothing");
    // AN EMPTY OVERRIDE IS NOT AN ANSWER EITHER (review B13): a CLI flag given as '' must not
    // re-point the fact at cwd — the module's own central rule, driven at its one env write.
    declareOverrides({ workspace: "", extensions: "" });
    assert.equal(process.env.VOICEBOX_WORKSPACE, path.resolve("relative/scratch"), "an empty-string workspace override is a no-op, not path.resolve('')");
    assert.equal(process.env.VOICEBOX_EXTENSIONS_DIR, path.resolve("another/scratch"), "an empty-string extensions override is a no-op too");
  } finally {
    delete process.env.VOICEBOX_WORKSPACE;
    delete process.env.VOICEBOX_EXTENSIONS_DIR;
    delete process.env.VOICEBOX_WASM_SHELF_DIR;
  }
});

test("the defaults hang off THIS checkout (the tree that holds the owner module), not the process cwd", async () => {
  // NOT self-referential: the parent of the default must be the tree that physically contains
  // lib/state-dirs.mjs (review B11 — an equality against the module's own REPO constant moves with
  // the mutation and stays green).
  const ws = withCleanEnv(() => workspaceDir());
  const ownerInTree = existsSync(path.join(path.dirname(ws), "lib", "state-dirs.mjs"));
  assert.ok(ownerInTree, `the workspace default's parent must be the tree holding the owner module (got ${ws})`);

  // CWD-INDEPENDENT, driven from a DIFFERENT cwd (review B10 — path.resolve("workspace") is
  // character-identical to the right answer when the test happens to run from the checkout root,
  // so the parent process can never observe the difference). A child with cwd=/tmp and every fact
  // variable cleared must still answer the checkout's defaults.
  const env = { ...process.env };
  for (const name of NAMES) delete env[name];
  // ALL FOUR facts, not two: the homedir-relative defaults cannot be caught by cwd in the parent
  // (review hole 3), so the child answers them too — and a cwd-relative mutation of either homedir
  // fact goes red HERE (cwd=/tmp), not just by value.
  const child = await execFileAsync(process.execPath, [
    "--input-type=module",
    "-e",
    `const m = await import(${JSON.stringify(pathToFileURL(path.join(REPO, "lib", "state-dirs.mjs")).href)}); console.log(JSON.stringify([m.workspaceDir(), m.extensionsDir(), m.wasmShelfDir(), m.sandboxHomesDir()]));`,
  ], { cwd: tmpdir(), env, encoding: "utf8" });
  const [childWorkspace, childExtensions, childShelf, childHomes] = JSON.parse(child.stdout.trim());
  assert.equal(childWorkspace, path.join(REPO, "workspace"), "a child running from /tmp still answers the checkout's workspace default — not its cwd");
  assert.equal(childExtensions, path.join(REPO, "extensions"), "and the extensions default — cwd-independence, driven not asserted");
  assert.equal(childShelf, path.join(homedir(), ".isocan", "modules", "wasm-tools"), "and the wasm shelf default — by VALUE, from a different cwd");
  assert.equal(childHomes, path.join(homedir(), "sandbox-homes"), "and the sandbox-homes default — by VALUE, from a different cwd");
});

test("the two homedir-relative defaults are pinned BY VALUE, not by shape (review holes 1+2)", () => {
  // A presence-only check lets '/tmp/bogus-shelf' or a cwd-relative path through; the VALUE is
  // the contract — the isocan shelf and the sandbox homes hang off the user's home, exactly there.
  const shelf = withCleanEnv(() => wasmShelfDir());
  const homes = withCleanEnv(() => sandboxHomesDir());
  assert.equal(shelf, path.join(homedir(), ".isocan", "modules", "wasm-tools"), "the wasm shelf default, by value");
  assert.equal(homes, path.join(homedir(), "sandbox-homes"), "the sandbox-homes default, by value");
  // And the module's own recorded lesson stays named: a home under /tmp is hidden by PrivateTmp
  // and the fence bind fails (status 226/NAMESPACE) — the value pin above is the primary guard,
  // this documents WHY that value must never be tidied somewhere writable-looking.
  assert.ok(!homes.startsWith(tmpdir() + path.sep), `the default must not be under ${tmpdir()} — the 226/NAMESPACE lesson`);
});
