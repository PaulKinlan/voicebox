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
   - Before an extension is admitted, the plan endpoint returns the full capability disclosure: declared capabilities, the enforcement mechanism for each (`host-primitive-scope`, `mediated-fetch`, `csp-connect-src`), granted host interfaces, and capabilities that remain permanently prohibited (`exec`, `eval`, `import`).
3. **Host-Authorized Admission**:
   - **Via Host Token (`POST /api/extensions/admit`)**: Requires `x-voicebox-host-token` (stored in `.host-token` with `0600` permissions in `VOICEBOX_EXTENSIONS_DIR`). Unauthenticated requests fail with HTTP `403` (`host-token-required`).
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
