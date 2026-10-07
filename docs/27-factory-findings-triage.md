# Factory Findings Triage: Private Report → Public Issue → Reviewed Bead

`voicebox-beads-h1u0` (child of `voicebox-beads-jyj1`). Implementation: `scripts/factory-triage.mjs`.
Tests: `tests/factory-triage.test.mjs`. Fixtures: `tests/fixtures/factory-reports/`.

## 1. What this replaces, and why

The factory writes its full delta report with `--sink file`. Every other sink is a publication
boundary: the factory's embargo module holds `PRIVATE_SINKS = {"file"}`, and on a public repository it
withholds `critical` and `high` findings from a tracker. `docs/25-factory-agent-proposal.md` measured
the result — **zero publishable bead output**, with the only interesting findings vanishing into a
private artefact.

The first design here kept that embargo for the top two bands: sensitive `critical`/`high` went to a
private escalation log and never to the board. **That is no longer the decision.** By
`voicebox-beads-h1u0`, this repository publishes **every severity** as a public issue, and the
protection is the published view rather than the withholding. Two things follow, and they are the
spine of this document:

- a finding becomes a **public issue**, never a bead, and
- a bead exists only when a reviewer runs the explicit `--promote` command afterwards.

The original "never raw secret/PoC" rule survives the change, enforced by the sanitiser instead of by
an embargo: a security station's raw candidate is never published, but the finding is never withheld
either, and nothing is dropped silently — every finding the report contains appears in the plan with
the reason it was or was not published.

## 2. The pipeline

```
factory station ──(--sink file)──> private report  ──> scripts/factory-triage.mjs
                                                          │
                              ┌───────────────────────────┴───────────────────────────┐
                              │                                                       │
                     --file-issues                                              --promote <n>
                              │                                              --reviewed-by <actor>
                     public GitHub issue                                            │
                     (triage record in the body,                                     bead
                      fingerprint marker, labels)                          (priority, external-ref,
                                                                            BLOCKED if the issue
                                                                            is marked human-review)
```

Nothing creates a bead from a report. The publisher has no such option, which is why the safety
property is testable: a scan run with both `gh` and `bd` stubs never invokes `bd`.

## 3. Input contract

| Input | Rule |
|---|---|
| Report location | `$VOICEBOX_FACTORY_PRIVATE_DIR`, else `~/.voicebox/factory-reports`. A path inside the repository is refused with exit 1, including through a symlink. |
| Report naming | `<target>-<agent>-delta.md`. The station is the longest known station suffix, so `voicebox-docs-drift-delta.md` is `docs-drift` and never `drift`. |
| Station names | The set `factory list` reports (22 stations as of 2026-10-07). An unknown station is refused unless `--agent` names it explicitly. |
| Report form | The full delta report. A reduced (step-summary) form has no snippet, so its identity cannot be recomputed: its findings are not published, and the plan says so. |
| Repository | `--repo <owner/name>` or `$VOICEBOX_FACTORY_REPO`. Issues are published to a named repository; there is no implicit default. |

Why the private path matters at all, given everything is published: the report is **unredacted**. It
holds the credential value, the raw payload and the private evidence trail. The refusal is what stops
one `git add -A` from committing it. Publishing the *finding* is the decision; publishing the *raw
value* is never allowed.

## 4. What gets published

| Effective severity | Station class | Published? | Bead priority on promotion |
|---|---|---|---|
| `critical` | any | Yes — deliberately, with the raw candidate withheld for identity-critical stations | P1 |
| `high` | any | Yes — deliberately (the embargo would withhold it) | P1 |
| `medium` | any | Yes | P2 |
| `low`, `info` | any | Only with `--include-low` | P3 |
| any | any | Functionality change → published, marked `human-review`, and the promoted bead is BLOCKED | P1–P2 by severity |

Severity is routed, not merely displayed:

- An **identity-critical** station — `secret-scan`, `vuln-discovery`, `vuln-verify`, `vuln-triage`,
  `threat-model` — routes as `critical` whatever the badge says. A scanner candidate *is* a
  credential and a vulnerability agent's candidate *is* an attack surface, so the label a triage model
  chose cannot lower the band. The issue body shows the label the station used beside the band it
  routed as, because a reviewer needs to see that difference.
- A badge the vocabulary does not recognise — `[SEVERE]`, `[5]`, absent — is `critical`. The factory's
  old default was `medium`, the band that publishes, so an absent field used to authorise publication.
- A finding whose remediation changes behaviour is published with the `human-review` marker, a
  `[human-review]` title prefix and an explicit decision to record; promoting it creates a **BLOCKED**
  bead with the `human-review` label and the decision in a comment.

## 5. What is never published, and what is never dropped

**Never published:** raw credential values, and the raw candidate of any identity-critical station.
Every other string is masked with the same credential shapes the factory masks, and absolute home
paths and the private report path are elided — **on the title as well as the body**, because the
factory's own sink learned that lesson and a credential recognised in the body reached the tracker
through the title.

Two layers decide what "a credential finding" means, mirroring the factory: the station (`secret-scan`)
and the rule id (any rule containing `key`, `secret`, `token`, `credential`, `password` or `private`).
Either one fires, because a station that is not the credential scanner can still report a matched key.
For those findings the pipeline publishes **derived text only** — the rule, the location, the severity,
the state and a generic rotate-and-remove remediation — and the triage model's own title, description
and remediation are dropped. What is dropped is the untrusted *prose*, never the finding: the severity,
the identity, the rule and the location all still publish, so a reader always sees that a critical
credential finding exists and where. That is deliberate, not fastidious: prose cannot be checked for an echo of a
value whose shape is unknown, so no regex would have caught it. The value and the model's notes exist only in the local report — and that
report is a **working file, not a durable store**: the published issue is the durable record, and a
matched credential has to be rotated rather than archived.

**Never dropped silently:** every finding parsed from the report appears in the plan, with the reason
it was published or not (`false positive`, `unchanged`, `below band`, `identity unverifiable`,
`identity mismatch`). A skip is a recorded decision, not a discard.

## 6. Publication is deliberately declared on the artefact

Every issue carries `PUBLICATION_DECLARATION` in a collapsed section: that the publisher reads an
unredacted private report, that the repository's visibility is **public and declared deliberately**,
that it **deliberately bypasses** the factory's public-sink embargo for its own findings and is *not*
claiming a private target, why, and that no bead was created from the scan. A deliberate bypass that
is not stated on the thing it affects is indistinguishable from a mistake.

## 7. Identity and dedupe

A finding's identity is its fingerprint, recomputed exactly as the factory computes it:
`sha256(agent:rule_id:normalize_path(path):normalize_text(snippet))`. The report prints only the first
16 hex characters, so the recomputed value is checked against that prefix before anything is
published.

The issue body carries the fingerprint in an HTML marker
(`<!-- factory-fingerprint: … -->`), and dedupe works off those markers:

- an **open** issue with the fingerprint wins, always;
- a **closed** issue wins too, unless the finding has regressed.

If the issue list cannot be read, the run publishes **nothing** and says so. A duplicate issue is
worse than no issue: it splits the triage record in two. The same rule applies to promotion, which
dedupes against beads already carrying the fingerprint (either as `external-ref factory:<sha256>` or
as a `Fingerprint:` line) so a finding cannot be promoted twice, and refuses outright when the issue
itself already carries a `<!-- factory-promoted: <id> -->` marker.

## 8. Promotion creates the bead, and only a human starts it

```text
node scripts/factory-triage.mjs --review <issue-number> --reviewed-by <actor> [--notes "..."]
node scripts/factory-triage.mjs --promote <issue-number> [--reviewed-by <actor>] [--apply]
```

Review evidence lives **on the issue**: `--review` posts a comment carrying
`<!-- factory-review: <actor> -->`, and `--promote` refuses an issue that has no such record. A name
typed at promotion time proves nothing about whether a review happened, so `--reviewed-by` at
promotion is only a cross-check that must match the recorded reviewer, not the evidence itself.
Promotion also refuses an issue marked `<!-- factory-self-test -->` (a publisher self-test is not
work) and an issue that is already closed, unless `--allow-closed` says otherwise.

The bead body names the reviewer and the issue URL, and a comment carrying the `factory-promoted`
marker is posted back on the issue. The
bead deliberately does **not** copy the finding text — it points at the issue, so there is one place
to correct. A functionality-changing issue produces a bead created `BLOCKED` with the `human-review`
label and a comment naming the single decision that unblocks it.

## 9. What it never does

- No code, workflow or configuration edits, and no auto-fix. The only writes are `gh issue create`,
  `gh issue comment`, and (on promotion) `bd create`, `bd update`, `bd comment`.
- No label creation, and no other repository-configuration change. Labels are requested only from the
  set the repository already has; the machine-readable record is the body markers, so a missing label
  costs nothing.
- No network call beyond `gh`, and no model call. Triage is deterministic and inspectable.
- No write into the repository working tree, in any mode.

## 10. CLI

```text
node scripts/factory-triage.mjs --report <path> [--json]            # plan only, writes nothing
node scripts/factory-triage.mjs --report <path> --file-issues       # publish (requires --repo)
node scripts/factory-triage.mjs --promote <n> --reviewed-by <who> [--apply]
```

Flags: `--report-dir <dir>`, `--repo <owner/name>`, `--target <path>`, `--agent <name>`,
`--include-low`, `--functionality-change <rule|agent>`, `--json`, `--private-root <dir>`,
`--review`, `--notes`, `--self-test`, `--allow-closed`.

Exit codes: `0` a plan was produced, an issue was published, or a bead was created · `1` usage or
policy refusal (in-repo report, unreadable file, unreadable issue list or board) · `2` nothing
actionable (no findings in band, or everything already published).

## 11. Verification

- **Format fidelity is not assumed.** The fixtures are produced by the factory's **own renderer**, one
  per station, including the reduced form in which the rule id lives in the heading. Regeneration is
  documented in `tests/fixtures/factory-reports/README.md`.
- **The fingerprint mirror is cross-checked** against the factory's Python implementation for the real
  fixture inputs, not merely asserted.
- **The embargo bypass is tested at its sharp edge**: a seeded `high` finding must produce an issue,
  and an identity-critical station must be published with its raw candidate withheld everywhere in the
  published text.
- **The reviewed findings are folded with a red-on-old/green-on-new check.** An independent review of
  the previous revision requested changes on three points (a home path leaking through the issue
  title, credential-rule findings not being withheld, and a repository-internal symlink defeating the
  in-repo refusal); each was reproduced against the old code, fixed, and re-driven.
- **Mutation testing** is the bar for the suite itself: for each policy rule, breaking that rule must
  turn the suite red. The previous revision's suite had three mutants stay green, which is how a
  vacuous severity test and a dead routing branch were found. On this revision **11 mutations** were
  run — the review gate, the self-test and closed-issue guards, the reviewer cross-check, the derived
  text, the credential rule-hint trigger, the plan's title sanitisation, the lexical symlink check,
  the issue dedupe, `--silent`, and the publication declaration — and every one turned the suite red
  over 58 passing tests.
- **Not verified: a live station run, and real issue publication.** The suite drives stub `gh`/`bd`
  binaries, and the CI wiring belongs to `voicebox-beads-cbxo`. The first real publication is a
  controlled self-test recorded on `voicebox-beads-h1u0`.

## 12. Related

- [`25-factory-agent-proposal.md`](25-factory-agent-proposal.md) — the defect-class evidence and the
  measured yield this policy responds to.
- `scripts/factory-triage.mjs` — the implementation; each mirrored constant names its upstream rule.
- `tests/factory-triage.test.mjs` — the policy tests, including the no-bead-from-a-scan property.
