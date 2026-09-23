# 08 — The wire: envelopes, the channel contract, and absence (§4 of the placement paper)

The fall-out that does not wait for the placement decision
([reports/2026-09-20-where-does-the-harness-run-placement-options.md §4](../../journal/reports/2026-09-20-where-does-the-harness-run-placement-options.md)),
now implemented and driven. **The shapes are fixed so the wire is a rename, not a redesign,
whichever harness orientation Paul picks.** What is deliberately NOT built: a live transport
endpoint — under a "browser renders, machine acts" decision it would be dead surface, and
wiring a socket before the decision is a guess with a port number.

**The honest claim, stated precisely:** driven with an in-process executor door wired to the
REAL registry (admission, bounds, budget all inherited) and a stand-in peer over a captured
pipe — **the round trip is real except the wire**. The admission path, the bounds check and
the budget are the real ones; the only synthetic thing is the transport. (`tests/channel.test.mjs`.)

## The envelopes (core/wire.ts — pure, runs in a page worker, N18)

```
call:   { v: 1, callId, tool, descriptorId, args, boundsEcho }
answer: { v: 1, callId, ok: true,  observed: { … } }
        { v: 1, callId, ok: false, refused: "<rule-id>", why: "…" }
```

- **Attribution**: a call names the descriptor that authorises it. The executor re-checks the
  call against THAT admission — a call is trusted because it matches an admission, never
  because it arrived. A tampered `boundsEcho` refuses `bounds-mismatch`; a call naming a
  descriptor that does not exist refuses `unattributed-call` — which is how a tool REFUSED at
  admission (exec-absent) stays unreachable on the wire: there is no authority to name.
- **The authority boundary, enforced by schema**: the envelope has NO field a decision or a
  grant could ride on. Strict field allowlists both directions — a call carrying `decision:
  "allow"` and an answer carrying `grant: "everything"` both refuse `unknown-field`. The line,
  exportable: *the harness that holds the tier table decides; the side that executes reports
  observed facts; the decision never crosses the channel, and the observation is never trusted
  unobserved.*
- **Observation, not assertion**: an `ok` answer without `observed` refuses — "it worked" is a
  claim, not an observation.

## The channel contract (lib/channel.mjs) — three methods, no more

`connected()` · `send(msg)` · `answer(callId, answer)` — the interface isocan's memory broker
proved (`createMemoryBroker`, `voice-harness.ts:591`, driven 4/4 on 2026-09-19). `ask` refuses
in words and sends NOTHING when the peer is absent; invalid answers NEVER settle a pending call
(inaudible peers get honest timeouts); `abandon()` settles every pending call with a NAMED
refusal — pending asks are never silence.

## Absence is a vocabulary — which half is missing is IN the refusal name

| state | page is the peer | machine is the peer |
|---|---|---|
| not connected | `no-page` | `machine-unreachable` |
| no answer in time | `page-timeout` | `machine-timeout` |
| gone with calls pending | `page-closed` | `machine-closed` |

"The page is closed" and "the machine is down" are not the same experience, so they are not the
same string. Driven: all six names are distinct and asserted so.

## Runtime refusals cross the wire unchanged

A routed call runs through the SAME runtime as a local one: `host-not-allowed`,
`fetch-failed` and `budget-exhausted` arrive over the wire with the same rules and the same
words, and the routed call's budget charges exactly like a local one (driven: undeclared host
refused, charged attempt on a dead port, next call `budget-exhausted` — `1 of 1 requests used`).

## What waits for Paul's decision

The transport (which socket, which side listens) and the harness orientation (machine-held or
page-held tier table). Both plug into `createChannel`/`createExecutorDoor` without touching the
envelopes, the validators, or the absence vocabulary.

## The `/channel` transport entitlement and authentication (server.mjs)

The routed-acts WebSocket endpoint (`/channel`) enforces an entitlement gate before any socket
can register as the executor (`pageSocket`):

1. **Local page**: connects with a local Origin header (`http://127.0.0.1:<port>`, `http://localhost:<port>`, `http://[::1]:<port>`, or rewritten by the Vite proxy). Entitled by construction: same-origin browser contexts cannot forge `Origin` and the local page holds no credentials.
2. **Paired remote executor**: any non-local connection must present a valid pairing bearer in the first hello frame within a bounded 5-second window:
   `{"type":"hello","role":"environment","bearer":"vbx_…"}`
   The bearer is validated against `readPairings()`.
3. **Refusal**: unauthenticated or non-matching connections receive a named refusal (`executor-unauthenticated` or `bearer-refused`), are closed with WS code 1008, and are NEVER assigned as `pageSocket`.

**What this boundary does NOT protect against:** A non-browser process running locally on the same machine can forge the `Origin: http://127.0.0.1:<port>` header on raw WebSocket requests. Closing that gap requires minting an ephemeral, per-process session token into the served HTML. This gate prevents Cross-Site WebSocket Hijacking (CSWSH) from untrusted browser tabs and unauthenticated remote network access.
