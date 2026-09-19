# Receipt: is a capability-based substrate a mechanism, or a policy sentence?

Date: 2026-09-19 · lane: ds-flash-2 · trigger: gemini applied §3.0 ("a guard must be a mechanism,
not a description") to §1.7's capability table and found `network`/`exec` on E2 to be descriptions.
Coord offered the hypothesis to **check rather than accept**: Deno's permission model enforces the
three axes natively.

**Verdict: largely right, with three corrections — one of them a live hole.**

## Method
`probe.ts` attempts each capability and prints `ALLOWED`/`DENIED <ErrorName>` — the runtime's own
word (`NotCapable` means the substrate refused it; that string is the evidence, not my summary).
Each run gets a **fresh `DENO_DIR`**, because the first attempt exposed that a cached module hides
the loader behaviour.

**Addendum, from the independent re-drive (ds-flash-1b), which is a method rather than a result:
count the requests.** With a fresh `DENO_DIR` the fixture server's GET count went **2 → 3**; reusing
the cache it stayed **3 → 3**. Counting is what turns *"I did not see a fetch"* into *"I can show
whether one happened"* — and the failure mode (a cached module hiding an import) is invisible from
the tool's own output. Any future probe of an egress or import claim in this repository should
report the count, not the absence of an error.

Also from that re-drive: **`eval`-style execution is unpermissioned** — with no flags it read a
secret outside the root — so the evaluator is a bypass path rather than a tool path. And
`--allow-run` was tested in four ways to falsify the exec row: a narrow `--allow-run=/bin/cat` with
no read permission still printed the secret, and a spawned child does not inherit the parent's
flags. Execution bounds *which* binary, never what it can do. Symlinks are created by the fixture: `root/link-outside -> /etc/hostname`,
`root/link-inside -> root/sub/file.txt`. The secret outside the root is a file with known content.

## Results

| Case | No flags | `--allow-read/-write=<root>` | `+ --allow-net=example.com` | `+ --allow-run` |
|---|---|---|---|---|
| read inside root | DENIED `NotCapable` | **ALLOWED** ✔ (positive control) | ALLOWED | ALLOWED |
| read outside root | DENIED | DENIED ✔ | DENIED | DENIED |
| read **through a symlink inside → outside** | DENIED | **ALLOWED ✗** | **ALLOWED ✗** | **ALLOWED ✗** |
| read through a symlink inside → inside | DENIED | ALLOWED ✔ | ALLOWED | ALLOWED |
| write outside root | DENIED | DENIED ✔ | DENIED | DENIED |
| list dir outside | DENIED | DENIED ✔ | DENIED | DENIED |
| `fetch` example.com | DENIED | DENIED | **ALLOWED 200** ✔ | DENIED |
| `fetch` example.org | DENIED | DENIED | **DENIED ✔** (scoping works) | DENIED |
| spawn `/bin/sh` | DENIED | DENIED | DENIED | **ALLOWED ✗** |
| **what the spawned child can read** | — | — | — | **`MACHINE-SECRET` from outside the root ✗** |
| read `Deno.env` | DENIED | DENIED | DENIED | DENIED |
| `dlopen` (FFI) | DENIED | DENIED | DENIED | DENIED |
| **remote dynamic import (`deno.land`)** | **ALLOWED ✗** | **ALLOWED ✗** | ALLOWED ✗ | ALLOWED ✗ |
| remote dynamic import with `--no-remote` | **DENIED ✔** | — | — | — |

Node 24's own permission model, for comparison (`node --permission --allow-fs-read=<root>`):
read inside ALLOWED, read outside DENIED `ERR_ACCESS_DENIED`, spawn DENIED — **and `fetch` ALLOWED
with no `--allow-net` equivalent existing at all ✗**.

## Three corrections to the hypothesis

1. **Confirmed with the runtime's own words**: absent `--allow-net`, `--allow-run`, `--allow-env`,
   `--allow-ffi` produce `NotCapable`, and `--allow-net=<host>` allows that host while another host
   is refused. `exec`, `network`, `env` and `ffi` are **mechanisms** in this substrate, not
   policies — so the table's `network` row can name a real mechanism.
2. **Its path scope is lexical, not resolved — the symlink escapes the root.** With
   `--allow-read=<root>`, `root/link-outside` read `/etc/hostname`. So `read`/`write` scope stays
   **conditional on the host** (gemini's point, now measured): the substrate bounds *which paths
   were named*, the host must bound *where they resolve*. And because a dynamic tool with
   `--allow-write` can *create* such a link itself, the host needs a **resolve-and-refuse pass over
   the root before each tool run** — §3.2's rule, applied to the tool's own substrate.
3. **The module loader is outside the permission model.** A remote dynamic import fetched and
   executed from `deno.land` with **no flags at all**, and `--no-remote` turns it into `TypeError`.
   So `--no-remote` (or an explicit `--allow-import` allow-list) is **mandatory** in the substrate
   invocation, or the `network` row is false from inside the runtime.

## Consequences adopted
- E2's substrate for dynamic tools: **the runtime with an explicit flag set**, `--no-prompt` and
  `--no-remote` mandatory; `--allow-read/-write` scoped to the execution root **and** a host-side
  resolve pass; `--allow-net=<hosts>` only when the environment can back it.
- **`--allow-run` is never granted to model-authored code**: with it, a child (`/bin/sh`) read the
  secret outside the root — it is not "exec scope", it is the whole machine. `exec` therefore stays
  **absent** for dynamic tools unless they run in a container that bounds the child.
- Node's model is insufficient as the substrate: it covers fs and child processes but **not
  network**, which is the axis that matters most here.
