// tests/self-environment-key.test.mjs — I1b (`voicebox-beads-4x7`).
//
// THE DEFECT THIS PINS: the environment key this host stamps was the constant
// "local" — a value every server spells the same way. Two hosts then re-stamped
// a descriptor to the same string, so no real path could produce a root whose
// owner differed from the acting environment, and
// `not-reachable-from-this-environment` was correct and unreachable.
//
// DRIVEN with two REAL servers on ephemeral ports, each with its own host
// directory: distinct self-issued keys, each stamping its own declarations, and
// the reviewer's probe re-run — A's descriptor posted to B comes back stamped
// with B's key, which is the evidence that the DECLARE path cannot manufacture
// the disagreement (and why the refusal needs the peer-descriptor path).
//
//   node --test tests/self-environment-key.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SERVER = fileURLToPath(new URL("../server.mjs", import.meta.url));
const KEY = /^env_[0-9a-f]{16}$/;

const roots = [];
test.after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

async function host(label) {
  const dir = mkdtempSync(path.join(os.tmpdir(), `voicebox-${label}-`));
  roots.push(dir);
  const extensions = path.join(dir, "extensions");
  const workspace = path.join(dir, "workspace", "project");
  mkdirSync(extensions, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  const child = spawn(process.execPath, [SERVER], {
    // PORT=0: the OS picks, and the server prints what it got. A fixed port
    // cannot run beside another lane's test.
    env: { ...process.env, PORT: "0", VOICEBOX_EXTENSIONS_DIR: extensions, VOICEBOX_WORKSPACE: workspace, VOICEBOX_RESOLVER: "script" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const port = await new Promise((resolve, reject) => {
    let out = "";
    const timer = setTimeout(() => reject(new Error(`no port from ${label} in 25s: ${out}`)), 25_000);
    child.stdout.on("data", (chunk) => {
      out += String(chunk);
      const found = /voicebox on http:\/\/127\.0\.0\.1:(\d+)/.exec(out);
      if (found) {
        clearTimeout(timer);
        resolve(Number(found[1]));
      }
    });
    child.on("exit", (code) => reject(new Error(`${label} exited ${code}: ${out}`)));
  });
  const token = readFileSync(path.join(extensions, ".host-token"), "utf8").trim();
  return { child, dir, extensions, workspace, port, key: readFileSync(path.join(extensions, ".environment-key"), "utf8").trim(), token };
}

const declare = (h, root) =>
  fetch(`http://127.0.0.1:${h.port}/api/root`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-voicebox-host-token": h.token },
    body: JSON.stringify({ project: "i1b", root }),
  }).then((r) => r.json());

test("two real hosts mint DISTINCT self-issued keys, and each stamps its own declaration", async () => {
  const a = await host("a");
  const b = await host("b");
  try {
    assert.match(a.key, KEY, "the key is a minted identity, not a label");
    assert.match(b.key, KEY);
    assert.notEqual(a.key, b.key, "a value every host spells the same way is the defect this bead is about");

    const declaredA = await declare(a, { kind: "machine", path: a.workspace });
    const declaredB = await declare(b, { kind: "machine", path: b.workspace });
    assert.equal(declaredA.root.environment, a.key, "A's root belongs to A");
    assert.equal(declaredB.root.environment, b.key, "B's root belongs to B");
    assert.notEqual(declaredA.root.environment, declaredB.root.environment);
  } finally {
    a.child.kill("SIGTERM");
    b.child.kill("SIGTERM");
  }
}, 90_000);

test("THE REVIEWER'S PROBE, RE-RUN: a descriptor posted to the other host is re-stamped — so the DECLARE path cannot manufacture the disagreement", async () => {
  const a = await host("c");
  const b = await host("d");
  try {
    const declaredA = await declare(a, { kind: "machine", path: a.workspace });
    // A's descriptor, carrying A's key, is posted to B — the reviewer's probe.
    const onB = await declare(b, { ...declaredA.root, environment: declaredA.root.environment });
    assert.equal(onB.root.environment, b.key, "B stamps what B declares — a foreign key is never accepted as an identity claim");
    assert.notEqual(onB.root.environment, a.key, "so B owns its copy, and acting on it is B acting on B's root");

    // The consequence, stated as the bead's residual: the refusal
    // (`not-reachable-from-this-environment`) cannot fire from this path. The
    // identity now EXISTS per host; the missing half is the path that hands a
    // host a root another host owns (a peer's descriptor from the registry),
    // which is where the refusal will fire.
    assert.equal(onB.root.environment === a.key, false);
  } finally {
    a.child.kill("SIGTERM");
    b.child.kill("SIGTERM");
  }
}, 90_000);
