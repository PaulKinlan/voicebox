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
- **Envelope identity**: the environment **key** (the stable self-issued id from `core/environment.ts`)
  is carried as its **own validated field** on the call — NOT as the `descriptorId`. The first draft
  proposed reusing `descriptorId`; review showed that overloads it, because `descriptorId` names an
  *admission in a tool registry* and an environment key names a *host* — different namespaces, and
  `unattributed-call` would conflate *"no such tool admission"* with *"no such host"*. So `envKey` is
  validated against the environment registry, and the tool + bounds are validated against the remote's
  own admission registry on the far side. Two registries, two checks, no conflation. (Reviewer over the
  first draft's suggestion, because it is true.)
- **The bearer is bound to the key, and the key must still exist.** `/api/execute` resolves `envKey`
  against the *remote's* registry **before** `bearerOk`, so a re-created or re-keyed environment's old
  credential refuses `unknown-environment` rather than silently reaching a different identity.

## 2. Custody: pairing, the bearer, and who holds it

- **Pairing** (an explicit act): the person points the local host at a remote origin and confirms.
  Pairing **creates a credential**, so it is the same authority class as admission and carries the same
  gate: the **host token** on both `/api/pair` and `/api/pair/complete` (a page's two token-less fetches
  cannot self-pair — the shape the host token closed for admission). The remote host issues a
  **per-(user, environment) bearer**, stored on the *issuing* host's side and registered on the
  *calling* host's side — both in the host's own directory (the `.host-token` sidecar pattern), 0600,
  **outside every project root and served by no route**. A store inside a writable root is a credential
  the page can read, so the location is the defence, not the file mode. The bearer is bound to the
  environment's **key**, so a re-pointed origin does not inherit the credential. The bearer is the one
  thing that never appears in a diagnostic — never logged, never in an error, never in a refusal's `why`.
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
