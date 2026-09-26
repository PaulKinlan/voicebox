# 18 — The loopback session gate: host-token bootstrap, landed as an opt-in (`2gq`)

**Landed:** `VOICEBOX_LOOPBACK_AUTH=1` — the implementation of [docs/13 §4](13-local-browser-authentication-options.md)
Option A (the Jupyter/code-server pattern), phased exactly as that document prescribed: an opt-in
product gate on top of the `5c1` baseline. Read docs/13 first; this document describes what landing
it changed, in `server.mjs` and `vite.config.js`, and what the gate closes and deliberately does not.

---

## 1. The boundary, restated in one paragraph

On loopback TCP the kernel does not say which local process opened a connection, so a script on the
same machine can write `Origin: http://127.0.0.1:<port>` and — before this gate — take the executor
chair on `/channel` (answering routed acts with `via:"page"` for writes it never performed) or open
`/live`. The Origin check still closes every cross-site browser attack (browsers enforce the header);
what it cannot do is distinguish *this machine's browser tab* from *this machine's shell script*.
docs/13 §1 ruled out minting a token into the openly-served HTML: a secret in an unauthenticated page
is readable by the same loopback reach that the Origin check defends, so it manufactures confidence,
not a boundary.

## 2. What the gate does (`VOICEBOX_LOOPBACK_AUTH=1`)

- **Per-process session secret.** The server mints a random session secret at startup and holds it in
  memory only — a restart mints a new one and silently invalidates every issued cookie. The honest
  failure mode: the remedy (open the URL the new process printed) *is* the launch.
- **One-time bootstrap ticket, printed.** At startup the server mints a single-use ticket and prints
  the full URL on stdout, right under its address line:
  `bootstrap  http://127.0.0.1:8787/?bootstrap=<64 hex>`.
  The terminal is the boundary, for the same reason Jupyter prints its token: a process that cannot
  read this server's stdout (a different UID, an unprivileged container) cannot read the ticket.
- **Redemption on the page route.** `GET /?bootstrap=<ticket>` validates the ticket, consumes it, and
  sets `vb_session=<secret>; HttpOnly; SameSite=Strict; Path=/` on the very response that serves the
  page — no second navigation. An unknown or already-consumed ticket is a named refusal
  (`bootstrap-ticket-refused`) with the remedy in the body: one ticket opens one session, and reloads
  ride the cookie, not the ticket.
- **The wall.** With the gate on, `handle()` refuses every request that carries neither the session
  cookie nor the host token with a named `401 loopback-unauthenticated` refusal carrying the remedy —
  before any route, including the static fallthrough. Three self-authorising exemptions, each with a
  reason: `/api/health` (the spawn-and-wait harness and supervisors read it before any session
  exists; it reports no root, no file, no credential), `POST /api/bootstrap` (it *is* the authority
  check and the re-entry door), and the page route carrying `?bootstrap=` (the route itself validates
  and consumes the ticket). Requests carrying a valid `x-voicebox-host-token` pass directly — the
  shell's 0600 authority (the one that admits extensions, declares roots, pairs environments) is
  authentication already, and the host's acts must not need a browser.
- **Re-entry without a restart.** `POST /api/bootstrap` with the host token mints a fresh single-use
  ticket and returns its URL — the door for a lost or cleared cookie. Without the host token: `403
  host-token-refused`. With the gate off the route does not exist (`404 loopback-auth-disabled`).
- **`/channel` and `/live`.** The local-page entitlement becomes `Origin ∈ localOrigins` **and** a
  valid session cookie. A script that forges the header without the cookie now falls through to the
  pairing-bearer hello path it was always refused by — the refusal keeps its name
  (`executor-unauthenticated` on `/channel`, `unauthenticated-call` on `/live`), and a *paired remote
  peer is untouched*: bearer hello admission is exactly the `5c1` path. The cookie itself arrives on
  the WebSocket upgrade automatically (same-origin upgrades carry cookies), so the page worker is
  unchanged — `browser/acts.ts` connects to `/channel` on its own origin and the browser attaches the
  credential, which is the whole point of putting it in a cookie.

## 3. The dev front (`vite.config.js`)

The dev front serves the page at `localhost:5173` while the API answers on `127.0.0.1:8787`, and a
cookie held for one host never rides the other's requests. So a `loopback-bootstrap-proxy` plugin
intercepts any navigation carrying `?bootstrap=` **before** Vite's own middlewares, forwards it to
`API_TARGET` verbatim (status, `Set-Cookie`, body), and lets the response through: the backend's
cookie carries no `Domain` attribute, so the browser scopes it to the dev front's host, where it then
rides every proxied API fetch and WebSocket upgrade. Gate off, no `?bootstrap=` in the URL — no
interception, byte-identical dev behaviour.

## 4. What this closes, what it names, and what it deliberately does not build

| surface | gate off (`5c1` baseline) | gate on |
|---|---|---|
| cross-site browser (CSWSH) | blocked (Origin) | blocked (Origin + cookie) |
| local process, forged Origin, no ticket/token | **takes the executor chair** | refused by name, before any route |
| local process that can read `.host-token` or the printed ticket | unblocked | unblocked — inside the host boundary by definition (docs/13 §4 rationale) |
| paired remote peer (bearer hello) | admitted | admitted, unchanged |
| launch UX | type the URL | open the URL the server printed (or `POST /api/bootstrap` from the shell) |

The same-UID process remains out of scope *on purpose*: anything running as the same user already
holds the filesystem, the shell and the git credentials, and docs/13 §4 explains why defending
loopback against it while `~/.config` sits readable is an asymmetric boundary. Option B (browser
WebCrypto pairing, docs/13 §2B) is the answer if that threat model ever becomes real; it is not built
here.

One deliberate asymmetry, named rather than left implicit: the HTTP wall checks the cookie but not
Origin (WS upgrades check both). That is sound because the credential itself answers the cross-site
question — `SameSite=Strict` means a cross-site browser request does not *carry* the cookie, so an
`evil.com` page has nothing to send and the wall refuses it, which is the same CSWSH family 5c1
closed by Origin on the sockets. A local non-browser caller bypasses Origin anyway, which is exactly
why the wall's real boundary is the ticket/host-token reach, not the header.

## 5. The proofs

`tests/loopback-auth.test.mjs` drives a real spawned server (the shared `tests/lib/server.mjs`
harness, which now also retains the server's stdout so a suite can read the printed bootstrap URL):

- **default OFF pinned:** the page answers without a cookie, `?bootstrap=` is inert, the door route
  does not exist, and a forged Origin alone still takes the chair — the documented residual, pinned
  so the default cannot drift without a decision.
- **gate ON:** unauthenticated page/API refusals carry the name and the remedy; `/api/health` stays
  open; the printed URL redeems exactly once into an `HttpOnly`/`SameSite=Strict` cookie; the cookie
  opens the page and the APIs; `POST /api/bootstrap` mints single-use tickets under host-token
  authority and refuses without it; the host token passes the wall; a forged Origin **without** the
  cookie (and with a *wrong* cookie) is refused on `/channel` and `/live`; the cookie-carrying page
  takes the executor chair hello-free and is entitled on `/live`.
