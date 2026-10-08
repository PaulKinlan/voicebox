#!/usr/bin/env bash
# scripts/factory-review-watcher.sh — bounded runner for review watcher (voicebox-beads-xacp)
set -uo pipefail

[ -f "$HOME/.fleet/env" ] && source "$HOME/.fleet/env"
[ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

REPORTS_DIR="${VOICEBOX_FACTORY_PRIVATE_DIR:-$HOME/.voicebox/factory-reports}"
LOG_FILE="$REPORTS_DIR/review-watcher.log"
LOCK_FILE="$REPORTS_DIR/review-watcher.lock"

mkdir -p "$REPORTS_DIR"

exec 202>"$LOCK_FILE"
if ! flock -n 202; then
  echo "[$(date -u +%FT%TZ)] [review-watcher] Another review watcher instance is already running. Exiting." >> "$LOG_FILE"
  exit 0
fi

echo "[$(date -u +%FT%TZ)] [review-watcher] Starting review watcher in $ROOT_DIR" >> "$LOG_FILE"

cd "$ROOT_DIR"
node "$SCRIPT_DIR/factory-review-watcher.mjs" "$@" 2>&1 | tee -a "$LOG_FILE"
rc=${PIPESTATUS[0]}

echo "[$(date -u +%FT%TZ)] [review-watcher] Review watcher finished with exit code $rc" >> "$LOG_FILE"
exit $rc
