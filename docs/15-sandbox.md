# The sandbox: what bounds an environment, what it does not, and how to read the reports

**This page is written by hand.** Its subject is machine-generated output — a probe report, a
boundary report, a proposals folder — but none of its text is generated from that output. Where
this page and a live report disagree, **the report is the fact and this page has a bug**; check
the report's `when` first, then file against this page.

## What the sandbox is

Voicebox runs work in **environments**, and an environment's security story is a **measured
boundary**, never a configured label. The word "sandbox" here covers two rungs that are built and
driven, both of which bound *filesystem and processes* and deliberately do not bound *the network*:

- **L1 — the fence** ([`tools/fence.sh`](../tools/fence.sh)): bubblewrap with `/usr` and `/etc`
  read-only, fresh `tmpfs` on `/tmp /run /var /home`, **one** writable home bound in from the host,
  `--unshare-pid --die-with-parent`. No root, no daemon, nothing installed.
- **L1.5 — the composition** ([`tools/fence-unit.sh`](../tools/fence-unit.sh)): the same fence
  launched inside a transient `systemd-run --user` unit that adds the kernel half the fence lacks —
  a seccomp filter (`Seccomp: 2`), an empty capability set (`CapEff: 0`), `PrivateTmp`, and
  `ProtectSystem=strict` with the one sandbox home as the writable exception. Units are transient
  by design, so they are bounded in time: `RuntimeMaxSec` (default 1800s, `VOICEBOX_FENCE_MAX_SEC`
  overrides) reaps a forgotten sandbox, the host stops one by name with
  `DELETE /api/environments/<key>` (host-token gated), and the server stops the units it booted on
  exit. Without these, every declare-and-boot leaks a unit, a port and its RSS until reboot —
  measured at 42 orphaned units and ~2.8 GB in one night (voicebox-beads-4kp).

## What it does not do — say it plainly, because each of these is someone's assumption

- **The network is shared.** The fence passes it through, and the boundary report's `network` axis
  says `passes` with the measurement that showed it. A probe reaching outbound 443 from inside a
  fence is the design working, not a bug. (The browser placement is the mirror: strong structural
  containment, weaker egress — see `02-environment.md` §1.1b.)
- **Ambient credentials are not fenced.** A process inside reads what its uid can read. The
  `credentials` axis reports seccomp/CapEff, and its note says this.
- **The digest binds bytes, never behavior.** A wasm tool's module is rehashed at admission and
  again at every call, so the bytes that run are the bytes that were admitted — but what those
  bytes *do* is bounded only by host constants: a call deadline, worker memory limits, a file-read
  bound. No declaration inside a descriptor buys more of any of them.
- **`/tmp` is not a place for a sandbox home.** The L1.5 unit's `PrivateTmp` hides the caller's
  `/tmp`; a home under it fails to bind (`226/NAMESPACE`). Homes live outside `/tmp` — the default
  is `~/sandbox-homes/<key>` (`VOICEBOX_SANDBOX_HOMES`).

## The boundary report: how a level is earned

The registry row for a booted environment carries a `boundary` produced by `measureBoundary`
([`lib/fence-provider.mjs`](../lib/fence-provider.mjs)) from the environment's **own probe**, run
inside it. Its provenance field is `measuredBy: "probe"` — a hand-written boundary in a descriptor
is nulled on read, because the probe is its only writer.

Every axis is **tri-state**, and the two absences are different facts:

| verdict | means |
|---|---|
| `fenced` | measured, and the bound holds |
| `not-fenced` | measured, and the bound **does not** hold — `violations` names which |
| `passes` | measured, and this axis deliberately does not bound (network; seccomp-off credentials) |
| `not measured` | the probe never saw this axis — **never** read as denied |

The `level` is **derived from those measurements, never stamped by a caller**:

- **`L1.5`** — files fenced ∧ processes fenced ∧ `Seccomp: 2` ∧ CapEff all-zero.
- **`L1`** — the fence's two axes fenced, without the kernel lockdown.
- **`not-earned`** — measured, and something failed; the axes carry the violation names.
- **`unmeasured`** — the probe never measured enough to say anything.

`not-earned` and `unmeasured` are **legitimate outcomes**, not errors: a unit that silently failed
to apply seccomp reports `L1`, and a report that could not see the fence reports what it saw.

## `probe.json`: the cache, field by field

`GET /api/probe` runs [`tools/sandbox-probe.mjs`](../tools/sandbox-probe.mjs) **on the environment
itself** — unprompted, the first time — and caches the report at **`<workspace>/probe.json`**
(mode `0600`: it carries identity facts). The act is recorded in the environment's own audit,
because it is the first time something ran somewhere unasked. A cached report is served with
`cached: true` and its `when`; a probe that cannot run is the named refusal `probe-failed`, never
a blank.

The probe's own rules: **facts with the method beside them, never verdicts**; `false`, `absent`
and `refused` are three different words. Fields:

- **`probe`** — the schema name and version (`sandbox-probe/1`). A reader who knows one knows the other.
- **`when`** — when it ran. Everything else is stale relative to this, not to your clock.
- **`identity`** — user, uid/gid/groups, cwd, platform. *Read as:* whose eyes the rest of the
  report is seen through.
- **`sandboxHints`** — evidence about the *kind* of place, each entry naming where it was read.
  `seccomp` is `0=off 1=strict 2=filter` from `/proc/self/status`; `capEff` is the capability mask;
  `mountSample` shows the bwrap binds; `invocationId`/`systemdEnv` say a systemd unit is present.
  *Read as:* hints, never a conclusion — these are the two numbers the L1.5 unit changes (0→2,
  nonzero→zero), and the reader decides.
- **`filesystem`** — per path: `listable`, and `writable` measured **by doing** (create a file,
  unlink it). `writable.value: false` with `error: "EROFS"` is a read-only mount; `"EACCES"` is a
  denial; `ENOENT` is absence. Probe writability checks create and unlink `.sandbox-probe-<pid>-<when>`;
  orphaned markers left if a probe process is SIGKILL'd mid-write are swept at server boot and
  on probe start by checking PID liveness (`kill -0`), preventing probe artefacts from polluting the tree (`voicebox-beads-ebq`).
  *Read as:* absence is not refusal and neither is not-permitted.
- **`limits`** — CPU count, total/free memory, and `/proc/self/limits` as `{soft, hard}` per name.
  *Read as:* the OS's numbers for this process — a moment, not a promise, and not the sandbox's
  bounds (those are the host constants above).
- **`tools`** — which binaries actually ran (`node`, `git`, …), each `{value}` or `{error}`.
  *Read as:* what a turn here can invoke. "not present" and "present but refused" are different
  answers, and this is the field the environment list shows as its tool count.
- **`network`** — DNS and outbound TCP attempts, each `ok` with a timing or a named error.
  *Read as:* **attempted is not carried** — `ok: true` means a connection completed. Inside the
  fence this is expected: the network is shared, and this axis is how the report says so.

## The proposals folder: `<workspace>/proposals/`

The model's door to the tool surface — **inside its own root**, so a turn can knock without
holding anything. Mechanics ([`lib/extensions.mjs`](../lib/extensions.mjs)):

- **What lands:** a descriptor JSON per proposal (`<id>.json`), written by `propose()` — from the
  `make-tool` verb, a `POST /api/extensions/proposals`, or a sideload. A proposal is **data**:
  nothing loads, evaluates or registers because a file appeared.
- **Who writes:** the proposing side only. The host decides: `admitProposal` runs the gate
  (`core/extensions.ts` — the closed primitive set, declared capabilities, bounds), records
  admission, and moves the state to `admitted` or `refused` **with the rule and the why** — a
  refusal is the artefact, not a footnote. Approval needs a one-use code from the host console;
  the page can disclose, never decide.
- **The fourth state:** a file present in the host's directory with no recorded admission is
  **present-not-admitted** — visible in the inventory as exactly that, never live, never swept in
  by the next admission.
- **Fail-closed at load:** the loader re-runs the gate on every admitted descriptor at every
  server start. The loaded set is what passed both the admission *and* the gate — an edit to a
  stored descriptor that breaks the rules means it simply does not load.

## Where the code lives

| thing | file |
|---|---|
| the fence (L1) | `tools/fence.sh` |
| the composition (L1.5) | `tools/fence-unit.sh`, `tools/voicebox-fence@.service` |
| the probe | `tools/sandbox-probe.mjs` |
| boundary derivation | `lib/fence-provider.mjs` (`measureBoundary`) |
| booting + serving | `lib/fence-provider.mjs`, `lib/unit-fence-provider.mjs`, `tools/env-serve.mjs` |
| wasm tools at the gate | `lib/wasm-shelf.mjs`, `lib/wasm-worker.mjs`, `core/extensions.ts` |
| proposals + admission | `lib/extensions.mjs`, `core/extensions.ts` |
| the probe cache route | `server.mjs` (`GET /api/probe`, `writeProbeCache`) |
