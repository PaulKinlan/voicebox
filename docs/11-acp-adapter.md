# Agent Client Protocol (ACP) Adapters

Voicebox integrates external coding agents—such as **Pi** (`lib/pi-acp.mjs`) and **Claude Code** (`lib/claude-acp.mjs`)—using the **Agent Client Protocol (ACP v1)** over stdio JSON-RPC (`lib/acp-client.mjs`).

---

## 1. Activating a Coding Agent Harness

You can activate a host coding agent harness in either of two ways:

1. **In the Browser UI (Recommended)**:
   - Click **Harnesses** in the top bar, inspect the detected coding agents on your machine, and click **Use Pi** or **Use Claude** (`PUT /api/harnesses/active`). The selection is saved in `.harness-settings.json` and activates the corresponding ACP executor immediately without restarting the server.
2. **Via Environment Variable at Startup**:
   ```bash
   VOICEBOX_HARNESS=pi npm start
   # or
   VOICEBOX_HARNESS=claude npm start
   ```

To verify installed harness binaries and adapter readiness from the terminal:
```bash
npm run doctor
```

When no harness is active, calling `delegate_task` returns `executor-unavailable`.

---

## 2. ACP Client & Executor Architecture

### Shared ACP Client (`lib/acp-client.mjs`)
`createAcpClient` manages the JSON-RPC stdio lifecycle for both Pi and Claude Code:
- **Handshake & Session Setup**: Sends `initialize`, creates a workspace session via `session/new`, configures model and reasoning options via `session/set_config_option`, and dispatches tasks via `session/prompt`.
- **Timeout Ceilings**: Enforces per-adapter wall-clock bounds (`60,000ms` ceiling for `pi-acp`; `120,000ms` `CLAUDE_ACP_TIMEOUT_CEILING_MS` for `claude-acp`, meta-capped at `600,000ms`) and a `64 KiB` output ceiling.
- **Three-State Cancellation**:
  - Calling `cancel()` during an active turn sends `session/cancel` (`{ ok: true, sent: true }`). When the adapter confirms `stopReason: "cancelled"`, the task settles as `task-cancelled`.
  - Calling `cancel()` when no task exists returns `task-not-found`.
  - Calling `cancel()` after a task has already settled returns `task-not-running`.
- **Unexpected Process Exit**: If the adapter subprocess exits before returning a prompt result, the task records a typed `TaskInterrupted` (`lib/task-interrupted.mjs`) with reason `harness-ended-outcome-unknown`.
  - A frame written to an adapter that has **already exited** fails — synchronously with `EPIPE`, or asynchronously as an `'error'` on the child's stdin. That write failure is not the task's outcome: the frame is dropped because there is nobody to receive it, and the exit descriptor (exit code, stage and stderr tail) is the diagnostic the caller sees. `isPeerGoneWrite` (`lib/acp-client.mjs`) names the peer-gone codes; any other write failure still surfaces as itself (`tests/acp-client.test.mjs`, `voicebox-beads-cps6`).

### Pi ACP Adapter (`lib/pi-acp.mjs`)
- Targets `pi-acp` (`0.0.34`) with `pi` (`0.87.1`). Override binary paths via `VOICEBOX_ACP_ADAPTER` and `VOICEBOX_ACP_PI`.
- Also provides `openPiAcpProbe()` for credential-free handshake verification inside bubblewrap isolation.
- **Anthropic Key Fallback**: Passes `ANTHROPIC_API_KEY` through to the `pi-acp` child environment so Anthropic-backed model selections succeed when Pi's internal auth store has no separate credential (`tests/pi-acp-options.test.mjs`).

### Claude Code ACP Adapter (`lib/claude-acp.mjs`)
- Drives `@agentclientprotocol/claude-agent-acp` over `runAcpTask`. Override the underlying CLI binary via `VOICEBOX_CLAUDE_CLI`.
- **Clean Child Environment**: By default, `lib/claude-acp.mjs` omits `ANTHROPIC_API_KEY` from the spawned child environment so an ambient key does not override an authenticated `claude.ai` CLI login. Set `VOICEBOX_CLAUDE_KEEP_API_KEY=1` (or `keepApiKey: true`) to explicitly retain the environment variable in the child process.

---

## 3. Configured Agent Options (`core/harness-config.ts`)

When `delegate_task` targets a configured agent entry (`core/harness-config.ts`, `lib/harness-config.mjs`), the adapter applies and validates its settings before running the prompt:
1. **Model Selection**: Forwarded via `session/set_config_option` (`configId: "model"`). Unsupported models fail pre-flight with `model-unsupported`.
2. **Thinking / Reasoning Effort**: When `model.thinking` is specified, forwarded via `session/set_config_option` (`configId: "thought_level"`). Unsupported levels fail with `thinking-level-unsupported`.
3. **System Persona (`agentConfig.prompt`)**: Prepended to the task prompt as system framing.
4. **Tool Reach Enforcement (`agentConfig.reach.tools`)**: Any tool request outside the agent's declared reach list is refused with `tool-not-in-agent-reach` before consulting host policy.
5. **Pre-Flight Validation**: Mismatched adapter versions, unsupported transports, or unconfigured harnesses fail closed with `adapter-not-configured`, `adapter-version-unsupported`, `unsupported-runtime-capability`, or `unsupported-model-options`.

---

## 4. Browser Placement Boundary

Stdio ACP adapters (`lib/pi-acp.mjs`, `lib/claude-acp.mjs`) spawn local OS subprocesses and therefore run on `machine` and `remote` placements (`lib/tasks.mjs`). Zero-server browser environments (`tests/acp-browser.test.mjs`) use `createBrowserTaskHost()` in `lib/task-placement.mjs` (see [`16-zero-server-delegation.md`](16-zero-server-delegation.md)).

### Verification Suites
```bash
VOICEBOX_ACP_ADAPTER="$PI_ACP_INSTALL_DIR" VOICEBOX_ACP_PI="$PI_BINARY" \
  node --test tests/acp-client.test.mjs tests/pi-acp.test.mjs tests/acp-browser.test.mjs tests/tasks.test.mjs tests/configured-harness.test.mjs
```
