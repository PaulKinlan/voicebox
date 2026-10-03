# Sandbox Network Architecture Decision (L1.5 vs. L2)

- **Status**: Decided — Interactive server environments operate at **L1.5** (fenced filesystem, isolated PID namespace, and kernel syscall/capability lockdown with shared network). Full network namespace isolation (`--unshare-net`) is reserved for offline batch task execution.
- **Related Documents**: [`02-environment.md`](02-environment.md) · [`08-how-it-runs.md`](08-how-it-runs.md) · [`15-sandbox.md`](15-sandbox.md)

---

## 1. Background: The Sandbox Isolation Tiers

Voicebox defines three OS sandboxing tiers for Linux environments:
- **L1 (`tools/fence.sh` — `bwrap`)**: Read-only system mounts (`EROFS`), isolated writable sandbox home (`~/sandbox-homes/<key>`), and PID namespace isolation (`--unshare-pid`). Network namespace is shared with the host.
- **L1.5 (`tools/fence-unit.sh` — `systemd-run --user` + `bwrap`)**: Adds kernel lockdown (`seccomp` filter mode 2, empty effective capability mask `CapEff=0`, `PrivateTmp`, and `ProtectSystem=strict`). Network namespace is shared with the host.
- **L2 (`--unshare-net`)**: Complete network namespace isolation containing only an internal loopback interface (`lo`).

When a server is launched inside `--unshare-net`, two things happen:
1. Outbound TCP and DNS connections fail immediately with `ENETUNREACH` / `ECONNREFUSED`.
2. The sandbox server binds `127.0.0.1:<port>` inside its private network namespace, making it unreachable from the host browser without a network relay bridge.

This document records the architectural decision on whether to build a network relay bridge (`socat` / `nsenter`) for interactive Voicebox servers or standardize interactive servers at **L1.5**.

---

## 2. Evaluation of Options

### Option 1: Build an Inbound/Outbound Network Bridge (`socat` / `nsenter` + Forward Proxy)
1. **How It Works**: A host relay forwards loopback HTTP/WebSocket traffic into the sandbox's Unix Domain Socket or network namespace, while an outbound HTTP/TLS proxy forwards model requests out to cloud providers.
2. **Why It Fails for Interactive Voice Servers**:
   - **Cloud Model Requirement**: An interactive Voicebox server establishes live outbound WebSockets to **Gemini Live** (`generativelanguage.googleapis.com`) or **OpenAI Realtime** (`api.openai.com`). An inbound bridge alone leaves the server unable to reach any AI model (`ENETUNREACH`).
   - **Outbound Proxy Complexity**: Punching an outbound hole through `--unshare-net` requires maintaining a custom HTTP/TLS forward proxy, re-introducing network egress while adding failure modes (socket leaks, DNS/IPv6 proxy edge cases, and external binary dependencies).

### Option 2: Standardize Interactive Server Environments at L1.5 (Selected)
1. **How It Works**:
   - Interactive server environments run at **L1.5**:
     - **Filesystem**: `fenced` (read-only code mounts, isolated sandbox home, host home inaccessible).
     - **Processes**: `fenced` (`--unshare-pid` namespace isolation).
     - **Syscalls & Capabilities**: `fenced` (`seccomp: 2`, `capEff: 0000000000000000`).
     - **Network**: `passes` (explicitly reported by `lib/fence-provider.mjs` as shared with the host).
   - `--unshare-net` is reserved for offline batch execution where no interactive browser UI or cloud voice WebSocket is required.

---

## 3. Comparison Matrix

| Property | Option 1: Network Bridge (`socat`/`nsenter` + Proxy) | Option 2: L1.5 Shared Network (Selected) |
|---|---|---|
| **Browser UI Connectivity** | Relayed via Unix socket / TCP forwarder | Native loopback (`127.0.0.1`) |
| **Cloud Voice Model Connectivity** | Broken (`ENETUNREACH`) without custom TLS proxy | Native outbound TLS WebSockets |
| **External Dependencies** | `bwrap` + `systemd-run` + `socat` + `nsenter` | `bwrap` + `systemd-run` |
| **Boundary Report Accuracy** | Claims network isolation despite proxy holes | Truthfully reports `L1.5` with `network.verdict: "passes"` |

---

## 4. Re-Open Conditions

This decision should only be revisited if either of the following architectural changes occurs:
1. **Fully Local Model Inference**: Voicebox adds an on-device speech-to-speech model runner that requires zero outbound internet connectivity.
2. **Dedicated Fleet Egress Proxy**: A hardened, domain-allowlisting TLS proxy is deployed as a first-class infrastructure component.
