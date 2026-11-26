#!/usr/bin/env bash
# A deploy that carries a store migration uses a different order: hrcdev, then
# svc, then max3, with schema comparison after each node.
set -euo pipefail

if (( $# < 1 || $# > 2 )) || [[ ! "$1" =~ ^[0-9a-f]{40}$ ]]; then
  echo "usage: just deploy-chain <full HRC SHA> [<satellite aspd SHA>|current]" >&2
  exit 2
fi
sha="$1"
satellite_aspd="${2:-current}"
short="${sha:0:8}"
cd "$(dirname "${BASH_SOURCE[0]}")/.."
export PATH="$HOME/.local/bin:$HOME/.bun/bin:$HOME/.cargo/bin:/opt/homebrew/bin:$PATH"

scratch_base="${SCRATCH:-$HOME/praesidium/var/scratch/hrc-runtime/primary}"
lock="$HOME/praesidium/var/run/hrc-runtime-deploy.lock"
mkdir -p "$scratch_base" "$(dirname "$lock")"
logs="$(mktemp -d "$scratch_base/deploy-chain-$short.XXXXXX")"
log="$logs/deploy-chain-$short.log"
echo "deploy-chain logs: $logs"

say() { printf '%s\n' "$*" >> "$log"; }

stop() {
  say "CHAIN_EXIT=$1"
  exit 1
}

aspd_for() {
  if [[ "$satellite_aspd" != current ]]; then
    printf '%s\n' "$satellite_aspd"
    return
  fi
  # Resolve each satellite just before deploying: ASP can move between nodes.
  local short_aspd aspd_repo="$HOME/praesidium/agent-spaces"
  short_aspd="$(just fleet-status 2>/dev/null | awk -v node="$1" '$1 == node && NF >= 8 {print $4; exit}')"
  [[ -n "$short_aspd" ]] || return 1
  git -C "$aspd_repo" fetch -q origin 2>/dev/null
  git -C "$aspd_repo" rev-parse --verify "${short_aspd}^{commit}"
}

locked_deploy() (
  local node="$1" aspd="$2"
  until mkdir "$lock" 2>/dev/null; do sleep 30; done
  trap 'rm -f "$lock/owner"; rmdir "$lock"' EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  printf 'mable@hrc-runtime:primary %s deploy-%s\n' "$(date -u +%FT%TZ)" "$node" > "$lock/owner" || return 1
  just "deploy-$node" "$sha" "$aspd" force
)

verify=''
for ((attempt=0; attempt<240; attempt++)); do
  verify="$(gh run list --workflow post-push-verify.yml --commit "$sha" --limit 1 \
    --json status,conclusion --jq '.[] | .status + ":" + .conclusion' 2>/dev/null)" || verify=''
  case "$verify" in
    completed:success) say "VERIFY green $(date -u +%TZ)"; break ;;
    completed:*) say "VERIFY $verify"; stop verify-red ;;
  esac
  sleep 30
done
[[ "$verify" == completed:success ]] || stop verify-timeout

svc_aspd="$(aspd_for svc)" || stop svc-aspd-unresolved
rc=0
just deploy-svc "$sha" "$svc_aspd" force > "$logs/deploy-svc-$short.log" 2>&1 || rc=$?
say "SVC_EXIT=$rc"
(( rc == 0 )) || stop svc-failed

locked_deploy max3 @max3 > "$logs/deploy-max3-$short.log" 2>&1 || rc=$?
say "MAX3_EXIT=$rc"
(( rc == 0 )) || stop max3-failed

# No load wait before hrcdev: the post-reboot ramp rule was retired (T-12832).
load="$(sysctl -n vm.loadavg | awk '{print $2}')"
hrcdev_aspd="$(aspd_for hrcdev)" || stop hrcdev-aspd-unresolved
locked_deploy hrcdev "$hrcdev_aspd" > "$logs/deploy-hrcdev-$short.log" 2>&1 || rc=$?
say "HRCDEV_EXIT=$rc (load $load)"
(( rc == 0 )) || stop hrcdev-failed
say "CHAIN_EXIT=done"
