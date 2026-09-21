// tests/tier-absent-capability.test.mjs — bead voicebox-beads-ho9, the tier-table half.
//
// WHAT THIS IS: `decide(report, act)` in core/tier-table.ts refuses an act BY NAME — `absent-capability`,
// with the axis and a remedy — when the environment's own measured BoundaryReport does not provide the
// boundary the act assumes.
//
// THE FIXTURES COME FROM THE RECEIPT, NOT FROM THE DESIGN. Every value below is copied from
// `~/journal/reports/sandbox-survey-20260920/probe-bwrap.json` (measured 2026-09-20T14:52:32Z, a bwrap
// fence), and each positive fixture flips ONE measured field so it fails for a reason a real fence could
// produce rather than a reason invented here:
//
//   · the bwrap receipt is ALREADY the deny-processes positive: the probe ran inside the fence and its
//     tools.sh.value / tools.node.value are present — which is the earlier finding in data rather than prose
//     (bwrap bounds which binary runs, never what it can do);
//   · the network positive flips outboundTcp443IpLiteral from {ok:false, error:"timed out"} to {ok:true};
//   · the files positive uses the receipt's own filesystem.mountsReadable.value === true.
//
// AND THE ONE THAT MATTERS MOST: a report whose axis IS denied must produce NO REFUSAL AT ALL. A refusal
// that fires on everything is a slogan, and this fleet has spent two days removing exactly those.
//
//   node --test tests/tier-absent-capability.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { decide, RULES } from "../core/tier-table.ts";

/** The measured report, trimmed to the fields that decide — values verbatim from probe-bwrap.json. */
const MEASURED = {
  filesystem: {
    home: "/home/voice",
    pathEntries: ["/usr/bin"],
    dirs: {
      "/": { listable: true, writable: { value: false } },
      "/home/voice": { listable: true, writable: { value: true } },
      "/root": { listable: false, error: "ENOENT", writable: { value: false, error: "ENOENT" } },
    },
    canReadPasswd: { value: true },
    mountsReadable: { value: true, lines: 22 },
  },
  tools: {
    sh: { value: "GNU bash, version 5.3.15(1)-release (x86_64-pc-linux-gnu)" },
    node: { value: "v26.8.1" },
    bwrap: { value: "bubblewrap 0.12.0" },
    pip: { error: "pip: not present" },
  },
  network: {
    loopback: { reachable: true, note: "ECONNREFUSED — loopback UP, nothing on port 1 (normal)" },
    outboundTcp443IpLiteral: { ok: false, error: "timed out after 4000ms", ms: 4002 },
    outboundTcp80ByName: { ok: false, error: "EAI_AGAIN", ms: 5 },
    cloudMetadataService: { ok: false, error: "timed out after 1500ms", ms: 1501 },
  },
};

/** A deep copy so one test's flip cannot leak into another's fixture — the fixture IS the experiment. */
const fixture = (mutate = () => {}) => {
  const copy = JSON.parse(JSON.stringify(MEASURED));
  mutate(copy);
  return copy;
};

/** The same report with every axis DENIED — the negative control, and the shape a real fence would produce. */
const ALL_DENIED = fixture((r) => {
  for (const name of Object.keys(r.tools)) r.tools[name] = { error: `${name}: not present` };
  r.filesystem.mountsReadable = { value: false, lines: 22 };
  r.filesystem.canReadPasswd = { value: false };
  // BOTH halves pinned: a fixture that omits `writable` cannot tell a refusal that quotes the field which
  // fired from one that quotes a neighbour — which is the defect this pin exists to catch.
  r.filesystem.dirs = {
    "/": { listable: false, writable: { value: false } },
    "/home/voice": { listable: false, writable: { value: false } },
  };
  for (const field of Object.keys(r.network)) r.network[field] = { ok: false, error: "ECONNREFUSED" };
});

const execAct = { kind: "exec", target: "/work/run.sh", tool: "sh" };
const readAct = { kind: "read", target: "/work/notes.txt" };
const netAct = { kind: "network", target: "https://example.test" };

test("deny-processes: a binary that RAN under a process-deny fence is the refusal, with the axis and the remedy", () => {
  // THE POSITIVE FIXTURE IS THE REAL RECEIPT: the probe ran inside bwrap and its own report shows the
  // interpreter present. Nothing is flipped — this is what the measured fence actually looks like.
  const verdict = decide(fixture(), execAct);
  assert.equal(verdict.ok, false, "an exec act under a fence whose report shows a process mechanism must be refused");
  assert.equal(verdict.refused, "absent-capability", "the refusal is named, not a bare no");
  assert.equal(verdict.axis, "deny-processes", "and it names the axis, because the remedy depends on which one failed");
  assert.match(verdict.why, /tools\.(sh|node|bwrap)\.value/, "the why QUOTES the measured field and value");
  assert.match(verdict.why, /GNU bash|v26\.8\.1|bubblewrap/, "…the value itself, not a summary of it");
  assert.match(verdict.remedy, /deny the interpreter/i, "and the remedy says what would fix it");
});

test("deny-processes: a spawn where NO process mechanism exists refuses differently — and says where to run it", () => {
  const verdict = decide(ALL_DENIED, execAct);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.axis, "deny-processes");
  assert.match(verdict.why, /no process mechanism in this environment/i, "absence and contradiction are different sentences");
  assert.match(verdict.remedy, /run it where the report shows exec/i, "the remedy points at an environment that CAN");
});

test("passthrough-network: a flipped outbound that REACHED is refused, axis and remedy named", () => {
  const verdict = decide(fixture((r) => { r.network.outboundTcp443IpLiteral = { ok: true, ms: 120 }; }), netAct);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.refused, "absent-capability");
  assert.equal(verdict.axis, "passthrough-network");
  assert.match(verdict.why, /network\.outboundTcp443IpLiteral/, "the field is quoted, so the receipt can be re-read");
  assert.match(verdict.remedy, /egress/i, "the remedy is an egress policy, not a stronger word");
});

test("passthrough-network: the METADATA SERVICE answering is its own sentence, because credentials may be reachable", () => {
  const verdict = decide(fixture((r) => { r.network.cloudMetadataService = { ok: true, ms: 4 }; }), netAct);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.axis, "passthrough-network");
  assert.match(verdict.why, /metadata service answered/i);
  assert.match(verdict.why, /credentials may be reachable/i);
});

test("deny-files: a readable home (the receipt's own mountsReadable) is refused, and /etc/passwd is named when it was readable", () => {
  const verdict = decide(fixture(), readAct);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.axis, "deny-files");
  assert.match(verdict.why, /filesystem\.mountsReadable|listable/, "the measured field is quoted");
  assert.match(verdict.why, /passwd was readable/, "and the credential-adjacent reading is said out loud");
  assert.match(verdict.remedy, /scope the root/i);
});

test("NEGATIVE CONTROL: when the axis IS denied, no CONTRADICTION refusal fires — a gate, not a slogan", () => {
  // This is the test the handover called the one that matters, and writing it corrected MY OWN conflation:
  // "axis denied ⇒ no refusal at all" cannot hold for exec, because an environment with no process
  // mechanism genuinely cannot run a spawn — that refusal is the bead's own DONE criterion ("a fenced
  // environment without exec refuses a spawn with the named refusal and remedy"), and it is the ABSENCE
  // sentence, not an accusation.
  //
  // So the property asserted is sharper than "nothing is refused": on an axis that IS denied, the refusal
  // may only ever be the ABSENCE sentence — never the contradiction one. That is what makes this a gate:
  // it refuses for the reason it measured, and a report where the fence held must never be read as a fence
  // that leaked.
  // The accusers, precisely: "found the opposite" (files), "RAN:" (processes), "REACHED out" (network).
  // NOT "claims … and its own probe could not tell", which is the UNVERIFIED sentence — a false positive
  // here would have hidden exactly the distinction the polarity decision turns on.
  const CONTRADICTION = /found the opposite|RAN:|REACHED out/i;

  // FILES still verify the deny: an unreadable home and a false mount table are a satisfied claim.
  const readVerdict = decide(ALL_DENIED, readAct);
  assert.equal(readVerdict.ok, true, `a read act on a denied file axis must pass, got ${JSON.stringify(readVerdict)}`);
  assert.ok(typeof readVerdict.why === "string" && readVerdict.why.length > 10, "the pass says what it saw");

  // NETWORK inverts (coord's polarity decision, 2026-09-21): a DEAD egress is UNMEASURED-BY-BROKENNESS, not
  // a bounded network, so it refuses too — and it must refuse with THAT sentence, never by accusing a fence
  // that held.
  const netVerdict = decide(ALL_DENIED, netAct);
  assert.equal(netVerdict.ok, false, `a dead egress must not be read as a bounded network: ${JSON.stringify(netVerdict)}`);
  assert.equal(netVerdict.axis, "passthrough-network");
  assert.ok(!CONTRADICTION.test(netVerdict.why), `the refusal must not accuse a fence that held: ${netVerdict.why}`);
  assert.match(netVerdict.why, /UNVERIFIED|could not tell a closed door from a broken resolver/i, "it says the claim is unverified rather than satisfied");
  assert.match(netVerdict.remedy, /IP-literal control/i, "and the remedy names what would make it verifiable");

  const execVerdict = decide(ALL_DENIED, execAct);
  assert.equal(execVerdict.ok, false, "a spawn with nothing to spawn is refused");
  assert.ok(
    !CONTRADICTION.test(execVerdict.why),
    `the refusal must not accuse a fence that held: ${execVerdict.why}`,
  );
  assert.match(execVerdict.remedy, /run it where the report shows exec/i, "and the remedy points at an environment that CAN");
});

test("UNMEASURED is not a pass either: a report that cannot answer refuses in its own words", () => {
  for (const [label, act] of [["exec", execAct], ["read", readAct], ["network", netAct]]) {
    const verdict = decide({}, act);
    assert.equal(verdict.ok, false, `an unmeasured boundary must not read as a permission (${label})`);
    assert.equal(verdict.refused, "absent-capability");
    assert.match(verdict.why, /unmeasured/i, "the refusal distinguishes 'we did not look' from 'we looked and it was denied'");
  }
});

test("an act kind with no axis mapped is a gap in the TABLE, named as one", () => {
  const verdict = decide(ALL_DENIED, { kind: "external", target: "" });
  // `external` IS mapped — to passthrough-network — so it inherits the polarity decision: on this probe
  // family a network-shaped act cannot be verified, and it refuses with the UNVERIFIED sentence rather than
  // falling through the gap or passing on a dead egress.
  assert.equal(verdict.ok, false, "an external act leans on the network axis, which this probe family cannot verify");
  assert.equal(verdict.axis, "passthrough-network", "and it says the mapping is real rather than falling through to the gap");
  assert.match(verdict.why, /UNVERIFIED|could not tell a closed door/i, "refused for the measured reason, not a table gap");
  const gap = decide(ALL_DENIED, { kind: "teleport", target: "" });
  assert.equal(gap.ok, false);
  assert.match(gap.why, /no boundary axis is mapped/i, "an unmapped kind is named as a table gap, not waved through");
  assert.match(gap.remedy, /extend AXIS_FOR_ACT/i, "with the file to extend, so the fix is one hop away");
});

test("THE TWO HALVES SPEAK THE SAME IDIOM: the table's `absent-capability` rule and decide() agree, and decide() supplies the reason the rule cannot", () => {
  // core/tier-table.ts has said `{ id: "absent-capability", why: "this placement has no mechanism for it" }`
  // for a while — a RULE that fires for an act kind with no enforcement mechanism (`!ENFORCEABLE.has(kind)`,
  // which today is exec and eval). What it cannot say is WHICH axis failed and WHAT the environment measured,
  // and that is exactly what the bead asks for: not a bare no.
  //
  // This test is the seam between them: the rule decides WHETHER, decide() decides WHICH and WHY, and they
  // must agree on the id so a reader meets one word in both places.
  const rule = RULES.find((r) => r.id === "absent-capability");
  assert.ok(rule, "the table still carries the rule this refusal is the explanation for");
  assert.equal(rule.tier, 0, "and it is still tier 0 — a refusal, not a prompt");

  const ctx = { root: "/work" };
  for (const kind of ["exec", "eval"]) {
    const act = { kind, target: "/work/x" };
    assert.equal(rule.matches(act, ctx), true, `the rule refuses ${kind}: no enforcement mechanism exists in this placement`);
    const verdict = decide(ALL_DENIED, act);
    assert.equal(verdict.ok, false, `and decide() must agree about ${kind}`);
    assert.equal(verdict.refused, rule.id, "the id is the TABLE's word, so both speak the same one");
    assert.ok(verdict.axis && verdict.remedy, `and decide() adds the axis and the remedy the rule cannot know (${kind})`);
  }

  // The rule's own sentence is generic by design ("no mechanism for it"); decide()'s is the measured one.
  // Both are true, and the bead's requirement is that the reader gets the second.
  const explained = decide(ALL_DENIED, { kind: "exec", target: "/work/x" });
  assert.notEqual(explained.why, rule.why, "decide() must not simply echo the generic sentence — it has the measurement to do better");
  assert.match(explained.why, /no process mechanism|unmeasured/i, "it names what was looked at");
});

test("FIX 1: the evidence line quotes the field that FIRED, not a neighbour that happens to be false", () => {
  // Driven by the review, and it is this bead's own defect class inside the refusal: with mounts and the
  // listing half denied but the WRITABLE half true, CONTRADICTION fired (the two halves are OR'd) and the
  // why-string printed `listable = true` — a measurement that was false.
  const verdict = decide(
    fixture((r) => {
      r.filesystem.mountsReadable = { value: false, lines: 22 };
      r.filesystem.canReadPasswd = { value: false };
      r.filesystem.dirs["/home/voice"] = { listable: false, writable: { value: true } };
    }),
    readAct,
  );
  assert.equal(verdict.ok, false, "a writable home is a readable home for this purpose");
  assert.match(verdict.why, /writable\.value = true/, "the fired field is the one quoted");
  assert.ok(!/listable = true/.test(verdict.why), `and the false one is not: ${verdict.why}`);
  assert.match(verdict.why, /the writable half, not the listing half/, "the distinction is said out loud, because it is the whole fix");
});

test("FIX 2a: an unmeasured SUB-FIELD refuses, even when the rest of the axis was measured", () => {
  const verdict = decide(
    fixture((r) => {
      r.filesystem.mountsReadable = { value: false, lines: 22 };
      r.filesystem.dirs["/home/voice"] = { listable: false, writable: { value: false } };
      delete r.filesystem.canReadPasswd; // the probe did not look — and "did not look" is not "denied"
    }),
    readAct,
  );
  assert.equal(verdict.ok, false, `a report missing canReadPasswd must not pass: ${JSON.stringify(verdict)}`);
  assert.match(verdict.why, /filesystem\.canReadPasswd/, "the missing field is named");
  assert.match(verdict.why, /unmeasured/i, "and the refusal says which kind of gap it is");
});

test("FIX 2b: an ABSENT mount measurement refuses rather than being read as a closed mount table", () => {
  const verdict = decide(
    fixture((r) => {
      delete r.filesystem.mountsReadable;
      r.filesystem.dirs["/home/voice"] = { listable: false, writable: { value: false } };
      r.filesystem.canReadPasswd = { value: false };
    }),
    readAct,
  );
  assert.equal(verdict.ok, false, `an unmeasured mount table must not pass: ${JSON.stringify(verdict)}`);
  assert.match(verdict.why, /filesystem\.mountsReadable/, "named");
});

test("FIX 3: a DNS-broken egress is refused as BROKENNESS, with the field evidence and the fence that proved it", () => {
  // The measured case: the retained fence's DNS was broken at probe time (EAI_AGAIN) so nothing was reached,
  // and the same fence reached out on port 80 BY NAME once DNS worked. "Did not reach" is not "denied".
  const verdict = decide(
    fixture((r) => {
      r.network.outboundTcp443IpLiteral = { ok: false, error: "timed out after 4000ms", ms: 4002 };
      r.network.outboundTcp80ByName = { ok: false, error: "EAI_AGAIN", ms: 5 };
      r.network.cloudMetadataService = { ok: false, error: "EAI_AGAIN", ms: 3 };
    }),
    netAct,
  );
  assert.equal(verdict.ok, false);
  assert.equal(verdict.axis, "passthrough-network");
  assert.match(verdict.why, /EAI_AGAIN/, "the evidence quotes the measured errors");
  assert.match(verdict.why, /name resolution, which is brokenness, not a fence/i, "and names what kind of failure it is");
  assert.match(verdict.why, /reached out by name once DNS worked/i, "citing the fence that proved the difference");
  assert.ok(!/REACHED out/.test(verdict.why), "this is not the contradiction sentence");
});

test("FIX 2c (processes): a tool list that did not look for the mechanisms is unmeasured, not denial", () => {
  const verdict = decide({ tools: { curl: { value: "curl 8.1" } } }, execAct);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.axis, "deny-processes");
  assert.match(verdict.why, /none of the mechanisms this axis depends on/, "the gap is named as a gap in the LOOKING");
});
