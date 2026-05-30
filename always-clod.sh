#!/usr/bin/env bash
# always-clod.sh — keep a clod session alive.
#
# Runs `hrc run clod` in a loop so the session respawns every time you /quit.
# Safety throttle: if the loop restarts more than MAX_RESTARTS times within
# WINDOW_SECONDS, it gives up and exits (prevents a tight crash-loop).

set -uo pipefail

MAX_RESTARTS=3
WINDOW_SECONDS=60

# Sliding window of recent restart timestamps (epoch seconds).
restarts=()

while true; do
  now=$(date +%s)

  # Drop timestamps older than the window.
  pruned=()
  for t in "${restarts[@]:-}"; do
    [[ -n "$t" ]] || continue
    if (( now - t < WINDOW_SECONDS )); then
      pruned+=("$t")
    fi
  done
  restarts=("${pruned[@]:-}")

  if (( ${#restarts[@]} >= MAX_RESTARTS )); then
    echo "always-clod: ${#restarts[@]} restarts within ${WINDOW_SECONDS}s (limit ${MAX_RESTARTS}); bailing out." >&2
    exit 1
  fi

  restarts+=("$now")

  echo "always-clod: starting clod session ($(date '+%H:%M:%S'))..." >&2
  hrc run clod
  echo "always-clod: clod session exited; respawning." >&2
done
