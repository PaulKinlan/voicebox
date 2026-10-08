#!/usr/bin/env bash
# scripts/factory-install-systemd.sh — installs systemd user units on project VM (voicebox-beads-xacp)
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

DEST_DIR="$HOME/.config/systemd/user"
mkdir -p "$DEST_DIR"

echo "[install-systemd] Copying user service and timer definitions to $DEST_DIR..."
cp "$ROOT_DIR/config/systemd/user/"*.service "$DEST_DIR/"
cp "$ROOT_DIR/config/systemd/user/"*.timer "$DEST_DIR/"

export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"

if command -v systemctl >/dev/null 2>&1; then
  echo "[install-systemd] Reloading systemd user daemon..."
  systemctl --user daemon-reload

  # Enable units if canonical checkout exists
  if [ -d "$HOME/voicebox/scripts" ]; then
    echo "[install-systemd] Canonical checkout present; enabling timers..."
    systemctl --user enable voicebox-factory-issue-poller.timer voicebox-factory-review-watcher.timer
    echo "[install-systemd] Active user timers:"
    systemctl --user list-timers --all | grep -E "voicebox|UNIT" || true
  else
    echo "[install-systemd] Note: Canonical checkout $HOME/voicebox not yet populated; leaving timers disabled until landed on main."
  fi
fi

echo "[install-systemd] Systemd user units installed successfully."
