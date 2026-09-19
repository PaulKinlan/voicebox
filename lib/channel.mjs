// lib/channel.mjs — the channel contract and the executor door.
//
// THE CONTRACT (three methods, the shape isocan's memory broker proved):
//   connected() — is the other side there?
//   send(msg)   — carry a string to the other side
//   answer(callId, answer) — settle a call the harness is waiting on
// Any transport that offers these three can carry a routed capability. No
// transport endpoint is built here ON PURPOSE: which side holds the harness is
// Paul's placement decision (reports/2026-09-20-where-does-the-harness-run-
// placement-options.md), and a socket wired before that decision is surface he
// might have to delete. What is here is the part that does not wait: the
// envelopes, the bounds re-check, the absence vocabulary, and the door —
// peer-parameterised, so either harness orientation fits.
//
// THE HONEST CLAIM, stated precisely: driven with an in-process executor door
// wired to the REAL registry (admission, bounds, budget all inherited) and a
// stand-in peer over a captured pipe, THE ROUND TRIP IS REAL EXCEPT THE WIRE.
// The admission path, the bounds check and the budget are the real ones; the
// only synthetic thing is the transport.
//
// Zero dependencies: node builtins only, plus the pure wire in core/.
import {
  makeCall,
  makeAnswerOk,
  makeAnswerRefused,
  parseAnswer,
  parseCall,
  NOT_CONNECTED,
  TIMED_OUT,
  CLOSED,
} from "../core/wire.ts";

function callId() {
  return `rt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * createChannel — the HARNESS side. It holds admitted descriptors, so it
 * attributes calls and waits for observed facts. `peer` names the missing
 * half in the refusals: a person can tell WHICH side is absent from the name
 * alone ("the page is closed" ≠ "the machine is down").
 */
export function createChannel({ peer, connected, send, timeoutMs = 5000 }) {
  const waiting = new Map(); // callId -> { resolve, timer }
  function settle(callId, answer) {
    const held = waiting.get(callId);
    if (!held) return false;
    clearTimeout(held.timer);
    waiting.delete(callId);
    held.resolve(answer);
    return true;
  }
  return {
    waiting: () => waiting.size,
    /** Issue an attributed call. Refuses in words when the peer is absent — and sends NOTHING. */
    ask(parts) {
      if (!connected()) {
        const refused = NOT_CONNECTED[peer];
        const why =
          peer === "page"
            ? "no page is connected — the capability lives in the page, so nothing routed can run"
            : "the machine is unreachable — its tools live there, so nothing routed can run";
        return Promise.resolve({ ok: false, refused, why });
      }
      const envelope = makeCall({ callId: callId(), ...parts });
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          waiting.delete(envelope.callId);
          resolve({ ok: false, refused: TIMED_OUT[peer], why: `the ${peer} did not answer the call in time` });
        }, timeoutMs);
        waiting.set(envelope.callId, { resolve, timer });
        send(JSON.stringify(envelope));
      });
    },
    /** Feed a raw answer from the wire. Invalid answers NEVER settle the call —
     * the pending ask keeps waiting (and can time out), which is honest silence
     * from a peer that said something inaudible. */
    deliver(raw) {
      const parsed = parseAnswer(raw);
      if (!parsed.ok) return { delivered: false, ...parsed };
      return { delivered: settle(parsed.value.callId, parsed.value) };
    },
    /** The peer is gone: every pending call settles with a NAMED refusal — never silence. */
    abandon() {
      for (const [id, held] of waiting) {
        clearTimeout(held.timer);
        waiting.delete(id);
        held.resolve({ ok: false, refused: CLOSED[peer], why: `the ${peer} closed before it answered` });
      }
    },
  };
}

/**
 * createExecutorDoor — the EXECUTOR side. A routed call arrives as a raw
 * string; the door validates it against the REAL registry (attribution, bounds
 * echo), executes through the REAL runtime (admission, bounds, budget), and
 * returns the answer to put back on the wire. A routed call gets nothing the
 * local call would not have got.
 */
export function createExecutorDoor({ lookup, exec }) {
  return {
    /** Returns the answer string to send, or null when there is nobody to
     * answer (unparseable garbage with no callId): the asker's timeout is the
     * honest outcome of shouting into noise. */
    receive(raw) {
      let probe = null;
      try {
        probe = JSON.parse(typeof raw === "string" ? raw : JSON.stringify(raw));
      } catch {
        return null;
      }
      const callId = typeof probe?.callId === "string" ? probe.callId : null;
      const parsed = parseCall(raw, lookup);
      if (!parsed.ok) {
        return callId === null ? null : JSON.stringify(makeAnswerRefused(callId, parsed.refused, parsed.why));
      }
      const call = parsed.value;
      let result;
      try {
        result = exec(call);
      } catch (e) {
        return JSON.stringify(makeAnswerRefused(callId, "exec-threw", e?.message ?? String(e)));
      }
      if (result instanceof Promise) {
        // ponytail: promise results resolved by the caller awaiting receive;
        // the sync tools (now/list/read/write) never hit this.
        return result.then((done) => JSON.stringify(toAnswer(callId, done)));
      }
      return JSON.stringify(toAnswer(callId, result));
    },
  };
}

function toAnswer(callId, result) {
  if (!result?.ok) {
    // The runtime's named refusals flow through UNCHANGED — a routed call is
    // refused by the same rules, with the same words, as a local one.
    return makeAnswerRefused(callId, result?.refused ?? "unknown-refusal", result?.why ?? "the executor returned no reason");
  }
  const observed = { ...result };
  delete observed.ok;
  if (typeof observed.content === "string") observed.content = observed.content.slice(0, 2000);
  return makeAnswerOk(callId, observed);
}

export { TIMED_OUT, CLOSED, NOT_CONNECTED };
