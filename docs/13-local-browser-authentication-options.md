# 13 — The local browser boundary: authentication options for loopback endpoints (`2gq`)

**Context:** Following the landing of `voicebox-beads-5c1` (`76abcf8`), both `/live` and `/channel`
enforce an Origin check against `localOrigins` (`127.0.0.1`, `localhost`, `[::1]`) and require a
cryptographic pairing bearer for remote peers.

This closes the primary web attack surface: **Cross-Site WebSocket Hijacking (CSWSH)**. Because web
browsers enforce immutable `Origin` headers on WebSocket handshakes, an untrusted website running in
another tab (`http://evil.com`) cannot connect to `/channel` or `/live`.

This document addresses the **residual local boundary** tracked under epic `voicebox-beads-2gq`
and milestone `voicebox-beads-dv3`: *what can a non-browser process running on the same machine
still do, why minting a token into openly served HTML is an illusion, and what real architectural
alternatives exist.*

---

## 1. The Core Transport Constraint

Over loopback TCP (`127.0.0.1`), the operating system kernel does not distinguish which local
process originated a TCP connection. Any process on the machine (running as the same user, or in a
shared network namespace) can write `Origin: http://127.0.0.1:3000` on a raw TCP socket.

### Why minting a token in unauthenticated HTML does not close the gap

It is tempting to propose injecting an ephemeral session token into `environment.html`
(e.g., `<meta name="voicebox-page-token" content="...">`) and requiring the browser worker to
echo it on `/channel`.

This does **not** close the local process boundary:
1. **Readable by anyone who can reach the port:** Because `environment.html` is served openly over
   unauthenticated HTTP on loopback, any local process can run:
   ```bash
   PAGE_TOKEN=$(curl -s http://127.0.0.1:3000/environment.html | grep -o 'vbx_ptk_[a-f0-9]*')
   wscat -c ws://127.0.0.1:3000/channel -H "Origin: http://127.0.0.1:3000" --auth-token "$PAGE_TOKEN"
   ```
   If the HTML page is unauthenticated, any secret embedded in that HTML is equally unauthenticated.
   It stops blind scanners that do not inspect HTTP, but provides zero cryptographic defense against
   a script written for Voicebox.
2. **The Single-Use Dilemma:**
   - If the token is **multi-use**: The attacker script fetches `environment.html` once and reuses the token.
   - If the token is **single-use**: A background attacker script can race the user's browser at boot,
     fetch `environment.html` first, consume the only token, and permanently lock the owner out (a DoS
     created out of the fix). Furthermore, user reloads would break.

**Conclusion:** Minting a token into unauthenticated HTML creates the appearance of a credential
without the substance of one. To cryptographically distinguish the user's browser tab from an
arbitrary local script, the authentication must reside in a mechanism that cannot be fetched openly.

---

## 2. The Two Architectural Alternatives

### Option A: Host-Token Bootstrap Ticket (The Jupyter / VS Code Server Pattern)

This pattern is established by tools like Jupyter Notebook, VS Code Server (`code-server`), and
Chrome DevTools (CDP).

#### How it works:
1. The web server does **not** serve HTML or endpoints openly on loopback without an authenticated session.
2. The server launcher CLI (which reads `~/.config/voicebox/.host-token`, file mode `0600`) mints a
   cryptographic, short-lived, single-use bootstrap ticket (nonce) and opens the browser:
   `xdg-open http://127.0.0.1:3000/?bootstrap=<ticket>` (or prints the URL to stdout).
3. On the initial navigation, the server validates the bootstrap ticket, consumes it, and issues an
   `HttpOnly`, `SameSite=Strict` session cookie bound to `127.0.0.1:3000`.
4. Subsequent HTTP, API, and WebSocket requests (`/channel`, `/live`) require this session cookie.

#### What it closes:
- Completely bars any local process that cannot read `.host-token` (different user accounts on the
  same host, unprivileged sandboxes, containers with shared network).
- Prevents unauthenticated local scripts from fetching HTML or connecting to WebSockets.

#### What it changes and costs for the person using it:
- **Direct typing of the URL stops working:** The user cannot simply bookmark `http://localhost:5173`
  or type it into a browser tab. If their cookie expires or is cleared, opening the bare URL returns
  `401 Unauthorized — launch via CLI or provide bootstrap ticket`.
- **Launcher coupling:** The user must start the product via a CLI launcher (or desktop launcher)
  that passes the ticket into the browser URL.
- **Dev proxy complexity:** The Vite dev front (`5173`) must proxy and preserve the bootstrap ticket
  and session cookies to the backend (`3000`).

---

### Option B: Browser-Generated WebCrypto Key Material & Out-of-Band Pairing

This pattern treats the browser tab as an independent cryptographic environment, mirroring the
pairing model used for remote hosts (`/api/pair`).

#### How it works:
1. On first load of `environment.html`, the browser runs:
   ```javascript
   const keyPair = await crypto.subtle.generateKey(
     { name: "ECDSA", namedCurve: "P-256" },
     false, // extractable: false — private key CANNOT be exported
     ["sign", "verify"]
   );
   // Store keyPair in IndexedDB
   ```
2. The browser displays a short pairing code (e.g. `PAIR-7429`) in the UI.
3. The user confirms pairing in the terminal using host token authority:
   `voicebox pair-browser PAIR-7429` (or clicks an approval prompt in the host console).
4. The server records the browser's public key in `.pairings.json`.
5. On every `/channel` connection, the server sends a challenge nonce; the browser worker signs the
   nonce with its non-extractable private key.

#### What it closes:
- Distinguishes the browser tab from any other script running on the machine, **even under the same user UID**,
  because WebCrypto private keys marked `extractable: false` cannot be read via JavaScript or scraped from
  HTTP responses. Even if a local script can read `.host-token`, it cannot forge the browser's signature
  without user interaction.

#### What it changes and costs for the person using it:
- **One-time human pairing friction:** The user must perform an out-of-band console pairing step the first
  time they open Voicebox in a browser profile.
- **Storage fragility:** If the user clears site data / IndexedDB, the private key is destroyed and the
  browser must be re-paired.
- **Multiple tabs / profiles:** Each distinct browser profile or device requires its own pairing approval.

---

## 3. Comparison Matrix

| Property | Current (`5c1`) | Option A (Bootstrap Ticket) | Option B (WebCrypto Pairing) |
|---|---|---|---|
| **Cross-site browser attacks (CSWSH)** | **Blocked** (Origin check) | **Blocked** (Cookie + Origin) | **Blocked** (Key signature) |
| **Cross-user local scripts (diff UID)** | Unblocked | **Blocked** (`.host-token` 0600) | **Blocked** (Console pairing) |
| **Same-user local scripts (same UID)** | Unblocked | Unblocked (script reads 0600) | **Blocked** (Non-extractable key) |
| **Launch UX: Type URL in browser** | **Yes** (zero friction) | **No** (requires launcher / ticket) | **Yes** (after one-time pair) |
| **First-run friction** | Zero | Launcher launches browser | Console pairing command |
| **Failure recovery** | Reload page | Re-launch from terminal | Re-pair if storage wiped |
| **Implementation surface** | Landed (minimal) | Medium (cookie/ticket lifecycle) | Medium-High (WebCrypto/challenge) |

---

## 4. Recommendation & Next Steps

### Recommendation: **Option A (Host-Token Bootstrap Ticket)**, phased as an opt-in product gate.

**Why Option A over Option B:**
1. **Alignment with existing Voicebox security model:** Voicebox already establishes `0600` host token
   authority (`.host-token`) for `/api/root`, `/api/pair`, and extension admission. Option A extends this
   established authority boundary to the HTTP front, rather than introducing a second cryptographic
   identity subsystem (WebCrypto P-256 + challenge/response protocol) into client workers.
2. **Same-user threat reality:** In a developer workstation model, any script running under the *same*
   UID as the developer already has access to the developer's shell, files, and git repositories directly
   through the OS filesystem. Defending against the same UID over loopback while leaving `~/.config` and
   the filesystem accessible to that same UID is asymmetrical. Option A cleanly establishes the multi-user
   and sandbox isolation boundary (preventing other accounts or untrusted containers from reaching Voicebox).
3. **Established developer expectations:** Developers are familiar with the Jupyter / code-server launch
   pattern where starting the server prints a link with a one-time token.

### Proposed Path Forward:
- Keep `voicebox-beads-5c1` as the baseline on `main`: Origin enforcement stops all external/cross-site
  browser hijacking.
- Keep `voicebox-beads-dv3` as the architectural rationale documenting why an HTML-minted token is omitted.
- When `2gq` is prioritized for implementation, file a dedicated implementation bead:
  `[feat] launcher bootstrap ticket and session cookie for loopback HTTP/WS endpoints`.

> **LANDED (2026-09-25, opt-in):** the implementation bead was filed as `voicebox-beads-kkc` and built to
> this recommendation — `VOICEBOX_LOOPBACK_AUTH=1` turns on the host-token bootstrap ticket and the
> HttpOnly session cookie across the page, the APIs, and the `/channel` + `/live` local-page
> entitlement. Default off; the `5c1` surface is unchanged. What landed, and the proofs, are in
> [18 — The loopback session gate](18-loopback-session-auth.md).
