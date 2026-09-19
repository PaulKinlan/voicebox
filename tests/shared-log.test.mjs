// tests/shared-log.test.mjs — the seen-mark seam, the liveness column, and the no-global-order rule.
//
//   node --test tests/shared-log.test.mjs
//
// These are the SHAPE's tests, and they exist before any writer does — which is the ordering the
// bead asks for: a shape that changes after the first writer exists is a migration. Nothing here
// needs a browser, a worker or a file: the log is pure data and so is everything derived from it.
import test from "node:test";
import assert from "node:assert/strict";
import {
  LIVENESS,
  activityEntry,
  activityAt,
  land,
  markOf,
  marksToClaim,
  presenceAt,
  presenceEntry,
  seeEntry,
  unseenBy,
} from "../core/shared-log.ts";

const T0 = Date.parse("2026-09-19T20:00:00Z");
const at = (offsetMs) => new Date(T0 + offsetMs).toISOString();
const now = (offsetMs) => new Date(T0 + offsetMs);

/** An act entry, which is what a reader catches up on: the shared facts are not work. */
const act = (instance, seq, atIso, target = "assets/x") => ({
  kind: "act",
  seq,
  instance,
  project: "atlas@browser",
  root: "v1/projects/atlas",
  turn: null,
  at: atIso,
  act: { kind: "write", target },
  decision: "allow",
  rule: "writes-inside",
  result: "ok",
  observed: { exists: true, bytes: 1 },
});

const base = (instance, seq, atIso) => ({
  seq,
  instance,
  project: "atlas@browser",
  root: "v1/projects/atlas",
  turn: null,
  at: atIso,
});

test("the entry shape carries all four kinds, and each constructor produces its own", () => {
  const presence = presenceEntry(base("phone", 1, at(0)), "ready", "on the walk");
  const activity = activityEntry(base("phone", 2, at(1000)), "editing the parser", "src/parser.ts");
  const see = seeEntry(base("phone", 3, at(2000)), "laptop", 7);

  assert.deepEqual(presence, { ...base("phone", 1, at(0)), kind: "presence", presence: { state: "ready", note: "on the walk" } });
  assert.deepEqual(activity, { ...base("phone", 2, at(1000)), kind: "activity", activity: { doing: "editing the parser", target: "src/parser.ts" } });
  assert.deepEqual(see, { ...base("phone", 3, at(2000)), kind: "see", see: { of: "laptop", upto: 7 } });
  // An act entry is built by makeEntry, which tags it; the other kinds never carry act fields.
  const work = act("phone", 4, at(3000));
  assert.equal(work.kind, "act");
  assert.deepEqual(act("phone", 4, at(3000)).act, { kind: "write", target: "assets/x" });
});

// THE PAIR THAT WOULD COLLAPSE: "it has never looked" versus "it looked and saw nothing".
test("'never looked' and 'looked and saw nothing' are different answers", () => {
  const work = [act("laptop", 1, at(0)), act("laptop", 2, at(1000))];

  // (a) laptop has never run: we have NO knowledge of what it knew.
  assert.equal(markOf(work, "laptop"), null, "an agent that never looked reported a mark");
  assert.equal(unseenBy(work, "laptop"), null, "an unknown reader was answered as if it had read");

  // (b) laptop looked and there was nothing to fold: that is a mark of zero, and it is KNOWLEDGE.
  const looked = [...work, seeEntry(base("laptop", 1, at(2000)), "phone", 0)];
  const mark = markOf(looked, "laptop");
  assert.ok(mark instanceof Map, "an agent that looked reported no mark");
  assert.deepEqual([...mark.entries()], [["phone", 0]], "the mark does not record the position it reached");
  assert.deepEqual(unseenBy(looked, "laptop"), [], "an agent that looked and saw nothing owes itself an unseen list");

  assert.notDeepEqual(unseenBy(work, "laptop"), unseenBy(looked, "laptop"), "the two answers collapsed");
});

test("a mark is a position PER WRITER, and a late or stale mark never moves a reader backwards", () => {
  const entries = [
    act("phone", 1, at(0)),
    act("laptop", 1, at(500)),
    act("phone", 2, at(1000)),
    act("laptop", 2, at(1500)),
    act("phone", 3, at(2000)),
    // A mark taken later, and then an older one arriving late from another machine. Convergence is
    // the furthest position each has reached, so the stale one must change nothing.
    seeEntry(base("phone", 4, at(3000)), "laptop", 2),
    seeEntry(base("phone", 5, at(2500)), "laptop", 1),
  ];
  assert.deepEqual([...markOf(entries, "phone").entries()], [["laptop", 2]]);

  // What phone has not seen is grouped per writer, each group in THAT writer's own order — the
  // merged list is never presented as one sequence, because two writers have no shared sequence.
  const unseen = unseenBy(entries, "phone");
  assert.deepEqual(unseen, [], "phone had already seen laptop up to 2");

  const early = unseenBy(entries.slice(0, 4), "phone");
  assert.equal(early, null, "phone had not looked yet at that point");
  const withMark = unseenBy([...entries.slice(0, 4), seeEntry(base("phone", 1, at(2500)), "laptop", 1)], "phone");
  assert.deepEqual(withMark.map((group) => group.writer), ["laptop"]);
  assert.deepEqual(withMark[0].entries.map((e) => e.seq), [2], "a group was not ordered by its own writer's seq");
  // And `see` entries are coordination, not work: a reader never "catches up" on marks.
  const withCoordination = unseenBy(
    [
      act("laptop", 1, at(0)),
      seeEntry(base("laptop", 2, at(1000)), "phone", 1),
      presenceEntry(base("laptop", 3, at(1100)), "ready"),
      activityEntry(base("laptop", 4, at(1200)), "writing assets"),
      seeEntry(base("phone", 1, at(1500)), "laptop", 0),
    ],
    "phone",
  );
  // Only work is offered as unseen: state is answered by the state views, at read time.
  assert.deepEqual(withCoordination.length, 1);
  assert.deepEqual(
    withCoordination[0].entries.map((e) => e.kind),
    ["act"],
    "a mark, a beat or an activity claim was offered as work to catch up on",
  );
});

test("no function returns a globally ordered list, however the input is interleaved", () => {
  const entries = [
    act("laptop", 1, at(900)),
    act("phone", 1, at(0)),
    act("laptop", 2, at(300)),
    act("phone", 2, at(1200)),
    seeEntry(base("phone", 3, at(2000)), "laptop", 0),
  ];
  const unseen = unseenBy(entries, "phone");
  // One group per writer, and no comparison between writers' seqs anywhere in the result.
  assert.deepEqual(unseen.map((g) => g.writer), ["laptop"]);
  assert.deepEqual(unseen[0].entries.map((e) => [e.instance, e.seq]), [["laptop", 1], ["laptop", 2]]);
  const everyGroupIsSingleWriter = unseen.every((group) => new Set(group.entries.map((e) => e.instance)).size === 1);
  assert.equal(everyGroupIsSingleWriter, true, "a group mixed two writers, which is where a global order sneaks in");
});

// THE PAIR THAT WOULD COLLAPSE: "never seen" versus "was here and went quiet".
test("liveness is measured at read time: the same bytes age from ready to elsewhere to unreachable", () => {
  const entries = [presenceEntry(base("phone", 1, at(0)), "ready")];

  const fresh = presenceAt(entries, now(1000)).get("phone");
  const middling = presenceAt(entries, now(LIVENESS.readyWithinMs + 1)).get("phone");
  const gone = presenceAt(entries, now(LIVENESS.elsewhereWithinMs + 1)).get("phone");

  assert.equal(fresh.state, "ready");
  assert.equal(middling.state, "elsewhere", "a stale beat still read as ready");
  assert.equal(gone.state, "unreachable", "an agent that stopped answering read as present");
  // The claim it made is kept beside the measurement, because "it said ready and then vanished" is a fact.
  assert.equal(gone.reported, "ready");
  assert.equal(gone.lastBeat, at(0));
  assert.equal(gone.ageMs, LIVENESS.elsewhereWithinMs + 1);

  // An agent that has never been seen is ABSENT, not unreachable: we know nothing about it, and
  // "unreachable" would be a claim about an agent that may not exist.
  assert.equal(presenceAt(entries, now(0)).has("laptop"), false, "an unseen agent was reported as unreachable");
});

test("activity is what an agent SAID it was doing, and a stale claim does not read as current work", () => {
  const entries = [
    activityEntry(base("phone", 1, at(0)), "editing the parser", "src/parser.ts"),
    activityEntry(base("laptop", 1, at(0)), "reading the tier table"),
  ];
  const fresh = activityAt(entries, now(1000));
  assert.equal(fresh.get("phone").doing, "editing the parser");
  assert.equal(fresh.get("phone").current, true);
  assert.equal(fresh.get("laptop").current, true);

  const later = activityAt(entries, now(LIVENESS.readyWithinMs + 1));
  assert.equal(later.get("phone").doing, "editing the parser", "the claim is kept");
  assert.equal(later.get("phone").current, false, "a stale claim read as current work");

  // A change of activity restarts `since`; repeating the same claim does not.
  const repeated = activityAt([...entries, activityEntry(base("phone", 2, at(2000)), "editing the parser", "src/parser.ts")], now(2500));
  assert.equal(repeated.get("phone").since, at(0), "a repeated claim reset the start time");
  const changed = activityAt([...entries, activityEntry(base("phone", 2, at(2000)), "running the tests")], now(2500));
  assert.equal(changed.get("phone").since, at(2000));
});

test("the landing step answers all four questions for a viewer, per writer", () => {
  const entries = [
    act("laptop", 1, at(0), "assets/laptop.txt"),
    presenceEntry(base("laptop", 2, at(0)), "ready"),
    activityEntry(base("laptop", 3, at(0)), "writing assets", "assets/laptop.txt"),
    seeEntry(base("laptop", 4, at(1000)), "phone", 2),
    act("phone", 1, at(1000), "assets/phone.txt"),
    act("phone", 2, at(1500), "assets/phone-2.txt"),
    presenceEntry(base("phone", 3, at(1500)), "ready"),
  ];

  const view = land(entries, "phone", now(1600));
  assert.equal(view.viewer, "phone");
  // phone has acted but never looked, so what IT owes itself is unknown, not "nothing".
  assert.equal(view.unseen, null, "a viewer that never looked was told it had nothing to catch up on");
  assert.deepEqual(view.agents.map((a) => [a.instance, a.state]), [["laptop", "ready"]]);
  assert.deepEqual(view.doing.map((d) => [d.instance, d.doing]), [["laptop", "writing assets"]]);
  // "What did it know?" — answered live, before any merge, from the log alone.
  assert.deepEqual(view.knew, [{ instance: "laptop", mark: new Map([["phone", 2]]) }]);
  // Once phone has looked, what it owes itself is laptop's work entries, grouped per writer — never
  // the two writers interleaved.
  const looked = land([...entries, seeEntry(base("phone", 4, at(1600)), "laptop", 0)], "phone", now(1700));
  assert.deepEqual(looked.unseen.map((g) => [g.writer, g.entries.map((e) => e.seq)]), [["laptop", [1]]]);

  // An agent that never looked reports `null` here too, not an empty mark.
  const neverLooked = land([act("laptop", 1, at(0))], "phone", now(100));
  assert.deepEqual(neverLooked.knew, [{ instance: "laptop", mark: null }]);

  // An agent we have only heard activity from appears in `doing` and NOT in `agents`: knowing what
  // someone says they are doing is not the same as knowing they are here.
  const onlyActivity = land([activityEntry(base("laptop", 1, at(0)), "writing assets")], "phone", now(100));
  assert.deepEqual(onlyActivity.agents, []);
  assert.deepEqual(onlyActivity.doing.map((d) => d.instance), ["laptop"]);
});

test("marks to claim advance per writer, exclude the viewer's own work, and never chase a mark", () => {
  const entries = [
    act("phone", 1, at(0)),
    act("laptop", 1, at(100)),
    act("laptop", 2, at(200)),
    seeEntry(base("laptop", 3, at(300)), "phone", 1),
    seeEntry(base("phone", 2, at(400)), "laptop", 1),
  ];
  // phone has already claimed laptop up to 1; only 2 is new; its own work is not something it reads.
  assert.deepEqual(marksToClaim(entries, "phone"), [{ of: "laptop", upto: 2 }]);
  // With nothing new, there is nothing to claim — reading does not grow the log on every look.
  const upToDate = [...entries, seeEntry(base("phone", 3, at(500)), "laptop", 2)];
  assert.deepEqual(marksToClaim(upToDate, "phone"), []);
  // A brand-new reader claims everything it folded, and nothing about itself.
  assert.deepEqual(marksToClaim(entries, "tablet"), [
    { of: "laptop", upto: 2 },
    { of: "phone", upto: 1 },
  ]);
});
