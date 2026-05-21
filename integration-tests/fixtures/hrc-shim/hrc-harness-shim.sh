#!/usr/bin/env bash
# hrc-harness-shim - stands in for claude-code / codex-cli in integration tests.
#
# Reads the HRC launch artifact, posts wrapper-started / child-started / exited
# callbacks to the server, then exits 0. If the server is unreachable the
# callbacks are skipped (the real wrapper would spool them).
#
# Required env:
#   HRC_LAUNCH_FILE   - path to the launch artifact JSON
#   HRC_CALLBACK_SOCK - Unix socket path for the HRC daemon
#
# Optional env:
#   HRC_SHIM_SLEEP    - seconds to sleep between child-started and exited (default 1)
#   HRC_SHIM_EXIT     - exit code to report (default 0)
#   HRC_SHIM_OUTPUT   - text to echo to stdout (visible in tmux capture)
#
# Reference: T-00963, T-00946

set -euo pipefail

LAUNCH_FILE="${HRC_LAUNCH_FILE:-}"
CALLBACK_SOCK="${HRC_CALLBACK_SOCK:-}"
SLEEP_SECS="${HRC_SHIM_SLEEP:-1}"
EXIT_CODE="${HRC_SHIM_EXIT:-0}"
SHIM_OUTPUT="${HRC_SHIM_OUTPUT:-hrc-shim running}"

if [ -z "$LAUNCH_FILE" ]; then
  echo "hrc-harness-shim: HRC_LAUNCH_FILE not set" >&2
  exit 1
fi

if [ ! -f "$LAUNCH_FILE" ]; then
  echo "hrc-harness-shim: launch file not found: $LAUNCH_FILE" >&2
  exit 1
fi

# Parse key fields from the launch artifact
LAUNCH_ID=$(cat "$LAUNCH_FILE" | bun -e 'const j=JSON.parse(await Bun.stdin.text());console.log(j.launchId)')
HOST_SESSION_ID=$(cat "$LAUNCH_FILE" | bun -e 'const j=JSON.parse(await Bun.stdin.text());console.log(j.hostSessionId)')

post_callback() {
  local endpoint="$1"
  local payload="$2"
  if [ -n "$CALLBACK_SOCK" ]; then
    # Use curl with Unix socket to post callback
    curl -s --unix-socket "$CALLBACK_SOCK" \
      -X POST "http://hrc${endpoint}" \
      -H "Content-Type: application/json" \
      -d "$payload" >/dev/null 2>&1 || true
  fi
}

# POST wrapper-started
post_callback "/v1/internal/launches/${LAUNCH_ID}/wrapper-started" \
  "{\"hostSessionId\":\"${HOST_SESSION_ID}\",\"wrapperPid\":$$}"

# Simulate child process (this script IS the child for shim purposes)
post_callback "/v1/internal/launches/${LAUNCH_ID}/child-started" \
  "{\"hostSessionId\":\"${HOST_SESSION_ID}\",\"childPid\":$$}"

# Output something visible to tmux capture
echo "$SHIM_OUTPUT"

# Simulate work
sleep "$SLEEP_SECS"

# POST exited
post_callback "/v1/internal/launches/${LAUNCH_ID}/exited" \
  "{\"hostSessionId\":\"${HOST_SESSION_ID}\",\"exitCode\":${EXIT_CODE}}"

exit "$EXIT_CODE"
