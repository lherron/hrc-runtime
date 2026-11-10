#!/usr/bin/env bash
# The HRC owner of a node: the native rusthrc owner (T-11893) under the launchd
# label com.praesidium.hrc-server. Every node has run it since 2026-10-26.
#
#   hrc-owner.sh kind [plist]                      print rusthrc (fails on any other plist)
#   hrc-owner.sh log-path [plist]                  the owner's StandardOutPath
#   hrc-owner.sh schema-state [--exe <rusthrc>]    the owner store against the installed release
#                                                  (or <rusthrc>), read-only: current | pending |
#                                                  ahead | below_baseline | not_hrc | absent | unreadable
#   hrc-owner.sh stage --expect-commit <sha> [--dry-run]
#                                                  back the store up when the release has migrations
#                                                  pending, copy the installed release to the owner
#                                                  root and its rusthrc (signed when configured) to
#                                                  the fixed exe, then prune old staged releases
#   hrc-owner.sh log-mark                          the owner log's byte length, taken before a restart
#   hrc-owner.sh boot-check <mark>                 after a restart: fail on store.migration_failed
#                                                  since <mark>, else require the store current for
#                                                  the running exe
#   hrc-owner.sh refresh-plist [--dry-run]         a rusthrc owner plist that still execs the old
#                                                  release-link path: point it at the fixed exe
#   hrc-owner.sh bootstrap                         after the stop: bootstrap the installed plist, wait for health
#
# The deploy recipes pipe this file to a node over ssh
# (`ssh host bash -s -- <cmd> ... < scripts/hrc-owner.sh`), so a node does not
# need this commit checked out, and nothing here may read a file from a checkout.
#
# Schema (T-12840 §3-4, T-13056): the daemon migrates its store at boot, under
# the store lock, before it binds. Nothing in this script writes the store. A
# release with migrations pending gets an online backup at stage, while the old
# daemon still serves; the invoking seat then restarts the node, and boot-check
# reads the outcome back from the owner log and the store.
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
    esac
  done < <(program_args "$plist")
  fail "$plist does not run rusthrc: $(program_args "$plist" | paste -sd ' ' -)"
}

plist_value() { plutil -extract "$2" raw -o - "$1" 2>/dev/null; }

# Run the installed release's rusthrc against this node's store, read-only (the
# schema read opens the DB read-only; status is a GET), with the plist's roots.
owner_status_json() {
  local exe="$1" env_json
  env_json="$(plutil -extract EnvironmentVariables json -o - "$PLIST")"
  # Exit 2 (degraded) still prints the schema.
  env HRC_RUNTIME_DIR="$(jq -r .HRC_RUNTIME_DIR <<<"$env_json")" HRC_STATE_DIR="$(jq -r .HRC_STATE_DIR <<<"$env_json")" \
    "$exe" server status --json 2>/dev/null || true
}

# The store the owner opens: the plist's absolute HRC_STATE_DIR.
owner_db() {
  local dir
  dir="$(plist_value "$PLIST" EnvironmentVariables.HRC_STATE_DIR)" || fail "$PLIST declares no HRC_STATE_DIR"
  [[ "$dir" == /* ]] || fail "$PLIST HRC_STATE_DIR is not absolute: $dir"
  printf '%s/state.sqlite\n' "$dir"
}

# One JSON reading {state, ...} of the owner store by <rusthrc>'s own build:
# `rusthrc store state`, the runner's read-only classification (no store lock,
# never creates). A build that predates the verb (exit 2, usage) is read
# through its own read-only status schema instead, so a release staged for a
# rollback still gets an answer; that reading cannot see an ahead store, so it
# is current only when readable with nothing pending and unreadable otherwise.
native_reading() {
  local exe="$1" db out rc=0
  [[ -x "$exe" ]] || fail "no rusthrc at $exe"
  db="$(owner_db)"
  out="$("$exe" store state "$db" 2>/dev/null)" || rc=$?
  if jq -ce 'select(type == "object" and (.state | type == "string"))' <<<"$out" 2>/dev/null; then
    return
  fi
  if ((rc == 2)) && [[ -z "$out" ]]; then
    jq -c --arg db "$db" '.schema // {} |
      if .readable == true and (.pending | type == "array") and (.pending | length) == 0
      then {state: "current", path: $db, releaseVersion, via: "server status (build predates store state)"}
      else {state: "unreadable", path: $db, via: "server status (build predates store state)", schema: .} end' \
      <<<"$(owner_status_json "$exe")" 2>/dev/null && return
  fi
  jq -cn --arg db "$db" --arg exe "$exe" --arg out "$out" --argjson rc "$rc" \
    '{state: "unreadable", path: $db, error: "\($exe) store state gave no reading (exit \($rc)): \($out)"}'
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

# Native rusthrc build identity outlives daemon role flags and works without
# a release manifest (including cargo builds); older native releases expose it too.
knows_native_roles() {
  [[ -x "$1" ]] || return 1
  local probe
  probe="$("$1" --build-info 2>/dev/null)" || return 1
  jq -e '.owner == "rusthrc" and (.sourceCommit | type == "string" and test("^[0-9a-fA-F]{40}$"))' <<<"$probe" >/dev/null 2>&1
}

# Copy the installed release to $OWNER_ROOT (which neither `just install` nor
# Bun's startup prune touches) and point hrc-runtime-current at it. The layout
# mirrors ~/.bun/install so native reports mode=atomic with the release's
# sourceCommit. Staging restarts nothing; the owner picks the link up on its next
# start. Earlier staged releases stay for a native-to-native rollback until
# prune_owner_releases, the last step, removes them.
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
  # The daemon migrates at boot (T-12840 §3). Pending migrations get the
  # online backup here, before anything is copied, so a migrating restart
  # never runs without one and a release with nothing pending never takes one.
  local reading
  reading="$(native_reading "$src/bin/rusthrc")"
  state="$(jq -r .state <<<"$reading")"
  case "$state" in
    current) echo "[stage] store schema current for $id" ;;
    pending)
      echo "[stage] store schema pending for $id: $(jq -c .pending <<<"$reading"); the daemon applies them at its next boot"
      if ((dry)); then
        echo "[stage] would back up $(owner_db) with VACUUM INTO before staging"
      else
        backup_store "$(owner_db)" "$src/bin/rusthrc"
      fi ;;
    *) fail "store schema is $state for $id: $reading; nothing staged" ;;
  esac

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
  prune_owner_releases "$dest" "$dry"
}

# Retention of staged releases (T-12695): keep current, the newest
# $OWNER_RELEASES_KEEP_NEWEST, the release the running daemon reports, and any
# release a live process holds or was started from. pruneReleaseDirs does the
# holder probes, and refuses to delete anything when one fails. It comes from
# the release just staged, so the keep list goes through its existing `keep`
# option: a new one would be ignored by an older release, and stage can roll back.
#
# The daemon needs its own line: under the fixed exe it holds no file of its
# release open, and it spawns hrc-pty from that release's path. A status that
# gives no answer prunes nothing. The stage already succeeded, so no failure
# here fails it; the next stage tries again.
OWNER_RELEASES_KEEP_NEWEST=5
prune_owner_releases() {
  local dest="$1" dry="$2" running
  if ((dry)); then
    echo "[stage] would prune staged releases, keeping current, the newest $OWNER_RELEASES_KEEP_NEWEST, the running daemon's and any a live process holds"
    return
  fi
  if ! running="$(owner_status_json "$dest/bin/rusthrc" | jq -er '
    if (.running | type) != "boolean" then error("no answer")
    elif .running and .release.mode == "atomic" and (.release.releasePath | type) == "string" then .release.releasePath
    else "" end' 2>/dev/null)"; then
    echo "[stage] release prune skipped: daemon status gave no answer; nothing deleted"
    return
  fi
  bun run - "$dest" "$OWNER_ROOT/hrc-runtime-releases" "$OWNER_ROOT/hrc-runtime-current" "$OWNER_RELEASES_KEEP_NEWEST" "$running" <<'JS' ||
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
const [dest, releaseRoot, currentLink, keepNewest, running] = process.argv.slice(2)
const { pruneReleaseDirs } = await import(`${dest}/packages/hrc-core/dist/release-prune.js`)
// Release ids sort by their creation stamp. A .partial is a crashed copy, not a release.
const newest = readdirSync(releaseRoot, { withFileTypes: true })
  .filter((e) => e.isDirectory() && e.name.startsWith('release-') && !e.name.endsWith('.partial'))
  .map((e) => e.name)
  .sort()
  .slice(-Number(keepNewest))
const keep = newest.map((name) => join(releaseRoot, name))
if (running) keep.push(running)
const result = await pruneReleaseDirs({ releaseRoot, currentLink, expectedCurrent: dest, keep })
if (!result.pruned) {
  console.log(`[stage] release prune skipped: ${result.reason}; nothing deleted`)
} else {
  const held = Object.entries(result.heldBy).map(([id, pids]) => `${id} (pid ${pids.join(', ')})`)
  console.log(
    `[stage] release prune: removed ${result.removed.length} [${result.removed.join(', ')}]; kept ${result.kept.length}` +
      `${held.length ? `; held by live processes ${held.join(', ')}` : ''}` +
      `${result.failed.length ? `; failed ${result.failed.join(', ')}` : ''}`
  )
}
JS
    echo "[stage] release prune failed; nothing further deleted, the next stage tries again"
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

# Online backup before a migrating restart, taken while the old daemon still
# serves (T-12840 §4), by the release's own `rusthrc store backup`: VACUUM INTO
# through a read-only connection, one consistent snapshot with committed WAL,
# checked with quick_check; no process but the daemon writes the store. (macOS
# sqlite3 cannot do it: it fails to open a WAL store whose -shm is absent, as
# it is while the daemon is down.) The name keeps the prefix the daemon's nightly
# retention ages at 7 days (ledger_prune/retention.rs, docs/state-retention.md).
# Refuses, before writing, unless the backups volume has room for the store and
# its WAL plus 2 GiB, so a backup never fills the disk under the live daemon.
BACKUP_HEADROOM_KIB=$((2 * 1024 * 1024))
backup_store() {
  local db="$1" exe="$2" dir backup size wal=0 need avail
  [[ -f "$db" ]] || fail "no store at $db; nothing staged"
  dir="$(dirname "$db")/backups"
  mkdir -p "$dir" || fail "cannot create $dir; nothing staged"
  backup="$dir/pre-activate-$(date -u +%Y%m%dT%H%M%SZ)-$$.sqlite"
  size="$(stat -f %z "$db")"
  [[ -f "$db-wal" ]] && wal="$(stat -f %z "$db-wal")"
  need=$(((size + wal) / 1024 + BACKUP_HEADROOM_KIB))
  avail="$(df -Pk "$dir" | awk 'NR == 2 { print $4 }')"
  [[ "$avail" =~ ^[0-9]+$ ]] || fail "cannot read the free space of $dir; nothing staged"
  ((avail >= need)) ||
    fail "backup needs ${need} KiB free in $dir (store ${size} B + WAL ${wal} B + 2 GiB headroom), ${avail} KiB available; nothing staged"
  echo "[stage] backup: $exe store backup (VACUUM INTO) $backup (store ${size} B, WAL ${wal} B, ${avail} KiB free)"
  "$exe" store backup "$db" "$backup" >/dev/null || fail "backup of $db failed; nothing staged"
  chmod 600 "$backup"
  echo "[stage] backup=$backup (quick_check ok)"
  # Older backups stay (T-13056): the daemon's nightly retention ages
  # pre-activate-* at 7 days, and the free-space check above refuses a backup
  # that would not fit.
}

log_mark() {
  local log
  log="$(plist_value "$PLIST" StandardOutPath)" || fail "$PLIST declares no StandardOutPath"
  if [[ -f "$log" ]]; then stat -f %z "$log"; else echo 0; fi
}

# After a restart: the boots since <mark> in the owner log, then the store as
# the running exe reads it. A boot that failed its migration logs
# store.migration_failed and exits before binding; launchd retries it, so each
# retry is another such line. The store then still holds its previous set.
boot_check() {
  local mark="${1:-}" log size since failed last exits reading state migrated
  [[ "$mark" =~ ^[0-9]+$ ]] || fail "boot-check requires the byte mark from log-mark"
  log="$(plist_value "$PLIST" StandardOutPath)" || fail "$PLIST declares no StandardOutPath"
  size=0
  [[ -f "$log" ]] && size="$(stat -f %z "$log")"
  ((size >= mark)) || mark=0 # rotated since the mark: read what there is
  since="$(tail -c "+$((mark + 1))" "$log" 2>/dev/null | jq -Rc 'fromjson? | select(type == "object")' 2>/dev/null || true)"
  failed="$(jq -c 'select(.event == "store.migration_failed")' <<<"$since")"
  if [[ -n "$failed" ]]; then
    last="$(tail -1 <<<"$failed")"
    echo "[boot-check] FAIL store.migration_failed: $(jq -r '"\(.data.id): \(.data.error)"' <<<"$last") (path $(jq -r .data.path <<<"$last"))" >&2
    echo "[boot-check] $(wc -l <<<"$failed" | tr -d ' ') boot(s) since the restart failed their migration and exited before binding; launchd keeps retrying this release. The store holds its previous migration set, which the previous release admits: install and stage that release, then restart. Log: $log" >&2
    exit 1
  fi
  exits="$(jq -c 'select(.event == "server.exit")' <<<"$since")"
  [[ -z "$exits" ]] || echo "[boot-check] $(wc -l <<<"$exits" | tr -d ' ') server.exit since the restart; last: $(tail -1 <<<"$exits" | jq -c .data)" >&2
  migrated="$(jq -c 'select(.event == "store.migrated") | .data' <<<"$since" | tail -1)"
  [[ -z "$migrated" ]] || echo "[boot-check] store.migrated $migrated"
  reading="$(native_reading "$OWNER_EXE")"
  state="$(jq -r .state <<<"$reading")"
  [[ "$state" == current ]] || fail "store is $state for the running exe $OWNER_EXE: $reading"
  echo "[boot-check] ok: store current for $OWNER_EXE ($(jq -r .releaseVersion <<<"$reading"))"
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
    case "$#:${1:-}" in
      0:) release="$(installed_release)"; read -r src _ _ <<<"$release"; exe="$src/bin/rusthrc" ;;
      2:--exe) exe="$2" ;;
      *) fail "usage: schema-state [--exe <rusthrc>]" ;;
    esac
    reading="$(native_reading "$exe")"
    echo "[hrc-owner] schema by $exe: $reading" >&2
    jq -r .state <<<"$reading" ;;
  stage) stage "$@" ;;
  log-mark) log_mark ;;
  boot-check) boot_check "$@" ;;
  refresh-plist) refresh_plist "$@" ;;
  bootstrap) wait_unloaded; bootstrap_owner ;;
  *) echo "usage: $0 kind|log-path|schema-state|stage|log-mark|boot-check|refresh-plist|bootstrap ..." >&2; exit 2 ;;
esac
