// core/shared-log.ts — the SHARED side of the log: presence, activity, and seen-marks.
//
// N19 settled the model and k3's §9 turned it into a specification: several named agents work on one
// project at the same time, and what they share is STATE — who is here, what each is doing, and what
// each has READ — while what they merge is ARTEFACTS. "How do we merge the log?" has no answer
// because the log never needs merging: nothing in it is overwritten. What this file adds to the
// audit is that other half of the medium.
//
// THE ENTRY SHAPE CHANGED FIRST, and deliberately before anything wrote one. A shared fact is an
// appendix to the same per-root log rather than a second file, because "the global state is the log"
// (N19) stops being true the moment there are two logs. So `LogEntry` carries a `kind`: an `act`
// with a tier decision and an observed result, or one of the three shared facts.
//
// THE NO-TOTAL-ORDER RULE HAS TO SURVIVE THIS FILE, and it is the constraint most easily broken by
// accident: a seen-mark that said "I have read up to entry 412 of the merged log" would reintroduce
// exactly the global order the local design refuses, because the merge has no such sequence to
// point at. So a mark is a POSITION PER WRITER — the version-vector shape two machines with no
// shared clock can actually converge on — and every derived view in this file is expressed per
// writer. Nothing here ever returns a flat, interleaved, globally-ordered list.

export type PresenceState = "ready" | "elsewhere" | "unreachable";

/**
 * An agent is a NAMED instance, not a directory: two agents in one checkout are two people (§9's
 * actor model). The session is carried because identity is claimed against it — which is what makes
 * "two placements of the same agent" distinguishable in a log that only records instance names.
 */
export interface Actor {
  name?: string;
  harness?: string | null;
  session?: string | null;
  cwd?: string | null;
}

export interface PresenceFact {
  state: PresenceState;
  note?: string;
}

export interface ActivityFact {
  doing: string;
  target?: string;
}

/** A POSITION PER WRITER: `of` wrote that many entries when this mark was taken. */
export interface SeeFact {
  of: string;
  upto: number;
}

/**
 * Liveness is MEASURED AT READ TIME, never stored (isocan's bench: "measured every time you look").
 * Storing "ready" is how a log comes to show an agent as present an hour after it stopped, so what
 * is stored is a beat and what is derived is a state. The two windows are data because they are a
 * policy, and a policy in a comment is a policy nobody can test.
 */
export const LIVENESS = {
  /** A beat this recent is `ready` — the agent answered on its last turn. */
  readyWithinMs: 30_000,
  /** Older than `readyWithinMs` but within this, the agent is elsewhere; past it, unreachable. */
  elsewhereWithinMs: 5 * 60_000,
};

/** The fields every entry in the log carries, whatever its kind. */
export interface LogEntryBase {
  seq: number;          // per-instance monotonic, from 1 — the only ordering that may be claimed
  instance: string;     // the writer: one agent instance in one placement
  actor?: Actor;        // who that instance is, in names a person can read
  project: string;      // "atlas@phone"
  root: string;         // "v1/projects/atlas"
  turn: string | null;
  at: string;           // ISO wall clock — a HINT, never an ordering key
  kind: "act" | "presence" | "activity" | "see" | "task";
  presence?: PresenceFact;
  activity?: ActivityFact;
  see?: SeeFact;
}

// ---------------------------------------------------------------- the fold: what did it know?

/**
 * What `instance` knew, folded from its own marks.
 *
 * `null` means **this agent has never looked** — we have no knowledge of what it knew, which is a
 * different fact from "it looked and saw nothing" (`new Map()`). Collapsing those two is the
 * expensive mistake here: an agent that has never run would read as an agent that knows nothing,
 * and a reader would then think everything is new to it when the truth is that it does not exist yet.
 */
export function markOf(entries: LogEntryBase[], instance: string): Map<string, number> | null {
  let seen: Map<string, number> | null = null;
  for (const entry of entries) {
    if (entry.kind !== "see" || entry.instance !== instance || !entry.see) continue;
    seen ??= new Map();
    // The position is RECORDED as claimed, including a zero: "I looked and phone had written
    // nothing" is a position, and a fold that dropped it would answer the same question with a
    // default rather than with what the agent said.
    const held = seen.has(entry.see.of) ? (seen.get(entry.see.of) as number) : -1;
    // Converging, not last-write-wins: two machines racing on marks must land on the furthest
    // position each has reached, and a stale mark must never move a reader backwards.
    if (entry.see.upto > held) seen.set(entry.see.of, entry.see.upto);
  }
  return seen;
}

export interface UnseenGroup {
  writer: string;
  entries: LogEntryBase[]; // ordered by THAT writer's seq, never against another's
}

/**
 * What `instance` has not seen, grouped per writer.
 *
 * `null` is not `[]`: with no marks at all the honest answer is "unknown", not "everything is new"
 * and not "nothing is new". The caller decides how to say that; this function refuses to guess.
 */
export function unseenBy(entries: LogEntryBase[], instance: string): UnseenGroup[] | null {
  const mark = markOf(entries, instance);
  if (mark === null) return null;

  const groups = new Map<string, LogEntryBase[]>();
  for (const entry of entries) {
    if (entry.instance === instance) continue; // an agent does not owe itself a mark
    if (entry.seq <= (mark.get(entry.instance) ?? 0)) continue;
    // ONLY WORK IS "UNSEEN". Presence, activity and marks are STATE: they are answered by
    // `presenceAt` / `activityAt` from the whole log, at read time, and offering them here would
    // tell a reader it has "12 unseen beats" — noise, and a worse answer than the state views give.
    // The mark still advances over them (a mark is a position in that writer's sequence, whatever
    // the kind), so this filter changes what is *reported*, never what is *folded*.
    if (entry.kind !== "act") continue;
    const group = groups.get(entry.instance) ?? [];
    group.push(entry);
    groups.set(entry.instance, group);
  }

  return [...groups.entries()]
    .map(([writer, group]) => ({ writer, entries: [...group].sort((a, b) => a.seq - b.seq) }))
    .sort((a, b) => a.writer.localeCompare(b.writer));
}

// ---------------------------------------------------------------- presence and activity

export interface AgentView {
  instance: string;
  actor?: Actor;
  /** The state as MEASURED now: the last beat, aged against `LIVENESS`. */
  state: PresenceState;
  /** What the agent last said about itself, kept because "it said ready and then vanished" is a fact. */
  reported: PresenceState;
  since: string;         // when the reported state was first claimed
  lastBeat: string;      // when the agent last said anything at all
  ageMs: number;
  /** The agent's own age, so a reader can see staleness instead of inferring it. */
  note?: string;
}

function ageOf(iso: string, now: Date): number {
  const then = Date.parse(iso);
  return Number.isNaN(then) ? Number.POSITIVE_INFINITY : Math.max(0, now.getTime() - then);
}

function measured(reported: PresenceState, ageMs: number): PresenceState {
  if (reported === "unreachable") return "unreachable";
  if (ageMs > LIVENESS.elsewhereWithinMs) return "unreachable";
  if (ageMs > LIVENESS.readyWithinMs) return reported === "ready" ? "elsewhere" : reported;
  return reported;
}

/**
 * Who is here, as of `now`.
 *
 * An agent with no presence entry is ABSENT FROM THE MAP — not `unreachable`. "We have never seen it"
 * and "it was here and stopped answering" are different facts, and the second is the only one a
 * reader can act on.
 */
export function presenceAt(entries: LogEntryBase[], now: Date): Map<string, AgentView> {
  const agents = new Map<string, AgentView>();
  for (const entry of entries) {
    if (entry.kind !== "presence" || !entry.presence) continue;
    const previous = agents.get(entry.instance);
    const ageMs = ageOf(entry.at, now);
    agents.set(entry.instance, {
      instance: entry.instance,
      actor: entry.actor ?? previous?.actor,
      reported: entry.presence.state,
      state: measured(entry.presence.state, ageMs),
      since: previous && previous.reported === entry.presence.state ? previous.since : entry.at,
      lastBeat: entry.at,
      ageMs,
      note: entry.presence.note,
    });
  }
  return agents;
}

export interface DoingView {
  instance: string;
  doing: string;
  target?: string;
  since: string;
  at: string;
  /** False once the beat is stale: a stale "editing the parser" is a claim about the past, not now. */
  current: boolean;
}

/** What each agent says it is doing — with freshness, so a stale claim cannot read as current work. */
export function activityAt(entries: LogEntryBase[], now: Date): Map<string, DoingView> {
  const doing = new Map<string, DoingView>();
  for (const entry of entries) {
    if (entry.kind !== "activity" || !entry.activity) continue;
    const previous = doing.get(entry.instance);
    doing.set(entry.instance, {
      instance: entry.instance,
      doing: entry.activity.doing,
      target: entry.activity.target,
      since: previous && previous.doing === entry.activity.doing && previous.target === entry.activity.target ? previous.since : entry.at,
      at: entry.at,
      current: ageOf(entry.at, now) <= LIVENESS.readyWithinMs,
    });
  }
  return doing;
}

// ---------------------------------------------------------------- the landing step

export interface LandingView {
  viewer: string;
  at: string;
  agents: AgentView[];      // every other agent, presence measured now
  doing: DoingView[];       // every other agent, with freshness
  /** What each other agent knew, as a mark per writer — `null` for an agent that has never looked. */
  knew: { instance: string; mark: Map<string, number> | null }[];
  /** What the viewer has not seen, per writer. `null` = the viewer has never looked. */
  unseen: UnseenGroup[] | null;
}

/**
 * The LANDING STEP (N19, ds-flash-2): what a session sees when it looks — the live answer to "who is
 * here, what are they doing, and what have they read", computed from the log rather than reconciled
 * in a background pass. This is the function the "merge stops being the coordination channel" line
 * means, and it is why it returns per-writer groups and never a global order.
 */
export function land(entries: LogEntryBase[], viewer: string, now: Date): LandingView {
  const presence = presenceAt(entries, now);
  const doing = activityAt(entries, now);
  const others = [...new Set(entries.map((e) => e.instance))].filter((i) => i !== viewer).sort();

  return {
    viewer,
    at: now.toISOString(),
    agents: others.map((instance) => presence.get(instance)).filter((a): a is AgentView => Boolean(a)),
    doing: others.map((instance) => doing.get(instance)).filter((d): d is DoingView => Boolean(d)),
    knew: others.map((instance) => ({ instance, mark: markOf(entries, instance) })),
    unseen: unseenBy(entries, viewer),
  };
}

// ---------------------------------------------------------------- construction

export function presenceEntry(base: Omit<LogEntryBase, "kind" | "presence">, state: PresenceState, note?: string): LogEntryBase {
  return { ...base, kind: "presence", presence: { state, ...(note ? { note } : {}) } };
}

export function activityEntry(base: Omit<LogEntryBase, "kind" | "activity">, doing: string, target?: string): LogEntryBase {
  return { ...base, kind: "activity", activity: { doing, ...(target ? { target } : {}) } };
}

export function seeEntry(base: Omit<LogEntryBase, "kind" | "see">, of: string, upto: number): LogEntryBase {
  return { ...base, kind: "see", see: { of, upto } };
}

/**
 * The marks a viewer should append after folding `entries`: the furthest position it has reached in
 * each other writer. Appending these is what makes "what did it know" answerable later — and it is
 * why reading is not a passive act in this design.
 */
export function marksToClaim(entries: LogEntryBase[], viewer: string): { of: string; upto: number }[] {
  const furthest = new Map<string, number>();
  for (const entry of entries) {
    if (entry.instance === viewer) continue;
    if (entry.kind === "see") continue;
    if (entry.seq > (furthest.get(entry.instance) ?? 0)) furthest.set(entry.instance, entry.seq);
  }
  const already = markOf(entries, viewer) ?? new Map<string, number>();
  return [...furthest.entries()]
    .filter(([of, upto]) => upto > (already.get(of) ?? 0))
    .map(([of, upto]) => ({ of, upto }))
    .sort((a, b) => a.of.localeCompare(b.of));
}
