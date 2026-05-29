#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HARNESS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DRY_RUN=0
LOG_TAIL_LINES="${LOG_TAIL_LINES:-800}"

usage() {
  cat <<'EOF'
Usage: snap.sh [--dry-run] <row-id> [run-dir]

Captures per-row evidence into runs/<id>/evidence/<row-id>/ and appends a
timestamp marker to timeline.md. If run-dir is omitted, the latest run with
env.json is used.
EOF
}

die() {
  echo "snap.sh: $*" >&2
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

stat_socket() {
  local path="$1"
  if [[ -S "$path" || -e "$path" ]]; then
    stat -f 'path=%N inode=%i mtime=%m size=%z mode=%Sp' "$path"
  else
    printf 'path=%s missing=1\n' "$path"
  fi
}

capture_lease() {
  local socket="$1"
  local pane="$2"
  local output="$3"
  if [[ -S "$socket" || -e "$socket" ]]; then
    tmux -S "$socket" capture-pane -t "$pane" -p -S - > "$output" 2>"$output.err" || true
  else
    printf 'missing lease socket: %s\n' "$socket" > "$output.err"
    : > "$output"
  fi
}

capture_ghostmux() {
  local surface="$1"
  local output="$2"
  if [[ -n "$surface" ]]; then
    ghostmux capture-pane -t "$surface" -S - -E - > "$output" 2>"$output.err" || true
  else
    printf 'missing ghostmux surface id\n' > "$output.err"
    : > "$output"
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    --*) die "unknown argument: $1" ;;
    *) break ;;
  esac
done

ROW_ID="${1:-}"
RUN_DIR="${2:-}"
[[ -n "$ROW_ID" ]] || die "row id is required"
if [[ -z "$RUN_DIR" ]]; then
  RUN_DIR="$(latest_run_dir)"
fi
[[ -n "$RUN_DIR" ]] || die "no run directory found"
ENV_JSON="$RUN_DIR/env.json"
[[ -f "$ENV_JSON" ]] || die "missing env.json: $ENV_JSON"

require_cmd jq
require_cmd hrc
require_cmd tmux
require_cmd ghostmux

EVIDENCE_DIR="$RUN_DIR/evidence/$ROW_ID"
DEFAULT_SOCK="$(jq -r '.defaultSock' "$ENV_JSON")"
BASELINE="$(jq -r '.defaultBaseline' "$ENV_JSON")"
LOG_OUT="$(jq -r '.daemonLogs.stdout // empty' "$ENV_JSON")"
LOG_ERR="$(jq -r '.daemonLogs.stderr // empty' "$ENV_JSON")"
LEASE_CC="$(jq -r '.targets.cc.leaseSocket' "$ENV_JSON")"
LEASE_CX="$(jq -r '.targets.cx.leaseSocket' "$ENV_JSON")"
PANE_CC="$(jq -r '.targets.cc.paneId // "%0"' "$ENV_JSON")"
PANE_CX="$(jq -r '.targets.cx.paneId // "%0"' "$ENV_JSON")"
SURFACE_CC="$(jq -r '.targets.cc.ghostmuxSurfaceId // empty' "$ENV_JSON")"
SURFACE_CX="$(jq -r '.targets.cx.ghostmuxSurfaceId // empty' "$ENV_JSON")"

if [[ "$DRY_RUN" -eq 1 ]]; then
  cat <<EOF
DRY RUN snap
  row: $ROW_ID
  run_dir: $RUN_DIR
  evidence_dir: $EVIDENCE_DIR
  would capture lease panes:
    cc: $LEASE_CC $PANE_CC
    cx: $LEASE_CX $PANE_CX
  would capture ghostmux surfaces:
    cc: $SURFACE_CC
    cx: $SURFACE_CX
  would compare default socket to baseline:
    $BASELINE
EOF
  exit 0
fi

mkdir -p "$EVIDENCE_DIR"

capture_lease "$LEASE_CC" "$PANE_CC" "$EVIDENCE_DIR/lease-cc.txt"
capture_lease "$LEASE_CX" "$PANE_CX" "$EVIDENCE_DIR/lease-cx.txt"
capture_ghostmux "$SURFACE_CC" "$EVIDENCE_DIR/ghostmux-cc.txt"
capture_ghostmux "$SURFACE_CX" "$EVIDENCE_DIR/ghostmux-cx.txt"

stat_socket "$DEFAULT_SOCK" > "$EVIDENCE_DIR/default-sock.current"
{
  printf 'baseline: %s\n' "$BASELINE"
  printf 'current:  %s\n' "$(cat "$EVIDENCE_DIR/default-sock.current")"
} > "$EVIDENCE_DIR/default-sock.compare"

hrc runtime list --json > "$EVIDENCE_DIR/runtime-list.json"

if [[ -n "$LOG_OUT" && -f "$LOG_OUT" ]]; then
  tail -n "$LOG_TAIL_LINES" "$LOG_OUT" > "$EVIDENCE_DIR/hrc-server.log.tail"
fi
if [[ -n "$LOG_ERR" && -f "$LOG_ERR" ]]; then
  tail -n "$LOG_TAIL_LINES" "$LOG_ERR" > "$EVIDENCE_DIR/hrc-server.err.log.tail"
fi

printf -- '- %s %s snap -> evidence/%s/\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$ROW_ID" "$ROW_ID" >> "$RUN_DIR/timeline.md"
echo "snap complete: $EVIDENCE_DIR"
