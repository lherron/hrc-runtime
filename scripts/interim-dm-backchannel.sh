#!/usr/bin/env bash
# INTERIM svc hub DM backchannel.
# DEMOTE svc<->lab TO BREAK-GLASS AT T-06622; svc<->max3 AT T-06672.
#
# This deliberately small bridge routes only explicit targets. New hrcchat
# sends use `route`/`send` before touching the local store; the retained poller
# forwards legacy records. Delivery remains at-least-once: poll forwarding
# precedes cursor advance, and an ambiguous direct-send retry may duplicate.

set -euo pipefail

# Non-login SSH sessions omit Bun's user bin directory on both nodes.
export PATH="${HOME}/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${PATH:-}"
export ASP_AGENTS_ROOT="${ASP_AGENTS_ROOT:-${HOME}/praesidium/var/agents}"

usage() {
  cat <<'EOF'
usage: interim-dm-backchannel.sh init|once|poll|route|send|inject ...

poller environment:
  BACKCHANNEL_NODE          local node name (svc, lab, or max3)
  BACKCHANNEL_DIR           runtime directory (default: ~/praesidium/var/backchannel)
  BACKCHANNEL_NODE_FILE     local node file (default: $BACKCHANNEL_DIR/node)
  BACKCHANNEL_ROUTES        static route table (default: $BACKCHANNEL_DIR/routes.tsv)
  BACKCHANNEL_CURSOR        cursor file (default: $BACKCHANNEL_DIR/cursor)
  BACKCHANNEL_POLL_SECONDS  poll interval (default: 2)
  BACKCHANNEL_BATCH_SIZE    messages per query (default: 100)
  BACKCHANNEL_REMOTE_SVC    SSH target for svc (default: lherron@localhost)
  BACKCHANNEL_REMOTE_LAB    SSH target for lab (default: lab@localhost)
  BACKCHANNEL_REMOTE_MAX3   SSH target for max3 (default: lherron@max3)
  BACKCHANNEL_SSH_IDENTITY  optional private key for the outgoing SSH leg
  BACKCHANNEL_SSH           SSH binary override (default: command lookup)
  BACKCHANNEL_REMOTE_SCRIPT remote script path override
  HRCCHAT                   local hrcchat binary (default: command lookup)

Route table format: <session-ref shell glob><TAB><node>. Blank lines and #
comments are ignored. A target matching no route, or a route for this node,
stays local.
EOF
}

log() {
  printf '%s %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*" >&2
}

die() {
  log "ERROR: $*"
  exit 1
}

command_name="${1:-}"
if [[ -z "$command_name" ]]; then
  usage >&2
  exit 2
fi
shift

backchannel_dir="${BACKCHANNEL_DIR:-${HOME}/praesidium/var/backchannel}"
routes_file="${BACKCHANNEL_ROUTES:-${backchannel_dir}/routes.tsv}"
node_file="${BACKCHANNEL_NODE_FILE:-${backchannel_dir}/node}"
cursor_file="${BACKCHANNEL_CURSOR:-${backchannel_dir}/cursor}"
poll_seconds="${BACKCHANNEL_POLL_SECONDS:-2}"
batch_size="${BACKCHANNEL_BATCH_SIZE:-100}"
local_node="${BACKCHANNEL_NODE:-}"
if [[ -z "$local_node" && -r "$node_file" ]]; then
  local_node="$(tr -d '[:space:]' < "$node_file")"
fi
if [[ -n "${HRCCHAT:-}" ]]; then
  hrcchat_bin="$HRCCHAT"
elif [[ -x "${HOME}/.bun/bin/hrcchat" ]]; then
  hrcchat_bin="${HOME}/.bun/bin/hrcchat"
else
  hrcchat_bin="$(command -v hrcchat || true)"
fi
remote_script="${BACKCHANNEL_REMOTE_SCRIPT:-}"
ssh_bin="${BACKCHANNEL_SSH:-$(command -v ssh || true)}"

[[ -n "$hrcchat_bin" ]] || die "hrcchat is not available"
[[ -n "$ssh_bin" ]] || die "ssh is not available"
command -v jq >/dev/null 2>&1 || die "jq is not available"

ensure_poller_config() {
  [[ "$local_node" == "svc" || "$local_node" == "lab" || "$local_node" == "max3" ]] ||
    die "BACKCHANNEL_NODE must be svc, lab, or max3"
  [[ -r "$routes_file" ]] || die "route table is not readable: $routes_file"
  mkdir -p "$backchannel_dir"
}

read_cursor() {
  local cursor
  if [[ ! -f "$cursor_file" ]]; then
    die "cursor is missing: run '$0 init' before polling"
  fi
  cursor="$(tr -d '[:space:]' < "$cursor_file")"
  [[ "$cursor" =~ ^[0-9]+$ ]] || die "invalid cursor in $cursor_file"
  printf '%s\n' "$cursor"
}

advance_cursor() {
  local seq="$1"
  local tmp="${cursor_file}.tmp.$$"
  printf '%s\n' "$seq" > "$tmp"
  mv "$tmp" "$cursor_file"
}

current_high_water() {
  "$hrcchat_bin" --json messages --limit 1 |
    jq -er 'if (.messages | length) == 0 then 0 else .messages[-1].messageSeq end'
}

route_for_target() {
  local target="$1"
  local pattern node matched=""

  while IFS=$'\t' read -r pattern node _rest; do
    [[ -z "$pattern" || "${pattern:0:1}" == "#" ]] && continue
    [[ -n "$node" && -z "${_rest:-}" ]] || die "invalid route row in $routes_file"
    [[ "$node" == "svc" || "$node" == "lab" || "$node" == "max3" ]] ||
      die "invalid route node '$node'"

    if [[ "$target" == $pattern ]]; then
      [[ -z "$matched" ]] || die "target matches multiple routes: $target"
      matched="$node"
    fi
  done < "$routes_file"

  printf '%s\n' "$matched"
}

remote_for_node() {
  case "$1" in
    svc) printf '%s\n' "${BACKCHANNEL_REMOTE_SVC:-lherron@localhost}" ;;
    lab) printf '%s\n' "${BACKCHANNEL_REMOTE_LAB:-lab@localhost}" ;;
    max3) printf '%s\n' "${BACKCHANNEL_REMOTE_MAX3:-lherron@max3}" ;;
    *) die "unsupported remote node: $1" ;;
  esac
}

session_ref_to_handle() {
  local session_ref="$1"
  if [[ "$session_ref" =~ ^agent:([^:]+):project:([^:]+):task:([^/]+)/lane:([^/]+)$ ]]; then
    if [[ "${BASH_REMATCH[4]}" == "main" ]]; then
      printf '%s@%s:%s\n' "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}" "${BASH_REMATCH[3]}"
    else
      printf '%s@%s:%s~%s\n' \
        "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}" "${BASH_REMATCH[3]}" "${BASH_REMATCH[4]}"
    fi
    return
  fi
  die "invalid target session ref: $session_ref"
}

script_for_node() {
  local node="$1"
  if [[ -n "$remote_script" ]]; then
    printf '%s\n' "$remote_script"
    return
  fi
  case "$node" in
    svc) printf '%s\n' '/Users/lherron/praesidium/var/backchannel/interim-dm-backchannel.sh' ;;
    lab) printf '%s\n' '/Users/lab/praesidium/var/backchannel/interim-dm-backchannel.sh' ;;
    max3) printf '%s\n' '/Users/lherron/praesidium/var/backchannel/interim-dm-backchannel.sh' ;;
    *) die "unsupported remote node: $node" ;;
  esac
}

inject_message() {
  local origin_node="${1:-}"
  local target="${2:-}"
  local from_kind="${3:-}"
  local from_value="${4:-}"
  local body prefixed output status

  [[ "$origin_node" == "svc" || "$origin_node" == "lab" || "$origin_node" == "max3" ]] ||
    die "invalid origin node"
  [[ -n "$target" ]] || die "inject requires a target"
  body="$(cat)"
  prefixed="[backchannel from ${origin_node}] ${body}"

  set +e
  case "$from_kind" in
    session)
      [[ -n "$from_value" ]] || die "session sender is missing a session ref"
      output="$(BACKCHANNEL_BYPASS=1 HRC_SESSION_REF="$from_value" "$hrcchat_bin" --json dm "$target" - <<<"$prefixed")"
      status=$?
      ;;
    entity)
      output="$(env -u HRC_SESSION_REF BACKCHANNEL_BYPASS=1 "$hrcchat_bin" --json dm "$target" - <<<"$prefixed")"
      status=$?
      ;;
    *) die "unsupported sender kind: $from_kind" ;;
  esac
  set -e

  printf '%s\n' "$output"
  # hrcchat exits 4 when target execution fails even though the DM was durably
  # inserted. The backchannel's delivery boundary is that durable insert.
  if jq -e '(.request.messageId? // .messageId?) != null' >/dev/null 2>&1 <<<"$output"; then
    return 0
  fi
  return "$status"
}

resolve_remote_route() {
  local target="${1:-}"
  local route_node
  ensure_poller_config
  [[ -n "$target" ]] || die "route requires a canonical target session ref"
  route_node="$(route_for_target "$target")"
  if [[ -n "$route_node" && "$route_node" != "$local_node" ]]; then
    printf '%s\n' "$route_node"
  fi
}

send_message() {
  local target="${1:-}"
  local from_kind="${2:-}"
  local from_value="${3:-}"
  local route_node body
  route_node="$(resolve_remote_route "$target")"
  if [[ -z "$route_node" ]]; then
    log "target is not remotely routed: $target"
    return 10
  fi
  body="$(cat)"
  log "direct send target=$target route=$route_node"
  forward_message "$route_node" "$target" "$from_kind" "$from_value" "$body"
}

forward_message() {
  local route_node="$1"
  local target_session_ref="$2"
  local from_kind="$3"
  local from_value="$4"
  local body="$5"
  local remote remote_path target_handle
  local -a ssh_args

  remote="$(remote_for_node "$route_node")"
  remote_path="$(script_for_node "$route_node")"
  target_handle="$(session_ref_to_handle "$target_session_ref")"
  ssh_args=(-o BatchMode=yes)
  if [[ -n "${BACKCHANNEL_SSH_IDENTITY:-}" ]]; then
    ssh_args+=(-i "$BACKCHANNEL_SSH_IDENTITY")
  fi
  printf '%s' "$body" |
    "$ssh_bin" "${ssh_args[@]}" "$remote" "$remote_path" inject "$local_node" "$target_handle" "$from_kind" "$from_value"
}

poll_once() {
  local cursor payload message seq target_kind target route_node from_kind from_value body
  cursor="$(read_cursor)"
  if ! payload="$("$hrcchat_bin" --json messages --after "$cursor" --limit "$batch_size")"; then
    log "message query failed; cursor remains $cursor"
    return 1
  fi

  while IFS= read -r message; do
    [[ -n "$message" ]] || continue
    seq="$(jq -er '.messageSeq' <<<"$message")"
    target_kind="$(jq -er '.to.kind' <<<"$message")"

    if [[ "$target_kind" != "session" ]]; then
      advance_cursor "$seq"
      continue
    fi

    target="$(jq -er '.to.sessionRef' <<<"$message")"
    route_node="$(route_for_target "$target")"
    if [[ -z "$route_node" || "$route_node" == "$local_node" ]]; then
      advance_cursor "$seq"
      continue
    fi

    from_kind="$(jq -er '.from.kind' <<<"$message")"
    if [[ "$from_kind" == "session" ]]; then
      from_value="$(jq -er '.from.sessionRef' <<<"$message")"
    else
      from_value="$(jq -er '.from.entity' <<<"$message")"
    fi
    body="$(jq -er '.body' <<<"$message")"

    log "forwarding seq=$seq target=$target route=$route_node"
    if ! forward_message "$route_node" "$target" "$from_kind" "$from_value" "$body"; then
      log "forward failed seq=$seq; cursor remains $cursor"
      return 1
    fi

    # Validation-only failpoint: successful remote injection followed by a
    # local crash proves restart duplicates rather than drops the message.
    if [[ "${BACKCHANNEL_FAIL_AFTER_FORWARD_SEQ:-}" == "$seq" ]]; then
      log "validation failpoint after forwarding seq=$seq before cursor advance"
      exit 75
    fi

    advance_cursor "$seq"
    log "advanced cursor=$seq"
  done < <(jq -c '.messages[]' <<<"$payload")
}

acquire_poller_lock() {
  local lock_dir="${backchannel_dir}/poller.lock"
  local old_pid=""
  while ! mkdir "$lock_dir" 2>/dev/null; do
    if [[ ! -f "${lock_dir}/pid" ]]; then
      die "poller lock has no owner pid; refusing to steal it: $lock_dir"
    fi
    old_pid="$(tr -d '[:space:]' < "${lock_dir}/pid")"
    [[ "$old_pid" =~ ^[0-9]+$ ]] || die "poller lock has an invalid owner pid: $lock_dir"
    if kill -0 "$old_pid" 2>/dev/null; then
      die "poller already running with pid $old_pid"
    fi
    rm -f "${lock_dir}/pid"
    rmdir "$lock_dir" 2>/dev/null || continue
    log "removed stale poller lock for dead pid $old_pid"
  done
  printf '%s\n' "$$" > "${lock_dir}/pid"
  trap 'exit 0' INT TERM
  trap cleanup_poller_lock EXIT
}

cleanup_poller_lock() {
  local lock_dir="${backchannel_dir}/poller.lock"
  local owner_pid=""
  [[ -f "${lock_dir}/pid" ]] && owner_pid="$(tr -d '[:space:]' < "${lock_dir}/pid")"
  if [[ "$owner_pid" == "$$" ]]; then
    rm -f "${lock_dir}/pid"
    rmdir "$lock_dir" 2>/dev/null || true
  fi
}

case "$command_name" in
  init)
    ensure_poller_config
    high_water="$(current_high_water)"
    advance_cursor "$high_water"
    log "initialized cursor=$high_water"
    ;;
  once)
    ensure_poller_config
    poll_once
    ;;
  poll)
    ensure_poller_config
    acquire_poller_lock
    log "poller started node=$local_node cursor=$(read_cursor) routes=$routes_file"
    while true; do
      if ! poll_once; then
        log "poll cycle failed; retrying"
      fi
      sleep "$poll_seconds"
    done
    ;;
  route)
    resolve_remote_route "$@"
    ;;
  send)
    send_message "$@"
    ;;
  inject)
    inject_message "$@"
    ;;
  -h|--help|help)
    usage
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac
