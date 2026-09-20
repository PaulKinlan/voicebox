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
into `workspace/proposals/` (inside its root, reported, revertible). The host
owns the extension directory (`extensions/`, outside the workspace root and
unreachable through it), the admission route, and the registry rebuild — which
is the reload. There is no model-reachable register or reload: driven, not
asserted — `POST /api/extensions/register` and `/reload` are 404s, a
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
