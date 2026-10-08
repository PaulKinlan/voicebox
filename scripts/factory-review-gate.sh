#!/usr/bin/env bash
# scripts/factory-review-gate.sh — review-time factory station invocation gate (voicebox-beads-xacp)
# Invoked during IN_REVIEW handoff to evaluate base..tip diff across the 5 domains,
# execute at most 1 primary station under heavy queue, record deferred stations for nightly,
# and post findings via the controlled publisher.
set -uo pipefail

[ -f "$HOME/.fleet/env" ] && source "$HOME/.fleet/env"
[ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

BASE=""
TIP="HEAD"
BEAD=""
EXTRA_ARGS=()

while [ $# -gt 0 ]; do
  case "$1" in
    --base)
      BASE="$2"
      shift 2
      ;;
    --tip)
      TIP="$2"
      shift 2
      ;;
    --bead)
      BEAD="$2"
      shift 2
      ;;
    --help|-h)
      echo "Usage: scripts/factory-review-gate.sh --base <merge-base> [--tip <head-sha>] [--bead <bead-id>] [options]"
      echo ""
      echo "Options:"
      echo "  --base <base>       Base git ref or commit SHA (required or auto-resolved from origin/main)"
      echo "  --tip <tip>         Tip git ref or commit SHA (default: HEAD)"
      echo "  --bead <id>         Bead issue ID to receive review verdict comments"
      echo "  --dry-run           Plan and select stations without executing or publishing"
      echo "  --force             Bypass cache and force re-execution"
      echo "  --repo <owner/repo> Target repository for publication (default: PaulKinlan/voicebox)"
      exit 0
      ;;
    *)
      EXTRA_ARGS+=("$1")
      shift
      ;;
  esac
done

if [ -z "$BASE" ]; then
  if git rev-parse --verify origin/main >/dev/null 2>&1; then
    BASE=$(git merge-base origin/main "$TIP" 2>/dev/null || echo "origin/main")
  else
    echo "[factory-review-gate] Error: --base is required (e.g. --base origin/main)" >&2
    exit 1
  fi
fi

ARGS=(--base "$BASE" --tip "$TIP")
if [ -n "$BEAD" ]; then
  ARGS+=(--bead "$BEAD")
fi
if [ ${#EXTRA_ARGS[@]} -gt 0 ]; then
  ARGS+=("${EXTRA_ARGS[@]}")
fi

echo "[factory-review-gate] Invoking factory review trigger: base=$BASE, tip=$TIP, bead=${BEAD:-none}"
cd "$ROOT_DIR"
node scripts/factory-review-trigger.mjs "${ARGS[@]}"
rc=$?

if [ $rc -eq 0 ]; then
  echo "[factory-review-gate] Review station gate: PASS (exit 0)"
else
  echo "[factory-review-gate] Review station gate: FAILED (exit $rc)"
fi
exit $rc
