# Proxied Custody & Multi-Environment Pairing

Voicebox enables a single browser interface to interact with tools, files, and coding agents across multiple local and remote execution environments. To protect remote credentials from browser exposure, Voicebox enforces **proxied credential custody** and **envelope-level environment identity**.

---

## 1. Overview & Security Model

- **Zero Browser Credential Custody**: The browser page never holds, stores, or transmits remote bearer tokens. Instead, the browser sends requests to its local Voicebox host (`server.mjs`), and the local host proxies calls to paired remote environments using host-held bearer tokens (`vbx_...`).
- **Envelope Identity (`envKey`)**: Every environment has a stable, self-issued cryptographic identity key defined in `core/environment.ts`. Cross-environment requests carry `envKey` as a dedicated envelope field validated against the host's environment registry (`environments.json`), keeping environment identity separate from extension tool admission (`descriptorId` in `core/wire.ts`).
- **Pre-Authentication Environment Resolution**: When a remote host receives an execution request (`POST /api/execute`), it resolves `envKey` against its own `environments.json` registry **before** checking the bearer token. If an environment was removed or re-keyed, stale credentials fail closed with `unknown-environment` rather than reaching a different environment identity.

```
Browser UI ──POST /api/call { envKey, tool, args }──▶ Local Host (server.mjs)
                                                             │
                                      Attaches host-held bearer (vbx_...)
                                                             ▼
                                              Remote Environment (/api/execute)
```

---

## 2. Host-Side Credential Custody (`HOST_DIR`)

All host credentials and pairing records live in the host state directory managed by `lib/state-dirs.mjs` (`VOICEBOX_EXTENSIONS_DIR`, outside every project workspace root and never served by static or file routes):

| File | Permissions | Purpose |
|---|---|---|
| `.host-token` | `0600` | Per-host secret required for administrative actions (`x-voicebox-host-token`). |
| `.pairings.json` | `0600` | Stores issued and outbound pairing bearer tokens (`vbx_...`) and `revokedBearers` by `envKey`. |
| `.api-keys.json` | `0600` | Stores provider API keys configured via the UI Settings dialog (`GET` / `PUT /api/keys`). |
| `.harness-settings.json` | `0600` | Stores the active coding agent harness selection configured via `GET` / `PUT /api/harnesses/active`. |

Bearer tokens are never logged, never returned to the browser, and never echoed in error or refusal messages.

---

## 3. Pairing & Revocation Lifecycle

Pairing a local host with a remote environment is an explicit, host-authorized operation gated by `x-voicebox-host-token`:

1. **Issue Pairing Bearer (`POST /api/pair`)**:
   - Called on the remote host with `x-voicebox-host-token` and `{ envKey }`.
   - The remote host verifies that `envKey` is declared in `environments.json`, generates a unique `vbx_...` bearer bound to `envKey`, and records it in `.pairings.json`.
2. **Record Outbound Bearer (`POST /api/pair/complete`)**:
   - Called on the local host with `x-voicebox-host-token` to store the remote's `vbx_...` call bearer for `envKey` in the local `.pairings.json`.
3. **Revoke Pairing (`DELETE /api/pair`)**:
   - Called with `x-voicebox-host-token` and `{ envKey }` to revoke a pairing immediately:
     - **Immediate Socket Termination**: Any active `/channel` executor socket or `/live` voice socket authenticated with that environment's bearer is immediately closed with WebSocket code `1008` (`pairing-revoked`), and pending calls are abandoned. Local same-origin browser sessions are unaffected.
     - **Durable Revocation**: The token is moved to `revokedBearers` in `.pairings.json` so subsequent calls return `pairing-revoked` (HTTP `403`) rather than a generic `bearer-refused`.
     - **Audit Trail**: When a machine workspace root is active, the revocation is recorded in `.audit/` with `rule: "pairing-revoked"`. If no machine root is declared, the response reports `logged: null` and `logRefused: "root-not-declared"`.

---

## 4. Proxied Execution & WebSocket Entitlement Gates

### HTTP Proxying & Fenced Environment Routes
- **Tool Calls (`POST /api/call` → `POST /api/execute`)**: The browser posts `{ envKey, tool, descriptorId, args }` to `POST /api/call`. The local host validates the call envelope, looks up the stored bearer for `envKey`, and forwards the request to the remote environment's `POST /api/execute` endpoint.
- **Sandboxed Environment Commands**: Host-mediated routes (`/api/environments/:key/exec`, `/api/environments/:key/git/config`, and `/api/environments/:key/git/init`) attach the environment's pairing bearer before forwarding commands to the fenced environment server (`tools/env-serve.mjs`).
- **Fleet Discovery & Session Contact**: `GET /api/fleet` and `POST /api/fleet/contact` (`lib/fleet.mjs`, `core/fleet.ts`) route agent discovery and session messages across paired environments using `environmentKey/agentId` addressing.

### WebSocket Upgrade Gates (`/live` and `/channel`)
Both `/live` (voice session gateway) and `/channel` (routed action executor) authenticate connections before allocating sessions or registering an executor:
1. **Local Same-Origin Browser**: Connections whose `Origin` matches the local server's bound loopback origin (`127.0.0.1`, `localhost`, or `[::1]`, plus the session cookie when `VOICEBOX_LOOPBACK_AUTH=1` is enabled) are admitted directly.
2. **Paired Remote Peer**: Non-local connections must send an initial authentication frame within `VOICEBOX_HELLO_BOUND_MS` (default `5000ms`):
   ```json
   { "type": "hello", "role": "environment", "bearer": "vbx_..." }
   ```
   Connections that time out or present an invalid or revoked bearer are refused by name and closed with WebSocket code `1008`.

---

## 5. Refusal Codes & Verification

| Refusal Code | HTTP / WS Status | Cause |
|---|---|---|
| `host-token-required` | HTTP `403` | Missing or invalid `x-voicebox-host-token` on `/api/pair`, `/api/pair/complete`, or `DELETE /api/pair`. |
| `unknown-environment` | HTTP `404` | Target `envKey` does not exist in `environments.json`. |
| `environment-not-paired` | HTTP `403` | Local host has no stored bearer for the requested `envKey`. |
| `pairing-revoked` | HTTP `403` / WS `1008` | The bearer for `envKey` has been explicitly revoked via `DELETE /api/pair`. |
| `bearer-refused` | HTTP `403` / WS `1008` | Presented `vbx_...` bearer is unrecognized or invalid for `envKey`. |
| `unauthenticated-call` | HTTP `401` / WS `1008` | Missing bearer token on `/api/execute` or `/live`. |
| `executor-unauthenticated` | WS `1008` | Unauthenticated non-local connection attempt on `/channel`. |
| `environment-unreachable` | HTTP `502` | Paired remote environment could not be reached over the network. |

### Verification Suites
```bash
node --test tests/proxied-custody.test.mjs tests/pairing-revocation.test.mjs tests/live-auth.test.mjs
```
