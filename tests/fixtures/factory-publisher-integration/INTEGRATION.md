# Publisher integration fixture (voicebox-beads-h1u0 → voicebox-beads-cbxo)

Owner split: **h1u0** owns the publisher (`scripts/factory-triage.mjs`) and the reviewed promotion;
**cbxo** owns the workflow wiring and the inbound-issue triage commenter. This file is the stable
interface between them, and it is mockable: nothing here needs a network or a token.

## 1. Commands (stable)

    # scan side: publish one sanitised PUBLIC issue per actionable finding, all severities
    node scripts/factory-triage.mjs --report <private report> --repo <owner/name> --file-issues
    # read-only inspection (CI-safe, writes nothing)
    node scripts/factory-triage.mjs --report <private report> --repo <owner/name> --json
    # inbound issue: append sanitised triage to an issue a person already opened (no new issue)
    node scripts/factory-triage.mjs --report <private report> --repo <owner/name> --comment <n>
    # review side (human): record the verdict ON the issue FIRST, then promote it
    node scripts/factory-triage.mjs --review <n> --reviewed-by <actor> --repo <owner/name>
    node scripts/factory-triage.mjs --promote <n> --repo <owner/name> --target <repo path> --apply

Exit codes: `0` plan produced / issue published / comment posted / bead created · `1` usage or policy
refusal **or a write that failed** (a run where any `gh issue create` failed exits 1 and reports the
count — a partial publication is never reported as success) · `2` nothing actionable (nothing in band,
everything already published, or nothing new to triage on `--comment`).

`--promote` requires the review record to already exist: `--review <n> --reviewed-by <actor>` posts
`<!-- factory-review: <actor> -->` on the issue, and promotion refuses without it. On the promotion
call `--reviewed-by` is optional and is only a cross-check that must match the recorded reviewer.

Env/inputs: report must be OUTSIDE the repo tree (default root `$VOICEBOX_FACTORY_PRIVATE_DIR`
else `~/.voicebox/factory-reports`); `--repo` or `$VOICEBOX_FACTORY_REPO` is required for any mode
that touches GitHub; promotion needs a beads dir via `--target`.

## 2. `--json` schema (stable field names)

    [ { "report": string, "target": string,
        "action": "issue" | "skip", "human_review": boolean, "reasons": [string],
        "finding": { "agent", "rule_id", "path", "line_number", "state",
                     "severity", "severity_reported", "identity_critical": boolean,
                     "fingerprint": <64 hex>, "identity_source": "recomputed-and-verified" |
                     "recomputed-mismatch" | "unverifiable" },
        "issue": null | { "title", "body", "labels": [string], "fingerprint", "station",
                          "severity", "humanReview": boolean, "url" } } ]

## 3. Mockable GitHub surface

A report whose target segment does not match the repository name is REFUSED (exit 1): `--report-dir`
takes every `*-delta.md` in a directory, so a foreign report would otherwise be filed into whatever
`--repo` was passed. Keep the directory per-run; `--allow-foreign-target` overrides deliberately.

`--file-issues` calls, in order:
 1. `gh issue list --state all --json number,body,state --limit 500 --repo <owner/name>`
    — returns a JSON array; anything unreadable => publish NOTHING, exit 1.
 2. `gh label list --json name --limit 200 --repo <owner/name>` — labels are filtered to the ones
    that exist; a failed call means no labels are requested, never an error.
 3. per finding: `gh issue create --title <t> --body <b> [--label a,b] --repo <owner/name>`
    — the FIRST URL in stdout is recorded as the created issue.
Re-promotion uses `gh issue view <n> --json number,title,body,state,url,labels,comments --repo …`
and `gh issue comment <n> --body … --repo …`.

`--promote` additionally calls `bd list --all --json -n 0 -C <target>` and
`bd create --silent --title … --description … --type … --priority … --labels … --external-ref …`,
then `bd update <id> --status blocked` and `bd comment <id> …` only for a functionality change.

## 4. Golden fixture

`plan-perf-review-high.json` is the real `--json` output for
`tests/fixtures/factory-reports/voicebox-perf-review-delta.md` with `--repo PaulKinlan/voicebox`:
one HIGH finding from a non-sensitive station, `action: "issue"`. Assert at least:

    title  == "[factory/high] perf-review: Startup probe blocks the boot banner"
    labels == ["enhancement"]                      # existing labels only
    body contains "<!-- factory-fingerprint: 5939431590a573447f5b1826c33d12e4b2429002741349d1d8313deb7af5cd9a -->"
    body contains "Visibility: public, declared deliberately"
    body contains "No bead was created from the scan"
    body does NOT contain any raw value from the report (snippet/credential)

## 5. Issue markers (the loop guard for the router and the commenter)

    <!-- factory-fingerprint: <64 hex> -->      every published issue
    <!-- factory-station: <agent> -->            <!-- factory-severity: <band> -->
    <!-- factory-state: new|regressed -->        <!-- factory-human-review -->      when flagged
    <!-- factory-review: <actor> -->             after --review
    <!-- factory-promoted: <bead-id> -->         after --promote
    <!-- factory-self-test -->                   a publisher self-test: never promote

Title shape: `[factory/<severity>] <station>: <text>`, or `[human-review] [factory/<severity>] …`.
A triage comment on an inbound issue carries a DIFFERENT marker, `<!-- factory-triage-comment: <hex> -->`
(deliberately not the body marker), because an issue a person opened must stay inbound for your router.
Do not add that marker to the skip list — the mode's own dedupe is what stops it spamming: a re-scan
with nothing new posts nothing and exits `2`.

An issue carrying the publisher markers is a factory artefact, **not** an inbound report: skip it in
the router and the commenter. Match the title as `/^\[factory[:/]/` (both `[factory/<severity>]` and
the factory's own `[factory:<station>]`) and the body as either `<!-- factory-fingerprint:` or
`**Fingerprint**: \`<hex>\``. Today's protection is accidental — the published #17 was authored by
`exe-dev-github-integration[bot]` with `author_association: NONE`, so the trust gate skips it; a
user/PAT credential makes the same issue `OWNER`/`MEMBER` and it re-enters the scan.
