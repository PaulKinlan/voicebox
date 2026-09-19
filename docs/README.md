# Start here — the map

**One page, so nobody has to read six documents to find the one they need.** If you are arriving
cold, read this, then read only the document this sends you to.

---

## 1. Read in this order (and stop when you have what you need)

| # | Read | Why | If you only have ten minutes |
|---|---|---|---|
| 1 | [`00-brief.md`](00-brief.md) | Paul's own words, quoted, numbered **N1–N13**. It is authority for **what** this is. | this |
| 2 | this file | which document is authority for what, and what you can skip | — |
| 3 | [`04-e1-m0-build-spec.md`](04-e1-m0-build-spec.md) | **if you are building**: the shapes, the rule subset, the acceptance checks | this, plus §1 of the design |
| 4 | [`02-environment.md`](02-environment.md) | the environment design: execution model, projects, concurrency, the tier table, the security boundary | §0 (decisions), §3.0 (the rule), §3.2 (the tiers) |
| 5 | [`03-architecture-k3.md`](03-architecture-k3.md) | the harness: what pi actually does, the permission path, the transport | §5 (what it changes in the design) |
| 6 | [`01-questions.md`](01-questions.md) | what is deliberately unresolved | the three questions |

## 1a. Two constraints that cross every document

These are not sections anywhere, so they are easy to lose: they constrain **every** document, and a
change that violates one is wrong wherever it is written.

- **N18 — the agent loop and the harness are a library, not a feature of one placement.** Paul's
  words: *"abstracted into a library in the project that can be imported and reused across client,
  server, and a bunch of other places... consistency at that level."* Stated as a **consistency
  requirement** rather than a portability technique, because it names the failure it prevents: **a
  core that runs in one placement becomes two implementations that drift.** The design's §1.7 and
  §4 say the same thing from the build side (pure data, small functions, narrow dependency surface);
  when they disagree with a convenient shortcut, N18 wins.
- **N16 — there is no second path for capabilities.** Skills are **not** first-class: *"pi doesn't
  have a concept of skills... you have to install an extension, and so I'm okay to follow that same
  model."* So the **user's tools and the model's tools go through the same admission point**
  (design §1.7) — which is the point, and why no separate skill loader should ever appear.

## 2. Which document wins

**The brief wins on *what*. The environment design wins on *how*. k3's architecture wins on the
harness.** If they disagree, the more specific one wins for its own area, and the disagreement is a
finding — say it rather than resolving it silently.

| Document | Authority for | Status |
|---|---|---|
| `00-brief.md` | **what** — Paul's intent, in his words. Never silently reinterpreted; interpretations are marked as interpretations | on main |
| `02-environment.md` | **how** — the execution model, projects, concurrency, tiers, placements, the security boundary | on main |
| `04-e1-m0-build-spec.md` | **how to build the first environment**, down to the acceptance checks. Derived from §1.8 of the design; where they differ, the design wins and the spec is corrected | on main |
| `03-architecture-k3.md` | **the harness** — what pi does, what it does not, and the transport | on main |
| `01-questions.md` | **open questions**, including question 2 (reuse CAP's runtime) which the design answers for the environment and nobody has closed for the rest | on main |
| `docs/interface.md` *(astra)* | **the interface** — the look, the model, the artefact surface | **on `design/astra-interface`**, not main yet |
| `docs/03-harvest.md`, `docs/04-dynamic-tools.md` *(qwen2)* | **prior-art findings** — read §5 of this page first, they are not a lift list | **on `research/qwen2-harvest`**, not main yet |
| `docs/evidence/*/RECEIPT.md` | **measurements**, with the probe beside them. Cited claims point here | on main |

**One collision to fix before it bites**: qwen2's branch carries `docs/03-harvest.md` and
`docs/04-dynamic-tools.md`, which collide with the numbers now canonical on main
(`03-architecture-k3.md`, `04-e1-m0-build-spec.md`). Renumber them on merge (`05-`, `06-`) rather
than merging two `03`s.

## 3. Where the load-bearing rules live (the fast path)

| Rule | Where | One line |
|---|---|---|
| **A guard must be a mechanism, not a description** | design §3.0 | the standard every claim in §3 has to meet, with four instances and three habits |
| **Resolve, then judge** — the tier is decided on the *resolved plan* | design §3.3 | realpaths, real counts, a real command line, read back in that form |
| **The tiers** — never / unprompted / confirm | design §3.2 | with the browser translation and its one weaker row (egress) |
| **Capabilities are enforced, not declared** | design §1.7 | a capability is the *interface the tool is given*; admission needs a named mechanism, or the tool is refused |
| **The four enforcement shapes** | design §1.1a | mediated / compliant (with its limits) / environmental / **disclosure** |
| **Containment: resolve and refuse, never tidy** | build spec §5 | `basename('..')` is `'..'`; `..` is refused **as a name** |
| **The audit reads the world, not the transcript** | design §3.8, build spec §4 | outcomes are **observed**; a model's account of its effects is not evidence |
| **An unknown verb is not a Tier 2 act** | design §0 | a prompt exists only where a mechanism does; a refusal names the missing thing |
| **`stop` is the only unconditional lever** | design §1.4 | everything else depends on the harness choosing to ask or answer |
| **Concurrency: one writer per root** | design §2.3 | several roots per project; sessions per (instance, root) |
| **Shared state, merged artefacts** (N19) | design §2.3 | the append-only log carries presence and seen-marks and **never needs merging**; files still merge, and that merge is the **landing step** — *the global state is the log, not the files* |
| **Other projects are prior art, never dependencies** | design §0 | techniques in, artefact out — and theirs to change, not ours |
| **How the document has been tested** | design §6 | which sections are driven and which are **design, unproven** |

## 4. Decision, technique, or still open

- **Decisions** (settled, with the reason): the placements and their order; concurrency by execution
  root; the tier table and its browser translation; mediated-by-default; the substrate and its flag
  set; worktrees as the execution root; `undoKind` declared per project; the four enforcement shapes;
  `stop` as the stop; the audit writing observed state.
- **Techniques** (worth copying, from wherever they were proven): the bridge's shape (loopback WS ⇄
  stdio JSON-RPC, declared cwd, permission round-trip) — written out in design §1.6; the brokers
  (the harness asks the *page* over a socket); the parameterised-primitive tool shape; the Wasm
  import boundary as the strongest interface available.
- **Still open** (deliberate gaps — do not close them by assumption):
  - **the server side** — whose machine, who else can see the files, what the agent may do there that
    it may not do locally (design §5; Paul named it twice as the part he cannot yet reason about);
  - **the interface** beyond the safety constraints (astra's);
  - **the complete tier rule set** — §3 of the build spec is the M0 subset; a browser satisfies the
    credential and system rules structurally, so they must not be re-implemented;
  - **eviction and durability policy** beyond recording and showing the state;
  - **spoken confirmations end to end** (M1; M0 requires a click, which is stricter);
  - **autonomy** — design §3.8 is a road with **no evidence at all**, written as a destination nobody
    has reached;
  - **isocan's licence** — Apache-2.0, so reuse is *legally* available, but Paul's instruction
    (*"inspired, yes; dependent, no"*) forbids it. **The instruction wins**: this is a product-identity
    decision, not a licensing one. If that ever changes, Apache-2.0 permits it with attribution.

## 5. What to read and what you can ignore

**Read**, in this order: §1 above. **Then ignore, deliberately:**

- **Anything about E2, E3 and E4** (the local, remote and hosted environments) if you are building
  E1. The build spec §7 lists the boundaries.
- **The substrate rows in design §1.7** — measured, but they are E2 concerns. E1's tool is a Wasm
  module and needs none of it.
- **Design §1.3 and §2.4's disclosure machinery** until you are wiring a provider.
- **§3.8's autonomy path** entirely, for now — it is reasoning, not evidence, and it says so.
- **The prior-art sections** as *background*, never as a source of code (design §0).

**And read the harvest documents as evidence, not as a shopping list — and their future-capability
items as *tests*, not features.** *"We might need MCP servers, we might need web search... maybe
they're a stress test for how the extensions can work"* (N16). So an MCP server or a web search tool
is the **next stress test of the extension mechanism**, not the next thing to build: if the mechanism
cannot express one, that is worth knowing **before** anyone needs it — and it is the reason the
harvest's items are listed as findings rather than queued as work. Since Paul's constraint
removed the code, their value is now mostly in the **defects and traps**: the readiness gate that
dropped 192 of 208 frames before `setupComplete`; the store with nine descriptors all
`admitted: false` executing nothing; the regex gate that missed eight live alias sites and had to
become an AST. A reader who takes them as a lift list will import somebody else's bugs and skip the
part that was worth having.

## 6. The evidence, if you want to check a claim rather than believe it

| Receipt | What it settles |
|---|---|
| [`evidence/substrate-20260919/`](evidence/substrate-20260919/RECEIPT.md) | what a capability substrate actually enforces: the flag set, the lexical path scope that follows a symlink out, the loader hole and why it is live, the evaluator bypass, and why `exec` is absent rather than scoped |
| [`evidence/opfs-20260919/`](evidence/opfs-20260919/RECEIPT.md) | OPFS needs **no user gesture** (measured at page load, `userActivation` false) and persistence **can be declined** — which is why the durability state is required |

Both receipts name their method **and their traps** — including the first attempt that was invalid
because an in-console evaluation carries activation, and the cached module that hid an import.
