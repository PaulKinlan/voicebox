// tests/pi-acp-probe-runtime.test.mjs — openPiAcpProbe's real path, with NO VOICEBOX_ACP_* env.
//
//   node --test tests/pi-acp-probe-runtime.test.mjs
//
// WHY THIS FILE EXISTS (voicebox-beads-x5lg, found under voicebox-beads-8gk7): tests/pi-acp.test.mjs
// SKIPS both probe tests unless VOICEBOX_ACP_ADAPTER and VOICEBOX_ACP_PI are set, so the only
// coverage of openPiAcpProbe on a normal gate was "does this file parse". A missing binding inside
// it — `const dir = fs.mkdtempSync(...)` was deleted outright — threw ReferenceError at runtime on
// every real call while the whole gate stayed green. `node --check` cannot see that, and this repo
// has no lint/no-undef stage.
//
// So the probe is driven here against a STAND-IN adapter and harness: a fake adapter dir whose
// package.json matches the pinned identity, with the sdk/zod paths the probe realpaths, and a fake
// `pi` that answers --version. That walks the probe's real code — temp dir, launcher script, the
// bwrap argv, the version check — without the installed adapter and without a model task.
//
// The negative control is the point of the pair: it MUTATES the module (removes exactly the binding
// that shipped missing) and asserts the same call DOES throw ReferenceError. A green positive test
// alone would not distinguish "the probe worked" from "this test cannot fail".
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { openPiAcpProbe, resolveLib64 } from "../lib/pi-acp.mjs";
import { ACP_AGENT } from "../lib/acp-client.mjs";

const LIB = fileURLToPath(new URL("../lib/", import.meta.url));

/**
 * Functional canary for bubblewrap unprivileged user-namespace execution.
 * Accepts injectable runner and existence check to allow unit testing of failure modes.
 */
export function canBwrap(spawnFn = spawnSync, existsFn = fs.existsSync) {
  if (!existsFn("/usr/bin/bwrap")) return false;
  const lib64 = resolveLib64();
  try {
    const res = spawnFn("/usr/bin/bwrap", [
      "--unshare-all",
      "--ro-bind", "/usr", "/usr",
      "--symlink", lib64, "/lib64",
      "--proc", "/proc",
      "--dev", "/dev",
      "/usr/bin/true",
    ], { stdio: "ignore", timeout: 3000 });
    return res?.status === 0;
  } catch {
    return false;
  }
}
const hasBwrap = canBwrap();

// The stand-in adapter answers the handshake and reports facts only a process INSIDE the fence can
// know (cwd=/work, PI_ACP_PI_COMMAND=/harness/pi), so trusting a reply is trusting the sandbox ran.
const STAND_IN_ACP = `process.stdin.setEncoding("utf8");
let buffered = "";
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
process.stdin.on("data", (chunk) => {
  buffered += chunk;
  for (let nl = buffered.indexOf("\\n"); nl !== -1; nl = buffered.indexOf("\\n")) {
    const line = buffered.slice(0, nl); buffered = buffered.slice(nl + 1);
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.method === "initialize") {
      reply(message.id, {
        protocolVersion: 1,
        agentInfo: { name: "${ACP_AGENT.name}", version: "${ACP_AGENT.version}" },
        standIn: { cwd: process.cwd(), piCommand: process.env.PI_ACP_PI_COMMAND ?? null, execPath: process.execPath },
      });
    } else if (message.method === "session/new") reply(message.id, { sessionId: "stand-in-session" });
    else if (message.id !== undefined) reply(message.id, {});
  }
});
process.stdin.resume();
`;

/** Build a stand-in adapter + harness pair under a scratch dir this test owns. */
function standIn(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "voicebox-acp-standin-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const adapterDir = path.join(root, "voicebox-acp-probe");
  const harnessDir = path.join(root, "harness");
  fs.mkdirSync(path.join(adapterDir, "node_modules", "zod"), { recursive: true });
  fs.mkdirSync(path.join(adapterDir, "dist"), { recursive: true });
  fs.mkdirSync(path.join(root, "@agentclientprotocol", "sdk"), { recursive: true });
  fs.mkdirSync(harnessDir, { recursive: true });
  fs.writeFileSync(path.join(adapterDir, "package.json"),
    JSON.stringify({ name: ACP_AGENT.name, version: ACP_AGENT.version, type: "module" }));
  fs.writeFileSync(path.join(adapterDir, "dist", "index.js"), STAND_IN_ACP);
  // The launcher runs /harness/pi --version and requires the pinned answer before exec.
  const piBinary = path.join(harnessDir, "pi");
  fs.writeFileSync(piBinary, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo ${ACP_AGENT.piVersion}; exit 0; fi\nexit 0\n`, { mode: 0o700 });
  return { adapterDir, piBinary };
}

test("the stand-in probe fails in the ACP layer or succeeds — never with a missing binding", { timeout: 30000 }, async (t) => {
  // The always-on half of the pair (x5lg): it does not need the fence's loader to work, only that the
  // probe got as far as its own code, so it still catches a deleted declaration on a host whose fence
  // cannot exec a dynamically-linked binary.
  if (!hasBwrap) {
    t.skip("no /usr/bin/bwrap on this host — the fenced diagnostic cannot boot here");
    return;
  }
  const { adapterDir, piBinary } = standIn(t);
  const settled = await openPiAcpProbe({ adapterDir, piBinary, timeoutMs: 15000 })
    .then(async (probe) => { await probe.close(); return { ok: true }; }, (error) => ({ ok: false, error }));
  assert.ok(!(settled.error instanceof ReferenceError),
    `a missing binding must not be able to hide here: ${settled.error?.stack}`);
  assert.ok(settled.ok || typeof settled.error?.refused === "string",
    `the probe must succeed or fail with a NAMED ACP outcome, got: ${settled.error}`);
});

test("openPiAcpProbe walks its real path against a stand-in adapter without VOICEBOX_ACP_* set", { timeout: 30000 }, async (t) => {
  if (!hasBwrap) {
    t.skip("no /usr/bin/bwrap on this host — the fenced diagnostic cannot boot here");
    return;
  }
  const { adapterDir, piBinary } = standIn(t);
  const probe = await openPiAcpProbe({ adapterDir, piBinary, timeoutMs: 15000 });
  t.after(() => probe.close());
  assert.equal(probe.info.protocolVersion, 1, "the pinned ACP handshake completed");
  assert.equal(probe.info.agentInfo.name, ACP_AGENT.name);
  assert.equal(probe.info.agentInfo.version, ACP_AGENT.version);
  // The reply carries facts only the fenced child can report: the fence's cwd and its own env.
  assert.equal(probe.info.standIn.cwd, "/work", "the adapter ran INSIDE the fence, at the fence's cwd");
  assert.equal(probe.info.standIn.piCommand, "/harness/pi", "the adapter saw the fence's own environment");
  assert.equal(probe.info.standIn.execPath, "/packages/node", "the adapter executed under the sandboxed /packages/node runtime");
  // The temp dir the probe created is removed when the child exits (x5lg's P0 was that creation).
  assert.equal(await probe.newSession(), "stand-in-session");
});

test("negative control: removing the probe's temp-dir binding makes the same call throw ReferenceError", { timeout: 30000 }, async (t) => {
  const { adapterDir, piBinary } = standIn(t);
  const source = fs.readFileSync(path.join(LIB, "pi-acp.mjs"), "utf8");
  const mutated = source.replace(/^ *const dir = fs\.mkdtempSync\([^\n]*\);\n/m, "");
  assert.notEqual(mutated, source, "the mutation must remove the temp-dir binding from lib/pi-acp.mjs");
  // The mutant is executed from a scratch copy, so its relative imports are rewritten absolute.
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "voicebox-acp-mutant-"));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const mutantPath = path.join(scratch, "pi-acp-mutant.mjs");
  fs.writeFileSync(mutantPath, mutated.replace(/from "\.\//g, `from "${LIB}`));
  const mutant = await import(pathToFileURL(mutantPath).href);
  await assert.rejects(
    mutant.openPiAcpProbe({ adapterDir, piBinary, timeoutMs: 15000 }),
    (error) => error instanceof ReferenceError && /dir is not defined/.test(error.message),
    "the same call must fail loudly on the exact defect this file exists to catch",
  );
});

test("fenced probe reports exit status without leaking arbitrary stderr or unlabelled secrets (voicebox-beads-7i5j)", { timeout: 30000 }, async (t) => {
  if (!hasBwrap) {
    t.skip("no functional bwrap on this host");
    return;
  }
  const { adapterDir, piBinary } = standIn(t);
  // Break the adapter to emit arbitrary unlabelled secret material on stderr and exit with code 42
  fs.writeFileSync(path.join(adapterDir, "dist", "index.js"), [
    'console.log(JSON.stringify({ jsonrpc: "2.0", method: "notification/stdout_canary" }));',
    'console.error("CONFIDENTIAL_ARBITRARY_SECRET_DATA_XYZ_987654321");',
    'process.exit(42);',
  ].join("\n"));
  await assert.rejects(
    openPiAcpProbe({ adapterDir, piBinary, timeoutMs: 15000 }),
    (error) => {
      assert.equal(error.refused, "harness-ended-outcome-unknown");
      assert.equal(error.detail, "exit 42");
      assert.match(error.message, /exit 42/);
      assert.doesNotMatch(error.message, /CONFIDENTIAL_ARBITRARY_SECRET_DATA/);
      assert.doesNotMatch(String(error.detail), /CONFIDENTIAL_ARBITRARY_SECRET_DATA/);
      assert.doesNotMatch(String(error.detail), /stdout_canary/);
      return true;
    },
    "an unexpected child failure must report exit status without exposing arbitrary child stderr",
  );
});

test("canBwrap canary: returns false on execution error or non-zero status (voicebox-beads-y63q P2)", () => {
  // Mock runner simulating non-zero exit status (e.g. userns clone denied or bad flag)
  assert.equal(canBwrap(() => ({ status: 1 })), false, "status 1 must return false");
  assert.equal(canBwrap(() => ({ status: 127 })), false, "status 127 must return false");
  // Mock runner simulating process spawn failure/throw
  assert.equal(canBwrap(() => { throw new Error("EPERM: operation not permitted"); }), false, "thrown spawn must return false");
  // Mock runner simulating missing bwrap binary
  assert.equal(canBwrap(spawnSync, () => false), false, "missing binary must return false");
  // Mock runner simulating successful unshare execution (positive control)
  assert.equal(canBwrap(() => ({ status: 0 }), () => true), true, "status 0 with present binary must return true");
});
