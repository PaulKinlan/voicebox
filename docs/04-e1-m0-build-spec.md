# E1-M0 build spec

**What this is.** §1.8 of [`02-environment.md`](02-environment.md) says *when the browser
environment can be said to exist*. This is what to **build** for that: shapes, boundaries, and the
checks that decide it. It is deliberately small — one environment, text input, one tool — and it is
written for an implementer who has not read the design end to end.

**What it is not.** Not the interface (astra's, §4 of the design), not the harness (k3's), not E2
and beyond. **Nothing here depends on pi, the bridge, a server, or a model provider.**

**And it is honest about its holes** — §7 lists what is *not* designed yet. If something below is
ambiguous while building, the fix belongs in this file rather than in the code, and that is the
intended way for it to improve.

---

## 1. Layout, and the rule that shapes it

```
core/            pure data + functions. No DOM. No Deno. No Node. No fetch.
  tier-table.ts    the tiers and the enforcement rows as DATA (§3)
  policy.ts        decide(resolvedAct) -> allow | confirm | refuse(ruleId, why)
  paths.ts         resolve-and-refuse; never normalise (§5)
  project.ts       the project record (§2)
  audit.ts         entry construction + append ordering (§4)
browser/
  worker.ts        THE HOST: owns the tier table, the audit, the projects, and the tool run
  opfs.ts          storage adapter (OPFS only, in M0)
  ui/ui.ts         renderer: text transcript, asset gallery, confirmation prompt
tools/
  create-asset.wat the one tool's logic (§6), and tools/create-asset.schema.json
tests/             the acceptance checks (§8)
```

**The rule that shapes it:** `core/` must run **unchanged** in a browser worker *and* in a
machine-side process later, so it takes its storage and its tool execution as **injected
interfaces**. This is the "one core, narrow surface" requirement from the design's §4 — copy the
*shape* of isocan's `voice-agent/src/live.ts`, **do not lift that file** (it imports
`@isocan/core`, and isocan's packages are out of bounds).

---

## 2. The project record

```jsonc
{
  "id": "atlas@phone",              // `${name}@${placementLabel}` — identity IS placement + location
  "name": "atlas",
  "placement": "browser",
  "location": { "kind": "opfs", "path": "v1/projects/atlas" },  // OPFS-relative, never a realpath
  "root": "v1/projects/atlas",      // the execution root: the containment boundary
  "capabilities": ["read", "write", "wasm"],
  "undoKind": "written-file-list",
  "createdAt": "2026-09-19T15:00:00Z",
  "lastUsed": "2026-09-19T15:04:00Z",
  "durability": { "persisted": false, "checkedAt": "2026-09-19T15:00:00Z" }
}
```

**"Identity is placement + location" concretely, when location is a handle and not a path:**

- `location.path` is a path **inside this origin's private file system** and it means **nothing
  anywhere else**. There is no realpath to compare and nothing to reconcile: two browsers each
  holding `atlas` are **two projects** because the placement label differs, and **no code should
  ever try to match them.**
- The handle itself is **not persisted**. On startup the host re-resolves `location.path` from the
  OPFS root with `navigator.storage.getDirectory()` — measured to need **no user gesture**, at page
  load, with `userActivation.isActive === false` (evidence in `evidence/opfs-20260919/`).
- `id` is the string the UI shows and the audit records. `root` is the **only** path any containment
  check ever measures against.
- `durability.persisted` is recorded from `navigator.storage.persisted()` at each open, and **shown**
  (it is `false` by default, measured; `persist()` may be declined).

---

## 3. The tier table, as data

Three shapes, in `core/tier-table.ts`. **First matching rule wins**; tier 0 refuses; tier 2 asks.

```ts
export type Tier = 0 | 1 | 2;
export type Act = {
  kind: "read" | "write" | "delete" | "exec" | "network" | "import" | "eval" | "external";
  target: string;             // resolved, relative to the project root
  bytes?: number;
  tool?: string;
};
export type Rule = { id: string; tier: Tier; why: string; matches: (a: Act) => boolean };

export const RULES: Rule[] = [
  { id: "outside-root",   tier: 0, why: "the execution root is the only place a tool may touch",
    matches: (a) => a.target !== "" && !insideRoot(a.target) },
  { id: "symlink-out",    tier: 0, why: "a link whose target resolves outside the root",
    matches: (a) => a.kind === "write" && isSymlinkOut(a.target) },
  { id: "eval-path",      tier: 0, why: "eval is not a tool path (see the design, §1.7)",
    matches: (a) => a.kind === "eval" },
  { id: "absent-capability", tier: 0, why: "this placement has no mechanism for it",
    matches: (a) => !ENFORCEABLE.has(a.kind) },
  { id: "writes-inside",  tier: 1, why: "inside the project, reported, revertible",
    matches: (a) => a.kind === "write" },
  { id: "reads-inside",   tier: 1, why: "reading a project's own files", matches: (a) => a.kind === "read" },
  { id: "delete",         tier: 2, why: "not reversible by replay", matches: (a) => a.kind === "delete" },
  { id: "leaves-browser", tier: 2, why: "anything that reaches outside the origin",
    matches: (a) => a.kind === "external" || a.kind === "network" },
];

export const ENFORCEABLE = new Map<Act["kind"], "handle-scope" | "import-boundary" | "egress-policy">([
  ["read", "handle-scope"], ["write", "handle-scope"], ["delete", "handle-scope"],
  ["network", "egress-policy"], ["import", "egress-policy"],
]);
// exec and eval are deliberately absent: no process exists, so the capability is ABSENT
```

**What M0 must have:** the rules above. **What it deliberately omits, and why:** the credential and
system rules from the design's §3.2 are **structurally satisfied** here — there is no `~/.ssh`, no
process, no privilege inside an origin — so they are not rules to implement in E1. Write them down
in the table as comments so nobody re-adds them as code.

**Every refusal prints its `rule` and `why`**, and writes an audit entry. A refusal that only says
"denied" is a description.

---

## 4. The audit

```ts
export type AuditEntry = {
  seq: number;                        // PER-INSTANCE monotonic, from 1
  instance: string;                   // "phone" — one instance in M0
  project: string;                    // "atlas@phone"
  root: string;                       // "v1/projects/atlas"
  turn: string | null;
  at: string;                         // ISO wall clock — a HINT, never an ordering key
  act: { kind: string; target: string; tool?: string };
  decision: "allow" | "confirm" | "refuse";
  rule: string | null;
  result: "ok" | "error" | "refused";
};
```

- **Append-only, one file per root**: `v1/projects/atlas/.audit/<instance>-<root-hash>.jsonl`.
  Because the design serialises **one writer per root** (§2.3), a file per root has exactly one
  writer — which is how two roots write without interleaving. **Readers merge by `(instance, seq)`
  and never claim a global order**, because two machines have no shared clock.
- **Refusals are entries**, with `decision: "refuse"` and the rule id. A log that only records
  successes cannot answer "what did it try to do".
- **It survives a reload** because it lives in OPFS. Assert that in a test, not by inspection.
- No hash chain in M0 — that is an autonomy-stage requirement (design §3.8), not an existence one.

---

## 5. Containment: resolve, refuse, and never tidy

`core/paths.ts` exposes exactly one decision:

```ts
resolveInsideRoot(root: string, candidate: string): { ok: true; path: string } | { ok: false; rule: "outside-root" }
```

- It **resolves**, then **compares**, then **refuses**. It never calls `basename`, `normalise`,
  `replace('../', '')` or `join`-and-hope: those are **rewrites**, and a rewrite is what produced the
  escape this rule exists to prevent (`basename('..')` is `'..'`).
- It refuses `..` **as a name**, not only as a path segment — that is the case a normalising
  implementation passes while looking correct.
- On the machine placement this becomes a realpath comparison; **in OPFS it is a prefix check on a
  resolved, normalised-for-comparison-only path**, because OPFS itself cannot express an escape
  (`..` does not resolve, there are no symlinks). Keep the *shape* identical so the core does not
  change when E2 arrives.

---

## 6. "Create an asset", precisely

**The schema is data the model fills; the body is a Wasm module the host runs.** That split is the
whole design (design §1.7: a model can emit a schema, not an `execute` body).

```jsonc
// tools/create-asset.schema.json
{ "title": "create-asset", "capabilities": ["read", "write"],
  "properties": { "name": { "type": "string" }, "kind": { "enum": ["svg", "text", "html"] },
                  "body": { "type": "string" } }, "required": ["name", "kind", "body"] }
```

**The run, in order — and the enforcement path is also the UX:**

1. **Schema validation.** Unknown fields refuse (`unknown-field`); the model's output is data.
2. **Resolve.** `name` → `root/assets/<name>` via `resolveInsideRoot` (§5). `../../evil.sh` and `..`
   are **refused with the rule id**, and the refusal is the transcript line the user sees.
3. **Instantiate the Wasm module with exactly two imports**: `writeFile(path, bytes)` and `note(msg)`.
   The module has **no `fetch`, no `import`, no `eval`** — not because they are denied, but because
   the host never hands them over. **This is what makes the network row true structurally.**
4. **Write**, then record the path in the **written-file list** for undo (`undoKind`), and append the
   audit entry (`decision: "allow"`, `rule: "writes-inside"`).
5. **Render the asset in the gallery.** SVG goes through `<img src=blob:…>` — **never inline** —
   because an inline SVG carries script. Text and HTML are shown **as text**. Names are **text
   nodes**, never interpolated into markup (design §3.5a).

**The Wasm question, answered**: *a 30-line hand-written `.wat` module is enough for M0* — export
`run(argsJson) -> void` and call the two imports. **No toolchain, no `wasm-pack`, no Rust build
step.** So it is neither the milestone nor a day's work on its own; it is the thing that makes the
enforcement row structural rather than promised, which is why it comes **first** rather than last.
**If it slips, the fallback is not a JS tool** — a JS tool in a worker keeps ambient `fetch`, which
would make §1.8's fourth condition false; the honest fallback is to say the environment does not
exist yet.

---

## 7. Not designed yet — say so rather than interpret

- **The interface** beyond "transcript as text, assets in a gallery, confirmations with the resolved
  plan". Astra owns it; the only constraints from here are the safety ones above.
- **The complete rule set.** §3 above is the M0 subset. The design's §3.2 has tiers the browser does
  not need yet (credentials, system commands) because it cannot reach them.
- **Persistence and eviction policy** beyond recording and showing the durability state.
- **Tier 2 confirmations end to end.** The *decision* path must exist (a `delete` assets action is
  the smallest way to drive it), but the spoken-confirmation rules (§3.4) are M1: M0 can require a
  click, which is strictly stronger.
- **Everything about E2, E3 and E4**, including the substrate work in the design's §1.7 — that is
  measured but not wired.

---

## 8. The acceptance checks

Each is a test, not an inspection. The positive control is part of every one.

1. **Reopen.** Create a project, write a file, reload the worker, and read the file back — with **no
   user gesture** anywhere in the test.
2. **Tier table both ways.** A `write` inside the root is allowed *and* appears in the audit as
   `allow`; a `write` outside is refused *and* appears as `refuse` with `rule: "outside-root"`.
3. **Refusals are named.** Assert on the rule id and the `why` string, not on a generic failure —
   and assert the **allowed** case in the same test, or the test proves only that refusals work.
4. **`..` as a name** is refused while a sibling name is accepted (the `basename` case).
5. **Import boundary.** The asset module instantiates; a **test module that imports `fetch` fails to
   instantiate** — `TypeError: … not a function`, the mechanism's own words.
6. **Nothing renders as markup.** A project file named `<img src=x onerror=alert(1)>` appears in the
   transcript and the gallery as **text**; the test asserts the DOM contains no element created from
   it.
7. **Bad input does not kill the host.** Malformed schema, huge body, unknown kind, a module that
   traps — each yields an error and an audit entry, and the worker serves the next request.
8. **Two roots write.** Two projects (two roots) each append to their own audit file; the merged
   read is ordered by `(instance, seq)` and the test asserts no interleaving and no claimed global
   order.
