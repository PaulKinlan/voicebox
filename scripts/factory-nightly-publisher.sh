#!/usr/bin/env bash
# scripts/factory-nightly-publisher.sh — publish nightly factory findings to public GitHub issues (voicebox-beads-xacp)
# Reads station delta reports written with --sink file by factory-nightly.sh in ~/agents/findings/
# and calls scripts/factory-triage.mjs --file-issues with literal credentials masked.
set -uo pipefail

[ -f "$HOME/.fleet/env" ] && source "$HOME/.fleet/env"
[ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

FINDINGS_DIR="${VOICEBOX_FINDINGS_DIR:-$HOME/agents/findings}"
REPO="${VOICEBOX_FACTORY_REPO:-PaulKinlan/voicebox}"
DRY_RUN=false
EXTRA_ARGS=()

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    --findings-dir)
      FINDINGS_DIR="$2"
      shift 2
      ;;
    --repo)
      REPO="$2"
      shift 2
      ;;
    --help|-h)
      echo "Usage: scripts/factory-nightly-publisher.sh [options]"
      echo ""
      echo "Options:"
      echo "  --dry-run              Output publication plan without filing GitHub issues"
      echo "  --findings-dir <dir>   Directory containing station delta reports (default: ~/agents/findings)"
      echo "  --repo <owner/repo>    Target GitHub repository (default: PaulKinlan/voicebox)"
      exit 0
      ;;
    *)
      EXTRA_ARGS+=("$1")
      shift
      ;;
  esac
done

if [ ! -d "$FINDINGS_DIR" ]; then
  echo "[nightly-publisher] Findings directory not found: $FINDINGS_DIR. Nothing to publish."
  exit 0
fi

cd "$ROOT_DIR"

PUBLISH_FLAG="--file-issues"
if [ "$DRY_RUN" = true ]; then
  PUBLISH_FLAG=""
  echo "[nightly-publisher] DRY-RUN mode active: planning issues without publishing."
fi

published_count=0
# Loop through all station delta reports for voicebox-factory, ignoring line-level voicebox-factory-delta.md
for report in "$FINDINGS_DIR"/voicebox-factory-*-delta.md; do
  [ -f "$report" ] || continue
  # Ignore composite line delta (lacks single agent name)
  if [ "$(basename "$report")" = "voicebox-factory-delta.md" ]; then
    continue
  fi

  echo "[nightly-publisher] Processing station report: $(basename "$report")"
  node scripts/factory-triage.mjs --report "$report" --repo "$REPO" --allow-foreign-target $PUBLISH_FLAG "${EXTRA_ARGS[@]}" || {
    echo "[nightly-publisher] Warning: failed to process $(basename "$report") (exit $?)"
  }
  published_count=$((published_count + 1))
done

echo "[nightly-publisher] Finished processing $published_count station delta report(s)."
exit 0
