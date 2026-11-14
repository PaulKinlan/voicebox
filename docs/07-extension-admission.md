# Extension Admission & Capability Gate

Voicebox uses a strict, capability-mediated extension system (`core/extensions.ts`, `lib/extensions.mjs`). Extensions are pure JSON descriptors that parameterize a closed set of host-mediated primitives—never arbitrary model-authored JavaScript. Both user-sideloaded extensions and model-proposed extensions pass through the same admission gate and require explicit host authorization before becoming callable.

---

## 1. Closed Primitive Set & Capability Rules

Every extension tool maps to one of the built-in primitives defined in `core/extensions.ts` (`now`, `read-file`, `write-file`, `list-files`, `http-get`, `wasm`). When `admit(descriptor, placement, existingTools)` evaluates a descriptor, it verifies that every required capability is declared and enforceable on the target placement:

| Refusal Rule | Trigger Condition | Reason |
|---|---|---|
| `exec-absent` | Declares `exec` or `runsIn: "process"` | Unbounded child process execution is not permitted on the `machine` placement outside an isolated container. |
| `eval-not-a-tool-path` | Declares `eval` | Dynamic code evaluation bypasses host capability mediation. |
| `capability-unmediated` | Declares `import` or `delete` | No host primitive mediates dynamic module imports or file deletion in extensions. |
| `network-unbounded` | Declares `network` without `hosts` and `maxRequests` | Network-capable extensions must declare explicit allowed hosts and a finite request budget. |
| `undeclared-credential` | A `params.headers` value interpolates a `$VAR` that `bounds.credentials` does not name | A header reads the host's environment, so the descriptor must name **which** variable it reads; the reachable secret set is the declared set, never "whatever the process holds" (TM-EXT-004). |
| `bad-credential-name` | A credential name (in `bounds.credentials` or a header's `$VAR`) is not `/^[A-Z][A-Z0-9_]*$/` | A credential is one environment variable, named exactly — no expression, no composite value, and nothing that looks like `$A$B` reaches `process.env`. |
| `under-declared` | Uses a primitive whose capability is omitted from `capabilities` | Every consumed capability must be explicitly declared in the descriptor. |
| `unknown-primitive` | References a primitive outside `PRIMITIVES` | Prevents execution of arbitrary or unmediated tool bodies. |
| `duplicate-tool` / `bad-tool-name` / `no-tools` | Invalid tool naming or empty `tools` array | Enforces unique, well-formed tool identifiers. |

### Path Containment at Execution Time
For file primitives (`read-file`, `write-file`, `list-files`), path containment is enforced on every invocation (`outside-root` for `../` or symlink escapes; `dotfile-refused` for hidden dotfiles such as `.host-token`).

---

## 2. Proposal, Disclosure & Host Admission Lifecycle

1. **Proposal & Staging (`proposals/<id>.json`)**:
   - **Model Proposal**: Calling `propose_extension` (or the `make-tool` verb) writes a pending JSON descriptor to `<workspace>/proposals/<id>.json`. Staging a proposal never loads or executes it.
   - **User Sideload & Local Creation**: `POST /api/extensions/sideload` and `POST /api/extensions/local` (`tools/create-extension.mjs`) validate the descriptor and stage it in `proposals/`.
2. **Capability Disclosure Plan (`GET /api/extensions/{proposals|catalogue}/<id>/plan`)**:
   - Before an extension is admitted, the plan endpoint returns the full capability disclosure: declared capabilities, the enforcement mechanism for each (`host-primitive-scope`, `mediated-fetch`, `csp-connect-src`), granted host interfaces, and capabilities that remain permanently prohibited (`exec`, `eval`, `import`). When the descriptor reads host secrets, the plan names the exact variables it may read (`credentials: BRAVE_API_KEY — …`) beside the hosts it may reach, because approving the plan is a decision about both.
3. **Host-Authorized Admission**:
   - **Via Host Token (`POST /api/extensions/admit`)**: Requires `x-voicebox-host-token` (stored in `.host-token` with `0600` permissions in `VOICEBOX_EXTENSIONS_DIR`). Unauthenticated requests fail with HTTP `403` (`host-token-required`).
   - **In-Room Admission (`POST /api/extensions/approve` with the room's session token)**: The room UI approves a proposal in place, and that act INSTALLS an extension — an admitted extension interpolates `$ENV_VAR` at run time, so the door is credential-bearing rather than positional. It requires `x-voicebox-session-token` (the token minted per server process and served into the room's own page) or `x-voicebox-host-token`; a bare `Origin` in the local page origins is **not** enough and is refused with HTTP `403` (`room-session-required`) (`voicebox-beads-93kz`, TM-EXT-014). The distinction matters because an `Origin` header is a claim any local process can write on a raw socket (docs/13 §1) and any same-origin page context can present, while the session token at least identifies the room. Its limit, stated plainly: that token is served in `GET /`'s HTML, so a local process that can read this server's page can still replay it — only the host token, which the page cannot hold, distinguishes a process from the person at the keyboard. This is why the host token remains the door for `POST /api/extensions/admit`.
   - **The same credential gates every other management act (`voicebox-beads-nxpq`)**: `POST /api/extensions/revoke`, `POST /api/extensions/refuse`, `POST /api/extensions/:id/refuse`, `DELETE /api/extensions/:id`, `POST /api/extensions/reconfigure` and `PATCH /api/extensions/:id` asked only `hasExtensionAuthority()` after 93kz, whose third arm accepts a bare `Origin` — so a loopback process could widen an admitted extension's network bounds or revoke it outright with a header it had written itself. They now take `x-voicebox-session-token` or `x-voicebox-host-token` and refuse with `403 room-session-required`. The page's own flow is unchanged: `public/extensions-ui.mjs` already sends the room token from the page's `meta[name="voicebox-session-token"]` on exactly these requests.
   - **Via One-Time Console Approval Code (`POST /api/extensions/approval-request` → `POST /api/extensions/approve`)**:
     - Clicking **Request approval code** in the Extensions UI generates an 8-digit single-use code bound to the exact capability plan (`lib/extension-approval.mjs`), prints it to the server console, and writes `.pending-approval.json` (`0600`) for lookup via `node tools/approval-code.mjs`.
     - The code expires after 2 minutes, allows at most 5 attempts, and refuses if the underlying proposal changes (`approval-plan-changed`).
4. **Ledger-Backed Registry (`loadRegistry`)**:
   - Admitted descriptors are recorded in `.ledger.jsonl` inside `VOICEBOX_EXTENSIONS_DIR`.
   - At startup and reload, `loadRegistry` loads only descriptors that have a matching admission entry in `.ledger.jsonl` and pass `admit()` re-verification. Unadmitted files sitting in the directory are reported as `present-not-admitted` and never activated.

---

## 3. Mediated Network Execution & Redirect Bounds

When an admitted extension uses `http-get` (such as `catalogue/web-search.json` or `catalogue/brave-search.json`):
- **Host Allowlist**: Requests to hosts outside `bounds.hosts` are refused immediately with `host-not-allowed`.
- **Redirect Hop Verification**: HTTP fetches use `redirect: "manual"`. Every redirect hop is validated against `bounds.hosts` (`redirect-host-not-allowed`), counted against `bounds.maxRequests` (`budget-exhausted`), capped at 5 hops (`too-many-redirects`), and recorded in the audit log with both the redirect chain (`via`) and final origin (`servedBy`).
- **Credential & Secret Scrubbing in Logs**: Outbound requests, redirects, refusal error traces (e.g. `redirect-host-not-allowed` chain reporting), and tool invocations logged to console/logs are scrubbed through `lib/redact.mjs` (`redactSecrets`). Credentials and keys in URL query strings (e.g. `?token=...`, `?key=...`, `?api_key=...`) are replaced with `[redacted]`, while environment-interpolated headers log header names only, never secret values (voicebox-beads-l9i3).
- **Named Credentials Only (TM-EXT-004)**: A header value of the form `"$BRAVE_API_KEY"` is resolved from the host's environment at call time, and **only** when the descriptor names that variable in `bounds.credentials` — `catalogue/brave-search.json` declares `credentials: ["BRAVE_API_KEY"]`. The gate refuses a header interpolating an unnamed variable (`undeclared-credential`) at admission and again on every load and reconfiguration; the read site in `lib/extensions.mjs` resolves nothing outside the declared set, so the moment a secret would leave is the moment the declaration is checked. `bounds.credentials` is an admission fact, not a live setting: `POST /api/extensions/reconfigure` refuses to change it (`credentials-not-reconfigurable`) rather than ignoring it, so widening the set always requires a reviewed, re-admitted descriptor.
- **Remote vs. Local MCP**: Remote HTTP MCP descriptors (`catalogue/mcp-server-remote.json`) pass admission under `mediated-fetch`, whereas local stdio process MCP descriptors (`catalogue/mcp-server-local.json`) are refused with `exec-absent`.

---

## 4. Model Discovery & Invocation

Live voice sessions (`Gemini Live` and `OpenAI Realtime`) and text resolvers share the extension discovery and invocation tools defined in `lib/commands.mjs`:
- **`list_extensions`**: Returns admitted extensions (tool names, descriptions, primitives, and parameter names) alongside pending proposals and catalogue entries.
- **`call_extension`**: Invokes an admitted extension tool by name with optional `url`, `path`, or `content` arguments, enforcing all runtime bounds and recording the outcome to the audit log.

### Verification Suites
```bash
node --test tests/extensions.test.mjs tests/extension-tracing.test.mjs tests/extension-approval.test.mjs tests/extension-approval-ui.test.mjs tests/extensions-live.test.mjs tests/commands.test.mjs tests/resolver-gemini.test.mjs
```
