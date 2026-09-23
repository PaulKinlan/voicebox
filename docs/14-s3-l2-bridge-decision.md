# 14 — S3: The L2 Bridge Decision (`voicebox-beads-qmn`)

- **Bead:** `voicebox-beads-qmn` (P2)
- **Status:** DECIDED — the network bridge for interactive server environments is **DECLARED OUT OF SCOPE**; `--unshare-net` is reserved for offline batch task sandboxes.
- **Companion documents:** [`docs/02-environment.md`](02-environment.md) · [`docs/08-how-it-runs.md`](08-how-it-runs.md) · [`journal/topics/sandbox-mechanisms.md`](../../journal/topics/sandbox-mechanisms.md)
- **Driven evidence:** [`reports/sandbox-survey-20260920/`](../../journal-data/reports/sandbox-survey-20260920/) (`probe-bwrap.json`, `attack-battery.net.out`)

---

## 1. The Question

In the sandbox ladder defined under `voicebox-beads-dkt`:
- **L1 (bwrap)**: Filesystem fenced (code EROFS, sandbox home writable) + processes fenced (pidns isolation). Network is shared.
- **L1.5 (systemd-run --user + bwrap)**: L1 + kernel lockdown (seccomp filter mode 2, empty capability set `CapEff=0`, PrivateTmp). Network is shared.
- **L2**: Complete network namespace isolation (`--unshare-net`).

The closure of `--unshare-net` was driven in both directions during the initial survey:
- When a sandbox is launched with `--unshare-net`, its network namespace contains only loopback (`lo`). Physical adapters (`enp4s0`), VPNs (`tailscale0`), and external routes disappear.
- Outbound TCP and DNS queries fail immediately with `ENETUNREACH` / `ECONNREFUSED`.
- The sandbox server binds `127.0.0.1:<port>` *inside its private network namespace*, meaning the host and the browser page (`environment.html`) cannot connect to it (`ECONNREFUSED` / no listener on the host loopback).

Bead `voicebox-beads-qmn` asks for **the one decision**:
Either build an inbound network bridge (`socat` / `nsenter` / Unix Domain Socket relay) so the browser page can reach a net-fenced server, or declare the network bridge out of scope for interactive page-facing server environments and label the level report accordingly.

---

## 2. Analysis of the Two Options

### Option 1: Build the `socat` / `nsenter` Bridge

#### How the bridge works:
1. The server inside the sandbox binds a Unix Domain Socket (UDS) mounted from the host (or a bridge process enters the sandbox network namespace).
2. On the host, a companion forwarder (`socat` or a Node relay) binds a host loopback port and forwards traffic into the sandbox socket.
3. The browser page connects to the host loopback port; the bridge relays HTTP and WebSockets into the isolated netns.

#### What Option 1 closes:
- **Closes outbound loopback snooping:** Software running inside the sandbox cannot connect to host loopback services (such as the fleet daemon on port 4441, other lanes' dev servers on port 8787, or local database ports).
- **Closes LAN and internet egress:** Raw TCP/UDP connections to the local network or internet are blocked at the kernel network namespace boundary.

#### What Option 1 costs and why it breaks down:
1. **The Core Product Contradiction (The Silent Model Failure):**
   Voicebox is an interactive live-voice assistant. Its server dials **Gemini Live** or **OpenAI Realtime** over outbound WebSockets.
   Inside `--unshare-net`, outbound connections to `generativelanguage.googleapis.com` or `api.openai.com` fail with `ENETUNREACH`.
   An inbound bridge solves only half the connection: the browser page can reach the server, but the server **cannot reach any AI model**. The environment boots and serves, but cannot think or speak.
2. **The Outbound Proxy Trap (The `srt` Precedent):**
   To restore model connectivity in an `--unshare-net` sandbox, one must also build an outbound HTTP/TLS filtering forward proxy (such as Anthropic's `@anthropic-ai/sandbox-runtime` proxy).
   As recorded in `journal/topics/sandbox-mechanisms.md`, `srt`'s proxy introduced massive complexity: IPv6 loopback requirements, `NO_PROXY` rewriting issues, proxy self-reading deadlock within deny policies, and path-widening CVEs. Adding an outbound MITM proxy to Voicebox is an enormous, fragile subsystem.
3. **Operational Overhead:**
   Requires external binary dependencies (`socat`, `nsenter`), manages paired process lifecycles, and introduces socket file leaks on unclean process termination.

---

### Option 2: Declare the Network Bridge Out of Scope for Interactive Server Environments

#### How it works:
1. The interactive server environment ladder deliberately stops at **L1.5**:
   - Filesystem: **`fenced`** (code read-only EROFS, sandbox home writable, host home unreadable).
   - Processes: **`fenced`** (pidns isolation, only sandbox processes visible).
   - Syscalls & Capabilities: **`fenced`** (`seccomp: 2`, `capEff: 0000000000000000`).
   - Network: **`passes`** (explicitly labeled as `passes`, with note: *"the network is SHARED with the host — this fence does not bound it; internet reach is separate"*).
2. `--unshare-net` is reserved for **offline batch task execution** (e.g. delegated compilation, data transforms, unit test execution under D1/D2), where tasks run to completion without serving an interactive web UI or connecting to cloud voice APIs.

#### What Option 2 closes and what it does not:
- **What it closes:**
  - It eliminates the illusion that an environment is network-isolated when it actually requires an outbound hole punched to reach cloud providers.
  - It avoids importing proxy bugs, external tooling dependencies, and bridge failure modes.
  - It preserves the core doctrine: **"Remote descriptor metadata does not sandbox an agent — the level shown is the probe's measured report, never a configured label."** The probe report truthfully reports `network.verdict: "passes"`.
- **What it leaves open:**
  - Code running inside an L1.5 interactive server environment retains ambient network egress and can dial host loopback services.

---

## 3. Comparison Matrix

| Property | Option 1: Inbound Bridge (`socat`/`nsenter`) | Option 2: Declare Out of Scope for Server (Recommended) |
|---|---|---|
| **Inbound Page Access** | Bridged via UDS/TCP relay | Native loopback (ambient) |
| **Outbound Host Loopback Egress** | Denied (`ECONNREFUSED`) | Shared (`passes`) |
| **Outbound Cloud Model Access (Gemini/OpenAI)** | **BROKEN (`ENETUNREACH`)** unless full proxy built | **Working** (native outbound TLS) |
| **External Binary Dependencies** | `bwrap` + `socat` + `nsenter` | `bwrap` + `systemd-run` |
| **Failure Modes** | Port races, broken proxying, orphan sockets | None (shares existing network namespace) |
| **Truthfulness of Report** | Labels environment "L2" despite proxy holes | Honestly reports `L1.5` with `network.verdict: "passes"` |

---

## 4. The Decision

**DECISION: Declare the inbound network bridge OUT OF SCOPE for interactive server environments. S3 (`voicebox-beads-qmn`) is CLOSED.**

### Rationale:
Building a bridge so a browser page can talk to an `--unshare-net` server that cannot talk to any AI model creates an environment that answers health checks but cannot perform its core function. Bypassing the network isolation with an outbound proxy recreates all the known defects of `srt` without adding security value.

The interactive server environment ladder is complete at **L1.5**:
1. Filesystem: fenced
2. Processes: fenced
3. Syscalls & Capabilities: locked down via `systemd-run --user`
4. Network: shared, truthfully reported as `passes`

`--unshare-net` remains a valid mechanism in `tools/fence.sh`, but belongs strictly to offline batch execution tools (`delegate_task`), not the interactive live-voice server.

---

## 5. Re-Open Conditions

This decision should only be re-opened if one of the following concrete architectural changes occurs:
1. **Local Model Execution:** Voicebox introduces a fully local, on-device model runner (e.g. an embedded llama.cpp/Ollama instance running inside the sandbox or via local IPC), eliminating the requirement for outbound internet access to Google/OpenAI.
2. **Approved Outbound Proxy Substrate:** A production-grade, hardened forward proxy specification is established for the fleet that provides TLS termination, domain-whitelisting, and credential stripping without the gotchas of ad hoc `socat` bridges.
