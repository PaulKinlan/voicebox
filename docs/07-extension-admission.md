# 07 — Extension admission: the gate, the two doors, and the refusals (driven)

Implements the seam named in [02-environment.md §1.7](02-environment.md) and
[03-architecture-k3.md §7](03-architecture-k3.md), and answers beads
`voicebox-beads-bxx` (the admission gate), `voicebox-beads-vwb` (the surface)
and `voicebox-beads-rsj` (MCP + web search as stress tests). Driven evidence:
[docs/evidence/extension-admission-20260920/drive.txt](evidence/extension-admission-20260920/drive.txt),
suite: `node --test tests/extensions.test.mjs` (14 tests, real server, real HTTP).

## What exists now

**The gate is pure data** — `core/extensions.ts`. `admit(descriptor, placement,
existingTools)` decides, and every refusal carries a rule id and a why:

| rule | fires when | why (abridged) |
|---|---|---|
| `exec-absent` | declares `exec`, or `runsIn: "process"` | no mechanism bounds a spawned child: `--allow-run` bounds which binary, never what it can do; a child does not inherit the parent's flags. Admission requires a container that bounds the child. |
| `eval-not-a-tool-path` | declares `eval` | the evaluator bypasses every substrate bound (design §1.7) |
| `capability-unmediated` | declares `import` / `delete` | no primitive in the closed set mediates it — nothing the host could hand the tool as an interface |
| `network-unbounded` | `network` without `hosts` + `maxRequests` | the declaration must say WHERE and HOW MUCH |
| `under-declared` | a primitive consumes a capability the descriptor did not declare | an undeclared need cannot be granted |
| `unknown-primitive` | tool names something outside the closed set | running it would mean evaluating model-authored code |
| `duplicate-tool` / `bad-tool-name` / `no-tools` | shape | pi's `dynamic-tools.ts` rules, lifted |

A capability is granted only where the placement's MECHANISMS table names the
thing that makes it true — `handle-scope` / `host-primitive-scope` for file
acts, `csp-connect-src` (browser) / `mediated-fetch` (machine) for network.
**Unenforceable means absent**: the inventory shows every extension's DECLARED
capabilities against its ENFORCED ones (capability → mechanism), so declared-vs-
enforced is a displayed fact, not a slogan.

**The verbs are a closed set of parameterised primitives** (`now`,
`read-file`, `write-file`, `list-files`, `http-get`) — docs/06 §1.4(2)'s light
path. A model authors a DESCRIPTOR (data), never a body; there is no code
evaluation anywhere in the runtime, which is what makes `mediated-fetch` an
honest mechanism: the tool's only fetch is the host's mediated one.

**Who owns what** (bxx): the model's only door is a PROPOSAL — a tier 1 write
into `<root>/proposals/` (inside the active project root, reported,
revertible). The host owns the extension directory (outside every project
root and unreachable through it), the admission route, and the registry
rebuild — which is the reload. There is no model-reachable register or reload:
driven, not asserted — `POST /api/extensions/register` and `/reload` are 404s, a
`../extensions/evil.js` write is refused by containment, a hand-dropped file in
the host directory does not hot-load, and pasted source becomes a FILE (data),
never code.

**One admission point, two doors** (N16, vwb): the user's sideload
(`POST /api/extensions/sideload`, confirm-first) and the model's proposal
(transcript or `POST /api/extensions/proposals`) land in the same pending
state and pass the same `admit()`. Neither loads its own proposal.

**The disclosure** (vwb) sits before every decision: `GET .../plan` returns the
resolved plan — the source, what it declares, what will be enforced and by
which mechanism, what it will be GIVEN (the mediated interfaces), and what it
CANNOT have (`exec`/`eval`/`import` named absent with their reasons, even when
never asked for). The catalogue listing shows what the gate WOULD decide about
a stranger before installation.

## The stress tests (rsj)

**Web search — the vocabulary is rich enough.** `catalogue/web-search.json`
declares `network` with `bounds: { hosts: ["api.duckduckgo.com"],
maxRequests: 5 }`. Driven with a self-probe tool (bounded to 127.0.0.1,
budget 1, no external network in tests): the declared host answers (status 200,
`request: "1/1"`), an undeclared host is refused **by name** (`host-not-allowed`,
`bounds.hosts is [127.0.0.1]`), the budget exhausts **by name**
(`budget-exhausted`, `1 of 1 requests used`), and an unbounded declaration is
refused at the gate (`network-unbounded`). The bound is the declaration made
true.

**The bound holds ACROSS redirects** (review finding, isocan-flash 2026-09-19,
fixed and re-driven — drive §11): the mediated fetch runs `redirect: "manual"`,
so a declared host answering 302 cannot walk the call to an undeclared origin.
A redirect to an undeclared host refuses **by name**
(`redirect-host-not-allowed`, the full chain quoted in the `why`); a redirect
within the declaration is followed hop-by-hop with **each hop charged to the
budget** (the budget counts requests, not calls), and the result and the audit
record **`servedBy`** — the URL that actually served the bytes — alongside
`via`, the whole chain. Over-eager chains stop at `too-many-redirects` (5).

**MCP — the architecture is rich enough to refuse.** A local stdio MCP server
(`runsIn: "process"`, declares `exec`) is REFUSED at admission with rule
`exec-absent` and a reason that names the upgrade path (a container that bounds
the child); the refused tool answers calls with its refusal; the refusal is an
audit entry with the rule id. A REMOTE MCP server (`runsIn: "remote"`, HTTP
transport) is expressible AND admissible — no process, bounded network,
authority host-side. Placement and authority are now descriptor fields the gate
decides on, not vibes.

## What is deliberately not here yet

- `delete` has no primitive (nothing mediates it yet); the browser placement's
  MECHANISMS row is written but the browser runtime is not built.
- `promptSnippet`/`promptGuidelines` fields exist on descriptors (pi's lesson
  about models writing "use this tool when…") but nothing yet enforces that a
  model-authored snippet names its tool.
- The surface is API-only by design — the page rendering (astra's bead) is a
  separate lane; `public/` is untouched.
- The audit is JSONL per root with core/audit.ts entry shape; no reader/UI yet.
- Test harnesses point `VOICEBOX_WORKSPACE` / `VOICEBOX_EXTENSIONS_DIR` at
  scratch directories — a test must never delete a directory the repository or
  a deployment owns (the hazard isocan-flash flagged in its notes; the suite
  no longer touches repo-owned files at all).

## Decision recorded (2026-09-20): declared paths are not gate-checked — enforcement is at use

The gate does not inspect a tool's `params.path`. An admitted `read-file` tool whose declared
path escapes the root is ADMITTED and refused AT EXECUTION — `outside-root`, named, by the
runtime containment (driven: `../`, deep `a/b/../../../`, and a symlink resolving outside).
This is deliberate and is the design's own rule applied consistently: **the declaration is a
request; enforcement is what makes the bound true** (§1.7). Enforcement-at-use is defensible
and arguably better — the same admitted tool serves any root-legal path without re-admission —
but it must be SAID: a reader would otherwise assume a declared path was checked when it was
declared. The disclosure for file tools should carry the root-scope line.

## The host token and the admission ledger (2026-09-20, driven findings closed)

Two driven findings on `prove/n10-admission` closed in the same branch:

- **The trigger is host-only now** (`voicebox-beads-m2i`): `POST /api/extensions/admit`
  requires the host token — `x-voicebox-host-token`, the design's own §1.5 mechanism
  (host-generated secret, file mode 0600, in the host's own directory, served by no route,
  readable by neither the page nor the model). Missing or wrong → `host-token-required`,
  named, 403. Driven acceptance: the page's two-fetch admission (propose → admit) now fails
  by name, and the tool still refuses `not-admitted`; the host's token-bearing call admits.
- **Set membership is ledger-defined** (`voicebox-beads-0xp`): `loadRegistry` loads only
  descriptors with a RECORDED admission (`.ledger.jsonl`, appended by the host's admit). A
  file present without an admission is `present-not-admitted` — visible in the inventory as
  exactly that, never live. The sweep-in (a never-admitted dropped file going live at the
  next host-triggered reload) is closed; driven.

## The ledger's boundary, stated so nobody builds on it (2026-09-20)

**`.ledger.jsonl` is unauthenticated JSONL appended by the host's admit, keyed by id, with no
signature — it attests AN ID, not bytes, and it is exactly as strong as the host directory's
ownership.** It is tamper-EVIDENT only in the sense that the directory is: anyone who can write
the host directory can add a ledger line for a dropped descriptor and the loader will load it
(by design — that actor is the host). The page and the model cannot write that directory
(containment refuses traversal and symlinks; driven), so the ledger's guarantee is *against
them*. A future reader must not treat the ledger as tamper-proof or as a byte-level integrity
check — "who admitted this" is answered by "who could write this directory", nothing more.

## Dotfiles are behind the loop's line (2026-09-20, driven chain)

The listing routes hide dotfiles; the read and write verbs and `/api/file` now refuse them by
name (`dotfile-refused`). Why this is one rule and not three: driven chain — `POST /api/root`
can declare the HOST's own extensions directory as the active root, and then
`GET /api/file?name=.host-token` returned the host token itself (and the write verb could
overwrite it), after which the page-held token admits. The listing filter without the read
refusal was blindness-ware. (The deeper question — `POST /api/root` accepts any existing path
unauthenticated — is filed as its own bead: it is the environment-declares flow, e1m0's to
decide.)
