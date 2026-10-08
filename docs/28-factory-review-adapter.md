# Local Software Factory Review Adapter & Inbound Issue Poller

This document defines the architecture, caching invariants, and operational contracts for Voicebox's local Software Factory integration (`voicebox-beads-cbxo`, `voicebox-beads-jyj1`).

Per Paul's 2026-10-07 activation directive, Software Factory scans run **exclusively on the local project VM** (no GitHub Actions CI workflows, secrets, or remote model billing). Voicebox provides a repo-owned portable local review adapter invoked during change review, coupled with an inbound GitHub issue poller.

---

## 1. System Topology & Operational Layers

| Layer | Execution Host | Trigger & Cadence | Scope & Purpose |
|---|---|---|---|
| **Layer 1: Local Review Adapter** | Project VM (`scripts/factory-review-trigger.mjs`) | On `IN_REVIEW` before handoff | Maps `base..tip` git diff to at most **one** diff-relevant station; executes under `fleet-heavy`; calls `h1u0` publisher. |
| **Layer 2: Local Issue Poller** | Project VM (`scripts/factory-issue-poller.mjs`) | Scheduled local timer or on-demand | Polls inbound GitHub issues with a durable cursor; posts safe triage comments on the existing issue with zero duplicate issues. |
| **Layer 3: Nightly Factory Line** | Private VM Fleet (`~/agents/targets/voicebox.yaml`) | Daily (systemd timer) | Comprehensive scan of `main` across all 22 stations with `--sink file`. |

---

## 2. Review Adapter Specification (`scripts/factory-review-trigger.mjs`)

When a feature branch reaches `IN_REVIEW`, the implementer or review tool invokes:

```bash
node scripts/factory-review-trigger.mjs --base <merge-base> --tip <head-sha> [--bead <bead-id>]
```

### 2.1 Deterministic Priority Ordering
Changed files are evaluated across five domains in strict order:
1. **Security** (`secret-scan`, `deps-supply-chain`): Paths matching auth, credentials, tokens, `lib/redact.mjs`, `package.json`.
2. **Performance** (`perf-review`, `bundle-size`): Paths matching `server.mjs`, `lib/ws-server.mjs`, `public/*.js`, wasm, assets.
3. **UX / Web Platform** (`ui-ux-audit`, `accessibility`, `modern-web`): Paths matching `public/*.html`, `public/*.css`, `browser/`.
4. **Documentation** (`docs-drift`): Paths matching `docs/`, `*.md`.
5. **Ops / General** (`log-check`, `issue-triage`): Scripts, tools, or general unclassified files.

### 2.2 Bounded Review Cap (Max 1 Station) & Deferred Recording
To prevent CPU exhaustion on project VMs, review execution is capped at **exactly one primary station**.
For mixed diffs (e.g. security + UI + docs), the highest-priority station runs, and all secondary matching stations are explicitly recorded on the review bead and output as **DEFERRED for the nightly factory line**:

```text
[review-trigger] Diff changes: 6 file(s) across categories: [security, ux, docs]
[review-trigger] Selected primary station: 'secret-scan' (category: security)
[review-trigger] Bounded review cap (max 1): Deferred secondary stations for nightly line: 'ui-ux-audit' (ux), 'docs-drift' (docs)
```

No review run falsely claims complete coverage over unexecuted domains.

### 2.3 Cache Key Invariants
Verdicts are cached in private local reports (`review-cache.json` under `$VOICEBOX_FACTORY_PRIVATE_DIR`) using a three-tuple SHA-256 fingerprint:

$$\text{CacheKey} = \text{SHA256}(\text{DiffHash} : \text{Station} : \text{FactoryRef})$$

- $\text{DiffHash}$: SHA-256 of `git diff base..tip`.
- $\text{Station}$: Primary station selected.
- $\text{FactoryRef}$: Pinned commit hash of the Software Factory engine (e.g. `1e970d595748a7c38b7fd39417e055165d7edecd`).

If the cache key matches a prior exit-0 run, the cached verdict is returned instantly without re-executing.

### 2.4 Heavy Queue Bounding & Failure Handling
Execution runs under `fleet-heavy timeout 900 factory run <station> --target . --sink file`.
- All scanner output is redirected to `$VOICEBOX_FACTORY_PRIVATE_DIR/runs/<id>/<station>.log`.
- Non-zero exits, kills, or timeouts (exit codes 124, 137, 143) are recorded honestly as `UNKNOWN`/`FAILED`.
- Partial reports from aborted runs are never published or treated as passing.

---

## 3. Findings Publication Contract (`scripts/factory-triage.mjs`)

When a delta markdown report (`<target>-<agent>-delta.md`) is produced:
1. The report is preserved in `$VOICEBOX_FACTORY_PRIVATE_DIR/<run-id>/` outside the repository tree.
2. The adapter calls the `h1u0` publisher:
   ```bash
   node scripts/factory-triage.mjs --report "<private-path>" --repo "PaulKinlan/voicebox" --file-issues
   ```
3. **Public Deliberate Visibility**: Voicebox deliberately publishes actionable findings across **all** severity bands (including HIGH and CRITICAL) as public GitHub issues. The publisher bypasses the factory's default public-sink embargo while withholding literal credential values and raw PoCs (derived text only).
4. **Bead Promotion**: No beads are created at scan time. Work beads are created only after human review via:
   ```bash
   node scripts/factory-triage.mjs --review <issue-number> --reviewed-by <actor> --repo "PaulKinlan/voicebox"
   node scripts/factory-triage.mjs --promote <issue-number> --repo "PaulKinlan/voicebox" --apply
   ```

---

## 4. Inbound Issue Poller & Loop Hazard Guard (`scripts/factory-issue-poller.mjs`)

The local issue poller checks inbound GitHub issues, runs relevant scans, and posts safe triage summaries on the triggering issue.

### 4.1 Loop Hazard Guard
To prevent recursive scan storms where factory-published finding issues trigger automated scans, [`tools/factory-issue-router.mjs`](../tools/factory-issue-router.mjs) immediately refuses issues matching any of:
- Body contains `<!-- factory-fingerprint:` (publisher finding marker).
- Body contains `**Fingerprint**:` (upstream factory github-issues sink).
- Body contains `<!-- factory-self-test -->` (publisher self-test).
- Title starts with `[factory:` or `[factory/` (e.g. `[factory/high] perf-review:`).

This guard applies **strictly independent of author association**, preventing token- or bot-created issues from triggering re-scans.

### 4.2 Shared Triage Comment Markers
Comments formatted by [`tools/factory-issue-commenter.mjs`](../tools/factory-issue-commenter.mjs) embed all five shared triage markers per finding:

```html
<!-- factory-triage-comment: <fingerprint> -->
<!-- factory-station: <station> -->
<!-- factory-severity: <severity> -->
<!-- factory-state: <new|regressed> -->
<!-- factory-human-review -->
```

- `factory-triage-comment`: SHA256 finding fingerprint (16–64 hex).
- `factory-station`: executing station name (e.g. `secret-scan`, `perf-review`).
- `factory-severity`: finding severity (`critical`, `high`, `medium`, `low`, `info`).
- `factory-state`: finding state (`new` or `regressed`).
- `factory-human-review`: presence flag emitted when the station is security-related (`secret-scan`, `vuln-discovery`, `vuln-triage`, `vuln-verify`, `threat-model`) or when the finding is flagged for human verification.

These markers allow `scripts/factory-triage.mjs --review` and `--promote` to read review records from issue comments on human-submitted issues, enabling seamless conversion to Beads.

---

## 5. Local VM Activation & Operational Runbook (`voicebox-beads-xacp`)

### 5.1 Hourly Inbound Issue Poller Timer
The inbound issue poller is scheduled locally on the project VM using an unprivileged systemd user timer (`config/systemd/user/`):

- **Service Unit**: `config/systemd/user/voicebox-factory-issue-poller.service`
  Executes `scripts/factory-issue-poller-runner.sh` as a `Type=oneshot` task with standard journal output.
- **Timer Unit**: `config/systemd/user/voicebox-factory-issue-poller.timer`
  Runs hourly (`OnCalendar=hourly`) with a randomized 2-minute delay (`RandomizedDelaySec=120`) and persistent catchup (`Persistent=true`).
- **Runner Script**: `scripts/factory-issue-poller-runner.sh`
  Sources `~/.fleet/env` and nvm, acquires an exclusive file lock (`~/.voicebox/factory-reports/poller.lock`), and invokes `scripts/factory-issue-poller.mjs` under `fleet-heavy timeout -k 30 600`.

#### Installation Commands (Unprivileged User)
```bash
mkdir -p ~/.config/systemd/user
cp config/systemd/user/voicebox-factory-issue-poller.* ~/.config/systemd/user/
XDG_RUNTIME_DIR=/run/user/1000 systemctl --user daemon-reload
XDG_RUNTIME_DIR=/run/user/1000 systemctl --user enable --now voicebox-factory-issue-poller.timer
```

#### Verification & Inspection
```bash
# Check timer schedule and next scheduled run
XDG_RUNTIME_DIR=/run/user/1000 systemctl --user list-timers voicebox-factory-issue-poller.timer

# Trigger manual on-demand execution
XDG_RUNTIME_DIR=/run/user/1000 systemctl --user start voicebox-factory-issue-poller.service

# View live poller logs
tail -f ~/.voicebox/factory-reports/poller.log
```

### 5.2 Pre-Merge Review Watcher & Review Gate (`scripts/factory-review-watcher.sh`)
To eliminate any dependency on manual merger ceremonies or shared `~/fleet` role edits, review-time station gating is automated via a repository-owned watcher (`scripts/factory-review-watcher.sh` & `scripts/factory-review-watcher.mjs`):

- **Timer Unit**: `config/systemd/user/voicebox-factory-review-watcher.timer`
  Runs periodically every 15 minutes (`OnCalendar=*:0/15`).
- **Conjunctive (`AND`) Ownership Predicate**:
  The watcher monitors **only** active beads assigned to `voicebox-*` (with status `in_progress` or label `merge-queue`) **AND** carrying an explicit candidate branch ref matching an owned `refs/remotes/origin/fleet/*` tip.
  Stale historical branches, third-party branches, and merger artifact refs (`fleet/rescued-*`, `fleet/backup-*`, `fleet/merger-*`) are strictly excluded.
- **Pre-Merge Execution & Bounding**:
  For each candidate branch, computes `base = git merge-base origin/main <tip>` and executes `scripts/factory-review-trigger.mjs` under `fleet-heavy timeout 900` capping at 1 primary station.
- **Landed Backstop & Rewrite Safety**:
  Monitors newly landed commits on `origin/main` (`lastMainSha..origin/main`) as an automated backstop. If `lastMainSha` is not an ancestor of `origin/main` (indicating an upstream rebase or history rewrite), the watcher fails closed with exit 1, halting and requiring explicit operator reconciliation (preventing broad or corrupted diffs).
- **Execution Safety**:
  Invokes only canonical `factory run <station> --sink file`, never executing untrusted scripts from candidate branches.

Manual invocation during `IN_REVIEW` handoff remains available:
```bash
scripts/factory-review-gate.sh --base <merge-base> --tip HEAD --bead <bead-id>
```

### 5.3 Nightly 5-Domain Station Coverage Audit
The VM nightly line (`fleet-factory.timer`, running daily at 03:00 UTC via `/home/exedev/fleet/remote/factory-nightly.sh`) executes `factory line project-audit --sink file`.

| Domain | Covered Stations in `project-audit.yaml` | Uncovered Stations in Target Definition (`~/agents/targets/voicebox.yaml`) | Domain Assessment & Remediation |
|---|---|---|---|
| **Security** | `secret-scan`, `threat-model`, `vuln-discovery`, `vuln-verify`, `vuln-triage`, `deps-supply-chain` | None | **100% complete coverage** across all static, dependency, and model-driven security stations. |
| **Performance** | `perf-review` | `bundle-size`, `memory-profile`, `perf-hillclimb` | `perf-review` covers diff anti-patterns. `bundle-size` and `memory-profile` require browser/runtime harness runs; `perf-hillclimb` is an interactive ledger optimizer. |
| **UX / Web Platform** | `modern-web`, `ui-ux-audit` | `accessibility`, `resilience` | `modern-web` and `ui-ux-audit` audit CSS/JS baseline and visual layout. Propose adding `accessibility` and `resilience` to an extended nightly line. |
| **Documentation** | `docs-drift` | `docs-write` | `docs-drift` detects drift between code and docs. `docs-write` is an active code patch proposer, not an audit observer. |
| **Ops / Maintenance** | `qa-station` | `test-gap`, `issue-triage`, `pr-fixer`, `log-check`, `release-notes` | `qa-station` audits factory quality. `issue-triage` is actively handled by our hourly issue poller. |

*Honest Deferral Accounting*: Stations deferred during a diff review are compared against `NIGHTLY_PROJECT_AUDIT_STATIONS`. Unmatched stations (e.g. `log-check`, `accessibility`) are explicitly recorded as `NOT SCHEDULED NIGHTLY (manual follow-up required)`, ensuring no domain is falsely claimed covered.

### 5.4 Nightly Findings Publication & SAME-RUN Manifest Barrier (`scripts/factory-nightly-publisher.sh`)
While the nightly systemd service (`fleet-factory.service` running `/home/exedev/fleet/remote/factory-nightly.sh`) runs `factory line project-audit --sink file`, its default output remains strictly on disk in `~/agents/findings/`.

To complete the issue-first chain across all severities (with literal secrets masked), Voicebox provides `scripts/factory-nightly-publisher.sh` and `scripts/factory-nightly-publisher.mjs`:
- **SAME-RUN Manifest Completion Barrier**:
  Inspects `~/agents/findings/voicebox-factory-line.json`. Asserts `target === "voicebox-factory"`, `line === "project-audit"`, `complete === true`, and every station record in `manifest.stations` has `status === "PASS"`. Rejects incomplete, failed, or missing manifests with zero `gh` calls.
- **Active Service Guard**:
  Asserts `fleet-factory.service` is inactive (i.e. not actively running mid-batch) before publishing.
- **Batch Window & Freshness**:
  Asserts station report `mtime` is within `(manifest.generated - 3h) <= report.mtime <= (manifest.generated + 60s)`, rejecting stale prior-day reports.
- **Canonical Path Containment**:
  Station `run_dir` and report paths are resolved via `realpath`, asserting strict containment within authorized runs/findings directories and rejecting `..` or symlink escapes.
- **Report Target Verification**:
  Validates report frontmatter explicitly targets `voicebox-factory` or `voicebox`. Any foreign or missing target report is rejected with zero `gh` invocations.
- **Idempotent Batch Cursor**:
  Records `manifest.generated` in `~/.voicebox/factory-reports/nightly-cursor.json` only after all findings across all stations publish successfully, ensuring failed batches remain retryable on the next tick.
- *Stated Operational Limitation*: Publication binds strictly to manifest `target`, `line`, report freshness, and `run_dir` provenance; the factory manifest contains no git commit SHA, so exact source revision cannot be asserted from the manifest alone.

### 5.5 Systemd User Units Installation
To install the systemd user service and timer definitions on the VM:
```bash
scripts/factory-install-systemd.sh
```
Timers remain disabled until the canonical checkout (`~/voicebox`) is populated after landing on `origin/main`.

