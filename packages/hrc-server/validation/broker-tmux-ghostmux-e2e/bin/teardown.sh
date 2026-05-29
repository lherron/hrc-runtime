#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HARNESS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$HARNESS_DIR/../../../.." && pwd)"
PLIST_SOURCE="$REPO_ROOT/launchd/com.praesidium.hrc-server.plist"
PLIST_INSTALLED="$HOME/Library/LaunchAgents/com.praesidium.hrc-server.plist"
LABEL="com.praesidium.hrc-server"
DRY_RUN=0
SKIP_FLAG_RESTORE=0

usage() {
  cat <<'EOF'
Usage: teardown.sh [--dry-run] [--skip-flag-restore] [run-dir]

Terminates the two validation runtimes, stops live monitor watchers, kills the
ghostmux surfaces, dumps post-run monitor journals, verifies the default tmux
socket against the setup baseline, and restores broker flag values if setup
changed them. If run-dir is omitted, the latest run with env.json is used.
EOF
}

die() {
  echo "teardown.sh: $*" >&2
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "missing required command: $1"
}

latest_run_dir() {
  local env_path
  env_path="$(find "$HARNESS_DIR/runs" -mindepth 2 -maxdepth 2 -name env.json -print \
    | sort \
    | tail -n 1)"
  if [[ -n "$env_path" ]]; then
    dirname "$env_path"
  fi
}

plist_set_env() {
  /usr/libexec/PlistBuddy -c "Set :EnvironmentVariables:$1 $2" "$PLIST_SOURCE"
}

restart_server_for_flags() {
  cp "$PLIST_SOURCE" "$PLIST_INSTALLED"
  launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
  sleep 2
  launchctl bootstrap "gui/$(id -u)" "$PLIST_INSTALLED"
  # bootstrap returns before the daemon is listening; wait for readiness.
  local deadline=$((SECONDS + 60))
  while (( SECONDS < deadline )); do
    if hrc monitor show --json >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  echo "teardown.sh: WARNING hrc-server not confirmed ready within 60s after restart" >&2
  return 0
}

stat_socket() {
  local path="$1"
  if [[ -S "$path" || -e "$path" ]]; then
    stat -f 'path=%N inode=%i mtime=%m size=%z mode=%Sp' "$path"
  else
    printf 'path=%s missing=1\n' "$path"
  fi
}

terminate_runtime() {
  local runtime_id="$1"
  if [[ -n "$runtime_id" && "$runtime_id" != "null" ]]; then
    hrc runtime terminate "$runtime_id" >/dev/null 2>&1 || true
  fi
}

kill_surface() {
  local surface="$1"
  if [[ -n "$surface" && "$surface" != "null" ]]; then
    ghostmux kill-surface -t "$surface" --force >/dev/null 2>&1 || true
  fi
}

dump_events() {
  local runtime_id="$1"
  local from_seq="$2"
  local output="$3"
  if [[ -n "$runtime_id" && "$runtime_id" != "null" ]]; then
    hrc monitor watch "runtime:$runtime_id" --from-seq "$from_seq" --json > "$output" 2>"$output.err" || true
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --skip-flag-restore) SKIP_FLAG_RESTORE=1; shift ;;
    -h|--help) usage; exit 0 ;;
    --*) die "unknown argument: $1" ;;
    *) break ;;
  esac
done

RUN_DIR="${1:-}"
if [[ -z "$RUN_DIR" ]]; then
  RUN_DIR="$(latest_run_dir)"
fi
[[ -n "$RUN_DIR" ]] || die "no run directory found"
ENV_JSON="$RUN_DIR/env.json"
[[ -f "$ENV_JSON" ]] || die "missing env.json: $ENV_JSON"

require_cmd jq
require_cmd hrc
require_cmd ghostmux
require_cmd launchctl

RUN_START_SEQ="$(jq -r '.runStartSeq // 0' "$ENV_JSON")"
RT_CC="$(jq -r '.targets.cc.runtimeId // empty' "$ENV_JSON")"
RT_CX="$(jq -r '.targets.cx.runtimeId // empty' "$ENV_JSON")"
SURFACE_CC="$(jq -r '.targets.cc.ghostmuxSurfaceId // empty' "$ENV_JSON")"
SURFACE_CX="$(jq -r '.targets.cx.ghostmuxSurfaceId // empty' "$ENV_JSON")"
DEFAULT_SOCK="$(jq -r '.defaultSock' "$ENV_JSON")"
BASELINE="$(jq -r '.defaultBaseline' "$ENV_JSON")"
SETUP_CHANGED_FLAGS="$(jq -r '.flags.setupChangedFlags // false' "$ENV_JSON")"
ORIG_CC_FLAG="$(jq -r '.flags.original.HRC_CLAUDE_CODE_TMUX_BROKER_ENABLED // "0"' "$ENV_JSON")"
ORIG_CX_FLAG="$(jq -r '.flags.original.HRC_CODEX_CLI_TMUX_BROKER_ENABLED // "0"' "$ENV_JSON")"

if [[ "$DRY_RUN" -eq 1 ]]; then
  cat <<EOF
DRY RUN teardown
  run_dir: $RUN_DIR
  terminate runtimes: $RT_CC $RT_CX
  kill surfaces: $SURFACE_CC $SURFACE_CX
  dump events from seq: $RUN_START_SEQ
  default baseline: $BASELINE
  restore flags: setupChangedFlags=$SETUP_CHANGED_FLAGS skip=$SKIP_FLAG_RESTORE values=$ORIG_CC_FLAG/$ORIG_CX_FLAG
EOF
  exit 0
fi

mkdir -p "$RUN_DIR/events"

if [[ -f "$RUN_DIR/watcher-pids" ]]; then
  while IFS= read -r pid; do
    [[ -n "$pid" ]] && kill "$pid" >/dev/null 2>&1 || true
  done < "$RUN_DIR/watcher-pids"
fi

terminate_runtime "$RT_CC"
terminate_runtime "$RT_CX"

dump_events "$RT_CC" "$RUN_START_SEQ" "$RUN_DIR/events/cc.jsonl"
dump_events "$RT_CX" "$RUN_START_SEQ" "$RUN_DIR/events/cx.jsonl"

kill_surface "$SURFACE_CC"
kill_surface "$SURFACE_CX"

stat_socket "$DEFAULT_SOCK" > "$RUN_DIR/default-sock.teardown"
{
  printf 'baseline: %s\n' "$BASELINE"
  printf 'teardown: %s\n' "$(cat "$RUN_DIR/default-sock.teardown")"
} > "$RUN_DIR/default-sock.final-compare"

if [[ "$SKIP_FLAG_RESTORE" -ne 1 && "$SETUP_CHANGED_FLAGS" == "true" ]]; then
  plist_set_env HRC_CLAUDE_CODE_TMUX_BROKER_ENABLED "$ORIG_CC_FLAG"
  plist_set_env HRC_CODEX_CLI_TMUX_BROKER_ENABLED "$ORIG_CX_FLAG"
  restart_server_for_flags
fi

printf -- '- %s teardown complete: events dumped from seq %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$RUN_START_SEQ" >> "$RUN_DIR/timeline.md"
echo "teardown complete: $RUN_DIR"
