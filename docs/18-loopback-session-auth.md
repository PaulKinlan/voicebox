# Loopback Session Gate (`VOICEBOX_LOOPBACK_AUTH=1`)

`VOICEBOX_LOOPBACK_AUTH=1` enables an opt-in bootstrap ticket and `HttpOnly` session cookie gate on `server.mjs` and `vite.config.js` (implementing Option A from [`13-local-browser-authentication-options.md`](13-local-browser-authentication-options.md)).

While the default loopback `Origin` check blocks Cross-Site WebSocket Hijacking (CSWSH) from external websites, enabling `VOICEBOX_LOOPBACK_AUTH=1` additionally blocks unauthenticated local processes (such as other OS users or unprivileged containers sharing the loopback network) from accessing the web UI, REST APIs, `/channel`, or `/live`.

---

## 0. Default Posture: Gate OFF (accepted testing posture, owner ruling 2026-10-06)

The gate is **OFF by default**, and the owner has ruled it stays that way for testing (voicebox-beads-k74h). The default is accepted, not silent:

- **Startup warning.** When `VOICEBOX_LOOPBACK_AUTH` is not `1` (unset or disabled), `server.mjs` prints a warning at startup naming the exposure and the flag remedy.
- **Local-process risk with the gate off.** Any local process can forge `Origin` and `Sec-Fetch-Site` on raw loopback TCP and reach uncredentialed mutation routes, including workspace writes, environment registration and command execution. That risk is distinct from cross-site browser requests, which the JSON body door and the scoped request-level guard now refuse (voicebox-beads-1la5, voicebox-beads-3bwx); neither browser signal authenticates a local process. A browser old enough to omit both `Origin` and Fetch Metadata on a cross-site GET cannot be distinguished from a machine caller at the probe seam.
- **Verified gate-on behaviour.** With `VOICEBOX_LOOPBACK_AUTH=1`, an unauthenticated HTTP request is refused with `401` (`loopback-unauthenticated`) before any route answers (WebSocket upgrades are refused too, under their own names — §1 item 6). The exemptions are the wall's own self-authorising checks (§1, "HTTP & API Wall"): `GET /api/health` remains `200` for supervisors and readiness checks (it exposes no file contents and no credential, though it does report the declared root and project name), and the bootstrap door, the `?bootstrap=` page, and host-token requests pass on their own authority. This is pinned by `tests/loopback-auth.test.mjs`. On the Vite front, a healthy `/api/health` keeps the server indicator up even when `/api/root` returns `401`; the page names the missing session and asks for a bootstrap ticket on that front's origin rather than claiming the server is offline (`tests/health-auth-browser.test.mjs`).
- **Browser request guard (measured).** A cross-site *simple* POST cannot declare JSON without a preflight, so JSON-body routes refuse absent/non-JSON `Content-Type` with `415`; `OPTIONS` receives no CORS grant. Before dispatch, bodyless `POST /api/undo`, `POST /api/probe`, bespoke-parser `POST /api/mini-app/tools`, and even cache-miss/refresh `GET /api/probe` refuse a cross-site browser request with `403 cross-origin-request-refused` and no side effect. The guard checks `Sec-Fetch-Site` as well as `Origin`: Vite also stamps the incoming browser Origin in `x-voicebox-proxied-origin` before rewriting it, and the guard refuses a mismatch against the browser-addressed Host. This prevents the dev front laundering older-browser POSTs without Fetch Metadata; a matching pair grants no authority. The check is scoped to HTTP and does not change the separate WebSocket proxy hops. Same-origin page, Vite-proxied page and unheaded machine clients remain functional (focused `tests/csrf-http.test.mjs` and a real-browser two-origin drive). A pre-Fetch-Metadata cross-site GET carrying neither header remains indistinguishable from a machine call.
- **Recommendation.** Run with `VOICEBOX_LOOPBACK_AUTH=1` outside local testing — the gate-off default exists for the raw command-line testing workflow, and the flag is one restart away.

Enabling the gate is one restart away:

```bash
VOICEBOX_LOOPBACK_AUTH=1 npm start
```

---

## 1. How the Loopback Session Gate Works

```bash
VOICEBOX_LOOPBACK_AUTH=1 npm start
```

1. **In-Memory Session Secret**: At startup, `server.mjs` generates a random session secret held solely in process memory. Restarting the server invalidates prior session cookies.
2. **One-Time Bootstrap Ticket**: On boot, the server mints **one** single-use 64-character hex ticket and prints its URL to stdout:
   ```
   bootstrap  http://127.0.0.1:8787/?bootstrap=<64-hex-ticket>
   ```
   The startup text then names the host the ticket must be opened on: a redemption's `Set-Cookie` carries no `Domain` attribute, so the browser scopes the session to the HOST that redeemed it, and a cookie minted at `127.0.0.1:8787` is never sent to a page served from `localhost:5173` (the symptom reported 2026-10-12). On the dev front (§2) the same ticket is opened on that host — `http://localhost:5173/?bootstrap=<ticket>`, which the `loopback-bootstrap-proxy` plugin forwards and whose `Set-Cookie` lands on `:5173` — so the printed block says so instead of leaving the person to follow the `127.0.0.1` URL from a `:5173` page, get a live cookie that page cannot present, and spend the only ticket. **Issuance is unchanged: one ticket, single-use, on whichever host is opened first** (voicebox-beads-t43w). The `127.0.0.1:5173` spelling is the same host case for a person who browses that address.
3. **Ticket Redemption (`GET /?bootstrap=<ticket>`)** (voicebox-beads-fo6m):
   - Opening the bootstrap URL validates and consumes the single-use ticket, sets `vb_session=<secret>; HttpOnly; SameSite=Strict; Path=/`, **and answers HTTP `303`** whose `Location` is the same route with the ticket removed (`/`, or `/?room=…` when the launch carried other parameters). The browser stores the cookie from the redirect and re-requests the plain route, so **the ticket never stays in the address bar** and the first refresh — the thing everyone does — is authenticated instead of re-presenting a consumed ticket.
   - Reusing an already consumed or invalid ticket **without a session cookie** returns HTTP `401` (`bootstrap-ticket-refused`) with the remedy in the body. Reusing one **with** a valid session — a bookmark, browser history, the back button — answers the same `303` to the plain route: an authenticated browser has no authorisation question left, and a refusal there reads as a broken server. Subsequent page reloads authenticate automatically via the `vb_session` cookie.
4. **HTTP & API Wall**:
   - Every HTTP request lacking a valid `vb_session` cookie or `x-voicebox-host-token` header is refused before reaching any route with HTTP `401` (`loopback-unauthenticated`). When the request's `Host` names the dev front (`localhost:5173` / `127.0.0.1:5173` — the Vite hop preserves `Host`, so this survives the proxy) the refusal appends one clause naming that front, saying why it holds no cookie (a session is scoped to the host that redeemed the ticket), and giving the remedy: redeem a ticket on the host you browse, swapping `127.0.0.1:8787` for the host in the address bar. That is the shape a dev-front user sees when every `/api` call answers `401` while the page (served by Vite) stayed `200` (voicebox-beads-t43w). No ticket, host token or other secret appears in a refusal.
   - Credential comparison has one owner, `lib/timing-safe.mjs` (`timingSafeStringEqual`): equal lengths first, then `crypto.timingSafeEqual`, because the primitive throws on a length mismatch and a bad token must be a refusal rather than a crashed request. The `vb_session` cookie check here, the host token in `lib/extensions.mjs` (`hostTokenOk`), and both in-room session-token comparisons in `server.mjs` (extension authority and `POST /api/root`) now answer with that one implementation instead of four inline ones (voicebox-beads-sseh / GH #26). The gate still reveals the expected length, and no timing exploit is claimed for this local posture — this is hardening.
   - **Exempt Endpoints**:
     - `GET /api/health` (remains open for process supervisors and readiness checks; exposes no files or credentials).
     - `POST /api/bootstrap` (validates `x-voicebox-host-token` to mint a fresh ticket).
     - `GET /?bootstrap=<ticket>` (redeems the bootstrap ticket).
5. **Re-Entry Without Restarting (`POST /api/bootstrap`)**:
   - If a user clears their browser cookies, they can mint fresh single-use bootstrap URLs from the terminal using the host token:
     ```bash
     curl -X POST http://127.0.0.1:8787/api/bootstrap \
       -H "x-voicebox-host-token: $(cat ~/.config/voicebox/.host-token)"
     ```
   - The response is unchanged in shape: `url`, naming this server's origin, carrying one fresh single-use ticket. Redeeming it from the dev front means swapping the host in that URL (§2) — the fix for the reported symptom is guidance about the host, not a second credential (voicebox-beads-t43w).
6. **WebSocket Upgrade Protection (`/channel` & `/live`)**:
   - When `VOICEBOX_LOOPBACK_AUTH=1` is active, local same-origin WebSocket upgrades must present **both** a loopback `Origin` header and a valid `vb_session` cookie (`browser/acts.ts` sends the cookie automatically on same-origin upgrades).
   - Local processes that forge `Origin: http://127.0.0.1:8787` without the cookie fall through to the remote pairing-bearer check and fail with `executor-unauthenticated` (`/channel`) or `unauthenticated-call` (`/live`). Paired remote peers authenticating via `{"type":"hello","bearer":"vbx_..."}` continue to work unchanged.

---

## 2. Vite Dev Server Integration (`vite.config.js`)

When running `npm run dev` (`localhost:5173` fronting `127.0.0.1:8787`), the `loopback-bootstrap-proxy` plugin in `vite.config.js` intercepts requests carrying `?bootstrap=` and forwards them directly to `server.mjs`, returning the upstream status (including the redemption's `303` and its relative `Location`) and the `Set-Cookie` header to the browser on the `:5173` origin so subsequent proxied API and WebSocket requests carry `vb_session`. The redirect target is deliberately relative: the browser follows it back to the dev front it came in on — and stayed on the origin that now holds the cookie — instead of being handed to the `127.0.0.1:8787` API origin. That is why the startup text tells a dev-front user to open the **same ticket on `localhost:5173`** (§1 item 2): it is the host in the URL that decides where the cookie lands, and the ticket is the same one, redeemed once, on whichever host is opened first. The `/api` proxy hop rewrites `Origin` to the API target but preserves `Host`, which is what lets a refusal name the front a request came in on (§1 item 4). The `/live` and `/channel` WebSocket hops only rewrite `Origin` to the API target when the request genuinely originates from the dev front (Origin matches the addressed `Host` on loopback or allowed tailnet hosts; `voicebox-beads-efc6`); external cross-origin WebSocket requests retain their incoming Origin so `server.mjs` refuses them with `1008` rather than laundering them into local-page entitlement. Dev-front connections from non-loopback IP literals (such as LAN `192.168.x.x` or Tailscale `100.x.y.z`) similarly preserve their client Origin; remote peers require pairing bearer authentication in the initial hello JSON frame (`{"type":"hello","bearer":"vbx_..."}`) from a paired environment, or an allowed tailnet hostname (`*.ts.net`) via Tailscale Serve for remote browser access (`voicebox-beads-vc1h`, `voicebox-beads-ocoj`).

---

## 3. Summary of Protected Surfaces

| Caller / Scenario | Gate Off (Default) | Gate On (`VOICEBOX_LOOPBACK_AUTH=1`) |
|---|---|---|
| External website in browser (CSWSH) | Blocked (`Origin` check) | Blocked (`Origin` + `SameSite=Strict` cookie) |
| Local script with forged `Origin` (no ticket/token) | Allowed on loopback | **Refused** (`401` / WS `1008`) |
| Local CLI with `.host-token` (`x-voicebox-host-token`) | Allowed | Allowed |
| Paired remote environment (`vbx_...` bearer) | Allowed | Allowed |
| Browser launch workflow | Open `http://localhost:8787` | Open the printed `?bootstrap=` URL **on the host you browse** (cookies are per-host: swap `127.0.0.1:8787` for `localhost:5173` when you are on the dev front, §1 item 2); it redeems once and redirects to the plain route |

### Verification Suite
```bash
node --test tests/loopback-auth.test.mjs tests/server-bind-resilience.test.mjs
```
