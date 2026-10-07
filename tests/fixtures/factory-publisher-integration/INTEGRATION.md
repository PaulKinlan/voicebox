# Publisher integration fixture (voicebox-beads-h1u0 → voicebox-beads-cbxo)

Owner split: **h1u0** owns the publisher (`scripts/factory-triage.mjs`) and the reviewed promotion;
**cbxo** owns the workflow wiring and the inbound-issue triage commenter. This file is the stable
interface between them, and it is mockable: nothing here needs a network or a token.

## 0. Where it runs (local only)

The factory runs on the local VM: no GitHub Actions, no runner, no CI secrets. This CLI reads no
Actions variable — verified by running with `GH_TOKEN`, `GITHUB_TOKEN`, `CI`, `GITHUB_ACTIONS`,
`RUNNER_TEMP` and `GITHUB_WORKSPACE` unset. Plan mode (`--json`, `--write-plan`) needs **no** `--repo`;
only `--file-issues`, `--review` and `--promote` do. The unredacted report stays in the
local private root; `--write-plan <path>` writes the sanitised plan as a local file for a review
adapter to read.

## 1. Commands (stable)

    # scan side: publish one sanitised PUBLIC issue per actionable finding, all severities
    node scripts/factory-triage.mjs --report <private report> --repo <owner/name> --file-issues
    # read-only inspection (CI-safe, writes nothing)
    node scripts/factory-triage.mjs --report <private report> --repo <owner/name> --json
    # promotion (human, reviewed only): reads the publisher body marker, or the triage markers YOUR
    # commenter writes in the comments; use --finding when a thread describes several findings
    node scripts/factory-triage.mjs --promote <n> [--finding <fingerprint-or-prefix>] --repo <owner/name> --apply
    # review side (human): record the verdict ON the issue FIRST, then promote it
    node scripts/factory-triage.mjs --review <n> --reviewed-by <actor> --repo <owner/name>
    node scripts/factory-triage.mjs --promote <n> --repo <owner/name> --target <repo path> --apply

Exit codes: `0` plan produced / issue published / bead created · `1` usage or policy
refusal **or a write that failed** (a run where any `gh issue create` failed exits 1 and reports the
count — a partial publication is never reported as success) · `2` nothing actionable (nothing in band,
everything already published, or every finding already published).

READ-ONLY SEAM (coord's ruling): your commenter owns the existing-issue comment surface; my
`--promote` reads these markers from the comments and writes none of them:
`<!-- factory-triage-comment: <hex> -->` (required), `<!-- factory-station: ... -->`,
`<!-- factory-severity: ... -->`, `<!-- factory-state: ... -->`, `<!-- factory-rule: ... -->`.

Only the fingerprint is required. `factory-station` and `factory-severity` are inherited by the bead, and
`factory-state` is recorded as-is. Two fallbacks you should know about, because they change what the bead
says: if the marker names an IDENTITY-CRITICAL station, the bead is marked for verification (reason
`model-prose`, `human-review` label, prose saying what needs verifying and why it stays claimable), and
**nothing is blocked** — a station is not a functionality change, so a security fix stays claimable; a
`<!-- factory-human-review -->` flag, when you do send one, wins over that inference and can name its own
reason. Without `factory-state` the bead records state `new`; a station outside the identity-critical set
with no flag acquires no verification marking at all.

With more than one distinct
fingerprint in a thread, `--promote` refuses unless `--finding <prefix>` says which finding the bead is
for. `--comment`/`--issue-number` were REMOVED from my script and are refused by name.

`--promote` requires the review record to already exist: `--review <n> --reviewed-by <actor>` posts
`<!-- factory-review: <actor> -->` on the issue, and promotion refuses without it. The verdict is TIED TO A
FINDING: `--review` stamps `<!-- factory-review-fingerprint: <hex> -->` for the one finding it is about
(automatic when the issue names exactly one), and `--promote` refuses when the verdict names a different
finding, or when a thread naming several findings carries a verdict that names none of them — record one
verdict per finding with `--review <n> --reviewed-by <actor> --finding <fingerprint>`. A verdict on the
thread is not authorisation for any particular identity in it. On the promotion call `--reviewed-by` is
optional and is only a cross-check that must match the recorded reviewer.

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
