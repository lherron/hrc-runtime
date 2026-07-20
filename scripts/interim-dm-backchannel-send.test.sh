#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "$0")" && pwd)"
bridge="${script_dir}/interim-dm-backchannel.sh"
test_dir="$(mktemp -d /tmp/t06680-send-test.XXXXXX)"

cleanup() {
  local exit_code=$?
  trap - EXIT
  case "$test_dir" in
    /tmp/t06680-send-test.*) rm -rf "$test_dir" ;;
  esac
  exit "$exit_code"
}
trap cleanup EXIT

mkdir -p "${test_dir}/bin"
printf '%s\n' '#!/bin/sh' 'printf "%s\\n" "$*" >> "$BACKCHANNEL_TEST_SSH_LOG"' 'cat >> "$BACKCHANNEL_TEST_BODY_LOG"' 'printf "%s\\n" "{\"request\":{\"messageId\":\"msg-remote\"}}"' > "${test_dir}/bin/ssh"
chmod +x "${test_dir}/bin/ssh"
printf '%s\n' '#!/bin/sh' 'printf "%s\\n" "$*" >> "$BACKCHANNEL_TEST_HRCCHAT_LOG"' 'exit 99' > "${test_dir}/bin/hrcchat"
chmod +x "${test_dir}/bin/hrcchat"

run_direction() {
  local origin="$1"
  local destination="$2"
  local target="$3"
  local expected_remote="$4"
  local routes="${test_dir}/routes-${origin}.tsv"
  local ssh_log="${test_dir}/ssh-${origin}.log"
  local body_log="${test_dir}/body-${origin}.log"
  printf '%s\t%s\n' "$target" "$destination" > "$routes"

  BACKCHANNEL_SSH="${test_dir}/bin/ssh" \
    BACKCHANNEL_NODE="$origin" \
    BACKCHANNEL_DIR="$test_dir" \
    BACKCHANNEL_ROUTES="$routes" \
    BACKCHANNEL_REMOTE_SCRIPT='/remote/interim-dm-backchannel.sh' \
    BACKCHANNEL_TEST_SSH_LOG="$ssh_log" \
    BACKCHANNEL_TEST_BODY_LOG="$body_log" \
    BACKCHANNEL_TEST_HRCCHAT_LOG="${test_dir}/hrcchat.log" \
    HRCCHAT="${test_dir}/bin/hrcchat" \
    "$bridge" send "$target" session "agent:cody:project:hrc-runtime:task:T-06680/lane:main" \
      <<<"${origin}-to-${destination}"

  [[ "$(wc -l < "$ssh_log" | tr -d '[:space:]')" == 1 ]]
  [[ "$(cat "$body_log")" == "${origin}-to-${destination}" ]]
  grep -q "/remote/interim-dm-backchannel.sh inject ${origin}" "$ssh_log"
  grep -q -- "-o BatchMode=yes ${expected_remote} /remote/interim-dm-backchannel.sh" "$ssh_log"
}

run_direction svc max3 'agent:mable:project:hrc-runtime:task:max3/lane:main' 'lherron@max3'
run_direction max3 svc 'agent:mable:project:hrc-runtime:task:minisvc/lane:main' 'lherron@mini'
[[ ! -e "${test_dir}/hrcchat.log" ]]

printf 'PASS: routed send bypasses the origin hrcchat/store in both directions\n'
