# Factory Agent Subset Proposal & Audit Yield Decision

This document records two paired engineering analyses for Voicebox's automated agent factory (`voicebox-beads-h0nv` and `voicebox-beads-algv`):

1. **Part 1 (`voicebox-beads-h0nv`) — Empirical Defect Class Mining across Voicebox History**: Categorizes recurring defect classes across Voicebox's commit and issue history to justify which factory agents to enable, trial, or reject.
2. **Part 2 (`voicebox-beads-algv`) — Factory Audit Yield & Engine / Subset Decision**: Evaluates the measured yield from initial factory runs and establishes the concrete operational decisions for engine selection, enabled agent subset, and scheduling cadence.

---

## Part 1: Empirical Defect Class Mining (`voicebox-beads-h0nv`)

### 1.1 Methodology & Corpus

The factory agent subset for Voicebox is justified by the defect classes the engineering fleet consistently identifies in practice rather than by subjective preference.

| Source | Corpus Size | Role in Analysis |
|---|---|---|
| Beads issue board (`bd export`) | **254 issues** (251 closed, 788 comments) | Fleet findings record: titles, close reasons, and review verdicts |
| Git commit history (`git log`) | **730+ commits** (`fix`, `feat`, `test`, `docs`, `perf`) | Commit-level defect and feature scope labels |
| GitHub repository | 16 PRs | Merged milestone and gate records |

**Counting discipline:** An issue counts toward a defect class only when the defect-shaped phrase appears in its **title, close reason, or review comments** — the places where verified findings are recorded. Issue *descriptions* are excluded because they carry forward-looking plans and specifications that name a class without an actual defect.

**Commit scope distribution (`git log`):** `ui` (39) · `live` (35) · `extensions` (28) · `gate` (20) · `test` (19) · `fence` (12) · `docs` (9) · `tier-table` (7) · `tasks` (7) · `room` (7) · `harness` (7).

---

### 1.2 Recurring Defect Classes & Counts

| Defect Class | Candidate Factory Agent | Beads Count | Commits | Representative Examples |
|---|---|---|---|---|
| **QA Station / UI & State Invariants & Flakes** | `qa-station` (+ `log-check`) | **26** | 2 | DOM state desync, popover light-dismiss, plain-language leaks (`tools/rendered-plain-language.mjs`), CSS specificity/layout shifts, and Chromium tests misfiled into the concurrent lane |
| **Test Coverage, Assertion Strength & Lane Isolation** | `test-gap` | **14** | 0 | Unit vs. live lane partitioning (`scripts/test-lanes.mjs`), scratch directory isolation (`tools/tree-dirt.mjs`), deterministic mock transports vs. live vendor calls, and vacuous assertions |
| **Documentation Drift & Generated Block Sync** | `docs-drift` + `docs-write` | **14** | 2 | Generated block synchronization (`scripts/docs-check.mjs`), backticked path claims (`docs/claims.json`), and pre-push `scripts/docs-touched.mjs` enforcement |
| **Process Orphans & Child Deadlines** | *Deterministic scanner check (gap)* | **13** | 4 | Hung live run leaving a 19-process orphan cluster (`scripts/reap-stale-servers.mjs`, `lib/wasm-shelf.mjs` worker deadline) |
| **Threat Model & Containment Boundaries** | `threat-model` | **11** (+ **7** refusal-accuracy) | 2 | Path traversal (`outside-root` in `core/paths.ts`), dotfile refusal, git hook env poisoning (`lib/git-env.mjs`), loopback session auth (`VOICEBOX_LOOPBACK_AUTH`), host token gates, and Wasm worker deadlines (`lib/wasm-shelf.mjs`) |
| **Vulnerability Hypotheses (SSRF / XSS / Traversal)** | `vuln-discovery` + `vuln-verify` | **11** | 2 | Extension redirect reaching undeclared origins, XSS payload drives in `tools/page-acceptance.mjs`, and symlink/path traversal refusals |
| **Modern Web Platform Primitives** | `modern-web` | **8** | 0 | Native `<dialog closedby>` light-dismiss, CSS container queries, and `light-dark()` color-scheme tokens (`public/style.css`) |
| **Performance, Startup Latency & Lane Budgets** | `perf-review` | **5** | 1 | Memoized `buildIdentity()` in `server.mjs`, non-blocking boot banner, bounded Wasm concurrency semaphore (`WASM_MAX_CONCURRENT_WORKERS` in `lib/wasm-shelf.mjs`), and live-lane server/browser split (345s → 252s) |
| **Duplicates / Board Hygiene** | `issue-triage` | ~**5** | 0 | Duplicate issue filing and stale claim cleanup |
| **UI Visual / Live-State Rendering** | `ui-ux-audit` | **2** | 0 | Dark-mode icon contrast and dock mirrored state drift (`public/pip-mic.mjs`, `public/fused.js`) |
| **Accessibility (WCAG)** | `accessibility` | **1** | 0 | Covered by `modern-web` guide set and `tools/page-acceptance.mjs` |
| **Web Failure States / Heap Leaks / Bundle Size / Release Notes** | `resilience`, `memory-profile`, `bundle-size`, `release-notes` | **0** | 0 | Zero historical defects in these categories |

---

### 1.3 Proposed Agent Classification

#### Enable First (Ranked by Class Size × Blast Radius)

1. **`qa-station` (26 beads)**:
   - Targets UI/DOM state desync, popover light-dismiss, plain-language leaks (`tools/rendered-plain-language.mjs`), CSS specificity regressions, and test instrument misclassifications.
2. **`test-gap` (14 beads)**:
   - Targets assertion strength (catching tests that remain green when the underlying fix is reverted), `unit` vs. `live` lane partitioning (`scripts/test-lanes.mjs`), scratch directory containment (`tools/tree-dirt.mjs`), and deterministic mock coverage.
3. **`threat-model` (11 containment + 7 refusal-accuracy beads)**:
   - Targets workspace root containment (`core/root.ts`, `core/paths.ts`), dotfile exclusion, sanitized git environments (`lib/git-env.mjs`), loopback session authentication (`VOICEBOX_LOOPBACK_AUTH`), host token gates, and Wasm worker deadlines (`lib/wasm-shelf.mjs`).
4. **`perf-review` (5 beads, highest wall-clock impact)**:
   - Targets startup latency (memoized `buildIdentity()`, non-blocking startup probes), bounded Wasm worker concurrency (`WASM_MAX_CONCURRENT_WORKERS`), and test-lane execution budgets.
5. **`docs-drift` + `docs-write` (14 beads)**:
   - Targets synchronization between live server routes/capabilities and documentation (`scripts/docs-check.mjs`, `scripts/docs-touched.mjs`).
6. **`modern-web` (8 beads)**:
   - Targets modern HTML/CSS/JS platform primitives (`<dialog>`, popover API, CSS `light-dark()`, container queries).
7. **`vuln-discovery` + `vuln-verify` (11 beads)**:
   - Adversarial discovery and verification of SSRF, XSS, and path-traversal hypotheses.
8. **`ui-ux-audit` (2 beads on the 39-commit `ui` surface)**:
   - Visual and interaction state consistency across the room stage and popovers.

#### Trial Once (Controls Without Historical Incident Volume)

- **`secret-scan`**: Zero leak incidents in history, though 7 beads hardened credential custody (`0600` `.host-token`, `.api-keys.json`, `.pairings.json`). Keep as a periodic security control rather than a defect-trend pick.
- **`deps-supply-chain`**: Zero dependency CVE incidents; historical matches reflect Voicebox's own SHA-256 Wasm module admission gate (`lib/wasm-shelf.mjs`).
- **`log-check`**: Useful on-demand when diagnosing a failing `live` lane run.

#### Reject (No Supporting Evidence in Repository History)

| Agent | Reason for Rejection |
|---|---|
| `resilience` | **0 findings** in history; offline/OPFS capabilities are tracked as explicit product epics (`lib/offline-speech.mjs`, `public/sw.js`). Large TTS text payloads are piped via stdin rather than passed as a command-line argument, avoiding E2BIG on large inputs (voicebox-beads-uck3). |
| `memory-profile` | **0 heap/DOM leak findings**; recurring leaks in Voicebox were child process orphans (`scripts/reap-stale-servers.mjs`), which heap profiling does not detect. |
| `bundle-size` | **0 findings**; Voicebox serves modular ESM directly without a monolithic client bundle budget. |
| `release-notes` | **0 findings**; `/api/changelog` is an in-product endpoint, not a release-note generation pipeline. |
| `accessibility` | **1 finding**; already covered by `modern-web` and live page checks. |
| `issue-triage` | Board hygiene is handled directly by orchestrator and merger lanes via `bd`. |
| `pr-fixer` | Derivative of finder agents; in-lane sub-agents already resolve review findings directly. |
| `perf-hillclimb` | Performance wins came from architectural and lane changes rather than single-metric hillclimbing loops. |
| `vuln-triage` | Deferred until `vuln-discovery` runs at scale. |

---

## Part 2: Factory Audit Yield & Engine / Agent Subset Decision (`voicebox-beads-algv`)

### 2.1 Measured Yield from Initial Factory Runs

Following the initial `.github/workflows/agent-factory.yml` integration (`voicebox-beads-xsjw`), two factory agents (`modern-web` and `docs-drift`) were executed against the repository using the default `deepseek-chat` engine:

1. **`modern-web` (151 candidate payloads)**:
   - Produced **1 `high`-severity finding**.
   - **Why 0 beads were filed**: Because Voicebox is a **public repository** (`visibility: public`), the factory's embargo policy automatically withholds `critical` and `high` findings from public issue trackers and writes them only to the private workflow run artifact (16-line report).
2. **`docs-drift` (374 candidate payloads)**:
   - Produced **0 findings**, accompanied by a fabricated *"no candidates were provided"* justification despite 374 candidates being supplied in the prompt payload.
   - **Why 0 beads were filed**: Engine triage failure on a large candidate payload.

Across both runs, **publishable bead output was zero** — caused by the combination of `deepseek-chat` triage quality on large candidate sets and the public-repo embargo withholding `high`/`critical` findings while allowing `medium`-severity engineering findings through.

---

### 2.2 Three Operational Decisions

To maximize actionable, publishable engineering yield per model call without wasting spend on uncalibrated cron runs, Voicebox adopts the following three decisions:

#### Decision 1 — Engine Selection: Two-Engine Measured Comparison (`claude` and `antigravity` vs. `deepseek-chat` Cost Floor)

- **Comparison Protocol**: Rather than re-running blind or discarding the existing candidate payloads, run a bounded two-engine comparison (`claude` and `antigravity`) against the **exact 151 `modern-web` and 374 `docs-drift` candidate payloads** already captured on file (zero new crawling cost).
- **Acceptance Criteria (scored before any production schedule)**:
  1. **Publishable Yield**: Produces `>= 1` real, actionable `medium`-severity finding that passes the public-repo embargo and lands as a bead.
  2. **Zero Fabricated Justifications**: Files **zero** hallucinated excuses (such as `deepseek-chat`'s false *"no candidates were provided"* claim over 374 real candidates, which is disqualifying on first offense).
  3. **Deduplication Survival**: Findings survive `FindingsStore` fingerprinting (`(agent, rule_id, path, snippet)`) without churning duplicate beads.
- **Role of `deepseek-chat`**: Retained as the low-cost baseline floor for negative-path workflow mechanics tests, but replaced for production triage by the winning engine (`claude` or `antigravity`) on cost-per-publishable-bead.

#### Decision 2 — Enabled Agent Subset: Enable the Medium-Shaped Quartet First

- **Enable First (`qa-station`, `test-gap`, `threat-model`, `perf-review`)**:
  - These four agents are both **justified by Voicebox's defect history** (26, 14, 11+7, and 5 historical beads respectively) and **produce `medium`-shaped engineering findings** (flake instrumentation, assertion strength, containment boundary checks, and latency/concurrency measurements).
  - Because `medium`-severity findings are **not withheld by the public-repo embargo**, this quartet directly exercises and satisfies the *"files findings as beads"* pipeline on a public repository.
- **Hold Pending Engine Verification (`docs-write`)**:
  - Held until the engine comparison confirms reliable triage on the 374 `docs-drift` candidates.
- **Hold for Internal / Non-Embargoed Runs (`vuln-discovery` + `vuln-verify`)**:
  - Because security vulnerability findings are `high`/`critical` by nature, the public-repo embargo withholds them from public beads by design. Run them on-demand or in internal artifact-only audits rather than expecting public bead creation.
- **Keep as Baseline (`modern-web`, `docs-drift`)**:
  - Remain in `.github/factory-agents.json` for the engine comparison benchmark and artifact reporting.

#### Decision 3 — Cadence: Keep Scheduled Cron Disarmed Until Comparison Gate Clears

- **Disarmed by Default**: The scheduled cron trigger in `.github/workflows/agent-factory.yml` remains commented out / disarmed while manual `workflow_dispatch` is gated to the repository owner.
- **Graduation Path**:
  1. Run the two-engine comparison (`claude` vs. `antigravity`) via manual dispatch.
  2. Once an engine + the medium-shaped quartet (`qa-station`, `test-gap`, `threat-model`, `perf-review`) produces `>= 1` publishable bead with zero fabricated justifications, arm a **weekly** schedule first.
  3. Graduate to a staggered **nightly** schedule only if weekly signal-to-noise remains high and run cost is approved.
