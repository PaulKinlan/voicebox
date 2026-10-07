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
                                                                            BLOCKED only if the
                                                                            change is a functionality change)
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
| `low`, `info` | any | Yes — every severity reaches the triage surface by default (`--exclude-low` opts out) | P3 |
| any | any | Functionality change → published, marked `human-review`, and the promoted bead is BLOCKED | P1–P2 by severity |
| any | security station | published and marked for **verification** (not a block): the bead stays claimable | P1–P2 by severity |

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
- **The block follows the criterion, not the station.** A bead is blocked when the remediation is
  likely to *majorly change functionality*, or when an external approval is unresolved — that is
  coord/Paul's rule. A security station is a different thing: its description and remediation are
  model-authored and are published unreviewed, so the **issue** is marked for human/independent
  verification (`[human-review]`, `factory-human-review` + `factory-human-review-reason: model-prose`)
  while the **bead stays claimable**. That is deliberate: an urgent critical fix must not be gated on a
  review queue position, and the sanitiser already withholds the raw candidate.
- **A security station's finding is flagged for human verification too**, for a different reason: its
  description and remediation are *model-authored prose*, and this pipeline publishes at every
  severity, so those words reach the public tracker with no human in between. Publishing the prose is
  the deliberate choice — a generic replacement would make the issue un-actionable — and the flag is
  the honest consequence: the issue says a person must verify it, and a promoted bead is filed
  `BLOCKED` only when the change is a functionality change; a security-only finding is marked for
  verification and stays claimable. Nothing here should be acted on unverified.

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
(`<!-- factory-fingerprint: … -->`), and dedupe reads **both marker shapes** in the wild: this
publisher's HTML marker and the markdown line the factory's own `github-issues` sink writes
(the factory's own github-issues sink writes `**Fingerprint**: …`). Both are the same sha256, and a dedupe that understood only
its own marker would file a second public issue for one finding. Either the full digest or the 16-hex
prefix the report itself prints will match. Dedupe then works off those markers:

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

## 8b. Promoting a reviewed, human-filed issue (read-only)

An inbound issue a person opened can become a bead, but only after it has been triaged **and** reviewed:
`--promote` refuses until a review record exists. It reads the identity from the issue, and it never
writes a marker into a comment — the existing-issue comment surface belongs to another lane's
commenter (bead `voicebox-beads-cbxo`), a script that does not live in this tree, and whose markers this
script reads and never writes.

`--promote <n>` resolves the finding in this order:

1. the publisher's own `<!-- factory-fingerprint: … -->` in the issue **body** (unchanged);
2. otherwise the triage markers another tool wrote **in the comments**:
   `<!-- factory-triage-comment: <fingerprint> -->` plus `factory-station`, `factory-severity` and
   `factory-state`, so the bead inherits the station, the severity (and therefore its priority) and
   the state instead of guessing from the title.

Only the fingerprint marker is required in that comment. The station and severity it names are
inherited by the bead, and the state is recorded as-is; two fallbacks matter. An
**identity-critical station** named by the marker marks the bead for verification even when no review
flag was written — reason `model-prose`, the `human-review` label, and prose saying what needs
verifying and why the bead stays claimable. A flag the writer *does* send wins over that inference. And
with no state marker the bead records `new`, because a missing marker is not evidence of a regression.
A station outside the identity-critical set with no flag acquires no verification marking: the
inference must not manufacture a security signal for an ordinary quality finding.

If the comments describe **more than one** finding, promotion refuses and lists them, and
`--finding <fingerprint-or-prefix>` says which one the bead is for. A comment can describe several
findings while a bead carries one identity, so that choice is explicit rather than derived. An issue
that neither its body nor its comments identify is refused by name.

**A thread can carry one verdict per finding, and one bead per reviewed finding.** The reviewer named in
the bead is the author of the verdict that authorises *that* finding — reading the first verdict on the
issue attributed the promotion to someone who had reviewed a different finding. The promotion receipt
records which finding it covers (`<!-- factory-promoted-fingerprint: … -->`), so promoting the second
reviewed finding from the same issue is allowed while re-promoting the first is refused by name. A record
without a fingerprint predates that rule and blocks only an issue that identifies exactly one finding.

**The verdict is tied to a finding.** `--review` stamps the finding it is about
(`<!-- factory-review-fingerprint: … -->`, automatic when the issue names exactly one), and promotion
requires a verdict that names the identity being promoted: a verdict tied to a different finding is
refused, and a thread that names several findings with a verdict that names none of them is refused as
unreviewed. One verdict per finding; a review of the thread is not authorisation for any identity in it.

`--comment` / `--issue-number` were **removed**: this script does not comment on existing issues. A
caller using them gets a named refusal that points at the other lane's commenter, rather than a silent
no-op.

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
`--exclude-low` (skip low/info; they are published by default), `--include-low` (accepted and redundant),
`--functionality-change <rule|agent>`, `--json`, `--private-root <dir>`, `--review`, `--notes`,
`--finding`, `--self-test`, `--allow-closed`, `--allow-foreign-target`.

Exit codes are part of the contract: `0` a plan was produced / an issue published / a bead created; `1` a usage or policy refusal, **or a write that failed** — a publication where any
`gh issue create` failed exits `1` and says how many, because a partial publication reported as
success is how a CI job passes while a finding was never filed; `2` nothing actionable (nothing in band,
or every finding already published). A report that declares more new/regressed findings than it contains
is NOT `2`: it exits `1` and publishes nothing, because a killed or timed-out station run is
indistinguishable from a complete one except by that declared count — record the run as UNKNOWN and
re-run the station.

Two refusals exist to stop silent mis-publication:

- **A report for another repository is refused.** `--report-dir` takes every `*-delta.md` in a
  directory, and a report names its own target, so a stale or foreign report would otherwise be filed
  into whatever `--repo` was passed — another repository's finding, published publicly, in the wrong
  tracker. The target segment must match the repository name; `--allow-foreign-target` forces it.
- **An in-repo report is refused**, as above: the report is the unredacted evidence trail.

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
- **The second review round found two more disclosure leaks, and one of them was in the surface a
  CI log captures.** The plan printed the raw rule id and path (a rule id is model text and can carry
  a credential the triage agent echoed; a path can carry the operator's home directory), on stdout
  *and* in `--json`; and the withheld-evidence notice interpolated the raw path before the elision
  existed, so a **quality** station raising a credential rule published
  `[withheld: … (/home/…/auth.ts:42)]` into a public issue body. Both are fixed, the credential case
  now refuses the evidence block entirely rather than only for identity-critical stations, and both
  are covered by tests that fail against the old code.
- **A seeded HIGH cannot disappear.** The factory's own public sinks embargo high and critical
  findings, so a finding routed through them vanishes from the tracker. This publisher bypasses that
  embargo deliberately, declares the bypass on every issue, and has a test that states both halves:
  that the factory's sink *would* withhold the seeded HIGH, and that this publisher publishes it with
  its issue body intact. The mutation that proves the guard works is to make `routeFinding` return
  `skip` for `EMBARGOED_SEVERITIES` — the factory's own behaviour — which turns five tests red,
  including the HIGH and CRITICAL publication tests.
- **A third review round found the cross-target refusal was bypassable, and it was.** A report whose
  target ends in a slash (`/repos/other/`) parsed to an empty segment, and the old guard only refused
  when the parsed target was non-empty, so the comparison was skipped and the report was published into
  whatever `--repo` was passed; a report with no target header was treated the same way. Both were
  reproduced against the previous revision before being fixed. The rule is now **fail closed** — a
  report whose target cannot be read is not evidence that its findings belong here — with the trailing
  slash stripped so a legitimate `/repos/voicebox/` is still accepted, and a test covers each case.
- **The same round caught a false claim in this document** — that `--promote` read a fingerprint from a
  triage comment. It did not, and the claim was retracted. It is now *implemented* instead, as the
  read-only seam in section 8b: promotion of a reviewed, human-filed issue is allowed, `--finding`
  resolves the one-finding-in-a-thread case, and the markers are written by the other lane's commenter.
- **A fourth round found the mirror of the cross-target bug**: `--repo owner/voicebox/` parsed to an
  empty repository name, which is falsy, which skipped the refusal — so a foreign report could be
  published while the guard looked armed. `--repo` is normalised exactly like the report's target now,
  and both directions are tested (our own repository with a slash still plans; a foreign one refuses).
- **A fifth round found three more real defects**, all fixed with a test that fails against the old
  code: `--repo /` (and slash-only or whitespace-only input) parsed to an empty repository name, which
  is the same falsy-hole as the trailing slash — malformed input now fails closed instead of quietly
  disarming the cross-target refusal; an explicit `--finding` was ignored whenever a thread held
  exactly one finding, so a prefix matching nothing silently promoted the identity it did find; and a
  green mutant proved the human-review flag read from a comment was never observed. It also caught the
  criterion's own trail: the issue body and the reason bullets still promised a BLOCKED bead for a
  security-only finding, which the new code no longer does.
- **`--write-plan` is atomic, and that property is now mutation-observable.** A failed write left its
  temporary file behind (reproduced by the reviewer with a directory destination, EISDIR). It is
  removed on failure now. Atomicity itself was unmonitored — a direct `writeFileSync` survived the
  suite — so the test uses the one arrangement that tells them apart: in a directory that cannot be
  written, creating the temp file fails while writing to an **existing** file still succeeds, so a
  direct write would have replaced the old plan and temp+rename cannot. A reviewer-found green mutant
  on the `human-review-reason` marker is closed the same way, by using a reason the station-based
  inference could never produce.
- **And a false statement in the bead comment.** Every flagged finding's bead was told "this
  remediation changes functionality" — untrue for a security station, whose prose is model-authored
  whether or not the fix changes behaviour. The reason now travels with the flag
  (`<!-- factory-human-review-reason: model-prose|functionality-change|both -->`), and both the issue
  body and the bead comment are composed from it, with a station-based inference only for issues that
  predate the marker.
- **Mutation testing** is the bar for the suite itself: for each policy rule, breaking that rule must
  turn the suite red. The last **full matrix** — run when the blocking criterion landed — was **50 mutations over 85
  passing tests, and every one turned the suite red** (0 green, 0 skipped). Each later revision added
  its own mutants for the code it touched and every one of those is red too: three over the marker-set
  tolerance and four over the round-6 fixes (body-marker exclusion from the candidate list, `--finding`
  validation skipped, ambiguity derived instead of refused, and malformed `--repo` returning null
  instead of throwing). The suite stands at **88 tests**. Mutants whose target code was removed with
  the comment mode are deleted from the matrix rather than counted
  seeded HIGH cannot quietly disappear. The reviewer's own mutation run had found **six rules that
  stayed green** on the revision before this one — the `falsePositive` and `state: "unchanged"` skips,
  `maskText` and private-root elision inside `displayTitle`, and the `bd create` / `gh issue create`
  failure checks — and all six now have tests and mutants of their own. Two mutants turned out to be
  *equivalent* rather than uncovered, and are recorded as such: dropping the `unchanged` early return
  falls through to a skip that also says "unchanged" (the assertion was tightened to the exact reason),
  and dropping the trailing-slash strip is caught by the fail-closed check for a foreign target but
  **not** for our own repository with a slash, which is why that case is now a test.
- **A failed publication cannot read as success.** Writing the failure tests found the defect itself:
  a failed `gh issue create` was swallowed, so a run could publish nothing and exit `0`. A partial
  publication now exits `1` and names the count.
- **Not verified: a live station run, and real issue publication.** The suite drives stub `gh`/`bd`
  binaries, and the CI wiring belongs to `voicebox-beads-cbxo`. The first real publication is a
  controlled self-test recorded on `voicebox-beads-h1u0`.

## 12. Local activation (no CI)

The factory runs on the **local VM only** (Paul's decision): stations run locally, the unredacted report
stays on the machine, and the publisher writes its issues and comments from there. No GitHub Actions,
no runner, no CI cost.

What that requires of this CLI, and what was verified rather than assumed:

- **No Actions secret or runner variable is read.** Verified by driving the real CLI with `GH_TOKEN`,
  `GITHUB_TOKEN`, `CI`, `GITHUB_ACTIONS`, `RUNNER_TEMP` and `GITHUB_WORKSPACE` all unset: exit `0`,
  both fixtures planned, and the full issue bodies present in the local plan file. The only environment
  inputs are `VOICEBOX_FACTORY_PRIVATE_DIR` (default `~/.voicebox/factory-reports`),
  `VOICEBOX_FACTORY_REPO`, and whichever credential `gh` itself is authenticated with.
- **The full report stays local.** The stations write `<target>-<agent>-delta.md` with `--sink file`;
  this CLI reads it from the private root and **refuses** a report inside the repository, so the
  unredacted evidence trail is never committed. It is a working file, not a durable store — the
  published issue is the durable record.
- **Public issues are published through the VM's own `gh` proxy, not a hub secret.** `gh` is
  `/usr/local/bin/gh`, authenticated to `github.int.exe.xyz` in its own config, with `GH_HOST` set in
  the environment; verified with `GH_TOKEN` and `GITHUB_TOKEN` unset — `gh api` and the publisher both
  work. The CLI never reads a token itself: it shells out to `gh` and inherits that authentication.
- **Plan mode needs no repository at all.** `--json` and `--write-plan` work with no `--repo`: a
  nightly local run can inspect its own findings without naming a tracker. `--file-issues`,
  `--review` and `--promote` require `--repo`, because they write to one.
- **`--write-plan <path>`** writes the same sanitised plan to a local file — the artefact a review
  adapter reads — creating the parent directory, atomically, and refusing with a named error if the
  path cannot be written. It never contains the raw report text.

```text
# 1. stations (unchanged; local, file sink)
factory run <station> --target ~/voicebox --sink file
# 2. inspect locally - no tracker, no token, no CI
node scripts/factory-triage.mjs --report ~/.voicebox/factory-reports/voicebox-perf-review-delta.md \
  --write-plan /tmp/triage/plan.json
# 3. publish (needs an authenticated gh and a repository)
node scripts/factory-triage.mjs --report ~/.voicebox/factory-reports/voicebox-perf-review-delta.md \
  --repo owner/name --file-issues
# 4. review on the issue, then promote
node scripts/factory-triage.mjs --review <n> --reviewed-by <actor> --repo owner/name
node scripts/factory-triage.mjs --promote <n> --repo owner/name --target ~/voicebox --apply
# 5. promote a reviewed, human-filed issue (read-only: reads the commenter's markers, writes none)
node scripts/factory-triage.mjs --promote <n> [--finding <fingerprint>] --repo owner/name --apply
```

A CI wiring candidate (a GitHub workflow calling this publisher) was superseded by the local-only
decision. The **flags above are unchanged** by that, so nothing in this contract moved; what moved is
where the command runs. A local adapter that re-scans an issue thread still gets the same
`factory-triage-comment` dedupe, which is what stops it repeating itself.

## 13. Related

- [`25-factory-agent-proposal.md`](25-factory-agent-proposal.md) — the defect-class evidence and the
  measured yield this policy responds to.
- `scripts/factory-triage.mjs` — the implementation; each mirrored constant names its upstream rule.
- `tests/factory-triage.test.mjs` — the policy tests, including the no-bead-from-a-scan property.
