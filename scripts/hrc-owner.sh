#!/usr/bin/env bash
# The HRC owner of a node: Bun (`~/.bun/bin/hrc server serve`) or the native
# rusthrc owner (T-11893). Both run under the one launchd label
# com.praesidium.hrc-server; only ProgramArguments and the log paths differ.
#
#   hrc-owner.sh kind [plist]                      print bun | rusthrc
#   hrc-owner.sh log-path [plist]                  the owner's StandardOutPath
#   hrc-owner.sh render <bun-plist> <out>          owner plist from an installed Bun plist
#   hrc-owner.sh stage --expect-commit <sha> [--dry-run]
#                                                  copy the installed release to the owner root
#   hrc-owner.sh preflight <node> <sha>            read-only switch report (KEY=value lines)
#   hrc-owner.sh prepare <node> <sha>              stage + render the owner plist to <plist>.rusthrc-owner.next
#   hrc-owner.sh activate                          after the stop: swap the plist in, bootstrap, wait for health
#
# The deploy and switch recipes pipe this file to a node over ssh
# (`ssh host bash -s -- <cmd> ... < scripts/hrc-owner.sh`), so a node does not
# need this commit checked out to be switched.
#
# Nothing here stops or restarts a daemon. A swapped plist takes effect only
# through a bootout + bootstrap: `hrc server restart` respawns launchd's LOADED
# definition. The invoking seat does the authorized `hrc server stop --node`;
# `activate` then bootstraps the job that stop booted out.
set -euo pipefail

LABEL=com.praesidium.hrc-server
PLIST="${HRC_OWNER_PLIST:-$HOME/Library/LaunchAgents/$LABEL.plist}"
OWNER_ROOT="${OWNER_ROOT:-$HOME/praesidium/var/hrc-owner}"
INSTALLED_LINK="${INSTALLED_LINK:-$HOME/.bun/install/hrc-runtime-current}"
OWNER_EXE="$OWNER_ROOT/hrc-runtime-current/bin/rusthrc"
export PATH="$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

fail() { echo "[hrc-owner] FAIL: $*" >&2; exit 1; }

# ProgramArguments as one argument per line.
program_args() { plutil -extract ProgramArguments json -o - "$1" | jq -r '.[]'; }

owner_kind() {
  local plist="${1:-$PLIST}" arg
  [[ -f "$plist" ]] || fail "no plist at $plist"
  while read -r arg; do
    case "${arg##*/}" in
      rusthrc) echo rusthrc; return ;;
      hrc) echo bun; return ;;
    esac
  done < <(program_args "$plist")
  fail "$plist runs neither hrc nor rusthrc: $(program_args "$plist" | paste -sd ' ' -)"
}

plist_value() { plutil -extract "$2" raw -o - "$1" 2>/dev/null; }

# The owner plist is the installed Bun plist with three changes: ProgramArguments
# execs the staged rusthrc (any launcher shim in front of `hrc` is kept, a bare
# `bun` interpreter is dropped), HRC_LAUNCHD_LABEL is declared, and both logs
# go to rusthrc-owner.log beside the Bun log. Everything else (env, label,
# ExitTimeOut, peer-listener settings) is the node's own and is kept. The edit
# is textual so the diff stays reviewable, then checked semantically.
render() {
  local src="$1" out="$2" log_dir new_args
  [[ "$(owner_kind "$src")" == bun ]] || fail "$src is not a Bun owner plist"
  [[ "$(plist_value "$src" Label)" == "$LABEL" ]] || fail "$src is not labelled $LABEL"
  local -a args=() kept=()
  local i hrc_at=-1
  # bash 3.2 (macOS /bin/bash, what `ssh host bash -s` gets on svc): no mapfile.
  while IFS= read -r i; do args+=("$i"); done < <(program_args "$src")
  for i in "${!args[@]}"; do
    [[ "${args[$i]##*/}" == hrc ]] && { hrc_at=$i; break; }
  done
  # A fronted Bun (T-11822) carries --listen-socket; the switch is for a direct one.
  [[ "${args[*]:hrc_at+1}" == 'server serve' ]] ||
    fail "$src runs '${args[*]}', expected <hrc> server serve (a fronted node? run just front-door-disable first)"
  for ((i = 0; i < hrc_at; i++)); do
    [[ "${args[$i]##*/}" == bun ]] || kept+=("${args[$i]}")
  done
  new_args="$(printf '%s\n' ${kept[@]+"${kept[@]}"} "$OWNER_EXE" server serve)"
  log_dir="$(dirname "$(plist_value "$src" StandardOutPath)")"
  [[ "$log_dir" == /* ]] || fail "$src declares no absolute StandardOutPath"

  # Through ENVIRON: BSD awk rejects a newline inside a -v value.
  OWNER_ARGS="$new_args" OWNER_LOG="$log_dir/rusthrc-owner.log" OWNER_LABEL="$LABEL" awk '
    BEGIN { args = ENVIRON["OWNER_ARGS"]; logpath = ENVIRON["OWNER_LOG"]; label = ENVIRON["OWNER_LABEL"] }
    function indent(s) { match(s, /^[ \t]*/); return substr(s, 1, RLENGTH) }
    function emit_label(ind) { print ind "<key>HRC_LAUNCHD_LABEL</key>"; print ind "<string>" label "</string>" }
    # ProgramArguments: replace the array body.
    in_args && /<\/array>/ { n = split(args, a, "\n"); for (j = 1; j <= n; j++) print arg_ind "<string>" a[j] "</string>"; in_args = 0 }
    in_args { if (arg_ind == "") arg_ind = indent($0); next }
    want_args && /<array>/ { want_args = 0; in_args = 1; print; next }
    /<key>ProgramArguments<\/key>/ { want_args = 1 }
    # Logs: the <string> after either key.
    want_log && /<string>/ { sub(/<string>.*<\/string>/, "<string>" logpath "</string>"); want_log = 0 }
    /<key>Standard(Error|Out)Path<\/key>/ { want_log = 1 }
    # HRC_LAUNCHD_LABEL: set it if present, else insert in key order.
    in_env && /<key>HRC_LAUNCHD_LABEL<\/key>/ { have_label = 1 }
    in_env && have_label == 1 && /<string>/ && !/<key>/ { sub(/<string>.*<\/string>/, "<string>" label "</string>"); have_label = 2 }
    in_env && !have_label && match($0, /<key>[^<]*<\/key>/) {
      k = substr($0, RSTART + 5, RLENGTH - 11)
      if (k > "HRC_LAUNCHD_LABEL") { emit_label(indent($0)); have_label = 2 }
      last_ind = indent($0)
    }
    in_env && /<\/dict>/ { if (!have_label) { emit_label(last_ind); have_label = 2 } in_env = 0 }
    want_env && /<dict>/ { want_env = 0; in_env = 1 }
    /<key>EnvironmentVariables<\/key>/ { want_env = 1 }
    { print }
  ' "$src" > "$out.tmp"
  plutil -lint -s "$out.tmp" || fail "rendered plist does not lint"

  # Semantic check: apart from the three intended edits, the plists are identical.
  local expect got
  expect="$(plutil -convert json -o - "$src" | jq -S --arg exe "$OWNER_EXE" --arg log "$log_dir/rusthrc-owner.log" \
    --arg label "$LABEL" --argjson args "$(jq -Rn '[inputs]' <<<"$new_args")" \
    '.ProgramArguments = $args | .StandardOutPath = $log | .StandardErrorPath = $log
     | .EnvironmentVariables.HRC_LAUNCHD_LABEL = $label')"
  got="$(plutil -convert json -o - "$out.tmp" | jq -S .)"
  [[ "$expect" == "$got" ]] || { diff <(echo "$expect") <(echo "$got") >&2 || true; fail "render changed more than the owner keys"; }
  mv "$out.tmp" "$out"
}

# Run the installed release's rusthrc against this node's store, read-only (the
# schema read opens the DB read-only; status is a GET), with the plist's roots.
schema_json() {
  local exe="$1" env_json
  local out
  env_json="$(plutil -extract EnvironmentVariables json -o - "$PLIST")"
  # Exit 2 (degraded) still prints the schema.
  out="$(env HRC_RUNTIME_DIR="$(jq -r .HRC_RUNTIME_DIR <<<"$env_json")" HRC_STATE_DIR="$(jq -r .HRC_STATE_DIR <<<"$env_json")" \
    "$exe" server status --json 2>/dev/null || true)"
  jq -c '.schema // {}' <<<"$out" 2>/dev/null || echo '{}'
}

# current | pending | ahead | unreadable. Only Bun migrates, and native refuses
# a store whose migration set differs from its own, in either direction.
schema_state() {
  local s
  s="$(schema_json "$1")"
  if [[ "$(jq -r '.readable // false' <<<"$s")" != true ]]; then echo unreadable
  elif [[ "$(jq -r '.schemaAhead // false' <<<"$s")" == true ]]; then echo ahead
  elif [[ "$(jq -r '(.pending // [1]) | length' <<<"$s")" != 0 ]]; then echo pending
  else echo current
  fi
}

installed_release() {
  local src manifest id commit
  src="$(cd "$INSTALLED_LINK" 2>/dev/null && pwd -P)" || fail "no installed release at $INSTALLED_LINK"
  id="$(basename "$src")"
  [[ "$id" == release-* ]] || fail "$src is not an atomic release dir"
  manifest="$src/praesidium-release.json"
  commit="$(jq -r '.hrcBuild.sourceCommit' "$manifest")"
  [[ "$commit" =~ ^[0-9a-f]{40}$ ]] || fail "bad sourceCommit in $manifest"
  [[ "$(jq -r .releaseId "$manifest")" == "$id" ]] || fail "manifest releaseId differs from dir name"
  printf '%s %s %s\n' "$src" "$id" "$commit"
}

# A native-capable rusthrc names --bun-socket in this refusal.
knows_native_roles() {
  [[ -x "$1" ]] || return 1
  local probe
  probe="$("$1" server --front 2>&1 || true)"
  [[ "$probe" == *'--front requires --bun-socket'* ]]
}

# Copy the installed release to $OWNER_ROOT (which neither `just install` nor
# Bun's startup prune touches) and point hrc-runtime-current at it. The layout
# mirrors ~/.bun/install so native reports mode=atomic with the release's
# sourceCommit. Earlier staged releases are kept for a native-to-native rollback.
# Staging restarts nothing; the owner picks the link up on its next start.
stage() {
  local expect="" dry=0 src id commit state release
  while (($#)); do
    case "$1" in
      --expect-commit) expect="$2"; shift ;;
      --dry-run) dry=1 ;;
      *) fail "stage: unknown argument $1" ;;
    esac
    shift
  done
  run() { if ((dry)); then echo "[stage] would run: $*"; else "$@"; fi; }
  release="$(installed_release)" || exit 1
  read -r src id commit <<<"$release"
  echo "[stage] installed release $id sourceCommit $commit"
  [[ -z "$expect" || "$commit" == "$expect" ]] ||
    fail "installed release is $commit, expected $expect (install the target first)"
  knows_native_roles "$src/bin/rusthrc" || fail "$src/bin/rusthrc is missing or does not know the native daemon roles"
  state="$(schema_state "$src/bin/rusthrc")"
  [[ "$state" == current ]] ||
    fail "store schema is $state for $id: $(schema_json "$src/bin/rusthrc"). Only Bun migrates: put the .bun-owner plist back, start Bun on this release, then switch again"

  local dest="$OWNER_ROOT/hrc-runtime-releases/$id"
  if [[ -d "$dest" ]]; then
    cmp -s "$src/praesidium-release.json" "$dest/praesidium-release.json" || fail "$dest exists with a different manifest"
    cmp -s "$src/bin/rusthrc" "$dest/bin/rusthrc" || fail "$dest exists with a different rusthrc"
    echo "[stage] $dest already staged"
  else
    run mkdir -p "$OWNER_ROOT/hrc-runtime-releases"
    run rm -rf "$dest.partial"
    run cp -Rp "$src" "$dest.partial"
    if ((!dry)); then
      cmp -s "$src/bin/rusthrc" "$dest.partial/bin/rusthrc" || fail "copy of rusthrc differs"
      [[ -z "$(find "$dest.partial" -type l -lname '/*' -print -quit)" ]] ||
        fail "staged copy has absolute symlinks into a prunable tree"
    fi
    run mv "$dest.partial" "$dest"
    echo "[stage] copied to $dest"
  fi
  local link="$OWNER_ROOT/hrc-runtime-current" prev
  prev="$(readlink "$link" 2>/dev/null || true)"
  run ln -s "$dest" "$link.next"
  run mv -fh "$link.next" "$link"
  echo "[stage] $link -> $dest (was: ${prev:-none})"
  if ((!dry)); then
    [[ "$(cd "$link" && pwd -P)" == "$dest" ]] || fail "link does not resolve to $dest"
  fi
  echo "[stage] ok release=$id sourceCommit=$commit exe=$OWNER_EXE"
}

# Read-only. Prints the rendered diff and KEY=value lines the switch recipe
# reads; every reason the switch cannot proceed is one SWITCH_BLOCKER line.
preflight() {
  local node="$1" sha="$2" status kind src id commit exe state tmp release
  blocker() { echo "SWITCH_BLOCKER=$*"; }
  status="$(hrc server status --json 2>/dev/null)" || { blocker 'HRC daemon is not healthy'; return; }
  [[ "$(jq -r '.node.nodeId // ""' <<<"$status")" == "$node" ]] ||
    { blocker "expected node $node, found $(jq -r '.node.nodeId // "unknown"' <<<"$status")"; return; }
  echo "SWITCH_ASPD_SHA=$(jq -r '.api.aspd.release.sourceCommit // ""' <<<"$status")"
  echo "SWITCH_ASPD_RELEASE=$(jq -r '.api.aspd.release.releaseId // ""' <<<"$status")"
  kind="$(owner_kind)"
  echo "SWITCH_OWNER=$kind"
  if [[ "$kind" == rusthrc ]]; then
    echo "[preflight] $PLIST already runs rusthrc; nothing to switch"
    return
  fi
  [[ ! -f "$HOME/Library/LaunchAgents/com.praesidium.rusthrc-server.plist" ]] ||
    blocker 'node is fronted (com.praesidium.rusthrc-server.plist); run just front-door-disable first'
  echo "SWITCH_BUN_RUNNING=$(jq -r '.release.hrcBuild.sourceCommit // ""' <<<"$status")"
  echo "SWITCH_BUN_RUNNING_EQUALS_INSTALLED=$(jq -r '.release.runningEqualsInstalled // false' <<<"$status")"
  if ! release="$(installed_release 2>/dev/null)"; then
    blocker "no atomic installed release at $INSTALLED_LINK"; return
  fi
  read -r src id commit <<<"$release"
  echo "SWITCH_INSTALLED=$id $commit"
  [[ "$commit" == "$sha" ]] || blocker "installed release is $commit, expected $sha (run just deploy-$node first)"
  exe="$src/bin/rusthrc"
  if knows_native_roles "$exe"; then
    state="$(schema_state "$exe")"
    echo "SWITCH_SCHEMA=$state $(schema_json "$exe")"
    case "$state" in
      current | pending) ;;
      *) blocker "store schema is $state against $id" ;;
    esac
  else
    blocker "$exe is missing or does not know the native daemon roles (install a release that ships it)"
  fi
  tmp="$(mktemp "${TMPDIR:-/tmp}/rusthrc-owner.XXXXXX")"
  if (render "$PLIST" "$tmp"); then
    echo "[preflight] rendered owner plist vs installed $PLIST:"
    diff -u "$PLIST" "$tmp" | sed "s|$tmp|<rendered rusthrc owner>|" || true
  else
    blocker 'owner plist did not render'
  fi
  rm -f "$tmp"
}

prepare() {
  local node="$1" sha="$2" report
  report="$(preflight "$node" "$sha")"
  echo "$report"
  grep -q '^SWITCH_OWNER=bun$' <<<"$report" || fail "$PLIST is not a Bun owner"
  ! grep -q '^SWITCH_BLOCKER=' <<<"$report" || fail 'preflight has blockers'
  grep -q '^SWITCH_SCHEMA=current' <<<"$report" || fail 'store schema is not current; migrate on Bun first'
  stage --expect-commit "$sha"
  render "$PLIST" "$PLIST.rusthrc-owner.next"
  echo "[prepare] staged; owner plist rendered to $PLIST.rusthrc-owner.next (the loaded Bun job is untouched)"
}

activate() {
  local domain target health_s=240 socket
  domain="gui/$(id -u)"
  target="$domain/$LABEL"
  [[ -f "$PLIST.rusthrc-owner.next" ]] || fail "no rendered $PLIST.rusthrc-owner.next; run prepare first"
  socket="$(plutil -extract EnvironmentVariables.HRC_RUNTIME_DIR raw -o - "$PLIST")/hrc.sock"
  for _ in $(seq 1 90); do
    launchctl print "$target" >/dev/null 2>&1 || break
    sleep 1
  done
  launchctl print "$target" >/dev/null 2>&1 && fail "$target is still loaded 90s after the stop; nothing was swapped"
  ! pgrep -f '/bin/hrc server serve' >/dev/null || fail "a Bun owner is still running: $(pgrep -fl '/bin/hrc server serve')"
  cp -p "$PLIST" "$PLIST.bun-owner"
  install -m 0644 "$PLIST.rusthrc-owner.next" "$PLIST"
  rm "$PLIST.rusthrc-owner.next"
  if command -v praesidium-adopt >/dev/null; then praesidium-adopt "$PLIST"; fi
  echo "[activate] $PLIST now runs $OWNER_EXE; Bun plist kept as $PLIST.bun-owner"
  # A bootstrap right after a bootout can fail once with I/O error 5.
  for attempt in 1 2 3 4 5; do
    launchctl bootstrap "$domain" "$PLIST" && break
    [[ "$attempt" == 5 ]] && fail "launchctl bootstrap $domain $PLIST failed"
    sleep 2
  done
  for _ in $(seq 1 "$health_s"); do
    if curl -sf --max-time 2 --unix-socket "$socket" http://localhost/v1/health >/dev/null; then
      echo "[activate] rusthrc owner healthy on $socket"
      return
    fi
    sleep 1
  done
  echo "[activate] no health on $socket after ${health_s}s; see $(plist_value "$PLIST" StandardOutPath)" >&2
  echo "[activate] roll back to Bun: launchctl bootout $target; install -m 0644 $PLIST.bun-owner $PLIST; launchctl bootstrap $domain $PLIST" >&2
  exit 1
}

cmd="${1:-}"
shift || true
case "$cmd" in
  kind) owner_kind "$@" ;;
  log-path) plist_value "${1:-$PLIST}" StandardOutPath ;;
  render) render "$@" ;;
  stage) stage "$@" ;;
  preflight) preflight "$@" ;;
  prepare) prepare "$@" ;;
  activate) activate ;;
  *) echo "usage: $0 kind|log-path|render|stage|preflight|prepare|activate ..." >&2; exit 2 ;;
esac
