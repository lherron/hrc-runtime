#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HARNESS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$HARNESS_DIR/../../../.." && pwd)"

PLIST_SOURCE="$REPO_ROOT/launchd/com.praesidium.hrc-server.plist"
PLIST_INSTALLED="$HOME/Library/LaunchAgents/com.praesidium.hrc-server.plist"
LABEL="com.praesidium.hrc-server"
PROJECT_ID="hrc-runtime"
CC_AGENT="clod"
CX_AGENT="cody"
TIER=""
WATCH=0
ALLOW_RESTART=0
ALLOW_BUSY=0
DRY_RUN=0
RUN_ID=""
PROMPT="Reply ACK for broker-tmux ghostmux validation setup."
TIMEOUT_SECONDS=180
CLEANUP_ARMED=0
FLAGS_CHANGED_BY_SETUP=0

usage() {
  cat <<'EOF'
Usage: setup.sh --core|--full [options]

Creates a timestamped broker-tmux ghostmux validation run directory, enables the
broker-tmux flags if needed, opens two ghostmux surfaces, starts fresh hrc run
scopes, waits for broker lease runtimes, and records env/baseline/cursor data.

Options:
  --core                 Prepare the CORE matrix.
  --full                 Prepare the FULL matrix.
  --watch                Start live monitor watch streams after runtimes resolve.
  --allow-restart        Permit bootout/bootstrap if broker flags are not already on.
  --allow-busy           Proceed with the restart even if runtimes are busy/starting
                         (override the safety guard only after confirming they are
                         stale/expendable; live runtimes are re-associated on restart).
  --dry-run              Print planned actions without mutating daemon, ghostmux, or files.
  --run-id <id>          Override UTC timestamp run id.
  --project <id>         Project id for validation targets (default: hrc-runtime).
  --cc-agent <agent>     claude-code-tmux agent identity (default: clod).
  --cx-agent <agent>     codex-cli-tmux agent identity (default: cody).
  --timeout <seconds>    Runtime discovery timeout (default: 180).
  -h, --help             Show this help.
EOF
}

die() {
  echo "setup.sh: $*" >&2
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "missing required command: $1"
}

plist_get_env() {
  /usr/libexec/PlistBuddy -c "Print :EnvironmentVariables:$1" "$PLIST_SOURCE" 2>/dev/null || true
}

plist_set_env() {
  /usr/libexec/PlistBuddy -c "Set :EnvironmentVariables:$1 $2" "$PLIST_SOURCE"
}

runtime_root() {
  local value
  value="$(plist_get_env HRC_RUNTIME_DIR)"
  if [[ -n "$value" ]]; then
    printf '%s\n' "$value"
  else
    printf '%s\n' "$HOME/praesidium/var/run/hrc"
  fi
}

daemon_log() {
  local key="$1"
  /usr/libexec/PlistBuddy -c "Print :$key" "$PLIST_SOURCE" 2>/dev/null || true
}

stat_socket() {
  local path="$1"
  if [[ -S "$path" || -e "$path" ]]; then
    stat -f 'path=%N inode=%i mtime=%m size=%z mode=%Sp' "$path"
  else
    printf 'path=%s missing=1\n' "$path"
  fi
}

json_escape() {
  jq -Rn --arg v "$1" '$v'
}

busy_runtime_count() {
  hrc runtime list --json \
    | jq '[.[] | select(.status == "busy" or .status == "starting")] | length'
}

restart_server_for_flags() {
  cp "$PLIST_SOURCE" "$PLIST_INSTALLED"
  launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
  sleep 2
  launchctl bootstrap "gui/$(id -u)" "$PLIST_INSTALLED"
  # bootstrap returns before the daemon is listening on its socket; wait for it
  # so the next hrc call doesn't race a not-yet-ready server. Trap-safe (no die).
  local deadline=$((SECONDS + 60))
  while (( SECONDS < deadline )); do
    if hrc monitor show --json >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  echo "setup.sh: WARNING hrc-server not confirmed ready within 60s after restart" >&2
  return 0
}

new_surface() {
  local title="$1"
  ghostmux new --title "$title" --cwd "$REPO_ROOT" --json \
    | jq -r '.id // .surfaceId // .surface_id // empty'
}

send_surface_command() {
  local surface="$1"
  local command="$2"
  # ScriptableGhostty can transiently fail to realize a freshly-created surface
  # (no surfaceModel yet -> send-keys prints "error: Terminal model unavailable"
  # but still exits 0). Retry until the surface accepts input, then fail loudly so
  # a wedged surface never silently becomes a 180s wait_for_runtime timeout.
  local attempts=0 out
  while (( attempts < 8 )); do
    out="$(ghostmux send-keys -t "$surface" "$command" 2>&1)"
    if [[ "$out" != *error* && "$out" != *unavailable* ]]; then
      return 0
    fi
    attempts=$((attempts + 1))
    sleep 2
  done
  die "ghostmux send-keys failed for surface $surface after $attempts attempts: ${out:-<empty>} (ScriptableGhostty surface did not realize; focus/restart Ghostty and retry)"
}

scope_ref() {
  local target="$1"
  local agent="${target%@*}"
  local rest="${target#*@}"
  local project="${rest%%:*}"
  local task="${rest#*:}"
  printf 'agent:%s:project:%s:task:%s\n' "$agent" "$project" "$task"
}

find_runtime() {
  local scope="$1"
  local driver="$2"
  hrc runtime list --transport tmux --json \
    | jq -r --arg scope "$scope" --arg driver "$driver" '
        [.[] | select(.scopeRef == $scope)
             | select(.transport == "tmux")
             | select((.tmuxJson.brokerDriver // .runtimeStateJson.tmux.brokerDriver // "") == $driver)
             | select(.status != "terminated" and .status != "dead")]
        | sort_by(.createdAt)
        | last // empty
        | @base64
      '
}

runtime_field() {
  local encoded="$1"
  local expr="$2"
  printf '%s' "$encoded" | base64 --decode | jq -r "$expr"
}

wait_for_runtime() {
  local label="$1"
  local scope="$2"
  local driver="$3"
  local deadline=$((SECONDS + TIMEOUT_SECONDS))
  local encoded=""
  while (( SECONDS < deadline )); do
    encoded="$(find_runtime "$scope" "$driver")"
    if [[ -n "$encoded" ]]; then
      printf '%s\n' "$encoded"
      return 0
    fi
    sleep 2
  done
  die "timed out waiting for $label runtime ($scope, $driver)"
}

cleanup_on_error() {
  local status=$?
  if [[ $status -eq 0 || "$DRY_RUN" -eq 1 ]]; then
    return
  fi
  if [[ "$CLEANUP_ARMED" -eq 1 ]]; then
    echo "setup.sh: setup failed; cleaning up created runtimes, ghostmux surfaces, and watchers" >&2
    if [[ -n "${WATCH_PID_CC:-}" ]]; then kill "$WATCH_PID_CC" >/dev/null 2>&1 || true; fi
    if [[ -n "${WATCH_PID_CX:-}" ]]; then kill "$WATCH_PID_CX" >/dev/null 2>&1 || true; fi
    if [[ -n "${RT_CC:-}" ]]; then hrc runtime terminate "$RT_CC" >/dev/null 2>&1 || true; fi
    if [[ -n "${RT_CX:-}" ]]; then hrc runtime terminate "$RT_CX" >/dev/null 2>&1 || true; fi
    if [[ -n "${SURFACE_CC:-}" ]]; then ghostmux kill-surface -t "$SURFACE_CC" --force >/dev/null 2>&1 || true; fi
    if [[ -n "${SURFACE_CX:-}" ]]; then ghostmux kill-surface -t "$SURFACE_CX" --force >/dev/null 2>&1 || true; fi
  fi
  if [[ "$FLAGS_CHANGED_BY_SETUP" -eq 1 ]]; then
    echo "setup.sh: restoring original broker flag values after failed setup" >&2
    plist_set_env HRC_CLAUDE_CODE_TMUX_BROKER_ENABLED "$ORIG_CC_FLAG" || true
    plist_set_env HRC_CODEX_CLI_TMUX_BROKER_ENABLED "$ORIG_CX_FLAG" || true
    restart_server_for_flags || true
  fi
  exit "$status"
}
trap cleanup_on_error EXIT

while [[ $# -gt 0 ]]; do
  case "$1" in
    --core) TIER="core"; shift ;;
    --full) TIER="full"; shift ;;
    --watch) WATCH=1; shift ;;
    --allow-restart) ALLOW_RESTART=1; shift ;;
    --allow-busy) ALLOW_BUSY=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --run-id) RUN_ID="${2:-}"; shift 2 ;;
    --project) PROJECT_ID="${2:-}"; shift 2 ;;
    --cc-agent) CC_AGENT="${2:-}"; shift 2 ;;
    --cx-agent) CX_AGENT="${2:-}"; shift 2 ;;
    --timeout) TIMEOUT_SECONDS="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

[[ -n "$TIER" ]] || die "choose --core or --full"
[[ "$TIMEOUT_SECONDS" =~ ^[0-9]+$ ]] || die "--timeout must be seconds"

require_cmd hrc
require_cmd jq
require_cmd ghostmux
require_cmd tmux
require_cmd launchctl
[[ -f "$PLIST_SOURCE" ]] || die "missing plist source: $PLIST_SOURCE"

RUN_ID="${RUN_ID:-$(date -u +%Y%m%dT%H%M%SZ)}"
RUN_DIR="$HARNESS_DIR/runs/$RUN_ID"
RUNTIME_ROOT="$(runtime_root)"
DEFAULT_SOCK="$RUNTIME_ROOT/tmux.sock"
BTMUX_DIR="$RUNTIME_ROOT/btmux"
LOG_OUT="$(daemon_log StandardOutPath)"
LOG_ERR="$(daemon_log StandardErrorPath)"
CC_TASK="gm-cc-$RUN_ID"
CX_TASK="gm-cx-$RUN_ID"
CC_TARGET="$CC_AGENT@$PROJECT_ID:$CC_TASK"
CX_TARGET="$CX_AGENT@$PROJECT_ID:$CX_TASK"
CC_SCOPE="$(scope_ref "$CC_TARGET")"
CX_SCOPE="$(scope_ref "$CX_TARGET")"

ORIG_CC_FLAG="$(plist_get_env HRC_CLAUDE_CODE_TMUX_BROKER_ENABLED)"
ORIG_CX_FLAG="$(plist_get_env HRC_CODEX_CLI_TMUX_BROKER_ENABLED)"
FLAGS_ALREADY_ON=0
if [[ "$ORIG_CC_FLAG" == "1" && "$ORIG_CX_FLAG" == "1" ]]; then
  FLAGS_ALREADY_ON=1
fi

if [[ "$DRY_RUN" -eq 1 ]]; then
  cat <<EOF
DRY RUN setup
  tier: $TIER
  run_dir: $RUN_DIR
  flags_already_on: $FLAGS_ALREADY_ON
  allow_restart: $ALLOW_RESTART
  claude target: $CC_TARGET
  codex target: $CX_TARGET
  default socket: $DEFAULT_SOCK
  daemon logs: ${LOG_OUT:-<none>} ${LOG_ERR:-<none>}
  would create ghostmux surfaces and run:
    hrc run $CC_TARGET -p $(printf '%q' "$PROMPT")
    hrc run $CX_TARGET -p $(printf '%q' "$PROMPT")
EOF
  exit 0
fi

[[ ! -e "$RUN_DIR" ]] || die "run directory already exists: $RUN_DIR"

if [[ "$FLAGS_ALREADY_ON" -ne 1 ]]; then
  [[ "$ALLOW_RESTART" -eq 1 ]] || die "broker flags are off; rerun with --allow-restart when it is safe to restart hrc-server"
  busy_count="$(busy_runtime_count)"
  if [[ "$busy_count" != "0" ]]; then
    if [[ "$ALLOW_BUSY" -eq 1 ]]; then
      echo "setup.sh: WARNING proceeding with $busy_count busy/starting runtime(s) (--allow-busy); live runtimes are re-associated on restart" >&2
    else
      die "refusing daemon restart: $busy_count runtime(s) are busy or starting (use --allow-busy to override after confirming they are stale/expendable)"
    fi
  fi
  plist_set_env HRC_CLAUDE_CODE_TMUX_BROKER_ENABLED 1
  plist_set_env HRC_CODEX_CLI_TMUX_BROKER_ENABLED 1
  FLAGS_CHANGED_BY_SETUP=1
  restart_server_for_flags
fi

mkdir -p "$RUN_DIR/events" "$RUN_DIR/evidence"
stat_socket "$DEFAULT_SOCK" > "$RUN_DIR/default-sock.baseline"
RUN_START_SEQ="$(hrc monitor show --json | jq -r '.eventLog.highWaterSeq // 0')"

CLEANUP_ARMED=1
SURFACE_CC="$(new_surface "btmux-cc-$RUN_ID")"
[[ -n "$SURFACE_CC" ]] || die "ghostmux did not return claude surface id"
SURFACE_CX="$(new_surface "btmux-cx-$RUN_ID")"
[[ -n "$SURFACE_CX" ]] || die "ghostmux did not return codex surface id"

send_surface_command "$SURFACE_CC" "hrc run $CC_TARGET -p $(printf '%q' "$PROMPT")"
send_surface_command "$SURFACE_CX" "hrc run $CX_TARGET -p $(printf '%q' "$PROMPT")"

RT_CC_B64="$(wait_for_runtime claude "$CC_SCOPE" claude-code-tmux)"
RT_CC="$(runtime_field "$RT_CC_B64" '.runtimeId')"
RT_CX_B64="$(wait_for_runtime codex "$CX_SCOPE" codex-cli-tmux)"
RT_CX="$(runtime_field "$RT_CX_B64" '.runtimeId')"
LEASE_CC="$(runtime_field "$RT_CC_B64" '.tmuxJson.socketPath // .runtimeStateJson.tmux.socketPath // empty')"
LEASE_CX="$(runtime_field "$RT_CX_B64" '.tmuxJson.socketPath // .runtimeStateJson.tmux.socketPath // empty')"
PANE_CC="$(runtime_field "$RT_CC_B64" '.tmuxJson.paneId // .runtimeStateJson.tmux.paneId // "%0"')"
PANE_CX="$(runtime_field "$RT_CX_B64" '.tmuxJson.paneId // .runtimeStateJson.tmux.paneId // "%0"')"

if [[ "$WATCH" -eq 1 ]]; then
  hrc monitor watch "runtime:$RT_CC" --from-seq "$RUN_START_SEQ" --follow --json > "$RUN_DIR/events/live-cc.jsonl" 2>"$RUN_DIR/events/live-cc.err" &
  WATCH_PID_CC=$!
  hrc monitor watch "runtime:$RT_CX" --from-seq "$RUN_START_SEQ" --follow --json > "$RUN_DIR/events/live-cx.jsonl" 2>"$RUN_DIR/events/live-cx.err" &
  WATCH_PID_CX=$!
  printf '%s\n%s\n' "$WATCH_PID_CC" "$WATCH_PID_CX" > "$RUN_DIR/watcher-pids"
fi

jq -n \
  --arg schema "broker-tmux-ghostmux-e2e/run-env/v1" \
  --arg runId "$RUN_ID" \
  --arg tier "$TIER" \
  --arg createdAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg repoRoot "$REPO_ROOT" \
  --arg runtimeRoot "$RUNTIME_ROOT" \
  --arg btmuxDir "$BTMUX_DIR" \
  --arg defaultSock "$DEFAULT_SOCK" \
  --arg defaultBaseline "$(cat "$RUN_DIR/default-sock.baseline")" \
  --arg runStartSeq "$RUN_START_SEQ" \
  --arg logOut "$LOG_OUT" \
  --arg logErr "$LOG_ERR" \
  --arg origCcFlag "$ORIG_CC_FLAG" \
  --arg origCxFlag "$ORIG_CX_FLAG" \
  --arg flagsAlreadyOn "$FLAGS_ALREADY_ON" \
  --arg ccTarget "$CC_TARGET" \
  --arg cxTarget "$CX_TARGET" \
  --arg ccScope "$CC_SCOPE" \
  --arg cxScope "$CX_SCOPE" \
  --arg surfaceCc "$SURFACE_CC" \
  --arg surfaceCx "$SURFACE_CX" \
  --arg rtCc "$RT_CC" \
  --arg rtCx "$RT_CX" \
  --arg leaseCc "$LEASE_CC" \
  --arg leaseCx "$LEASE_CX" \
  --arg paneCc "$PANE_CC" \
  --arg paneCx "$PANE_CX" \
  --arg ccAgent "$CC_AGENT" \
  --arg cxAgent "$CX_AGENT" \
  --argjson watch "$WATCH" \
  '{
    schema: $schema,
    runId: $runId,
    tier: $tier,
    createdAt: $createdAt,
    repoRoot: $repoRoot,
    runtimeRoot: $runtimeRoot,
    btmuxDir: $btmuxDir,
    defaultSock: $defaultSock,
    defaultBaseline: $defaultBaseline,
    runStartSeq: ($runStartSeq | tonumber),
    daemonLogs: {stdout: $logOut, stderr: $logErr},
    flags: {
      original: {
        HRC_CLAUDE_CODE_TMUX_BROKER_ENABLED: $origCcFlag,
        HRC_CODEX_CLI_TMUX_BROKER_ENABLED: $origCxFlag
      },
      setupChangedFlags: ($flagsAlreadyOn != "1")
    },
    targets: {
      cc: {agent: $ccAgent, target: $ccTarget, scopeRef: $ccScope, driver: "claude-code-tmux", runtimeId: $rtCc, leaseSocket: $leaseCc, paneId: $paneCc, ghostmuxSurfaceId: $surfaceCc},
      cx: {agent: $cxAgent, target: $cxTarget, scopeRef: $cxScope, driver: "codex-cli-tmux", runtimeId: $rtCx, leaseSocket: $leaseCx, paneId: $paneCx, ghostmuxSurfaceId: $surfaceCx}
    },
    liveWatchStarted: ($watch == 1)
  }' > "$RUN_DIR/env.json"

cp "$HARNESS_DIR/templates/findings.md" "$RUN_DIR/findings.md"
{
  printf '# timeline\n\n'
  printf -- '- %s setup complete: cc=%s cx=%s startSeq=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$RT_CC" "$RT_CX" "$RUN_START_SEQ"
} > "$RUN_DIR/timeline.md"

echo "setup complete: $RUN_DIR"
