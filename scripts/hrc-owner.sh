#!/usr/bin/env bash
# The HRC owner of a node: Bun (explicit hrc-cli entrypoint) or the native
# rusthrc owner (T-11893). Both run under the one launchd label
# com.praesidium.hrc-server; only ProgramArguments and the log paths differ.
#
#   hrc-owner.sh kind [plist]                      print bun | rusthrc
#   hrc-owner.sh log-path [plist]                  the owner's StandardOutPath
#   hrc-owner.sh schema-state                     installed release vs owner store, read-only
#   hrc-owner.sh render <bun-plist> <out>          owner plist from an installed Bun plist
#   hrc-owner.sh stage --expect-commit <sha> [--dry-run]
#                                                  copy the installed release to the owner root and
#                                                  its rusthrc (signed when configured) to the fixed exe
#   hrc-owner.sh preflight <node> <sha>            read-only switch report (KEY=value lines)
#   hrc-owner.sh prepare <node> <sha>              stage + render the owner plist to <plist>.rusthrc-owner.next
#   hrc-owner.sh activate --expect-commit <sha> [--expect-pending <id,id>] [--reason <text>] [--dry-run|--prepare-only]
#                                                  migrate the store, stage, request authorized restart, verify
#                                                  prepare-only backs up/migrates/stages; invoking seat restarts remotely
#   hrc-owner.sh activate                          after the stop: swap the plist in, bootstrap, wait for health
#   hrc-owner.sh refresh-plist [--dry-run]         a rusthrc owner plist that still execs the old
#                                                  release-link path: point it at the fixed exe
#   hrc-owner.sh bootstrap                         after the stop: bootstrap the installed plist, wait for health
#
# The deploy and switch recipes pipe this file to a node over ssh
# (`ssh host bash -s -- <cmd> ... < scripts/hrc-owner.sh`), so a node does not
# need this commit checked out to be switched.
#
# Schema activation requests a restart through HRC (Mable primary only).
# The separate plist switch takes effect only
# through a bootout + bootstrap: `hrc server restart` respawns launchd's LOADED
# definition. The invoking seat does the authorized `hrc server stop --node`;
# `activate` then bootstraps the job that stop booted out.
set -euo pipefail

LABEL=com.praesidium.hrc-server
PLIST="${HRC_OWNER_PLIST:-$HOME/Library/LaunchAgents/$LABEL.plist}"
OWNER_ROOT="${OWNER_ROOT:-$HOME/praesidium/var/hrc-owner}"
INSTALLED_LINK="${INSTALLED_LINK:-$HOME/.bun/install/hrc-runtime-current}"
# The owner execs a fixed, real (never symlinked) copy of the staged release's
# rusthrc (T-12224). macOS TCC keys a non-bundled binary's grants on its
# resolved path plus its designated requirement, so a new release dir path or
# an ad-hoc cdhash is a new app that must be approved again at the console.
# With a node codesign identity, the copy's designated requirement is identifier
# + certificate and stays the same across builds; rusthrc finds its release
# through hrc-runtime-current beside bin/.
OWNER_EXE="$OWNER_ROOT/bin/rusthrc"
LEGACY_OWNER_EXE="$OWNER_ROOT/hrc-runtime-current/bin/rusthrc"
CODESIGN_ID=com.praesidium.rusthrc
# The node's signing keychain and its password file, shared with
# scripts/macos-codesign-identity.sh (which creates them). This file reaches
# nodes through `ssh bash -s`, so it cannot source that script; the few lines
# of unlock + sign below repeat it on purpose.
CODESIGN_KEYCHAIN="${PRAESIDIUM_CODESIGN_KEYCHAIN:-$HOME/Library/Keychains/praesidium-codesign.keychain-db}"
CODESIGN_KEYCHAIN_PASSWORD_FILE="${PRAESIDIUM_CODESIGN_KEYCHAIN_PASSWORD_FILE:-$HOME/praesidium/var/codesign/praesidium-codesign.keychain.password}"
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
      hrc | cli.ts | hrc.js) echo bun; return ;;
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
    [[ "${args[$i]##*/}" == hrc || "${args[$i]}" == */hrc-cli/src/cli.ts || "${args[$i]}" == */hrc-cli/bin/hrc.js ]] && { hrc_at=$i; break; }
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
  # The fixed exe is copied, signed and probed before the link moves, so a
  # refusal leaves the link and the exe as a matched pair.
  prepare_owner_exe "$dest" "$id" "$dry"
  local link="$OWNER_ROOT/hrc-runtime-current" prev
  prev="$(readlink "$link" 2>/dev/null || true)"
  run ln -s "$dest" "$link.next"
  run mv -fh "$link.next" "$link"
  echo "[stage] $link -> $dest (was: ${prev:-none})"
  if ((!dry)); then
    [[ "$(cd "$link" && pwd -P)" == "$dest" ]] || fail "link does not resolve to $dest"
  fi
  commit_owner_exe "$dest/bin/rusthrc" "$dry"
  echo "[stage] ok release=$id sourceCommit=$commit exe=$OWNER_EXE"
}

# The node's code-signing identity (its certificate common name): the
# HRC_CODESIGN_IDENTITY env, else the first line of $OWNER_ROOT/codesign.identity.
# Empty means none is configured.
codesign_identity() {
  local id="${HRC_CODESIGN_IDENTITY:-}"
  if [[ -z "$id" && -f "$OWNER_ROOT/codesign.identity" ]]; then
    IFS= read -r id < "$OWNER_ROOT/codesign.identity" || true
  fi
  id="${id#"${id%%[![:space:]]*}"}"
  printf '%s' "${id%"${id##*[![:space:]]}"}"
}

# Sign $1 as identity $2 (common name) from the signing keychain: unlock it
# with its password file (an ssh session never sees the console's unlocked
# keychains, and a locked one makes codesign raise a dialog at the console),
# then sign by the certificate's SHA-1 restricted to that keychain, so a
# same-named certificate in another keychain is never picked.
sign_owner_exe() {
  local file="$1" identity="$2" hash
  [[ -f "$CODESIGN_KEYCHAIN" ]] || { echo "[stage] no signing keychain $CODESIGN_KEYCHAIN (run scripts/macos-codesign-identity.sh create)" >&2; return 1; }
  [[ -f "$CODESIGN_KEYCHAIN_PASSWORD_FILE" ]] || { echo "[stage] no keychain password file $CODESIGN_KEYCHAIN_PASSWORD_FILE" >&2; return 1; }
  security unlock-keychain -p "$(<"$CODESIGN_KEYCHAIN_PASSWORD_FILE")" "$CODESIGN_KEYCHAIN" || return 1
  hash="$(security find-identity -p codesigning "$CODESIGN_KEYCHAIN" 2>/dev/null |
    awk -v q="\"$identity\"" 'index($0, q) && $1 ~ /^[0-9]+\)$/ { print $2; exit }')"
  [[ -n "$hash" ]] || { echo "[stage] no code-signing identity \"$identity\" in $CODESIGN_KEYCHAIN" >&2; return 1; }
  echo "[stage] signing as \"$identity\" ($hash in $CODESIGN_KEYCHAIN) with identifier $CODESIGN_ID"
  codesign -f -s "$hash" --keychain "$CODESIGN_KEYCHAIN" -i "$CODESIGN_ID" --timestamp=none "$file"
}

# Copy a release's rusthrc to the fixed $OWNER_EXE: a temp file in the same
# directory, signed there when an identity is configured, then renamed over the
# old one by commit_owner_exe. The rename gives a new inode, so a running owner
# keeps executing the file it started from; the kernel kills a process whose
# signed pages change under it, which is why the copy is never signed or
# written in place.
#
# A build that predates the fixed exe (T-12224) cannot find its release from
# $OWNER_EXE: it would report itself unmanaged and miss its hrc-pty. The probe
# runs the signed copy from a scratch twin of the owner layout and requires its
# --version to name the release. A plist that already execs $OWNER_EXE refuses
# such a build; under a plist that still execs the release link it is a warning.
OWNER_EXE_TMP=""
prepare_owner_exe() {
  local dest="$1" id="$2" dry="$3" identity probe version
  identity="$(codesign_identity)"
  if ((dry)); then
    echo "[stage] would copy $dest/bin/rusthrc to $OWNER_EXE (temp file + rename)"
    if [[ -n "$identity" ]]; then
      echo "[stage] would unlock $CODESIGN_KEYCHAIN and run: codesign -f -s <SHA-1 of \"$identity\"> --keychain $CODESIGN_KEYCHAIN -i $CODESIGN_ID --timestamp=none <temp>"
    else
      echo "[stage] no codesign identity configured; would keep the linker's ad-hoc signature"
    fi
    return
  fi
  mkdir -p "$OWNER_ROOT/bin"
  OWNER_EXE_TMP="$OWNER_ROOT/bin/.rusthrc.$$.tmp"
  rm -f "$OWNER_EXE_TMP"
  cp -p "$dest/bin/rusthrc" "$OWNER_EXE_TMP"
  if [[ -n "$identity" ]]; then
    sign_owner_exe "$OWNER_EXE_TMP" "$identity" || {
      rm -f "$OWNER_EXE_TMP"
      fail "codesign as \"$identity\" failed; nothing was replaced. Check: scripts/macos-codesign-identity.sh status --sign-probe (a locked keychain, or a key that denies codesign, fails here)"
    }
    codesign --verify --strict "$OWNER_EXE_TMP" || { rm -f "$OWNER_EXE_TMP"; fail "signed copy does not verify"; }
    echo "[stage] designated requirement: $(codesign -dr - "$OWNER_EXE_TMP" 2>/dev/null | sed -n 's/^#* *designated => //p')"
  else
    echo "[stage] no codesign identity ($OWNER_ROOT/codesign.identity or HRC_CODESIGN_IDENTITY); $OWNER_EXE keeps the linker's ad-hoc signature, a new macOS TCC identity every release"
  fi
  probe="$OWNER_ROOT/.exe-probe.$$"
  rm -rf "$probe"
  mkdir -p "$probe/bin"
  ln "$OWNER_EXE_TMP" "$probe/bin/rusthrc"
  ln -s "$dest" "$probe/hrc-runtime-current"
  version="$("$probe/bin/rusthrc" --version 2>&1 || true)"
  rm -rf "$probe"
  if [[ "$version" != *"releaseId $id,"* ]]; then
    if [[ -f "$PLIST" ]] && program_args "$PLIST" | grep -qxF "$OWNER_EXE"; then
      rm -f "$OWNER_EXE_TMP"
      fail "$id predates the fixed owner exe ($version); $PLIST execs $OWNER_EXE, so this release cannot run there. Nothing was switched"
    fi
    echo "[stage] WARN: $id predates the fixed owner exe ($version); the plist execs the release link, so the copy is unused and refresh-plist refuses it"
  fi
}

commit_owner_exe() {
  local src="$1" dry="$2"
  ((dry)) && return
  [[ -n "$OWNER_EXE_TMP" ]] || return 0
  mv -f "$OWNER_EXE_TMP" "$OWNER_EXE"
  [[ -f "$OWNER_EXE" && ! -L "$OWNER_EXE" ]] || fail "$OWNER_EXE is not a regular file"
  echo "[stage] $OWNER_EXE <- $src"
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

# Inline so this script still works when piped to a node via ssh bash -s.
# The installed package owns migration; the wrapper is never used for readback.
activation_migrations() {
  bun run - "$@" <<'JS'
import { Database } from 'bun:sqlite'
const [rel, path, mode, expected] = process.argv.slice(2)
const m = await import(`${rel}/packages/hrc-store-sqlite/dist/migrations.js`)
function report() {
  const ro = new Database(path, { readonly: true })
  try {
    const applied = m.appliedMigrationIds(ro)
    const known = new Set(m.phase1Migrations.map(x => x.id))
    return { storeVersion: applied.at(-1), releaseVersion: m.releaseSchemaVersion(),
      pending: m.pendingMigrationIds(ro), schemaAhead: applied.some(id => !known.has(id)) }
  } finally { ro.close() }
}
const before = report()
if (mode === 'state') {
  console.log(before.schemaAhead ? 'ahead' : before.pending.length ? 'pending' : 'current')
  process.exit(0)
}
console.log(JSON.stringify({ path, before }))
const pending = [...before.pending].sort()
if (before.schemaAhead || !pending.length ||
    (expected !== undefined && JSON.stringify(pending) !== JSON.stringify(expected.split(',').sort()))) {
  throw new Error('unexpected pending set or schema ahead; nothing changed')
}
if (mode === 'apply') {
  const { openHrcDatabase } = await import(`${rel}/packages/hrc-store-sqlite/dist/database.js`)
  const store = openHrcDatabase(path)
  store.close()
  const after = report()
  console.log(JSON.stringify({ path, after }))
  if (after.pending.length || after.schemaAhead || after.storeVersion !== after.releaseVersion) {
    throw new Error('migration readback is not current; stage/restart skipped')
  }
}
JS
}

activate_schema() {
  local expect="" pending="" has_pending=0 reason="" release src id commit env_json db log since status warm attempt
  local dry=0 prepare_only=0 backup
  while (($#)); do
    case "$1" in
      --expect-commit|--expect-pending|--reason)
        [[ $# -ge 2 && -n "$2" && "$2" != --* ]] || fail "activate: $1 requires a value; nothing changed"
        case "$1" in
          --expect-commit) expect="$2" ;;
          --expect-pending) pending="$2"; has_pending=1 ;;
          --reason) reason="$2" ;;
        esac
        shift 2 ;;
      --dry-run) dry=1; shift ;;
      --prepare-only) prepare_only=1; shift ;;
      *) fail "activate: unknown argument $1; nothing changed" ;;
    esac
  done
  [[ "$expect" =~ ^[0-9a-f]{40}$ ]] || fail 'activate requires --expect-commit <full sha>; nothing changed'
  release="$(installed_release)" || return 1
  read -r src id commit <<<"$release"
  [[ "$commit" == "$expect" ]] || fail "installed release is $commit, expected $expect; nothing changed"
  [[ "$(owner_kind)" == rusthrc ]] || fail 'activate requires a rusthrc owner; nothing changed'
  knows_native_roles "$src/bin/rusthrc" || fail 'installed release lacks native roles; nothing changed'
  env_json="$(plutil -extract EnvironmentVariables json -o - "$PLIST")"
  # Scope every CLI/schema read to the same store the owner will open.
  local HRC_STATE_DIR HRC_RUNTIME_DIR
  HRC_STATE_DIR="$(jq -er '.HRC_STATE_DIR | select(type == "string" and startswith("/"))' <<<"$env_json")" || fail 'no absolute owner state root; nothing changed'
  HRC_RUNTIME_DIR="$(jq -er '.HRC_RUNTIME_DIR | select(type == "string" and startswith("/"))' <<<"$env_json")" || fail 'no absolute owner runtime root; nothing changed'
  export HRC_STATE_DIR HRC_RUNTIME_DIR
  db="$HRC_STATE_DIR/state.sqlite"
  log="$(plist_value "$PLIST" StandardOutPath)"
  [[ -f "$db" && -r "$log" ]] || fail "store or owner log unavailable ($db, $log); nothing changed"
  echo "[activate] db=$db release=$id sourceCommit=$commit"
  local -a expected_args=()
  if ((has_pending)); then expected_args=("$pending"); fi
  activation_migrations "$src" "$db" report ${expected_args[@]+"${expected_args[@]}"} || fail 'migration preflight failed; nothing changed'
  if ((dry)); then
    echo '[activate] dry run: would back up, migrate and stage; no changes made'
    return
  fi
  backup="$HRC_STATE_DIR/backups/pre-activate-$(date -u +%Y%m%dT%H%M%SZ)-$$.sqlite"
  # SQLite's backup API includes committed WAL pages; copying the live DB does not.
  python3 - "$db" "$backup" <<'PY'
import pathlib, sqlite3, sys
source, target = map(pathlib.Path, sys.argv[1:])
target.parent.mkdir(parents=True, exist_ok=True)
with sqlite3.connect(f'file:{source}?mode=ro', uri=True) as src:
    with sqlite3.connect(target) as dst:
        src.backup(dst)
        if dst.execute('PRAGMA quick_check').fetchall() != [('ok',)]:
            raise SystemExit('activation backup failed SQLite quick_check')
target.chmod(0o600)
PY
  echo "[activate] backup=$backup"
  # Retention: the backup just written (quick_check ok) is this activation's
  # rollback point; older pre-activate copies are a full store each (2–25 GiB)
  # and roll back nothing current, so only the newest is kept.
  local old
  for old in "$HRC_STATE_DIR"/backups/pre-activate-*.sqlite; do
    [[ -f "$old" && "$old" != "$backup" ]] || continue
    rm -f -- "$old" && echo "[activate] pruned older backup $old"
  done
  [[ -n "$reason" ]] || reason="activate schema bump at $expect"
  echo "[activate] migrate -> stage -> restart (restart requires mable@<project>:primary)"
  activation_migrations "$src" "$db" apply ${expected_args[@]+"${expected_args[@]}"}
  stage --expect-commit "$expect"
  if ((prepare_only)); then
    echo "[activate] prepared sourceCommit=$commit; invoking Mable seat must restart and read back this node"
    return
  fi
  if ! hrc server restart --force --reason "$reason"; then
    fail 'restart failed; migration and stage already applied. HRC permits restart only from an authorized Mable primary seat (or Lance); ask mable@hrc-runtime:primary to finish activation'
  fi
  for attempt in $(seq 1 60); do
    status="$(hrc server status --json 2>/dev/null || true)"
    if jq -e --arg sha "$expect" '
      .release.hrcBuild.sourceCommit == $sha and .release.runningEqualsInstalled == true and
      .api.startedAt != null and (.api.startedAt | type == "string") and
      .schema.readable == true and (.schema.releaseVersion | type == "string") and
      .schema.storeVersion == .schema.releaseVersion and .schema.pending == [] and
      .schema.schemaAhead == false' >/dev/null 2>&1 <<<"$status"; then
      echo "$status" | jq -c '{sourceCommit:.release.hrcBuild.sourceCommit, schema}'
      break
    fi
    [[ "$attempt" != 60 ]] || fail 'post-restart release/schema readback failed'
    sleep 1
  done
  # Bound warmup to the verified process start.
  since="$(jq -r .api.startedAt <<<"$status")"
  for _ in $(seq 1 120); do
    warm="$(jq -Rc --arg since "$since" 'fromjson? | select(.event == "broker.warmup.complete" and .ts >= $since)' "$log" | tail -1)"
    if [[ -n "$warm" ]]; then
      echo "$warm"
      jq -e '.data | (.attached | type == "number") and (.total | type == "number") and
        .attached == .total and (.byCategory | type == "object") and
        (.byCategory | del(.attached) | [.[]] | all(. == 0))' >/dev/null <<<"$warm" || fail 'broker warmup incomplete'
      echo "[activate] ok release=$id sourceCommit=$commit"
      return
    fi
    sleep 1
  done
  fail "no broker.warmup.complete from this activation in $log"
}

activate() {
  local domain target
  domain="gui/$(id -u)"
  target="$domain/$LABEL"
  [[ -f "$PLIST.rusthrc-owner.next" ]] || fail "no rendered $PLIST.rusthrc-owner.next; run prepare first"
  wait_unloaded
  ! pgrep -f '/bin/hrc server serve' >/dev/null || fail "a Bun owner is still running: $(pgrep -fl '/bin/hrc server serve')"
  cp -p "$PLIST" "$PLIST.bun-owner"
  install -m 0644 "$PLIST.rusthrc-owner.next" "$PLIST"
  rm "$PLIST.rusthrc-owner.next"
  if command -v praesidium-adopt >/dev/null; then praesidium-adopt "$PLIST"; fi
  echo "[activate] $PLIST now runs $OWNER_EXE; Bun plist kept as $PLIST.bun-owner"
  bootstrap_owner || {
    echo "[activate] roll back to Bun: launchctl bootout $target; install -m 0644 $PLIST.bun-owner $PLIST; launchctl bootstrap $domain $PLIST" >&2
    exit 1
  }
}

# Wait for the job a stop booted out to unload, then bootstrap the installed
# plist and wait for health. Returns 1 (after saying why) on no health.
wait_unloaded() {
  local target="gui/$(id -u)/$LABEL"
  for _ in $(seq 1 90); do
    launchctl print "$target" >/dev/null 2>&1 || return 0
    sleep 1
  done
  fail "$target is still loaded 90s after the stop"
}

bootstrap_owner() {
  local domain health_s=240 socket
  domain="gui/$(id -u)"
  socket="$(plutil -extract EnvironmentVariables.HRC_RUNTIME_DIR raw -o - "$PLIST")/hrc.sock"
  # A bootstrap right after a bootout can fail once with I/O error 5.
  for attempt in 1 2 3 4 5; do
    launchctl bootstrap "$domain" "$PLIST" && break
    [[ "$attempt" == 5 ]] && fail "launchctl bootstrap $domain $PLIST failed"
    sleep 2
  done
  for _ in $(seq 1 "$health_s"); do
    if curl -sf --max-time 2 --unix-socket "$socket" http://localhost/v1/health >/dev/null; then
      echo "[bootstrap] rusthrc owner healthy on $socket"
      return 0
    fi
    sleep 1
  done
  echo "[bootstrap] no health on $socket after ${health_s}s; see $(plist_value "$PLIST" StandardOutPath)" >&2
  return 1
}

# The one-time move of a rusthrc owner plist from the release-link exe
# ($LEGACY_OWNER_EXE) to the fixed $OWNER_EXE (T-12224). Refuses unless that
# ProgramArguments entry is the only difference, and unless stage has already
# put a regular file at $OWNER_EXE. It rewrites the file only: launchd keeps
# running the loaded definition until the authorized stop, then `bootstrap`.
refresh_plist() {
  local dry=0 expect got tmp
  [[ "${1:-}" == --dry-run ]] && dry=1
  [[ "$(owner_kind)" == rusthrc ]] || fail "$PLIST is not a rusthrc owner"
  if program_args "$PLIST" | grep -qxF "$OWNER_EXE"; then
    echo "[refresh-plist] $PLIST already execs $OWNER_EXE; nothing to do"
    echo "REFRESH_NEEDED=0"
    return
  fi
  local current version
  if ((dry)) && [[ ! -f "$OWNER_EXE" ]]; then
    echo "[refresh-plist] (dry run) $OWNER_EXE is not staged yet; apply stages it first"
  else
    [[ -f "$OWNER_EXE" && ! -L "$OWNER_EXE" ]] || fail "no regular file at $OWNER_EXE; stage first"
    current="$(cd "$OWNER_ROOT/hrc-runtime-current" && pwd -P)" || fail "no $OWNER_ROOT/hrc-runtime-current"
    version="$("$OWNER_EXE" --version 2>&1 || true)"
    [[ "$version" == *"releaseId ${current##*/},"* ]] ||
      fail "$OWNER_EXE does not resolve its release ${current##*/} ($version); stage a release that ships the fixed owner exe first"
  fi
  tmp="$(mktemp "${TMPDIR:-/tmp}/rusthrc-owner-refresh.XXXXXX")"
  # Textual edit of the one <string>, then a semantic check that it is the only change.
  OLD="<string>$LEGACY_OWNER_EXE</string>" NEW="<string>$OWNER_EXE</string>" awk '
    BEGIN { old = ENVIRON["OLD"]; new = ENVIRON["NEW"] }
    { line = $0; at = index(line, old); if (at) { line = substr(line, 1, at - 1) new substr(line, at + length(old)); n++ } print line }
    END { if (n != 1) exit 3 }
  ' "$PLIST" > "$tmp" || { rm -f "$tmp"; fail "$PLIST does not exec $LEGACY_OWNER_EXE exactly once: $(program_args "$PLIST" | paste -sd ' ' -)"; }
  plutil -lint -s "$tmp" || { rm -f "$tmp"; fail "refreshed plist does not lint"; }
  expect="$(plutil -convert json -o - "$PLIST" | jq -S --arg old "$LEGACY_OWNER_EXE" --arg new "$OWNER_EXE" \
    '.ProgramArguments |= map(if . == $old then $new else . end)')"
  got="$(plutil -convert json -o - "$tmp" | jq -S .)"
  [[ "$expect" == "$got" ]] || { diff <(echo "$expect") <(echo "$got") >&2 || true; rm -f "$tmp"; fail "refresh changed more than the exec path"; }
  echo "[refresh-plist] $PLIST:"
  diff -u "$PLIST" "$tmp" | sed "s|$tmp|<refreshed>|" || true
  if ((dry)); then
    rm -f "$tmp"
    echo "REFRESH_NEEDED=1"
    return
  fi
  cp -p "$PLIST" "$PLIST.pre-fixed-exe"
  install -m 0644 "$tmp" "$PLIST"
  rm -f "$tmp"
  if command -v praesidium-adopt >/dev/null; then praesidium-adopt "$PLIST"; fi
  echo "[refresh-plist] $PLIST now execs $OWNER_EXE (previous kept as $PLIST.pre-fixed-exe); the loaded job is unchanged until the stop + bootstrap"
  echo "REFRESH_NEEDED=1"
}

cmd="${1:-}"
shift || true
case "$cmd" in
  kind) owner_kind "$@" ;;
  log-path) plist_value "${1:-$PLIST}" StandardOutPath ;;
  schema-state)
    release="$(installed_release)"
    read -r src id commit <<<"$release"
    env_json="$(plutil -extract EnvironmentVariables json -o - "$PLIST")"
    db="$(jq -er '.HRC_STATE_DIR | select(type == "string" and startswith("/"))' <<<"$env_json")/state.sqlite"
    activation_migrations "$src" "$db" state ;;
  render) render "$@" ;;
  stage) stage "$@" ;;
  preflight) preflight "$@" ;;
  prepare) prepare "$@" ;;
  activate) if (($#)); then activate_schema "$@"; else activate; fi ;;
  refresh-plist) refresh_plist "$@" ;;
  bootstrap) wait_unloaded; bootstrap_owner ;;
  *) echo "usage: $0 kind|log-path|schema-state|render|stage|preflight|prepare|activate|refresh-plist|bootstrap ..." >&2; exit 2 ;;
esac
