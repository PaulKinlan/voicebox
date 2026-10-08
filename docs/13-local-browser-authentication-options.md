# Local Browser Authentication Options for Loopback Endpoints

Both `/live` and `/channel` validate the request `Origin` against local loopback origins (`127.0.0.1`, `localhost`, `[::1]`) and require a cryptographic pairing bearer (`vbx_...`) for non-local peers. Because browsers enforce immutable `Origin` headers on WebSocket handshakes, this closes **Cross-Site WebSocket Hijacking (CSWSH)** from external web pages.

This document analyzes the **local loopback process boundary**: what a non-browser process running on the same machine can do, why embedding a token inside unauthenticated HTML does not add security, and how the opt-in bootstrap session gate (`VOICEBOX_LOOPBACK_AUTH=1`) works.

---

## 1. The Loopback Transport Constraint

Over loopback TCP (`127.0.0.1`), the operating system kernel does not attach browser identity to a socket. Any process running on the same machine (under the same user or a shared network namespace) can open a TCP socket and send `Origin: http://127.0.0.1:8787`.

### Why Embedding a Token in Unauthenticated HTML Is Ineffective
Injecting an ephemeral session token into openly served HTML (for example, `<meta name="voicebox-page-token" content="...">`) does not prevent local scripts from connecting:
1. **Readable Over Loopback**: If the HTML page is served without authentication, any local script can fetch the page over HTTP, extract the token, and pass it on a WebSocket connection.
2. **The Single-Use Dilemma**:
   - **Multi-use token**: A local script fetches the HTML once and reuses the token.
   - **Single-use token**: A local process can race the browser at startup, consume the single-use token first, and lock the user out (or break normal browser page reloads).

To distinguish the authorized user's browser session from an unprivileged local process, the initial credential must be delivered out-of-band rather than embedded in unauthenticated HTML.

---

## 2. Architectural Options Evaluated

### Option A: Host-Token Bootstrap Ticket (Implemented as Opt-In)
Established by tools such as Jupyter Notebook and VS Code Server (`code-server`):
1. When `VOICEBOX_LOOPBACK_AUTH=1` is set, the server does not serve HTML or API routes without an authenticated session.
2. At startup, the server mints a single-use cryptographic bootstrap ticket and prints the launch URL (`http://127.0.0.1:8787/?bootstrap=<ticket>`) to stdout (or mints one on demand via `POST /api/bootstrap` authenticated with `x-voicebox-host-token`).
3. Navigating to `/?bootstrap=<ticket>` redeems the ticket once, sets an `HttpOnly`, `SameSite=Strict` session cookie (`vb_session`), and answers `303` to the same route with the ticket removed — so the address bar is left holding the plain page a refresh can re-request.
4. Subsequent HTTP, REST API, and WebSocket (`/channel`, `/live`) requests require either the session cookie or `x-voicebox-host-token`.

### Option B: Browser-Generated WebCrypto Key & Console Pairing
1. On first load, the browser generates a non-extractable ECDSA P-256 keypair (`crypto.subtle.generateKey(..., false, ["sign", "verify"])`), stores it in IndexedDB, and displays a pairing code.
2. The user confirms the pairing code in the terminal using `.host-token`.
3. On each connection, the browser signs a server challenge nonce with its non-extractable private key.

---

## 3. Comparison Matrix

| Property | Default Baseline (`Origin` Check) | Option A: Bootstrap Ticket (`VOICEBOX_LOOPBACK_AUTH=1`) | Option B: WebCrypto Pairing |
|---|---|---|---|
| **Cross-site browser attacks (CSWSH)** | **Blocked** (`Origin` header) | **Blocked** (Cookie + `Origin`) | **Blocked** (Key signature) |
| **Other OS users / containers on shared loopback** | Unblocked | **Blocked** (`.host-token` mode `0600`) | **Blocked** (Console pairing) |
| **Same-UID local scripts** | Unblocked | Unblocked (can read `.host-token`) | **Blocked** (Non-extractable key) |
| **Direct URL launch (`http://localhost:8787`)** | **Yes** (zero friction) | Requires bootstrap URL on first load | Requires one-time console pairing |
| **Failure recovery** | Reload page | Open printed URL or call `POST /api/bootstrap` | Re-pair if IndexedDB is cleared |

---

## 4. Decision & Implementation

Voicebox implements **Option A (Host-Token Bootstrap Ticket)** as an opt-in security gate (`VOICEBOX_LOOPBACK_AUTH=1`), while keeping the zero-friction `Origin`-validated baseline as the default for single-user workstations:
1. **Consistent Authority Model**: Reuses the existing `0600` `.host-token` boundary already used for `/api/root`, `/api/pair`, and extension admission.
2. **Multi-User & Container Isolation**: Prevents other OS accounts or unprivileged containers sharing loopback from accessing the server or WebSocket endpoints.
3. **Full Implementation Details**: See [`18-loopback-session-auth.md`](18-loopback-session-auth.md) and `tests/loopback-auth.test.mjs`.
