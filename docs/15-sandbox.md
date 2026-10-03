# Environment Sandboxing & Boundary Probes

Voicebox isolates execution environments using OS-level sandboxes and verifies every environment's isolation boundaries by running an in-sandbox diagnostic probe (`tools/sandbox-probe.mjs`) rather than trusting static configuration labels.

---

## 1. Sandbox Isolation Tiers

Voicebox provides two Linux sandbox tiers for server environments:

1. **L1 — Bubblewrap Fence (`tools/fence.sh`)**:
   - Mounts `/usr` and `/etc` read-only (`EROFS`).
   - Mounts fresh `tmpfs` instances over `/tmp`, `/run`, `/var`, and `/home`.
   - Binds a single writable sandbox home directory from the host (`VOICEBOX_SANDBOX_HOMES`, default `~/sandbox-homes/<key>`).
   - Isolates the process tree with `--unshare-pid --die-with-parent`.
2. **L1.5 — Systemd + Bubblewrap Composition (`tools/fence-unit.sh`, `tools/voicebox-fence@.service`)**:
   - Launches the L1 bubblewrap fence inside a transient `systemd-run --user` unit.
   - Enforces kernel syscall filtering (`Seccomp: 2`), drops all effective capabilities (`CapEff: 0`), enables `PrivateTmp`, and sets `ProtectSystem=strict`.
   - Enforces a finite unit lifetime (`RuntimeMaxSec`, default `1800s`, configurable via `VOICEBOX_FENCE_MAX_SEC`). Units can be stopped explicitly via `DELETE /api/environments/<key>` (gated by `x-voicebox-host-token`) and are cleaned up automatically on server exit.

### Explicit Non-Goals of L1 / L1.5
- **Shared Network**: Interactive environments share the host network namespace so they can connect to cloud speech-to-speech providers (see [`14-s3-l2-bridge-decision.md`](14-s3-l2-bridge-decision.md)). The boundary report explicitly records `network: "passes"`.
- **Sandbox Home Outside `/tmp`**: Because L1.5 units enable `PrivateTmp`, sandbox home directories must reside outside `/tmp` (default `~/sandbox-homes/<key>`) so bind mounts succeed across namespaces.

---

## 2. Fenced Command & Git Execution (`tools/env-serve.mjs`)

Each booted sandbox runs `tools/env-serve.mjs` on its loopback port, mediated by the local host (`server.mjs`):

### Sandbox Endpoints
- **`POST /exec`**: Executes `{ argv: [...] }` directly or `{ command: "..." }` via `/usr/bin/sh -c`.
  - Requires `cwd` to resolve inside the sandbox `HOME` (`exec-cwd-outside-home`).
  - Enforces wall-clock timeouts (`timeoutMs`: `100`–`60,000ms`, default `10,000ms` → `exec-timeout`) and output caps (`maxBytes`: `1,024`–`1,048,576`, default `256 KiB` → `exec-output-over-budget`). Timed-out commands terminate the entire process group.
  - Commands run with a scrubbed child environment (`lib/fence-child-env.mjs`) containing only standard system variables (`PATH`, `HOME`, `TMPDIR`, `USER`, `LOGNAME`, `SHELL`, `LANG`, `TERM`, `XDG_CONFIG_HOME`, `GIT_CONFIG_GLOBAL`, `VOICEBOX_FENCE`), excluding host API keys and host `GIT_DIR` / `GIT_WORK_TREE` variables.
- **`GET` / `POST /git/config`**: Reads or writes the sandbox's isolated Git identity (`user.name`, `user.email`) in `<sandbox-home>/.gitconfig`.
- **`POST /git/init`**: Initializes a Git repository inside the sandbox workspace.

### Host Proxy & Bearer Authentication
- The browser calls `POST /api/environments/<key>/exec`, `GET` / `POST /api/environments/<key>/git/config`, and `POST /api/environments/<key>/git/init` on `server.mjs`.
- Mutating endpoints on `tools/env-serve.mjs` require the pairing bearer (`VOICEBOX_BEARER`) minted when the host booted the fence. Unpaired requests are refused with `exec-unpaired`.

---

## 3. Earned Boundary Levels (`measureBoundary`)

When an environment boots, `measureBoundary` in `lib/fence-provider.mjs` evaluates the environment's self-probe report (`measuredBy: "probe"`) across four axes:

| Verdict | Meaning |
|---|---|
| `fenced` | Probe measured the boundary and confirmed isolation holds. |
| `not-fenced` | Probe measured the boundary and detected a violation (listed in `violations`). |
| `passes` | Axis is intentionally shared (such as outbound network access). |
| `not measured` | Probe did not measure this axis. |

From these axis verdicts, `measureBoundary` derives the overall `level`:
- **`L1.5`**: Filesystem `fenced` + Processes `fenced` + `Seccomp: 2` + `CapEff: 0`.
- **`L1`**: Filesystem `fenced` + Processes `fenced` (without kernel seccomp/capability lockdown).
- **`not-earned`**: Probe ran and detected one or more boundary violations.
- **`unmeasured`**: Probe has not yet run or lacked required sections.

---

## 4. Reading `probe.json` (`GET /api/probe`)

`GET /api/probe` runs `tools/sandbox-probe.mjs` inside the environment and caches the result at `<workspace>/probe.json` (mode `0600`):

- **`probe` & `when`**: Schema version (`sandbox-probe/1`) and ISO timestamp of the measurement.
- **`identity`**: Process UID, GID, supplementary groups, working directory, and OS platform.
- **`sandboxHints`**: Kernel status values from `/proc/self/status` (`seccomp`, `capEff`), mount table sample (`mountSample`), and systemd unit indicators.
- **`filesystem`**: Tests path listability and writability by attempting to create and unlink a temporary marker file (`.sandbox-probe-<pid>-<when>`), reporting `EROFS` (read-only mount), `EACCES` (permission denied), or `ENOENT` (absent). Orphaned markers from interrupted probes are automatically cleaned up at startup.
- **`limits`**: CPU count, system memory, and `/proc/self/limits` soft/hard rlimits.
- **`tools`**: Probes availability of common developer binaries (`node`, `git`, etc.) with bounded concurrency (at most 8 at a time).
- **`network`**: Tests DNS resolution (bounded to 4s) and outbound TCP connectivity (`1.1.1.1:443` and `example.com:80`).

---

## 5. Key Implementation Files

| Subsystem | Files |
|---|---|
| L1 & L1.5 Sandbox Launchers | `tools/fence.sh`, `tools/fence-unit.sh`, `tools/voicebox-fence@.service` |
| Diagnostic Probe & Cache | `tools/sandbox-probe.mjs`, `server.mjs` (`GET /api/probe`) |
| Boundary Evaluation & Lifecycle | `lib/fence-provider.mjs`, `lib/unit-fence-provider.mjs` |
| Fenced Server & Child Environment | `tools/env-serve.mjs`, `lib/fence-child-env.mjs` |
| WebAssembly & Extension Gates | `lib/wasm-shelf.mjs`, `lib/wasm-worker.mjs`, `lib/extensions.mjs`, `core/extensions.ts` |
