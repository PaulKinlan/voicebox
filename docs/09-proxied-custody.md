# Proxied custody + envelope identity — design for review (NOT landed)

Paul's decisions 3 and 4 (2026-09-20): **custody is via a server (proxied)** — *"we might need a proxy
if we need to make fetch requests that can be done in a browser"* — and **identity lives at the
envelope, not the vocabulary** (no rename of `page | machine`). This is a **security boundary**: a
credential, a proxy, and an identity that decides who may act. **Per coord's rule it is reviewed
BEFORE it lands.** This document is the reviewable artefact; the slice that accompanies it is
`git diff` on the `feat/env-registry` worktree, uncommitted until review clears.

**The gate coord set, and it is the load-bearing one: drive the REMOTE case, not the local one.**
Tonight's failure was a firewall refusing the tailnet interface while every local check passed —
the machine was reachable and one road to it was locked, and nothing said so. A credential that works
locally and fails remotely, with the failure reading as "the remote is down", is the same shape. So
every claim below is stated for the remote path first.

---

## 1. The two halves are one seam

- **Proxied custody**: the page holds **no** remote credential. It asks its *local* host to make the
  remote call; the local host originates the connection to the remote environment and holds the bearer.
  The page's browser socket never carries a remote secret — which also removes the unproven
  "can a browser WebSocket carry a header" direction entirely: the page→host leg is same-origin
  loopback (ambient), and the host→remote leg is a server-side `fetch`/`WebSocket` that *can* carry a
  header (astra drove it).
- **Envelope identity**: the remote call is a `core/wire.ts` `CallEnvelope`, and the **environment key**
  (the stable self-issued id from `core/environment.ts`) rides as the **descriptor the call is
  attributed to**. `parseCall` already refuses a call that names an authority that does not exist
  (`unattributed-call`) or whose bounds do not match (`bounds-mismatch`) — so "which environment may
  this act on" is the same check as "which descriptor authorised this", not a new field to smuggle.

## 2. Custody: pairing, the bearer, and who holds it

- **Pairing** (an explicit act): the person points the local host at a remote origin and confirms.
  The remote host issues a **per-(user, environment) bearer**, stored on the *issuing* host's side and
  registered on the *calling* host's side — both 0600, both outside any project root and served by no
  route (the host-token shape, `lib/extensions.mjs:50`, already the proof). The bearer is bound to the
  environment's **key**, so a re-pointed origin does not inherit the credential.
- **Who holds it**: the **local host**, never the page. The page's `POST /api/call` names the
  environment by **key** and the tool + args; the local host looks up the bearer for that key, attaches
  it, and forwards. The page cannot read the bearer and cannot be asked to.
- **Revocation is part of pairing, not deferred**: withdrawing a bearer (a) removes it from both sides
  and (b) makes the next call refuse by name (`environment-not-paired`), and a running task's authority
  is cancelled by the host that admitted it.

## 3. The proxy route, and the remote drive

```
page ──POST /api/call {envKey, tool, args}──▶ local host ──(bearer)──▶ remote env: executes, answers
```

- The local host validates the envelope against the *admitted* descriptor for that environment
  (`parseCall`'s lookup), attaches the bearer, and forwards over TLS.
- The remote host authenticates the bearer **before** creating anything (the `/live` hello-auth rule:
  the provider session must not be built on an unauthenticated upgrade), executes inside its own root,
  and answers with **observed facts or a named refusal** — never a grant (the wire schema enforces it).
- **The driven case is the remote one**: the accompanying test runs **two real servers** (a local host
  and a "remote" one on a second ephemeral port), pairs them, and drives a call across. The local-only
  path is asserted to *refuse* (no bearer, no remote), so "it works on loopback" can never again stand
  in for "it works across the wire".

## 4. What is NOT in this slice (named, so review does not have to find them)

- TLS termination / certificates (the drive is loopback-to-loopback on two ports; real TLS is the
  deployment shape, not the seam).
- Multi-user (Paul: single user, many environments).
- The remote `/live` audio path (the first-frame/hello auth gate) — the custody seam is proven on the
  HTTP call path first; `/live` reuses the same bearer once this lands.
- The proxy as a general browser-fetch relay (Paul's forward-looking reason) — this slice proves the
  custody + identity seam on the call path; the general relay builds on it.

## 5. The questions I want the reviewer to answer

1. Does putting the environment key in `descriptorId` (rather than a new envelope field) keep the
   authority boundary intact, or does it overload the field?
2. Is bearer storage on both sides (0600, outside the root, no route) sufficient, or does the calling
   host's copy need to be held only in memory?
3. Does the refusal vocabulary cover the failure modes a person will hit — `environment-not-paired`,
   `environment-unreachable`, `unattributed-call` — or is one of them collapsing two remedies?
