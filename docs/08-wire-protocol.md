# Wire Protocol & Channel Contract

When Voicebox routes actions between the server and a browser-owned root (`opfs` or `handle`) or a paired remote environment, messages travel over a structured JSON wire envelope (`core/wire.ts`) managed by the channel RPC broker (`lib/channel.mjs`).

---

## 1. Wire Envelopes (`core/wire.ts`)

`core/wire.ts` is a zero-dependency module that validates call and answer envelopes across both Node and browser workers:

```json
// Call Envelope
{ "v": 1, "callId": "call_1", "tool": "read_notes", "descriptorId": "notes", "args": {}, "boundsEcho": { ... } }

// Success Answer Envelope
{ "v": 1, "callId": "call_1", "ok": true, "observed": { ... } }

// Refusal Answer Envelope
{ "v": 1, "callId": "call_1", "ok": false, "refused": "<rule-id>", "why": "Human-readable explanation" }
```

### Security & Schema Guarantees
- **Admission Attribution (`descriptorId` & `boundsEcho`)**: Every tool call names the admitted extension (`descriptorId`) and echoes its admitted bounds. The receiving executor re-verifies the descriptor and bounds locally (`unattributed-call` if not admitted; `bounds-mismatch` if altered).
- **Strict Field Allowlist**: Neither calls nor answers can carry ambient permission grants (such as `decision: "allow"` or `grant: "everything"`); any unrecognized property is rejected with `unknown-field`.
- **Observed Outcomes Required**: A response with `ok: true` must include an `observed` object containing measured results; bare assertions without observed data are rejected.

---

## 2. Channel Broker Contract (`lib/channel.mjs`)

`createChannel` and `createExecutorDoor` in `lib/channel.mjs` provide a 3-method bidirectional RPC interface (`connected()`, `send(msg)`, `answer(callId, answer)`):
- **Immediate Offline Refusal**: If the peer is disconnected when `ask()` is called, it refuses immediately without transmitting frames.
- **Explicit Timeout & Abandonment**: Malformed frames never settle a pending call. Disconnecting calls `abandon()`, settling all in-flight requests with a named refusal rather than leaving callers hanging.
- **Exception Containment**: If an executor throws synchronously or rejects asynchronously, `createExecutorDoor` catches the error and returns `{ ok: false, refused: "exec-threw" }`.
- **Preserved Runtime Refusals**: Extension runtime refusals (`host-not-allowed`, `fetch-failed`, `budget-exhausted`) cross the wire unchanged with their original rule identifiers and request budget accounting.

### Peer Absence Refusal Vocabulary

| Failure Condition | When Browser Page is Peer | When Machine Host is Peer |
|---|---|---|
| Peer not connected | `no-page` | `machine-unreachable` |
| Call timed out waiting for answer | `page-timeout` | `machine-timeout` |
| Connection closed with call in flight | `page-closed` | `machine-closed` |

---

## 3. WebSocket `/channel` Authentication (`server.mjs`)

The `/channel` WebSocket endpoint in `server.mjs` enforces an entitlement check before any connection is registered as the active `pageSocket` executor:

1. **Same-Origin Local Browser**: Connections carrying a loopback `Origin` header (`http://127.0.0.1:<port>`, `http://localhost:<port>`, or `http://[::1]:<port>`, plus a valid session cookie when `VOICEBOX_LOOPBACK_AUTH=1` is enabled) are admitted directly. Because browsers enforce `Origin` headers on WebSocket upgrades, this blocks Cross-Site WebSocket Hijacking (CSWSH) from external web pages.
2. **Paired Remote Environment**: Connections without a local browser `Origin` must send an authenticated hello frame within `VOICEBOX_HELLO_BOUND_MS` (default `5000ms`):
   ```json
   { "type": "hello", "role": "environment", "bearer": "vbx_..." }
   ```
   The server validates `bearer` against `.pairings.json` (`readPairings()`).
3. **Refusal**: Unauthenticated or invalid connections receive `executor-unauthenticated` or `bearer-refused`, close with WebSocket status `1008`, and are never attached as `pageSocket`.

*(For protecting loopback endpoints against untrusted local processes running under other OS accounts, see [`13-local-browser-authentication-options.md`](13-local-browser-authentication-options.md) and [`18-loopback-session-auth.md`](18-loopback-session-auth.md)).*

### Verification Suite
```bash
node --test tests/channel.test.mjs
```
