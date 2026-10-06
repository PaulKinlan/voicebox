#!/usr/bin/env sh
# scripts/landing-preflight.sh — one answer to one question: IS IT SAFE TO PUSH THIS TREE AT THAT
# REF? (voicebox-beads-vto3)
#
#   scripts/landing-preflight.sh                    preconditions, real dry run at the target, verdict
#   scripts/landing-preflight.sh --classify <file>  verdict for output captured earlier
#   scripts/landing-preflight.sh --check            preconditions only
#   scripts/landing-preflight.sh --rehearse         every branch driven with the push STUBBED
#   scripts/landing-preflight.sh --help             usage, options, exit codes
#
# WHY THIS EXISTS (measured 2026-10-05; the fleet-13q family, and TO-SHELLEY fleet-a13). Four merger
# lanes hand-built the same closing check in the minute before a push, on four VMs, and all four
# converged on the same four-branch fail-closed shape — which is the condition where four copies
# diverge later. One of those lanes had a rebase conflict, pushed, saw the transport print
# `Everything up-to-date`, and read that as success while the default branch had not moved; the
# cleanup step then deleted the only copy of reviewed-but-unlanded bytes. The diagnosis is sharper
# than "be careful": what failed was the ASSUMPTION THAT A PUSH RESULT IS EVIDENCE ABOUT THE DEFAULT
# BRANCH. `Everything up-to-date` is a TRUE statement about a ref that is not the one being landed.
# So this is a script, versioned with the code, with a test that can fail — not a ritual kept in
# somebody's memory.
#
# WHAT MAKES THE VERDICT WORTH HAVING: the dry run goes to the REAL TARGET ref
# (`<remote> HEAD:refs/heads/<target>`), not to a probe ref and not to another branch. A dry run
# against a throwaway ref answers a question nobody asked — which is exactly how the up-to-date lie
# got told.
#
# THE FOUR BRANCHES, IN THIS ORDER. Order is the mechanism, not style: a refusal line also carries a
# sha, so a loose update-row pattern can be satisfied by a refusal, and a rejection tested second
# would read a refused push as a good one.
#
#   1. output contains `[rejected]`                         -> REFUSED  exit 3  do NOT push; fetch,
#      (tested FIRST)                                            re-merge, RE-GATE the merged tree
#   2. output contains `Everything up-to-date`               -> NO-OP    exit 2  a probe, or HEAD
#      already is the target; it says NOTHING about whether the landing happened
#   3. an update row `^ *<sha4+>..<sha4+>  HEAD -> <target>`  -> OK      exit 0  push
#      whose NEW-side sha is a prefix of `git rev-parse HEAD`
#   4. anything else                                        -> UNKNOWN  exit 4  do NOT push
#
# BRANCH 3 IS THREE PARTS, all asserted: (a) the row exists, (b) it is not a refusal wearing a sha,
# (c) the sha it prints is the tree standing here. Part (c) is what ties the verdict to the bytes the
# gate ran on — without it the row only proves git would move *a* ref. The length is read FROM THE
# ROW and never hardcoded: git's abbreviation varies with repository size and `core.abbrev`, so a
# 7-char assumption breaks silently on a big repo, and a small fixture cannot make a 7-char one.
#
# THE PRECONDITION IS ASSERTED TOO (exit 5): a clean worktree, and HEAD != `<remote>/<target>`. An
# uncommitted merge leaves HEAD sitting on the default branch, and the dry run then truthfully
# reports `Everything up-to-date` about a landing that never happened — a false green that branch 2
# would otherwise have to explain away.
#
# DASH, NOT BASH (measured in this tree): eight scripts here carry `#!/usr/bin/env sh` and `/bin/sh`
# is dash on the fleet's VMs — including `.githooks/pre-push` and `scripts/pre-push.sh`, which commit
# `221c44d` (2026-10-05) had to make POSIX-portable after a branch push ran the whole gate on dash.
# So: no `PIPESTATUS`, no `set -o pipefail`, no arrays, no `[[`. The dry run writes a FILE and its
# exit code is read on the next line, never through a pipe.
#
# ONE RULE THAT IS NOT COSMETICS: if the dry-run command itself exits non-zero, an OK verdict is
# DOWNGRADED to UNKNOWN (exit 4). A row printed by a command that then failed is an output, not a
# promise.
#
# Exit codes are distinct on purpose: a caller that reads every non-zero as "red" cannot tell "the
# remote refused" from "you are standing on the thing you meant to push", and those want opposite
# answers.
#
#   0 OK  2 NO-OP  3 REFUSED  4 UNKNOWN  5 PRECONDITION  6 IDENTITY-MISMATCH  1 USAGE
set -e

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$REPO_ROOT"

REMOTE="origin"
TARGET="main"
LOCAL_REF="HEAD"
MODE="full"
CLASSIFY_FILE=""
PUSH_CMD="${LANDING_PREFLIGHT_PUSH_CMD:-}"   # set it to a stub to rehearse without touching a remote
HEAD_SHA=""
DRYRUN_RC=0

usage() {
  cat <<'USAGE'
landing-preflight.sh — is it safe to push this tree at that ref?

  (no args)                     preconditions, then a DRY RUN AT THE REAL TARGET, then a verdict
  --classify <file>             verdict for previously captured push output (preconditions too)
  --check                       preconditions only
  --rehearse                    drive every branch with the push stubbed; sends nothing anywhere
  --remote <name>               remote to ask (default: origin)
  --target <branch>             ref being landed (default: main)
  --local-ref <ref>             what is being pushed (default: HEAD)
  --push-cmd <command>          shell command performing the dry run; $1=remote $2=target
                                $3=local-ref (default: git push --dry-run $1 "$3:refs/heads/$2")

verdicts / exit codes
  0  OK                  the target would move to the tree standing here
  2  NO-OP              nothing would move — a probe, or HEAD already is the target. Do not push.
  3  REFUSED             the remote would reject this push: fetch, re-merge, RE-GATE, ask again
  4  UNKNOWN             output this script does not recognise, or a failing dry run. Do not push.
  5  PRECONDITION        dirty worktree, or HEAD equals the target tip — nothing was asked
  6  IDENTITY-MISMATCH   the row it found names a different sha than HEAD here. Do not push.
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --help|-h) usage; exit 0 ;;
    --classify) MODE="classify"; CLASSIFY_FILE="${2:-}"; shift 2 ;;
    --check) MODE="check"; shift ;;
    --rehearse) MODE="rehearse"; shift ;;
    --remote) REMOTE="${2:-}"; shift 2 ;;
    --target) TARGET="${2:-}"; shift 2 ;;
    --local-ref) LOCAL_REF="${2:-}"; shift 2 ;;
    --push-cmd) PUSH_CMD="${2:-}"; shift 2 ;;
    *) printf 'landing-preflight: unknown argument: %s\n' "$1" >&2; usage >&2; exit 1 ;;
  esac
done

say() { printf '%s\n' "$*"; }
warn() { printf '%s\n' "$*" >&2; }

# ── THE SHAPES ────────────────────────────────────────────────────────────────
# FIXED STRINGS, not patterns, where a pattern would lie: `[rejected]` as a BRE is a character class
# matching any single one of r,e,j,t,c — nearly every line git prints — which turns every push into a
# REFUSED one. Written as a pattern first here; the rehearsal caught it, which is the argument for
# having the rehearsal.
REJECT_MARK='[rejected]'
NOOP_MARK='Everything up-to-date'

# The update row, as ERE: anchored, four-or-more hex either side of the dots, then the LOCAL REF
# being pushed. Built by concatenation because the ref is data, and passed to `grep -E`.
# Deletion rows (`-  …`) and forced rows (`+ old...new`) begin with a marker, not a sha, and a `...`
# row cannot match `[0-9a-f]{4,}\.\.[0-9a-f]{4,}` — both fall through to UNKNOWN, which is the
# fail-closed answer for a shape this script has not been shown how to read.
row_pattern() {
  printf '%s' '^ *[0-9a-f]{4,}\.\.[0-9a-f]{4,} +'
  printf '%s' "$LOCAL_REF"
  printf '%s' '([ ]|$)'
}

# ── THE PRECONDITION (asserted, not assumed) ──────────────────────────────────
precondition() {
  _head="$(git rev-parse "$LOCAL_REF" 2>/dev/null || true)"
  if [ -z "$_head" ]; then
    warn "[preflight] PRECONDITION: $LOCAL_REF does not resolve to a commit (exit 5)"
    return 5
  fi
  if [ -n "$(git status --porcelain 2>/dev/null | head -n 1)" ]; then
    warn "[preflight] PRECONDITION: the worktree is not clean (exit 5). An uncommitted merge leaves"
    warn "[preflight]   HEAD on the default branch, and the dry run then reports 'Everything"
    warn "[preflight]   up-to-date' about a landing that has not happened."
    git status --porcelain 2>/dev/null | head -n 12 || true
    return 5
  fi
  _tip="$(git rev-parse --verify --quiet "$REMOTE/$TARGET" 2>/dev/null || true)"
  if [ -n "$_tip" ] && [ "$_head" = "$_tip" ]; then
    warn "[preflight] PRECONDITION: HEAD ($_head) IS $REMOTE/$TARGET — there is nothing here to land."
    warn "[preflight]   Either the merge never happened or it is already in. Do the merge, then ask."
    return 5
  fi
  HEAD_SHA="$_head"
  return 0
}

# ── THE CLASSIFIER: one verdict line, one exit code ───────────────────────────
classify() {
  _out="$1"
  if [ ! -f "$_out" ]; then
    printf 'UNKNOWN  no captured output to read (%s). Do NOT push.\n' "$_out"
    return 4
  fi

  # 1 — REFUSED, tested FIRST: a refusal line carries a sha and can also look like an update row.
  if grep -qF -- "$REJECT_MARK" "$_out" 2>/dev/null; then
    printf 'REFUSED  the remote would reject this push. Do NOT push.\n'
    grep -nF -- "$REJECT_MARK" "$_out" | head -n 5 || true
    printf '         next: git fetch %s, re-merge %s/%s, then RE-GATE the merged tree.\n' \
      "$REMOTE" "$REMOTE" "$TARGET"
    return 3
  fi

  # 2 — NO-OP: a true statement about a ref, silent about the landing. Never evidence of movement.
  if grep -qF -- "$NOOP_MARK" "$_out" 2>/dev/null; then
    printf 'NO-OP    nothing would move. This is a probe, or HEAD already is the target.\n'
    printf '         It is NOT evidence that anything landed. Do NOT push.\n'
    return 2
  fi

  # 3 — OK only when the row exists, names the ref being landed, and prints THIS tree's sha.
  _row="$(grep -E "$(row_pattern)" "$_out" 2>/dev/null | head -n 1 || true)"
  if [ -z "$_row" ]; then
    printf 'UNKNOWN  no update row naming %s, no refusal, no up-to-date. Do NOT push.\n' "$LOCAL_REF"
    printf '%s\n' '---- captured output ----'
    head -n 40 "$_out" || true
    return 4
  fi
  # The sha on the NEW side of `old..new` is what would be written to the target. sed keeps the
  # digits and drops the tail; the length is whatever the row printed, read not assumed.
  _new_sha="$(printf '%s\n' "$_row" | sed -e 's/^[ 	]*//' -e 's/^\([0-9a-f]*\)\.\.\([0-9a-f]*\).*$/\2/')"
  if [ -z "$_new_sha" ] || [ "$_new_sha" = "$_row" ]; then
    printf 'UNKNOWN  the update row did not yield a new-side sha. Do NOT push.\n'
    printf '         row: %s\n' "$_row"
    return 4
  fi
  case "$HEAD_SHA" in
    "$_new_sha"*)
      printf 'OK       %s/%s would move to %s — the tree standing here (%s).\n' \
        "$REMOTE" "$TARGET" "$_new_sha" "$HEAD_SHA"
      return 0
      ;;
    *)
      printf 'IDENTITY-MISMATCH  the dry run would write %s, but HEAD here is %s.\n' \
        "$_new_sha" "$HEAD_SHA"
      printf '         The gated tree is not the tree being offered. Do NOT push.\n'
      printf '         row: %s\n' "$_row"
      return 6
      ;;
  esac
}

# `classify` answers with an exit code, and under `set -e` a non-zero function return in command
# position ends the script before the caller can report it, so the verdict is captured with `if`.
OUT_DEFAULT=""
cleanup() {
  if [ -n "$OUT_DEFAULT" ] && [ -f "$OUT_DEFAULT" ]; then rm -f "$OUT_DEFAULT" 2>/dev/null || true; fi
}
trap cleanup EXIT INT TERM

do_dryrun() {
  _out="$1"
  _rc=0
  if [ -n "$PUSH_CMD" ]; then
    # shellcheck disable=SC2086
    sh -c "$PUSH_CMD" _ "$REMOTE" "$TARGET" "$LOCAL_REF" >"$_out" 2>&1 || _rc=$?
  else
    git push --dry-run "$REMOTE" "${LOCAL_REF}:refs/heads/${TARGET}" >"$_out" 2>&1 || _rc=$?
  fi
  DRYRUN_RC="$_rc"
  return 0
}

# A verdict nobody can read back is not auditable: the captured output is echoed with the verdict.
report() {
  _out="$1"
  _echo_body="${_echo_body:-1}"
  _vc=0
  if classify "$_out"; then _vc=0; else _vc=$?; fi
  if [ "$_echo_body" = "1" ]; then
    printf '%s\n' '---- captured output ----'
    head -n 40 "$_out" 2>/dev/null || true
  fi
  return $_vc
}

case "$MODE" in
  check)
    _rc=0
    precondition || _rc=$?
    if [ "$_rc" -ne 0 ]; then exit "$_rc"; fi
    say "PRECONDITION-OK  HEAD=$HEAD_SHA  target=$REMOTE/$TARGET"
    exit 0
    ;;

  classify)
    if [ -z "$CLASSIFY_FILE" ]; then usage >&2; exit 1; fi
    _rc=0
    precondition || _rc=$?
    if [ "$_rc" -ne 0 ]; then exit "$_rc"; fi
    _echo_body=0
    report "$CLASSIFY_FILE"
    exit $?
    ;;

  full)
    _rc=0
    precondition || _rc=$?
    if [ "$_rc" -ne 0 ]; then exit "$_rc"; fi
    OUT_DEFAULT="$(mktemp "${TMPDIR:-/tmp}/landing-preflight.XXXXXX")"
    say "[preflight] dry run against the REAL target: $REMOTE refs/heads/$TARGET  (local ref $LOCAL_REF)"
    do_dryrun "$OUT_DEFAULT"
    say "[preflight] dry-run exit code: $DRYRUN_RC"
    _echo_body=0
    _vc=0
    if report "$OUT_DEFAULT"; then _vc=0; else _vc=$?; fi
    # A row printed by a command that then failed is not a promise: never say OK on a failed dry run.
    if [ "$_vc" = "0" ] && [ "$DRYRUN_RC" != "0" ]; then
      printf 'UNKNOWN  the dry-run command itself exited %s. Do NOT push on a partial answer.\n' "$DRYRUN_RC"
      _vc=4
    fi
    if [ "$_vc" != "0" ]; then
      printf '%s\n' '---- captured output ----'
      cat "$OUT_DEFAULT" 2>/dev/null || true
    fi
    exit "$_vc"
    ;;

  rehearse)
    # Every branch, driven with the classifier's input SYNTHESISED and the push stubbed. Nothing here
    # contacts a remote, and that is the control: the rehearsal proves the classifier, not the
    # transport. Refusals and update rows from a REAL git are driven by
    # tests/landing-preflight.test.mjs, which labels which input was real.
    _tmp="$(mktemp -d "${TMPDIR:-/tmp}/landing-preflight-rehearse.XXXXXX")"
    HEAD_SHA="$(git rev-parse "$LOCAL_REF" 2>/dev/null || echo 0000000000000000000000000000000000000000)"
    _h7="$(printf '%s' "$HEAD_SHA" | cut -c1-7)"
    _h4="$(printf '%s' "$HEAD_SHA" | cut -c1-4)"
    _h40="$(printf '%s' "$HEAD_SHA" | cut -c1-40)"
    _foreign7="abcdef0"        # 7 hex that cannot be a prefix of any real HEAD here
    _old7="0123456"
    _failed=0
    _want() { # <label> <expected code> <file>
      _wvc=0
      if classify "$3" >/dev/null 2>&1; then _wvc=0; else _wvc=$?; fi
      if [ "$_wvc" = "$2" ]; then
        printf 'REHEARSE  %-22s exit %s as expected\n' "$1" "$_wvc"
      else
        printf 'REHEARSE  %-22s exit %s, WANTED %s  <<< WRONG VERDICT\n' "$1" "$_wvc" "$2" >&2
        _failed=$((_failed + 1))
      fi
    }

    # SYNTHESISED refusals — both wordings this repo has actually printed, then the ordering trap.
    printf 'To github.example:owner/repo.git\n ! [rejected]        %s -> %s (non-fast-forward)\n' "$_h7" "$TARGET" > "$_tmp/refused-nff"
    printf 'To github.example:owner/repo.git\n ! [rejected]        %s -> %s (fetch first)\n' "$_h7" "$TARGET" > "$_tmp/refused-fetchfirst"
    printf 'To github.example:owner/repo.git\n ! [rejected]        %s..%s  HEAD -> %s (non-fast-forward)\n' "$_h7" "$_h7" "$TARGET" > "$_tmp/refused-wearing-a-row"
    printf 'Everything up-to-date\n' > "$_tmp/noop"
    printf 'To x\n   %s..%s  HEAD -> %s\n' "$_h7" "$_h7" "$TARGET" > "$_tmp/ok-7char"
    printf 'To x\n   %s..%s  HEAD -> %s\n' "$_h4" "$_h4" "$TARGET" > "$_tmp/ok-4char"
    printf 'To x\n   %s..%s  HEAD -> %s\n' "$_old7" "$_foreign7" "$TARGET" > "$_tmp/mismatch"
    printf 'To x\n   %s..%s  HEAD -> %s\n' "$_h4" "$_h40" "$TARGET" > "$_tmp/ok-full-sha-on-right"
    printf 'To x\n   00000000..%s  refs/heads/feature -> %s\n' "$_h7" "$TARGET" > "$_tmp/probe-ref"
    printf 'remote: Internal server error\nfatal: the remote end hung up unexpectedly\n' > "$_tmp/unknown"
    : > "$_tmp/empty"

    _want REFUSED-non-fast-forward 3 "$_tmp/refused-nff"
    _want REFUSED-fetch-first 3 "$_tmp/refused-fetchfirst"
    _want REFUSED-beats-loose-row 3 "$_tmp/refused-wearing-a-row"
    _want NO-OP 2 "$_tmp/noop"
    _want OK-7-CHAR 0 "$_tmp/ok-7char"
    _want OK-4-CHAR-FROM-ROW 0 "$_tmp/ok-4char"
    _want IDENTITY-MISMATCH 6 "$_tmp/mismatch"
    _want OK-40-CHAR-READ-FROM-ROW 0 "$_tmp/ok-full-sha-on-right"
    _want UNKNOWN-probe-ref 4 "$_tmp/probe-ref"
    _want UNKNOWN-server-error 4 "$_tmp/unknown"
    _want UNKNOWN-empty 4 "$_tmp/empty"

    rm -rf "$_tmp" 2>/dev/null || true
    if [ "$_failed" -ne 0 ]; then
      warn "[rehearse] $_failed branch(es) mis-classified — the classifier is wrong, not the remote."
      exit 1
    fi
    say "[rehearse] every branch classified as expected. These inputs were SYNTHESISED; real refusals"
    say "[rehearse] and a real update row are driven in tests/landing-preflight.test.mjs, which names"
    say "[rehearse] which is which. No remote was contacted by this rehearsal."
    exit 0
    ;;
esac
