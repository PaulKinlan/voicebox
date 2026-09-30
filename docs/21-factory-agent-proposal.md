# The factory agent subset for voicebox — justified by its own history

**Status:** proposal (voicebox-beads-h0nv, 2026-09-30). No workflow code here: the sibling
`vb-factory` lane builds the dispatch wiring from the audio-feed reference. This document is the
justification, the enable-list, the rejections, the cadence and the sink contract that wiring
implements.

## Method (so the numbers can be re-run)

Three sources, all local, all quotable:

| source | size at 2026-09-30 | what it is |
|---|---|---|
| `bd export` of this board | **254 issues** — 251 closed, 250 with a close reason, 788 comments | the fleet's findings record: titles, close reasons, review verdicts |
| `git log` | **730 commits** (211 `fix`, 108 `feat`, 30 `test`, 24 `docs`, 3 `perf`) | the work's own class labels |
| GitHub `PaulKinlan/voicebox` | 16 PRs, **0 issues** | issues live in beads, so GitHub adds little |

**Evidence basis:** an issue counts toward a class when the class's phrase appears in its **title,
close reason or comments** — the places findings are recorded. Issue *descriptions* are excluded
because they carry plans and specs that name a class without a defect ("enable docs-drift", "the
lane split eliminates contention"), which is how a first pass counted
[106 beads for docs drift and 97 for secrets] and was wrong. The queries are in
`/tmp/h0nv-final.py`'s shape: defect-shaped phrases only (`nothing is pinned`, `mutation survives`,
`phantom`, `glyph … black`, `outliv`, `stale base` …), each count eyeballed against its matches.
My own bead (h0nv) is excluded — its description names every agent, which would inflate all of them.

**Commit scopes** (second basis, objective, from `git log --format=%s`): `ui 39 · live 35 ·
extensions 28 · gate 20 · test 19 · fence 12 · docs 9 · tier-table 7 · tasks 7 · room 7 · harness 7`.

## Counts

| class | agent | beads | commits | examples |
|---|---|---|---|---|
| Flaky / load-sensitive tests and instruments | `qa-station` (+ `log-check`) | **26** | 2 | 5i2i, 5dg, 6qu |
| Assertion strength / unpinned claims | `test-gap` | **14** | 0 | 5dg, ths, 1kid |
| Docs drift: phantom rows, stale tables and prose | `docs-drift` + `docs-write` | **14** | 2 | xsjw, qxy2, 6qu |
| Process orphan / leak (child outlives its deadline) | *no agent — gap* | **13** | 4 | u2lx, 6qu, 6io |
| Containment / fence boundary tests | `threat-model` | **11** | 2 | fqq, t80, zxb |
| Vulnerability hypotheses (SSRF / XSS / traversal) | `vuln-discovery` + `vuln-verify` | **11** | 2 | 1i0, bxx, b1p |
| Modern-web platform primitives | `modern-web` | **8** | 0 | tee, snk, c8u |
| Refusal accuracy: a claim asserting a measurement it lacks | `threat-model` (partial) | **7** | 0 | p9bf, dzd, kkc |
| Perf: gate/lane budgets, suite runtimes | `perf-review` | **5** | 1 | 6qu, gzm, 67b |
| Stale base / landing mechanics | *no agent — gap* | **3** | 0 | 1kid, lt6, cx16 |
| Duplicates / stale claims / board hygiene | `issue-triage` | 13 mentions, **~5 findings** | 0 | 4iv, fqq, 8fv.5 |
| UI visual / live-state defects | `ui-ux-audit` | **2** on a 39-commit `ui` surface | 0 | 35eg, dzd |
| Web failure states (offline/quota/tab-discard) | `resilience` | 3 mentions, **0 findings** | 0 | — |
| Heap / DOM leak vectors | `memory-profile` | **0** | 0 | — |
| Accessibility (WCAG) defects | `accessibility` | **1** | 0 | 8ht |
| Bundle / asset size | `bundle-size` | **0** | 0 | — |
| Release-note / changelog defects | `release-notes` | **0** | 0 | — |

## Enable first (ranked by class size × blast radius)

1. **`qa-station`** — the largest class (26), and the one that cost the most wall-clock: the 6io
   hung live run left a **19-process orphan cluster and load 47** on a busy box; the
   page-writes/k6uu and ku4f flakes each passed alone and failed in the suite. A meta-agent that
   audits instrument anatomy, noise and false-positive rates is the direct fit; it would have
   caught the ku4f misclassification (a Chromium-spawning file filed into the concurrent lane) as
   an instrument defect rather than a review surprise.
2. **`test-gap`** — 14 findings, all of one shape: *the assertion cannot fail*. 5i2i's allocation
   claim stayed green when the fix was reverted (M2 survived); lpol's forged-turn assertion could
   not be false; dzd shipped with "nothing pins this behaviour". 30 `test(...)` commits are the
   surface. This is assertion strength rather than coverage, which is test-gap's territory minus
   the coverage framing.
3. **`docs-drift` + `docs-write`** — 14 findings on a 24-commit docs surface. The generator class
   is real: the phantom `X` row in the generated config tables (5qox) came from a comment scanned
   as a variable; docs/07's page row replaced a still-true sentence (snk, f1o); the "allowed, not
   admitted" copy fix (ri4k) is docs-write's class exactly. `docs-drift` is already in
   `~/agents/targets/voicebox.yaml`'s schedule (07:40) — keep it, and pair it with docs-write so the
   finding arrives with a patch.
4. **`threat-model`** — 11 containment findings plus 7 refusal-accuracy findings. Concrete
   incidents: the extension-network redirect reaching an undeclared origin (bxx, SSRF-shaped);
   `evil.sh` and symlink traversal refusals (t80, zxb); the L1.5 fence's `PrivateTmp` making a
   `/tmp` home invisible (a boundary *fact* the model did not hold); and the tier-table
   refusal-accuracy thread (3ryb/a3zx/1kid) where a refusal asserted probes it never measured.
   The last one is only a partial fit — see the gaps.
5. **`vuln-discovery` + `vuln-verify`** — 11 hypotheses: the XSS payload drive (1i0), the
   SSRF-shaped redirect (bxx), traversal refusals (t80, zxb), and the 8fv.* adversarial rounds.
   Discovery finds; verify exists to *disprove* — the fleet already reviewers candidate security
   work adversarially, so this mirrors the working practice rather than inventing one.
6. **`perf-review`** — 5 findings but the largest measured wins of the period: the live lane was
   345s serial before the server/browser split (ku4f, ~252s after, and 0i14 took the server lane
   from 96.6s to 54.1s); the rate wait is bounded at 1.5s (9jvs); the wasm shelf went 65.5s →
   10.3s (u2lx). `gate` is the fourth-largest commit scope (20). Findings side only — hillclimb
   needs a measurable target and the wins here were workflow changes, not target loops.
7. **`modern-web`** — 8 primitive-replacement cases, and the one class the audio-feed reference
   already validates end to end (IME guard, `Temporal`, `base-select`, `dialog closedby`). Voicebox
   instances: the `closedBy` prototype deletion test (snk), the container query deciding columns by
   component width (tee), hand-rolled modal/dialog work. Cheap to justify: the agent's guide set is
   versioned and its findings are concrete diffs.
8. **`ui-ux-audit`** — two user-visible defects on the largest commit scope (`ui`, 39): the folder
   glyph painted black (35eg) and the dock's mirrored state drifting from the control it delegates
   to (dzd). Ranked last of the enables because the class is thin today, but the surface churns
   fastest, so a visual agent's expected catch rate is highest here.

## Run once, then decide (controls with no incident history)

- **`secret-scan`** (already scheduled, 07:30) — **zero leak incidents** in the history. What does
  recur is credential *surfaces*: the three mutating env doors requiring the boot-minted pairing
  bearer, timing-safe and non-echoing (pehr); the credential inventory (cpbr); redaction in the
  debug panel (gdl). Keep it as a standing control if Paul wants one, but do not present the
  history as its justification — it is a control, not a measured class.
- **`deps-supply-chain`** (already scheduled, 07:35) — **zero advisories, CVEs or licence
  findings**. The 47 "digest/admission/tamper" matches are the product's *own* module-integrity
  gate (the wasm shelf admits by SHA-256 and refuses tampering), i.e. a feature that works, not a
  dependency defect. Run once to measure; do not schedule it on this evidence.
- **`log-check`** — half of the flake class is "root-cause this failing output". A trial run
  against a known red live-lane log would test it; standing enablement is not justified yet.

## Reject (with the evidence that is missing)

| agent | why not |
|---|---|
| `resilience` | the 3 matches are product language (in-browser/offline inference is a design goal, `localStorage` quota is a design note). **No web-failure-state finding exists in the history** — 0 offline/lie-fi/tab-discard defects. |
| `memory-profile` | **0 heap/DOM leak findings**. The leak class that does recur is *process* orphans (13), which its scope (heap, detached DOM, listeners, timers) does not cover. See gap 1. |
| `bundle-size` | **0** — voicebox serves a page, not a bundle; no size budget has ever been raised. |
| `release-notes` | **0 defects**. `/api/changelog` and its dialog are a product feature (dzd, 7nd5), not a release-note problem to audit. |
| `accessibility` | **1 finding** (8ht). `modern-web`'s guide set includes accessibility categories, so leaving the specialist off does not remove the coverage. |
| `issue-triage` | 13 mentions but ~5 genuine hygiene items (one `duplicate of`, a few `already filed`/reopened). The fleet already files duplicates with a note; board hygiene is the coordinator's job, not a scheduled agent's. |
| `pr-fixer` | derivative: its input is every other agent's verified findings and failing CI. No independent class in this history, and the one-item review fixes are already done in-lane by the author (the fast path). Enable it only after finders are producing. |
| `perf-hillclimb` | 3 `perf(...)` commits, and the wins were workflow changes (lane split, watchdog) rather than an iterative target loop. `perf-review` covers the findings side. |
| `vuln-triage` | correct agent to *have*, wrong one to enable first: it dedupes and ranks vulnerability findings, so it earns its place the day `vuln-discovery` starts producing. Defer, do not reject as a capability. |

## The gaps the agent set does not cover

1. **Process orphans and leaks** (13 findings, no agent). The measured incident: a hung live run
   left **19 processes** behind and held load at 47. `memory-profile` is heap-scoped; the right
   instrument is a deterministic orphan/child-leak check in the pre-pass (every spawned child gets
   a deadline and a parent-side kill), which is scanner code, not an AI agent.
2. **Stale-base landings** (3 tight findings, and the whole ku4f/5qox/cx16/8dr8/1kid series). A
   branch that is 18 commits behind main, or a bead closed on a verified-but-unmerged SHA, is
   detectable in one command (`git merge-base --is-ancestor`). This belongs in the **gate**, not in
   an agent — and the fleet has since adopted the rule and the blob-pin check.
3. **Refusal accuracy / claim-versus-evidence** (7 findings + the tier-table thread). The general
   defect is a refusal or test asserting a measurement it does not have. `threat-model` covers the
   boundary facts, not the evidence discipline; the fleet's answer was procedural (pre-posted
   re-verification checklists, mutation drills, negative pins). If the factory wants this class,
   it is a **qa-station rule** ("every claim quotes the field that fired") rather than a new agent.

## Cadence

Follows `~/agents/docs/PLAN.md`'s rule (expensive agents on a schedule, local plane preferred; a scheduled
agent repeating the same forty findings is worse than nothing), and the existing
`~/agents/schedules/com.softwarefactory.voicebox.<station>.{timer,service,plist}` pattern at 07:30/07:35/07:40:

- **Nightly line** (the Tier-1 subset, staggered in a single window): `qa-station`, `test-gap`,
  `docs-drift` + `docs-write`, `threat-model`, `perf-review`. `andon_halt_on_critical: true`, as
  `~/agents/lines/project-audit.yaml` already sets.
- **Weekly**: `modern-web`, `ui-ux-audit`, `vuln-discovery` (+ `vuln-verify` on its output).
- **On demand** (not scheduled): `vuln-verify` after discovery reports; `qa-station` after any red
  live lane; `perf-review` on a gate/lane change; `log-check` on a failing suite's output.
- **Trial, once**: `secret-scan`, `deps-supply-chain`.
- Noise control is the findings store's job (`SUPPRESSIONS_FILENAME`, fingerprint dedupe, the
  lifecycle's `unchanged` count) — a class whose rate stays flat across runs gets suppressed, not
  re-reported.

## How findings reach beads

The path already exists in `~/agents`; the proposal endorses it rather than inventing one:

1. `FindingsStore.process_run(agent, raw_findings)` fingerprints each finding as
   `(agent, rule_id, path, snippet)`, dedupes against the store and classifies it
   **new / regressed / fixed / unchanged / suppressed**.
2. `dispatch_to_sink("beads", target, dir, findings, stats)` → `_dispatch_beads()` creates one
   bead per *active, publishable* finding in the target's own board (`~/voicebox/.beads`), skipping
   anything already carrying that sink in `dispatched_sinks`. `~/agents/targets/voicebox.yaml` already
   declares `sink: beads`, `visibility: public`.
3. Publication: for a public target the high/critical band is withheld from the step summary and
   lives in the private artefact, per the visibility rule in `~/agents/targets/README.md`.
4. Triage stays where it is today: the finding bead lands on the voicebox board, `coord` routes it,
   a lane fixes it, and the **close reason names the landing SHA** (the rule adopted 2026-09-30).
   Each bead carries the agent name and fingerprint, so a second run that finds the same defect
   marks it `unchanged` in the store instead of filing another bead.
5. Station labels map to the fleet's priorities: `andon_stations` (secret-scan, vuln-triage) are
   P1; CWE/severity-high findings are P1–P2; polish classes (docs prose, UI nits) are P3.

## What to change in `~/agents` for this target

`~/agents/targets/voicebox.yaml` currently lists **all 20 agents** and schedules three. This proposal's
counterpart edit (for the `vb-factory` lane or the operator) is to keep the enable-first subset in
`schedule:`, move the trial pair behind a manual first run, and delete the rejected stations from
the target — so the target's agent list *is* its justification.
