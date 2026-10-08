# fo6m — the bootstrap launch leaves the address bar on the plain route

**Bead:** `voicebox-beads-fo6m` (P0, `first-run`, `paul-request`)
**Branch:** `fleet/roboticon`
**Fix commit:** `5c672a8` (code + docs + focused test), evidence in the commit that follows it.
**Owner report, verbatim:** "after you launch the very first time and give it a bootstrap URL. It
should just redirect to the plain route because obviously if I then refresh the page it says the
bootstraps taken and people will refresh the page."

## What was wrong

With `VOICEBOX_LOOPBACK_AUTH=1`, `GET /?bootstrap=<ticket>` consumed the one-time ticket and then
served the page **at that URL** (`200` + HTML + `Set-Cookie`). The ticket therefore stayed in the
address bar, and the refresh everyone performs re-presented a ticket that had already been consumed:
`401 bootstrap-ticket-refused`, a plain-text refusal. A successful first launch read as a broken
server on the very next gesture.

## What the fix does

`server.mjs`'s page route now answers **`303`** with a **relative** `Location` naming the same route
with the ticket removed, carrying the `Set-Cookie`. The browser stores the cookie from the redirect
and re-requests the plain route in one hop. Two decisions worth naming:

- **Relative `Location`** (`/`, not `http://127.0.0.1:8787/`): on the dev front the browser stays on
  `localhost:5173` — the origin that now holds the cookie — instead of being handed to the API origin.
- **A consumed ticket with a session behind it also redirects** (bookmark / history / back button):
  there is no authorisation question left. **Without** a session the named `401
  bootstrap-ticket-refused` stays, because a stale ticket must not silently become a sign-in.
- Only the `bootstrap` parameter is dropped; a launch's other parameters survive the redirect.

## Evidence — real browser, the three moments Paul named

Driven through Chromium via `tests/lib/cdp.mjs` (the repo's own CDP driver). `before` is the same
drive against the pre-fix `server.mjs` (`git show HEAD~1:server.mjs`), temporarily in place and
restored afterwards — so the failing half is measured, not asserted.

### The printed bootstrap URL (`node server.mjs`, gate on)

| Moment | pre-fix (`before`) | fixed (`after`) |
|---|---|---|
| 1. Open the printed bootstrap URL | `200` at `…/?bootstrap=<ticket>` — page renders, **ticket stays in the address bar** (`responseReceived 200`) | `303`, `Location: /`, next request `/` — **address bar is the plain route** |
| 2. Refresh that page | `401 bootstrap-ticket-refused` (`title: ""`, body is the refusal) | page renders (`title: "Voicebox"`, body: "agent: script · no folder chosen yet …") |
| 3. Revisit the original consumed URL | `401 bootstrap-ticket-refused` | `303` → `/`, page renders |
| Stale ticket, **no** cookie (HTTP) | `401 bootstrap-ticket-refused` | `401 bootstrap-ticket-refused` (unchanged, deliberately) |
| Plain route, **no** cookie (HTTP) | `401 loopback-unauthenticated` | `401 loopback-unauthenticated` (unchanged) |

- Files: `before-1-launched.png`, `before-2-refreshed.png`, `before-3-consumed-revisit.png`,
  `after-1-launched.png`, `after-2-refreshed.png`, `after-3-consumed-revisit.png`, and the raw CDP
  logs `before-drive.json` / `after-drive.json`.
- `before-2-refreshed.png` is the defect itself: a full-window `401 bootstrap-ticket-refused`.
  `after-2-refreshed.png` is the same gesture: the Voicebox room.
- The browser's own jar after the launch (`Storage.getCookies`, shape only): `vb_session`,
  `domain 127.0.0.1`, `path /`, `httpOnly true`, `sameSite Strict` — the cookie rode the `303`.
  (CDP does not expose `Set-Cookie` on `Network` response headers; the jar is the proof.)

### The Vite dev front (`npm run dev`, `localhost:5273` fronting a scratch-port API)

`drive-front.mjs` runs the more demanding case — the front is a *different origin* from the API:

| Check | Result |
|---|---|
| Launch redirects to the front's own origin | `location.href === http://localhost:5273/` |
| Refresh renders the room | `title: "Voicebox"`, room body rendered |
| Revisit of the consumed URL | `303` → `/`, page renders |
| Cookie scoped to the front | `vb_session`, `domain localhost`, `path /`, `httpOnly true`, `sameSite Strict` |
| Stale ticket, no cookie, through the proxy | `401 bootstrap-ticket-refused` |

Files: `front-1-launched.png`, `front-2-refreshed.png`, `front-3-consumed-revisit.png`,
`front-drive.json`.

## How to reproduce

```bash
node docs/evidence/fo6m-bootstrap-redirect-20261008/drive.mjs --label after   # the printed-URL flow
node docs/evidence/fo6m-bootstrap-redirect-20261008/drive-front.mjs          # the dev-front flow
```

Both scripts start their own server(s) on scratch ports with a scratch extensions directory, close
the browser and both processes in a `finally`, and remove the scratch state. Nothing here writes
into the tree.

## Focused test (the non-browser half)

`node --test tests/loopback-auth.test.mjs` — **17/17 pass**, including the four added/extended cases:
redemption redirects and the refresh works; an authenticated revisit of a consumed URL redirects
(and the no-session case still refuses); other query parameters survive the redirect; the minted
ticket redirects like the startup one.

## Notes and limits

- The `303` is chosen over `302` deliberately: it is the status that says "the result is elsewhere,
  re-request it with GET", and `lib/extensions.mjs` already treats `303` as a redirect status.
- `Location: /` is relative by construction in `plainRouteWithoutTicket()`; an absolute URL would
  have walked a dev-front browser off the origin holding its cookie.
- Docs updated in the same change: `docs/18-loopback-session-auth.md` (§1 redemption, §2 dev-front
  proxy), `docs/13-local-browser-authentication-options.md`, `README.md`, and the generated config
  row in `scripts/docs-check.mjs` (regenerated with `npm run docs:write`).
