// core/wire.ts — the call/answer envelopes and the authority boundary, as DATA + pure functions.
//
// This is docs (reports/2026-09-20-where-does-the-harness-run-placement-options.md) §4:
// the fall-out that does not wait for the placement decision. The SHAPES are fixed
// here so that whichever harness orientation Paul picks, the wire is a rename, not a
// redesign. Nothing here knows where the harness runs — a channel peer is a name
// ("page" | "machine"), not an architecture.
//
// THE AUTHORITY BOUNDARY, in one line, enforced structurally:
//
//   The harness that holds the tier table decides; the side that executes reports
//   observed facts; the decision NEVER crosses the channel, and the observation is
//   never trusted unobserved.
//
// "Structurally" means: an envelope has NO field a decision could ride on. Calls carry
// ATTRIBUTION (which admitted descriptor authorises this) plus a BOUNDS ECHO (the
// bounds it was admitted with, so the executor can re-check rather than trust); answers
// carry OBSERVED FACTS or a NAMED REFUSAL. Anything else on the wire fails validation
// with a named refusal — fail closed, like every other gate in this system.
//
// Pure: no imports, no IO. Runs in a page worker as readily as in the server (N18).
// Zero dependencies.

// ── the absence vocabulary: which half is missing is IN the refusal name ───
// "the page is closed" and "the machine is down" must not be the same experience,
// so they are not the same string. peer-parameterised, not placement-decided.
export type Peer = "page" | "machine";

export const NOT_CONNECTED: Record<Peer, string> = {
  page: "no-page",
  machine: "machine-unreachable",
};
export const TIMED_OUT: Record<Peer, string> = {
  page: "page-timeout",
  machine: "machine-timeout",
};
export const CLOSED: Record<Peer, string> = {
  page: "page-closed",
  machine: "machine-closed",
};

export const AUTHORITY_BOUNDARY =
  "the harness that holds the tier table decides; the side that executes reports observed facts; the decision never crosses the channel, and the observation is never trusted unobserved";

// ── envelopes ──────────────────────────────────────────────────────────────

export const WIRE_VERSION = 1;

export interface CallEnvelope {
  v: number;
  callId: string;
  tool: string;
  descriptorId: string; // WHICH admitted descriptor authorises this call
  args: Record<string, unknown>;
  boundsEcho: Record<string, unknown>; // the bounds it was admitted with — re-checked, never trusted
}

export type AnswerEnvelope =
  | { v: number; callId: string; ok: true; observed: Record<string, unknown> }
  | { v: number; callId: string; ok: false; refused: string; why: string };

export type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; refused: string; why: string };

const CALL_FIELDS = new Set(["v", "callId", "tool", "descriptorId", "args", "boundsEcho"]);
const ANSWER_FIELDS = new Set(["v", "callId", "ok", "observed", "refused", "why"]);

/** A call must be attributable (descriptorId) and re-checkable (boundsEcho) — a routed
 * call is trusted because it matches an ADMISSION, never because it arrived. */
export function makeCall(parts: {
  callId: string;
  tool: string;
  descriptorId: string;
  args?: Record<string, unknown>;
  boundsEcho: Record<string, unknown>;
}): CallEnvelope {
  return {
    v: WIRE_VERSION,
    callId: parts.callId,
    tool: parts.tool,
    descriptorId: parts.descriptorId,
    args: parts.args ?? {},
    boundsEcho: parts.boundsEcho,
  };
}

/** Strict parse: unknown fields are a REFUSAL, not noise — a decision cannot smuggle
 * across as an extra key (that is the authority boundary, enforced by schema). */
export function parseCall(
  raw: unknown,
  lookup: (descriptorId: string, tool: string) => { bounds: Record<string, unknown> } | null,
): ParseResult<CallEnvelope> {
  let obj: Record<string, unknown>;
  if (typeof raw === "string") {
    try {
      obj = JSON.parse(raw);
    } catch {
      return { ok: false, refused: "malformed-call", why: "the call did not parse as JSON" };
    }
  } else if (obj && typeof raw === "object") {
    obj = raw as Record<string, unknown>;
  } else {
    return { ok: false, refused: "malformed-call", why: "the call is not an object" };
  }
  if (!obj || typeof obj !== "object") {
    return { ok: false, refused: "malformed-call", why: "the call is not an object" };
  }
  for (const k of Object.keys(obj)) {
    if (!CALL_FIELDS.has(k)) {
      return { ok: false, refused: "unknown-field", why: `'${k}' is not a call field — the wire is strict, and a decision has no field to ride on` };
    }
  }
  if (obj.v !== WIRE_VERSION) {
    return { ok: false, refused: "bad-version", why: `wire version ${JSON.stringify(obj.v)} is not ${WIRE_VERSION}` };
  }
  if (typeof obj.callId !== "string" || !obj.callId) {
    return { ok: false, refused: "malformed-call", why: "the call has no callId" };
  }
  if (typeof obj.descriptorId !== "string" || !obj.descriptorId || typeof obj.tool !== "string" || !obj.tool || !obj.boundsEcho || typeof obj.boundsEcho !== "object") {
    return { ok: false, refused: "unattributed-call", why: "a routed call must name the descriptor that authorised it (descriptorId) and echo the bounds it was admitted with (boundsEcho) — it is trusted because it matches an admission, never because it arrived" };
  }
  const admitted = lookup(obj.descriptorId, obj.tool);
  if (!admitted) {
    return { ok: false, refused: "unattributed-call", why: `no admitted descriptor '${obj.descriptorId}' carrying tool '${obj.tool}' — the call names an authority that does not exist here` };
  }
  if (!boundedEqual(admitted.bounds, obj.boundsEcho as Record<string, unknown>)) {
    return { ok: false, refused: "bounds-mismatch", why: `the call's boundsEcho does not match the admitted descriptor's bounds (${JSON.stringify(admitted.bounds)}) — re-admit or re-issue the call; echoed bounds are checked, never trusted` };
  }
  return {
    ok: true,
    value: {
      v: WIRE_VERSION,
      callId: obj.callId,
      tool: obj.tool,
      descriptorId: obj.descriptorId,
      args: (obj.args && typeof obj.args === "object" ? obj.args : {}) as Record<string, unknown>,
      boundsEcho: obj.boundsEcho as Record<string, unknown>,
    },
  };
}

export function makeAnswerOk(callId: string, observed: Record<string, unknown>): AnswerEnvelope {
  return { v: WIRE_VERSION, callId, ok: true, observed };
}

export function makeAnswerRefused(callId: string, refused: string, why: string): AnswerEnvelope {
  return { v: WIRE_VERSION, callId, ok: false, refused, why };
}

/** Same strictness, opposite direction: an answer carries OBSERVED FACTS or a NAMED
 * REFUSAL — never a grant. `grant`, `decision`, `allow` and friends have no field. */
export function parseAnswer(raw: unknown): ParseResult<AnswerEnvelope> {
  let obj: Record<string, unknown>;
  if (typeof raw === "string") {
    try {
      obj = JSON.parse(raw);
    } catch {
      return { ok: false, refused: "malformed-answer", why: "the answer did not parse as JSON" };
    }
  } else if (raw && typeof raw === "object") {
    obj = raw as Record<string, unknown>;
  } else {
    return { ok: false, refused: "malformed-answer", why: "the answer is not an object" };
  }
  for (const k of Object.keys(obj)) {
    if (!ANSWER_FIELDS.has(k)) {
      return { ok: false, refused: "unknown-field", why: `'${k}' is not an answer field — an answer carries observed facts or a named refusal, never authority (a grant has no field to ride on)` };
    }
  }
  if (obj.v !== WIRE_VERSION) {
    return { ok: false, refused: "bad-version", why: `wire version ${JSON.stringify(obj.v)} is not ${WIRE_VERSION}` };
  }
  if (typeof obj.callId !== "string" || !obj.callId) {
    return { ok: false, refused: "malformed-answer", why: "the answer has no callId" };
  }
  if (obj.ok === true) {
    if (!obj.observed || typeof obj.observed !== "object") {
      return { ok: false, refused: "malformed-answer", why: "an ok answer must carry observed facts — 'it worked' is a claim, not an observation" };
    }
    return { ok: true, value: { v: WIRE_VERSION, callId: obj.callId, ok: true, observed: obj.observed as Record<string, unknown> } };
  }
  if (obj.ok === false) {
    if (typeof obj.refused !== "string" || !obj.refused || typeof obj.why !== "string") {
      return { ok: false, refused: "malformed-answer", why: "a refused answer must carry the named rule (refused) and the why" };
    }
    return { ok: true, value: { v: WIRE_VERSION, callId: obj.callId, ok: false, refused: obj.refused, why: obj.why } };
  }
  return { ok: false, refused: "malformed-answer", why: "the answer's ok field is neither true nor false" };
}

// ── stable deep-equal for the bounds re-check (key order is never an excuse) ──

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stable((value as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

export function boundedEqual(a: unknown, b: unknown): boolean {
  return stable(a) === stable(b);
}
