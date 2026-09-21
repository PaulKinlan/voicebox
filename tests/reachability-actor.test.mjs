// tests/reachability-actor.test.mjs — I1: explicit-actor reachability
// (`voicebox-beads-g7c`, environments plan §1).
//
// THE CLAIM: two machine environments can be told apart, and a refusal about a
// root they disagree on NAMES the one that can act.
//
// THE CONTRAST THAT MATTERS: the positional vocabulary cannot express the
// disagreement at all — `reachableFrom(root, "machine")` answers `ok` for both
// environments, which is why the facts row read "the machine" and meant "some
// machine". Both are driven here, so the difference is visible rather than
// asserted in prose.
//
//   node --test tests/reachability-actor.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Scratch state BEFORE the lib loads — importing the channel must not touch
// repo-owned files (the same rule tests/channel.test.mjs follows).
const SCRATCH = mkdtempSync(path.join(os.tmpdir(), "voicebox-i1-actor-"));
process.env.VOICEBOX_WORKSPACE = path.join(SCRATCH, "workspace");
process.env.VOICEBOX_EXTENSIONS_DIR = path.join(SCRATCH, "extensions");

const {
  reachableFrom,
  reachableFromEnvironment,
  ownerOf,
  ROOT_NOT_REACHABLE,
  ROOT_NOT_REACHABLE_FROM_ENVIRONMENT,
} = await import("../core/root.ts");
const { createChannel } = await import("../lib/channel.mjs");

test.after(() => rmSync(SCRATCH, { recursive: true, force: true }));

/** The server on this machine, and a sandbox VM — two environments that are
 *  both `machine`, which is exactly why the old vocabulary could not name them. */
const LAPTOP = "env_2c9f-laptop";
const VM = "env_7b41-atlas-vm";
const root = { kind: "machine", path: "/srv/voicebox/workspace", environment: LAPTOP };

test("the root names its owner, and an unattributed root names nobody", () => {
  assert.equal(ownerOf(root), LAPTOP);
  assert.equal(ownerOf({ kind: "machine", path: "/srv/x" }), null, "no owner is UNKNOWN, never everyone");
});

test("CONTRAST: positionally both machine environments reach the same root — the disagreement is inexpressible", () => {
  // This is the defect, driven: the positional question has one answer, and it
  // is the same answer for both hosts, so nothing can disagree.
  assert.deepEqual(reachableFrom(root, "machine"), { ok: true });
  assert.deepEqual(reachableFrom({ kind: "machine", path: "/srv/x" }, "machine"), { ok: true });
});

test("DRIVE: the owner may act; the other environment is refused BY NAME, naming the host that can act", () => {
  assert.deepEqual(reachableFromEnvironment(root, { peer: "machine", environment: LAPTOP }), { ok: true });

  const other = reachableFromEnvironment(root, { peer: "machine", environment: VM });
  assert.equal(other.ok, false);
  assert.equal(other.refused, ROOT_NOT_REACHABLE_FROM_ENVIRONMENT);
  assert.match(other.why, new RegExp(LAPTOP), "the host that CAN act is named");
  assert.match(other.why, new RegExp(VM), "and the host that was asked, so the reader knows both ends");
});

test("the two refusals split on OWNERSHIP, not on who is asking", () => {
  // An owned root: every environment that is not the owner gets the refusal
  // that NAMES the owner — including the page. A page refused a machine root
  // is refused an environment's root, and "the machine can act" is weaker than
  // "'env_2c9f-laptop' can act", which is the whole point of the change.
  const page = reachableFromEnvironment(root, { peer: "page", environment: "env-the-page" });
  assert.equal(page.ok, false);
  assert.equal(page.refused, ROOT_NOT_REACHABLE_FROM_ENVIRONMENT);
  assert.match(page.why, new RegExp(LAPTOP), "the page is told WHICH host can act, not just which position can");

  // An UNATTRIBUTED root (declared before this landed): the old code, because
  // there is no owner to name and inventing one would be the lie.
  const legacy = { kind: "machine", path: "/srv/x" };
  const pageOnLegacy = reachableFromEnvironment(legacy, { peer: "page", environment: "env-the-page" });
  assert.equal(pageOnLegacy.refused, ROOT_NOT_REACHABLE, "a caller matching the old code still sees it where it is still true");
  assert.match(pageOnLegacy.why, /machine/, "and the positional sentence still says which side can act");
});

test("an unattributed root falls back to the positional check — unknown ownership is not permission", () => {
  const legacy = { kind: "machine", path: "/srv/x" };
  assert.deepEqual(reachableFromEnvironment(legacy, { peer: "machine", environment: VM }), { ok: true });
  // And the peer facts still refuse the pair that never made sense.
  const pageOnOpfs = reachableFromEnvironment({ kind: "opfs", path: "storage" }, { peer: "machine", environment: VM });
  assert.equal(pageOnOpfs.refused, ROOT_NOT_REACHABLE);
});

test("ENVELOPES: two channels put DIFFERENT environments on the wire for the same call", () => {
  const a = [];
  const b = [];
  const channelA = createChannel({ peer: "machine", connected: () => true, send: (m) => a.push(m), environment: LAPTOP });
  const channelB = createChannel({ peer: "machine", connected: () => true, send: (m) => b.push(m), environment: VM });
  const parts = { tool: "clock", descriptorId: "clock-tool", boundsEcho: {} };
  void channelA.ask(parts);
  void channelB.ask(parts);
  assert.equal(a.length, 1);
  assert.equal(b.length, 1);
  assert.equal(JSON.parse(a[0]).environment, LAPTOP);
  assert.equal(JSON.parse(b[0]).environment, VM);
  // The refusal this file is about can now be produced from what the wire carries.
  const asked = JSON.parse(b[0]).environment;
  const reach = reachableFromEnvironment(root, { peer: "machine", environment: asked });
  assert.equal(reach.refused, ROOT_NOT_REACHABLE_FROM_ENVIRONMENT);
});

test("a channel that cannot say who it is refuses to ask — and sends NOTHING", async () => {
  const sent = [];
  const anonymous = createChannel({ peer: "machine", connected: () => true, send: (m) => sent.push(m) });
  const refused = await anonymous.ask({ tool: "clock", descriptorId: "clock-tool", boundsEcho: {} });
  assert.equal(refused.ok, false);
  assert.equal(refused.refused, "environment-unknown");
  assert.equal(sent.length, 0, "no envelope with no actor on it reaches the wire");
});

test("the asker cannot claim another environment — the channel's identity wins", async () => {
  const sent = [];
  const channel = createChannel({ peer: "machine", connected: () => true, send: (m) => sent.push(m), environment: LAPTOP });
  void channel.ask({ tool: "clock", descriptorId: "clock-tool", boundsEcho: {}, environment: VM });
  assert.equal(JSON.parse(sent[0]).environment, LAPTOP, "a call cannot assert an identity the channel does not hold");
});
