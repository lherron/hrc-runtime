#!/usr/bin/env bash
# Called only by _deploy-node after _node-readback proves the running sourceCommit.
# Install does not activate an owner, so it must not retire this job itself.
set -euo pipefail
label=com.praesidium.hrc-prune-deltas
domain="gui/$(id -u)"
plist="$HOME/Library/LaunchAgents/${label}.plist"
if launchctl print "$domain/$label" >/dev/null 2>&1; then
  launchctl bootout "$domain/$label"
  if launchctl print "$domain/$label" >/dev/null 2>&1; then
    echo "retention: old job remains loaded; refusing to remove its plist" >&2
    exit 1
  fi
fi
# No plist is an ordinary repeat deploy. A bootout failure never reaches unlink.
if [[ -e "$plist" ]]; then
  python3 - "$plist" <<'PY'
import pathlib, sys
pathlib.Path(sys.argv[1]).unlink()
PY
fi
echo '[retention] retired nightly Bun prune job; maintenance belongs to the daemon'
