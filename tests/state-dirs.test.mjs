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
// Env hygiene: the four fact variables are saved before and restored after every drive — a test
// that leaks its probe value re-points every later suite at a directory that vanishes with /tmp.
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { FACTS, REPO, workspaceDir, workspaceDeclared, extensionsDir, wasmShelfDir, sandboxHomesDir, declareOverrides } from "../lib/state-dirs.mjs";

const NAMES = Object.values(FACTS).map((f) => f.env);
const saved = new Map();
for (const name of NAMES) {
  if (Object.prototype.hasOwnProperty.call(process.env, name)) saved.set(name, process.env[name]);
}
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
    process.env[fact.env] = "";
    assert.equal(fact.value(), unsetDefault, `${fact.id}: 'set to nothing' is ONE state with unset — the default, never a relative-everything path`);
    assert.equal(fact.declared(), null, `${fact.id}: an empty value is not an operator declaration either`);
    delete process.env[fact.env];
  }
});

test("CALL-TIME READS: the getter answers the variable as it is NOW, not as it was at import", () => {
  for (const fact of Object.values(FACTS)) {
    const before = withCleanEnv(() => fact.value());
    const probe = `/state-dirs-probe/${fact.id}`;
    process.env[fact.env] = probe;
    assert.equal(fact.value(), probe, `${fact.id}: a later write is seen by the next call`);
    assert.equal(fact.declared(), probe, `${fact.id}: declared() answers the declaration, no default`);
    delete process.env[fact.env];
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
  } finally {
    delete process.env.VOICEBOX_WORKSPACE;
    delete process.env.VOICEBOX_EXTENSIONS_DIR;
    delete process.env.VOICEBOX_WASM_SHELF_DIR;
  }
});

test("the defaults hang off THIS checkout (REPO), not the process cwd", () => {
  const ws = withCleanEnv(() => workspaceDir());
  assert.equal(ws, path.join(REPO, "workspace"), "the workspace default is beside the module that owns it — cwd-independence is the contract");
});
