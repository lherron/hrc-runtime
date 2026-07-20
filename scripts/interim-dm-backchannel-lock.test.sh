#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "$0")" && pwd)"
bridge="${script_dir}/interim-dm-backchannel.sh"
test_dir="$(mktemp -d /tmp/t06673-lock-test.XXXXXX)"
pid_a=""
pid_b=""
pid_c=""

cleanup() {
  local exit_code=$?
  trap - EXIT
  for child in "$pid_a" "$pid_b" "$pid_c"; do
    [[ "$child" =~ ^[0-9]+$ ]] && kill -KILL "$child" 2>/dev/null || true
  done
  case "$test_dir" in
    /tmp/t06673-lock-test.*) rm -rf "$test_dir" ;;
  esac
  exit "$exit_code"
}
trap cleanup EXIT

printf '# no routes in lock test\n' > "${test_dir}/routes.tsv"
BACKCHANNEL_NODE=max3 BACKCHANNEL_DIR="$test_dir" "$bridge" init >/dev/null

start_poller() {
  BACKCHANNEL_NODE=max3 BACKCHANNEL_DIR="$test_dir" BACKCHANNEL_POLL_SECONDS=0.1 \
    "$bridge" poll >"${test_dir}/poller-$1.log" 2>&1 &
  STARTED_PID=$!
}

wait_for_lock() {
  local expected="$1"
  for _ in {1..10}; do
    [[ -f "${test_dir}/poller.lock/pid" ]] &&
      [[ "$(cat "${test_dir}/poller.lock/pid")" == "$expected" ]] && return 0
    sleep 0.1
  done
  return 1
}

start_poller a
pid_a="$STARTED_PID"
wait_for_lock "$pid_a"

start_poller b
pid_b="$STARTED_PID"
if wait "$pid_b"; then
  printf 'second poller unexpectedly started while pid %s held the lock\n' "$pid_a" >&2
  exit 1
fi
pid_b=""

kill -TERM "$pid_a"
for _ in {1..30}; do
  kill -0 "$pid_a" 2>/dev/null || break
  sleep 0.1
done
if kill -0 "$pid_a" 2>/dev/null; then
  printf 'poller pid %s survived TERM\n' "$pid_a" >&2
  exit 1
fi
wait "$pid_a" 2>/dev/null || true
pid_a=""

start_poller c
pid_c="$STARTED_PID"
wait_for_lock "$pid_c"
kill -TERM "$pid_c"
wait "$pid_c"
pid_c=""

printf 'PASS: live holder excludes rerun; TERM exits; one replacement acquires\n'
