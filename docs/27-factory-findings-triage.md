# Factory Findings Triage: Private File Sink → Sanitised Beads

`voicebox-beads-h1u0` (child of `voicebox-beads-jyj1`). Implementation: `scripts/factory-triage.mjs`.
Tests: `tests/factory-triage.test.mjs`. Fixtures: `tests/fixtures/factory-reports/`.

## 1. The gap this closes

The factory writes its full delta report with `--sink file`. Every other sink is a publication
boundary: the factory's embargo module (`embargo.py` in the factory repository) holds
`PRIVATE_SINKS = {"file"}`, and on a public repository the
embargo withholds `critical` and `high` findings from a tracker no matter how harmless they look.
Voicebox is public, so the consequence is measured rather than theoretical — `docs/25-factory-agent-proposal.md`
records **zero publishable bead output** from the first two runs, because the only findings that
survived were the ones nobody needed a tracker for.

`scripts/factory-triage.mjs` is the missing bridge. It reads the private report — the one place a
high-severity finding actually exists — and turns it into beads, with the disclosure decision made
explicitly instead of being a side effect of which sink was configured.

## 2. The one rule

**The unredacted report never leaves the private directory, and a bead body is built only from the
published view.**

Concretely: the report path is refused if it is inside the repository working tree (including
through a symlink), a credential-class station's snippet is withheld wholesale rather than masked,
every other published string is masked against the same credential shapes the factory masks, and a
`critical` finding — or any finding from a station that is security-sensitive by construction —
becomes a private escalation instead of a bead.

## 3. Input contract

| Input | Rule |
|---|---|
| Report location | `$VOICEBOX_FACTORY_PRIVATE_DIR`, else `~/.voicebox/factory-reports`. A path inside the repository is refused with exit 1. |
| Report naming | `<target>-<agent>-delta.md`; the station is read as the longest known station suffix, so `voicebox-docs-drift-delta.md` is station `docs-drift` and not `drift`. |
| Station names | The set `factory list` reports. A report for an unknown station is refused (or named explicitly with `--agent`); a station name is never guessed. |
| Report form | The full delta report. A reduced (step-summary) report is accepted but its findings cannot have their identity recomputed, so they are deferred privately rather than filed. |

The station name is not decoration: it selects the disclosure class. The factory's own
`IDENTITY_CRITICAL_AGENTS` are mirrored here — `secret-scan`, `vuln-discovery`, `vuln-verify`,
`vuln-triage`, `threat-model` — because a scanner candidate *is* a credential and a vulnerability
agent's candidate *is* an attack surface; a triage model that understates one does not authorise
its publication.

## 4. Severity mapping

The script does not trust the label on the badge. It follows the factory's routing rules:

- An **identity-critical** station routes as `critical` whatever the badge says. The factory
  usually prints this as `[MEDIUM · routed critical]`; the backstop is enforced here too, so a
  plain `[MEDIUM]` on `secret-scan` still routes as critical.
- A badge the vocabulary does not recognise — `[SEVERE]`, `[5]`, or a missing badge — is
  `critical`. The factory's old default was `medium`, which is exactly the band public sinks
  publish, so an absent field used to authorise publication.

| Effective severity | Station class | Action | Priority |
|---|---|---|---|
| `critical` | any | **Defer** — private escalation, no public bead | — |
| `high` | identity-critical | **Defer** — private escalation, no public bead | — |
| `high` | any other | Public bead, sanitised | P1 |
| `medium` | any | Public bead, sanitised | P2 |
| `low`, `info` | any | Skipped by default (mirrors the factory's board band); `--include-low` files at P3 | P3 |

Two deliberate decisions, stated so a reviewer can disagree with them rather than discover them:

1. **A non-sensitive `high` finding is filed publicly.** The embargo protects *detail*, and the
   sanitised body carries no exploit or credential — a startup probe that blocks the boot banner
   is not a disclosure. Deferring every `high` is what produced the zero yield documented in
   `docs/25-factory-agent-proposal.md`.
2. **`low` and `info` are below the board band by default.** The factory's own `beads` sink skips
   them; a board that files them is a board that stops being read.

**A functionality change is never filed as work to do.** The script is deterministic, so it cannot
know whether a behaviour change is wanted: it flags the signals it can detect (a remediation that
reads as rename/refactor/migrate/change-the-API), accepts the analyst's `--functionality-change`
confirmation, and files that finding **BLOCKED** with a `human-review` label, a recorded reason and
the single decision a human has to make. No findings are auto-fixed, ever — the script cannot edit
code at all (section 7).

## 5. Identity and idempotency

A finding's identity is its fingerprint, recomputed here exactly as the factory computes it:
`sha256(agent:rule_id:normalize_path(path):normalize_text(snippet))`. The report prints only the
first 16 hex characters, so the recomputed full hash is checked against that prefix.

- **Verified** → the bead carries `--external-ref factory:<sha256>` and a `Fingerprint:` line, the
  same convention the factory's own `beads` sink writes. A bead filed here and a bead filed by the
  factory's sink therefore dedupe against each other instead of duplicating.
- **Mismatch** → the finding is deferred, never filed. An identity that cannot be recomputed is
  not an identity to file work under.
- **Unverifiable** (a reduced report with no snippet) → deferred.

Dedupe reads the whole board (`bd list --all --json`), because the store's receipts only cover its
own store: an open bead tracking the fingerprint wins; a closed one wins too unless the finding
regressed. If the board cannot be read, the run files **nothing** and says so — a duplicate bead is
worse than no bead.

## 6. What it never does

- No code, workflow or configuration edits; no auto-fix. The only writes are `bd create`,
  `bd update --status blocked`, `bd comment`, and the private escalation log.
- No network call and no model call. Triage is deterministic and inspectable.
- No write into the repository working tree, in either `--report` or `--apply` mode.

## 7. Usage

```text
node scripts/factory-triage.mjs --report <path>        # plan only, nothing is filed
node scripts/factory-triage.mjs --report-dir <dir>     # every *-delta.md in a private directory
node scripts/factory-triage.mjs --report <path> --apply
```

| Flag | Meaning |
|---|---|
| `--agent <name>` | Override the station when the filename does not carry it |
| `--apply` | File the beads (default is a plan on stdout) |
| `--include-low` | File `low`/`info` at P3 instead of skipping them |
| `--functionality-change <rule\|agent>` | The analyst confirms a behaviour change → BLOCKED + `human-review` |
| `--json` | Machine-readable plan |
| `--private-root <dir>`, `--escalation-log <path>` | Override the private locations |

Exit codes: `0` a plan was produced or beads were filed · `1` usage or policy refusal · `2` nothing
actionable (no findings in band, or everything already tracked).

`--apply` writes deferred findings as JSONL to `<private-root>/escalations.jsonl` (mode `0600`).
That log keeps the evidence a responder needs — the value, the path, the remediation — because it
is the one place a withheld finding still exists in a usable form. Escalation to the hub is the
operator's action on that file; the script never transmits it.

## 8. Verification

- **Format fidelity is not assumed.** The fixtures in `tests/fixtures/factory-reports/` are
  produced by the factory's **own renderer** (the factory's `_render_delta_report`), so the
  parser is measured against the real format, including the reduced form in which the rule id
  lives in the heading and no `Fingerprint:` line exists. Regeneration is documented in
  `tests/fixtures/factory-reports/README.md`.
- **The fingerprint mirror is cross-checked**, not just asserted: the same inputs are hashed by
  the factory's `compute_fingerprint` and by this script, and the script's value must match the
  prefix the report printed.
- **36 tests** cover the policy, and **9 mutations** were run against the script — dropping the
  identity elevation, the fail-closed severity, the masking, the in-repo refusal, the station
  resolution, the dedupe, the critical deferral, the identity reason and the low-band skip — each
  one turning the suite red. Three mutants stayed green on the first pass, and each exposed a real
  weakness: one **vacuous test** (it asserted a value the test itself computed), one test that
  leaned on the factory's routed badge instead of exercising this script's own elevation, and one
  sub-branch in the routing code that was **dead** — an identity-critical station already routes as
  `critical`, so the separate identity check could never fire and was collapsed into a single
  decision with the identity kept in the reason a human reads. That is three defects found by
  mutation testing that 36 green tests had not found.
- **Not yet run end-to-end against a live station.** No factory station was executed with a real
  model for this change: that is the wiring bead (`voicebox-beads-cbxo`), and the run cost belongs
  to whoever arms the schedule. What is verified here is the parse, the policy, the sanitisation,
  the identity chain and the dispatch, against renderer-produced reports and a stub `bd`.

## 9. Related

- [`25-factory-agent-proposal.md`](25-factory-agent-proposal.md) — the defect-class evidence and
  the measured yield that motivates this policy.
- `scripts/factory-triage.mjs` — the implementation, whose comments name the upstream rule each
  mirror comes from.
- `tests/factory-triage.test.mjs` — the policy tests and the mutation-proven boundaries.
