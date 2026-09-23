#!/bin/bash
# The voicebox fence: bubblewrap, no root, no daemon. Source tree read-only,
# one writable home bound in from the host, everything else fresh. Network is
# SHARED — deliberately: this fence bounds filesystem and processes, NOT the
# network, and the boundary report says so.
#
# Usage: fence.sh <home> <port> [command...]
#   <home>   the sandbox's writable home (host path), created if absent
#   <port>   the loopback port the fenced server binds
#   command  what to run inside (default: the probe)
set -euo pipefail
SANDBOX_HOME="$1"
PORT="$2"
shift 2
mkdir -p "$SANDBOX_HOME/workspace"
# The tree the fence binds is THIS SCRIPT's repo, not the caller's cwd: a server that boots a fence
# may run from anywhere, and the probe and the source it mounts live beside this script.
SELF="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec /usr/bin/bwrap \
  --ro-bind /usr /usr \
  --symlink usr/lib /lib64 \
  --symlink usr/lib /lib \
  --ro-bind /etc /etc \
  --proc /proc \
  --dev /dev \
  --tmpfs /tmp \
  --tmpfs /run \
  --ro-bind-try /run/systemd/resolve/stub-resolv.conf /run/systemd/resolve/stub-resolv.conf \
  --tmpfs /var \
  --tmpfs /home \
  --bind "$SANDBOX_HOME" /home/voice \
  --ro-bind "$SELF" /srv/voicebox \
  --bind "$SANDBOX_HOME/workspace" /home/voice/workspace \
  --tmpfs /probes \
  --ro-bind "$SELF/tools/sandbox-probe.mjs" /probes/sandbox-probe.mjs \
  --clearenv \
  --setenv PATH /usr/bin \
  --setenv PORT "$PORT" \
  --setenv HOME /home/voice \
  --setenv VOICEBOX_BOOT_MARKER "${VOICEBOX_BOOT_MARKER:-}" \
  --setenv SANDBOX_PROBE_PATHS /srv/voicebox:/home/voice/workspace \
  --chdir /home/voice \
  --unshare-pid --unshare-uts --die-with-parent --new-session \
  -- "$@"
