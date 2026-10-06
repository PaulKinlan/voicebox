# Loopback Session Gate (`VOICEBOX_LOOPBACK_AUTH=1`)

`VOICEBOX_LOOPBACK_AUTH=1` enables an opt-in bootstrap ticket and `HttpOnly` session cookie gate on `server.mjs` and `vite.config.js` (implementing Option A from [`13-local-browser-authentication-options.md`](13-local-browser-authentication-options.md)).

While the default loopback `Origin` check blocks Cross-Site WebSocket Hijacking (CSWSH) from external websites, enabling `VOICEBOX_LOOPBACK_AUTH=1` additionally blocks unauthenticated local processes (such as other OS users or unprivileged containers sharing the loopback network) from accessing the web UI, REST APIs, `/channel`, or `/live`.

---

## 0. Default Posture: Gate OFF (accepted testing posture, owner ruling 2026-10-06)

The gate is **OFF by default**, and the owner has ruled it stays that way for testing (voicebox-beads-k74h). The default is accepted, not silent:

- **Startup warning.** When `VOICEBOX_LOOPBACK_AUTH` is unset, `server.mjs` prints a warning at startup naming the exposure and the flag remedy.
- **Browser-originated write risk.** With the gate off, the loopback `Origin` check distinguishes browser contexts but requires no credential. A page the operator merely visits can cause the browser to send requests that reach **state-mutating routes** — writing files into the **active workspace** and registering environments — with no credential, no prompt, and nothing visible in the page. The command-execution verb sits behind the same route wall. The response is not readable cross-origin, but the server has already acted.
- **Verified gate-on behaviour.** With `VOICEBOX_LOOPBACK_AUTH=1`, every such request is refused with `401` (`loopback-unauthenticated`) — including the request shapes a browser can send cross-origin without negotiation — while `GET /api/health` remains `200` for supervisors and readiness checks (it reports no root, no file, and no credential). This is pinned by `tests/loopback-auth.test.mjs`.

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
2. **One-Time Bootstrap Ticket**: On boot, the server mints a single-use 64-character hex ticket and prints the bootstrap URL to stdout:
   ```
   bootstrap  http://127.0.0.1:8787/?bootstrap=<64-hex-ticket>
   ```
3. **Ticket Redemption (`GET /?bootstrap=<ticket>`)**:
   - Opening the bootstrap URL validates and consumes the single-use ticket, then sets `vb_session=<secret>; HttpOnly; SameSite=Strict; Path=/` on the HTML response.
   - Reusing an already consumed or invalid ticket returns HTTP `401` (`bootstrap-ticket-refused`). Subsequent page reloads authenticate automatically via the `vb_session` cookie.
4. **HTTP & API Wall**:
   - Every HTTP request lacking a valid `vb_session` cookie or `x-voicebox-host-token` header is refused before reaching any route with HTTP `401` (`loopback-unauthenticated`).
   - **Exempt Endpoints**:
     - `GET /api/health` (remains open for process supervisors and readiness checks; exposes no files or credentials).
     - `POST /api/bootstrap` (validates `x-voicebox-host-token` to mint a fresh ticket).
     - `GET /?bootstrap=<ticket>` (redeems the bootstrap ticket).
5. **Re-Entry Without Restarting (`POST /api/bootstrap`)**:
   - If a user clears their browser cookies, they can mint a new single-use bootstrap URL from the terminal using the host token:
     ```bash
     curl -X POST http://127.0.0.1:8787/api/bootstrap \
       -H "x-voicebox-host-token: $(cat ~/.config/voicebox/.host-token)"
     ```
6. **WebSocket Upgrade Protection (`/channel` & `/live`)**:
   - When `VOICEBOX_LOOPBACK_AUTH=1` is active, local same-origin WebSocket upgrades must present **both** a loopback `Origin` header and a valid `vb_session` cookie (`browser/acts.ts` sends the cookie automatically on same-origin upgrades).
   - Local processes that forge `Origin: http://127.0.0.1:8787` without the cookie fall through to the remote pairing-bearer check and fail with `executor-unauthenticated` (`/channel`) or `unauthenticated-call` (`/live`). Paired remote peers authenticating via `{"type":"hello","bearer":"vbx_..."}` continue to work unchanged.

---

## 2. Vite Dev Server Integration (`vite.config.js`)

When running `npm run dev` (`localhost:5173` fronting `127.0.0.1:8787`), the `loopback-bootstrap-proxy` plugin in `vite.config.js` intercepts requests carrying `?bootstrap=` and forwards them directly to `server.mjs`, returning the `Set-Cookie` header to the browser on the `:5173` origin so subsequent proxied API and WebSocket requests carry `vb_session`.

---

## 3. Summary of Protected Surfaces

| Caller / Scenario | Gate Off (Default) | Gate On (`VOICEBOX_LOOPBACK_AUTH=1`) |
|---|---|---|
| External website in browser (CSWSH) | Blocked (`Origin` check) | Blocked (`Origin` + `SameSite=Strict` cookie) |
| Local script with forged `Origin` (no ticket/token) | Allowed on loopback | **Refused** (`401` / WS `1008`) |
| Local CLI with `.host-token` (`x-voicebox-host-token`) | Allowed | Allowed |
| Paired remote environment (`vbx_...` bearer) | Allowed | Allowed |
| Browser launch workflow | Open `http://localhost:8787` | Open printed `?bootstrap=` URL once |

### Verification Suite
```bash
node --test tests/loopback-auth.test.mjs tests/server-bind-resilience.test.mjs
```
