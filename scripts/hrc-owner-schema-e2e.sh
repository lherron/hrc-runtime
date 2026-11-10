#!/usr/bin/env bash
# Keep-manual e2e (not in `just verify`): the deploy path's schema branch,
# through the real `just _deploy-node` recipe and the real scripts/hrc-owner.sh,
# against a scratch owner root, scratch store and scratch daemon (T-13056;
# replaces the Bun-activation hrc-owner-schema-e2e.py).
#
#   scripts/hrc-owner-schema-e2e.sh <repo> <bins-dir> <out-dir>
#
# <bins-dir> holds three rusthrc builds of the same commit:
#   rusthrc-base  the forward registry empty (the commit under test)
#   rusthrc-ok    + test-only 0132_t13056_scratch_ok (creates a table)
#   rusthrc-fail  + test-only 0132_t13056_scratch_fail (creates a table, then fails)
# Build the two test-only variants by editing `FORWARD` in
# crates/hrc-store/src/migrate/mod.rs to one entry each, never committed (the
# T-13056 artifact dir has the build helper used); the ids must sort after the
# registry's real head.
#
# Isolation: HOME is a scratch dir for the recipe, the owner script and the
# daemon, so every default the script derives from HOME (plist, owner root,
# installed link, keychain) is scratch, and the plist names every daemon root
# (state, runtime, wrkq db, peer config) explicitly under it. Fakes on PATH:
#   ssh   runs `bash -s -- <owner cmd>` locally from / (the piped script, no
#         checkout); answers phase 1 with DEPLOY_* lines; swallows the retire step
#   hrc   `server restart`: stands in for launchd. Stops the scratch daemon, then
#         starts the plist's ProgramArguments with the plist's environment, and
#         retries a boot that exits (KeepAlive) up to 3 times
#   just  `_node-readback` only: records that it was reached
#   bun   sentinel: records every call (argv, parent) and exits 1
# Nothing here restarts or reads a live daemon or a live store.
set -eu # no pipefail: `| head` would SIGPIPE a probe into a false failure

repo="$(cd "$1" && pwd -P)"
bins="$(cd "$2" && pwd -P)"
out="$3"
mkdir -p "$out"
out="$(cd "$out" && pwd -P)"
real_just="$(command -v just)"
sha="$(git -C "$repo" rev-parse HEAD)"
for b in base ok fail; do
  [[ "$("$bins/rusthrc-$b" --build-info | jq -r .sourceCommit)" == "$sha" ]] || { echo "rusthrc-$b is not built from $sha" >&2; exit 2; }
done

root="$(cd "$(mktemp -d /tmp/t13056-e2e.XXXXXX)" && pwd -P)"
H="$root/home"
STATE="$root/state"
RUN="$root/run"
mkdir -p "$H/.bun/bin" "$H/.bun/install/hrc-runtime-releases" "$H/Library/LaunchAgents" \
  "$H/praesidium/var/logs/hrc-runtime" "$STATE" "$RUN" "$root/fake"
PLIST="$H/Library/LaunchAgents/com.praesidium.hrc-server.plist"
OWNER_ROOT="$H/praesidium/var/hrc-owner"
OWNER_EXE="$OWNER_ROOT/bin/rusthrc"
LOG="$H/praesidium/var/logs/hrc-runtime/rusthrc-owner.log"
DB="$STATE/state.sqlite"
BUNLOG="$root/bun-calls.log"
JUSTLOG="$root/just-calls.log"
: >"$BUNLOG"
results="$out/result.jsonl"
: >"$results"
transcript="$out/transcript.log"
: >"$transcript"
pass=0
failn=0

say() { printf '\n=== %s\n' "$*" | tee -a "$transcript"; }
record() { # case pass(0|1) detail-json
  jq -cn --arg case "$1" --argjson pass "$2" --argjson detail "$3" '{case: $case, pass: ($pass == 1), detail: $detail}' >>"$results"
  if (($2)); then pass=$((pass + 1)); echo "PASS $1" | tee -a "$transcript"; else failn=$((failn + 1)); echo "FAIL $1: $3" | tee -a "$transcript"; fi
}

# ---- fakes ------------------------------------------------------------------
cat >"$H/.bun/bin/bun" <<EOF
#!/bin/bash
printf '%s\tppid=%s\tparent=%s\targv=%s\n' "\$(date -u +%FT%TZ)" "\$PPID" "\$(ps -o command= -p \$PPID | cut -c1-160)" "\$*" >>"$BUNLOG"
exit 1
EOF
cp "$H/.bun/bin/bun" "$root/fake/bun"
cat >"$root/fake/ssh" <<'EOF'
#!/bin/bash
args=("$@"); i=0
while [[ "${args[i]}" == -o ]]; do i=$((i + 2)); done
i=$((i + 1)) # the target
rest=("${args[@]:i}")
if [[ "${rest[0]:-} ${rest[1]:-} ${rest[2]:-}" == 'bash -s --' ]]; then
  case "${rest[3]:-}" in
    kind | log-path | schema-state | stage | log-mark | boot-check | refresh-plist)
      cd / && exec bash -s -- "${rest[@]:3}" ;;
  esac
  cat >/dev/null
  printf '%s\n' 'DEPLOY_RESTART_NEEDED=1' "DEPLOY_TARGET_SHA=$E2E_SHA" 'DEPLOY_ASPD_SHA=e2e-aspd' 'DEPLOY_ASPD_RELEASE=e2e-aspd-release'
  exit 0
fi
cat >/dev/null
EOF
cat >"$root/fake/just" <<EOF
#!/bin/bash
echo "\$*" >>"$JUSTLOG"
[[ "\$1" == _node-readback ]]
EOF
cat >"$root/fake/hrc" <<'EOF'
#!/bin/bash
# launchd stand-in for `hrc server restart`.
set -u
[[ "$1 $2" == 'server restart' ]] || { echo "fake hrc: unexpected $*" >&2; exit 2; }
plist="$HOME/Library/LaunchAgents/com.praesidium.hrc-server.plist"
pidfile="$HOME/daemon.pid"
if [[ -f "$pidfile" ]]; then
  old="$(cat "$pidfile")"
  kill -TERM "$old" 2>/dev/null || true
  for _ in $(seq 1 300); do kill -0 "$old" 2>/dev/null || break; sleep 0.1; done
  rm -f "$pidfile"
fi
argv=(); envv=()
while IFS= read -r a; do argv+=("$a"); done < <(plutil -extract ProgramArguments json -o - "$plist" | jq -r '.[]')
while IFS= read -r a; do envv+=("$a"); done < <(plutil -extract EnvironmentVariables json -o - "$plist" | jq -r 'to_entries[] | "\(.key)=\(.value)"')
log="$(plutil -extract StandardOutPath raw -o - "$plist")"
sock="$(plutil -extract EnvironmentVariables.HRC_RUNTIME_DIR raw -o - "$plist")/hrc.sock"
for attempt in 1 2 3; do
  env -i "${envv[@]}" "${argv[@]}" >>"$log" 2>&1 &
  pid=$!
  for _ in $(seq 1 300); do
    if ! kill -0 "$pid" 2>/dev/null; then break; fi
    if curl -sf --max-time 2 --unix-socket "$sock" http://localhost/v1/health >/dev/null 2>&1; then
      echo "$pid" >"$pidfile"
      echo "restart proven: healthy new process pid $pid (attempt $attempt)"
      exit 0
    fi
    sleep 0.1
  done
  kill -TERM "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
  echo "[fake launchd] boot attempt $attempt exited; KeepAlive throttle" >&2
  sleep 1
done
echo 'restart_unproven: no healthy new process within 120000ms' >&2
exit 1
EOF
chmod +x "$H/.bun/bin/bun" "$root/fake/"*

cat >"$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>EnvironmentVariables</key>
	<dict>
		<key>HOME</key>
		<string>$H</string>
		<key>HRC_ACP_WEBHOOK_URL</key>
		<string></string>
		<key>HRC_PEER_CONFIG_FILE</key>
		<string>$root/absent-peers.json</string>
		<key>HRC_RUNTIME_DIR</key>
		<string>$RUN</string>
		<key>HRC_STATE_DIR</key>
		<string>$STATE</string>
		<key>HRC_WRKQ_DB</key>
		<string>$root/wrkq.db</string>
		<key>PATH</key>
		<string>$root/fake:/usr/bin:/bin:/usr/sbin:/sbin</string>
		<key>WRKQ_DB</key>
		<string>$root/wrkq.db</string>
	</dict>
	<key>Label</key>
	<string>com.praesidium.hrc-server</string>
	<key>ProgramArguments</key>
	<array>
		<string>$OWNER_EXE</string>
		<string>server</string>
		<string>serve</string>
	</array>
	<key>StandardErrorPath</key>
	<string>$LOG</string>
	<key>StandardOutPath</key>
	<string>$LOG</string>
</dict>
</plist>
EOF
plutil -lint -s "$PLIST"

# A scratch "just install": a release dir with a manifest naming this commit.
n=0
install_release() { # build-name -> sets $rel_id
  n=$((n + 1))
  local id rel
  id="release-2026111000000${n}000-$n"
  rel="$H/.bun/install/hrc-runtime-releases/$id"
  mkdir -p "$rel/bin"
  cp -p "$bins/rusthrc-$1" "$rel/bin/rusthrc"
  jq -n --arg id "$id" --arg sha "$sha" --arg now "$(date -u +%FT%T.000Z)" '{
    schema: 1, releaseId: $id,
    hrcBuild: {schema: 1, repository: "hrc-runtime", canonicalRemote: "git@github.com:lherron/hrc-runtime.git",
      sourceCommit: $sha, setName: "hrc", setVersion: "0.0.0-t13056", builtAt: $now},
    aspContracts: [{name: "agent-scope", version: "0.0.0-t13056"}], installedAt: $now}' >"$rel/praesidium-release.json"
  ln -sfh "$rel" "$H/.bun/install/hrc-runtime-current"
  rel_id="$id"
}

export HOME="$H" E2E_SHA="$sha"
export PATH="$root/fake:/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin"
owner() { (cd / && bash -s -- "$@" <"$repo/scripts/hrc-owner.sh"); }
deploy() { # restart publication -> recipe exit code; output in $root/deploy.{out,err}
  local rc=0
  "$real_just" --justfile "$repo/justfile" _deploy-node scratch scratch "$sha" e2e-aspd pin "$1" "$2" \
    >"$root/deploy.out" 2>"$root/deploy.err" || rc=$?
  { echo "--- stdout"; cat "$root/deploy.out"; echo "--- stderr"; cat "$root/deploy.err"; echo "--- exit $rc"; } >>"$transcript"
  return "$rc"
}
# Verification reads: Python's SQLite on a copy of the main file and its WAL,
# so the store under test is never opened by the checker (macOS sqlite3 and
# Python cannot open a WAL store read-only while its -shm is absent).
q() { python3 -I -c 'import os, shutil, sqlite3, sys, tempfile
d = tempfile.mkdtemp(prefix="t13056-q-", dir="/tmp")
shutil.copy(sys.argv[1], d + "/db")
if os.path.exists(sys.argv[1] + "-wal"): shutil.copy(sys.argv[1] + "-wal", d + "/db-wal")
c = sqlite3.connect(d + "/db")
for row in c.execute(sys.argv[2]): print("|".join(map(str, row)))
c.close(); shutil.rmtree(d)' "$1" "$2"; }
ids() { q "$1" 'SELECT id FROM hrc_migrations ORDER BY id'; }
count() { q "$1" "$2"; }
backups() { find "$STATE/backups" -name 'pre-activate-*.sqlite' 2>/dev/null | sort; }
daemon_pid() { cat "$H/daemon.pid" 2>/dev/null || true; }
current_release() { basename "$(readlink "$OWNER_ROOT/hrc-runtime-current" 2>/dev/null)"; }
opened_db() { lsof -a -p "$1" -Fn 2>/dev/null | sed -n 's/^n//p' | grep -E 'state\.sqlite$' | head -1; }
log_since() { tail -c "+$(($1 + 1))" "$LOG" | jq -Rc 'fromjson? | select(type == "object")'; }
cleanup() {
  local pid
  pid="$(daemon_pid)"
  [[ -z "$pid" ]] || kill -TERM "$pid" 2>/dev/null || true
  chmod -R u+w "$root" 2>/dev/null || true
  [[ -z "${dmg_mount:-}" ]] || hdiutil detach -quiet "$dmg_mount" 2>/dev/null || true
}
trap cleanup EXIT

# ---- boot: base release, store created by the scratch verb, daemon on it ----
say "setup: base release, scratch store, scratch daemon"
install_release base
"$bins/rusthrc-base" store migrate "$DB" | tee -a "$transcript"
owner stage --expect-commit "$sha" >>"$transcript" 2>&1
hrc server restart --node scratch --force --reason setup >>"$transcript" 2>&1
pid0="$(daemon_pid)"
record setup_daemon_on_scratch_store "$([[ -n "$pid0" && "$(opened_db "$pid0")" == "$DB" ]] && echo 1 || echo 0)" \
  "$(jq -cn --arg pid "$pid0" --arg opened "$(opened_db "$pid0")" --arg db "$DB" '{pid: $pid, opened: $opened, expected: $db}')"

# ---- schema-state is read-only and never answers current for what it cannot read
say "schema-state read-only readings"
alt="$root/alt"
mkdir -p "$alt/state"
sed "s|<string>$STATE</string>|<string>$alt/state</string>|" "$PLIST" >"$alt/plist"
a1="$(HRC_OWNER_PLIST="$alt/plist" owner schema-state --exe "$bins/rusthrc-base" 2>/dev/null)"
created="$(ls -A "$alt/state")"
echo garbage >"$alt/state/state.sqlite"
a2="$(HRC_OWNER_PLIST="$alt/plist" owner schema-state --exe "$bins/rusthrc-base" 2>/dev/null)"
rm "$alt/state/state.sqlite"
cp "$DB" "$alt/state/state.sqlite"
before="$(shasum -a 256 "$alt/state/state.sqlite" | cut -d' ' -f1)"
a3="$(HRC_OWNER_PLIST="$alt/plist" owner schema-state --exe "$bins/rusthrc-ok" 2>/dev/null)"
after="$(shasum -a 256 "$alt/state/state.sqlite" | cut -d' ' -f1)"
a4="$(HRC_OWNER_PLIST="$alt/plist" owner schema-state --exe "$repo/../nonexistent-rusthrc" 2>/dev/null || echo refused)"
record schema_state_read_only "$([[ "$a1" == absent && -z "$created" && "$a2" == unreadable && "$a3" == pending && "$before" == "$after" && "$a4" == refused ]] && echo 1 || echo 0)" \
  "$(jq -cn --arg missing "$a1" --arg created "$created" --arg garbage "$a2" --arg pendingCopy "$a3" --arg before "$before" --arg after "$after" --arg noexe "$a4" \
    '{missingStore: $missing, filesCreated: $created, garbageStore: $garbage, pendingCopy: $pendingCopy, mainFileUnchanged: ($before == $after), missingExe: $noexe}')"

# ---- A: nothing pending: no backup, staged, restarted ----------------------
say "A: nothing pending (restart=wait, no-publish)"
install_release base; r_a="$rel_id"
: >"$JUSTLOG"
rc=0; deploy wait no-publish || rc=$?
pid_a="$(daemon_pid)"
record nothing_pending_no_backup_staged_restarted "$([[ $rc == 0 && -z "$(backups)" && "$(current_release)" == "$r_a" && -n "$pid_a" && "$pid_a" != "$pid0" ]] &&
  ! grep -q 'backup' "$root/deploy.out" && grep -q '_node-readback' "$JUSTLOG" && grep -q 'boot-check\] ok' "$root/deploy.out" && echo 1 || echo 0)" \
  "$(jq -cn --argjson rc "$rc" --arg backups "$(backups)" --arg cur "$(current_release)" --arg want "$r_a" --arg pid "$pid_a" --arg old "$pid0" \
    '{exit: $rc, backups: $backups, staged: $cur, expected: $want, pid: $pid, previousPid: $old}')"

# ---- C: failing migration ---------------------------------------------------
say "C: failing migration (restart=force)"
ids_before="$(ids "$DB" | shasum | cut -c1-12)"
install_release fail
: >"$JUSTLOG"
mark="$(stat -f %z "$LOG")"
rc=0; deploy force no-publish || rc=$?
fails="$(log_since "$mark" | jq -c 'select(.event == "store.migration_failed")' | wc -l | tr -d ' ')"
fail_path="$(log_since "$mark" | jq -r 'select(.event == "store.migration_failed") | .data.path' | head -1)"
ids_after="$(ids "$DB" | shasum | cut -c1-12)"
table="$(count "$DB" "SELECT count(*) FROM sqlite_master WHERE name='t13056_scratch'")"
record failing_migration_fails_the_deploy_naming_the_cause "$([[ $rc != 0 && "$ids_before" == "$ids_after" && "$table" == 0 && "$fails" -ge 2 && "$fail_path" == "$DB" ]] &&
  grep -q 'store.migration_failed: 0132_t13056_scratch_fail' "$root/deploy.err" && ! grep -q '_node-readback' "$JUSTLOG" 2>/dev/null && echo 1 || echo 0)" \
  "$(jq -cn --argjson rc "$rc" --arg before "$ids_before" --arg after "$ids_after" --arg table "$table" --arg fails "$fails" --arg path "$fail_path" \
    --arg err "$(grep 'boot-check' "$root/deploy.err" | head -2)" \
    '{exit: $rc, migrationSetUnchanged: ($before == $after), testTable: $table, failedBoots: $fails, failedPath: $path, report: $err}')"
# Recovery: the previous build (the base release) admits the store; deploying it
# through the same recipe brings the node back.
install_release base
rc=0; deploy wait no-publish || rc=$?
pid_back="$(daemon_pid)"
record previous_build_admits_after_failed_migration "$([[ $rc == 0 && -n "$pid_back" && "$(opened_db "$pid_back")" == "$DB" && "$("$bins/rusthrc-base" store state "$DB" | jq -r .state)" == current ]] && echo 1 || echo 0)" \
  "$(jq -cn --argjson rc "$rc" --arg pid "$pid_back" --arg opened "$(opened_db "$pid_back")" '{exit: $rc, pid: $pid, opened: $opened}')"

# ---- E: backup cannot be written: refused before the stage -----------------
say "E: backups dir not writable (pending)"
install_release ok
before_link="$(current_release)"; before_pid="$(daemon_pid)"; before_exe="$(shasum "$OWNER_EXE" | cut -c1-12)"
nb_before="$(backups | wc -l | tr -d ' ')"
mkdir -p "$STATE/backups"; chmod 500 "$STATE/backups"
: >"$JUSTLOG"
rc=0; deploy wait no-publish || rc=$?
chmod 700 "$STATE/backups"
record unwritable_backup_refused_before_stage "$([[ $rc != 0 && "$(current_release)" == "$before_link" && "$(daemon_pid)" == "$before_pid" && "$(shasum "$OWNER_EXE" | cut -c1-12)" == "$before_exe" && "$(backups | wc -l | tr -d ' ')" == "$nb_before" ]] &&
  grep -q 'backup of .* failed; nothing staged' "$root/deploy.err" && ! grep -q '_node-readback' "$JUSTLOG" 2>/dev/null && echo 1 || echo 0)" \
  "$(jq -cn --argjson rc "$rc" --arg link "$(current_release)" --arg want "$before_link" --arg err "$(grep FAIL "$root/deploy.err" | head -1)" '{exit: $rc, staged: $link, expectedUnchanged: $want, refusal: $err}')"

# ---- F: not enough free space: refused before writing anything -------------
say "F: backups volume too small (pending)"
dmg="$root/small.dmg"
dmg_mount=""
if hdiutil create -quiet -size 20m -fs HFS+ -volname t13056 "$dmg" && hdiutil attach -quiet -nobrowse -mountpoint "$root/small" "$dmg"; then
  dmg_mount="$root/small"
  mv "$STATE/backups" "$root/backups.real"
  ln -s "$dmg_mount" "$STATE/backups"
  rc=0; deploy wait no-publish || rc=$?
  written="$(find "$dmg_mount" -name 'pre-activate-*' | wc -l | tr -d ' ')"
  rm "$STATE/backups"; mv "$root/backups.real" "$STATE/backups"
  hdiutil detach -quiet "$dmg_mount"; dmg_mount=""
  record low_free_space_refused_before_writing "$([[ $rc != 0 && "$written" == 0 && "$(current_release)" == "$before_link" && "$(daemon_pid)" == "$before_pid" ]] &&
    grep -q 'backup needs .* KiB free' "$root/deploy.err" && echo 1 || echo 0)" \
    "$(jq -cn --argjson rc "$rc" --arg written "$written" --arg err "$(grep FAIL "$root/deploy.err" | head -1)" '{exit: $rc, filesWritten: $written, refusal: $err}')"
else
  record low_free_space_refused_before_writing 0 '"hdiutil could not make the small volume"'
fi

# ---- B: pending: backup, staged, migrated by the daemon at boot, current ----
say "B: pending (restart=force, publish)"
events_before="$(count "$DB" "SELECT count(*) FROM hrc_events WHERE event_kind='store.migrated'")"
seq_before="$(count "$DB" "SELECT seq FROM sqlite_sequence WHERE name='hrc_events'")"
inc_before="$(count "$DB" 'SELECT ledger_incarnation_id FROM hrc_event_ledger_metadata')"
old_backups="$(backups)"
: >"$JUSTLOG"
mark="$(stat -f %z "$LOG")"
rc=0; deploy force publish || rc=$?
pid_b="$(daemon_pid)"
bk="$(backups)"
bk_n="$(printf '%s\n' "$bk" | grep -c . || true)"
bk_check="$( [[ -n "$bk" ]] && q "$bk" 'PRAGMA quick_check' || echo none)"
bk_ids="$( [[ -n "$bk" ]] && ids "$bk" | wc -l | tr -d ' ' || echo 0)"
bk_has_new="$( [[ -n "$bk" ]] && ids "$bk" | grep -c 0132 || true)"
store_has_new="$(ids "$DB" | grep -c '^0132_t13056_scratch_ok$' || true)"
events_after="$(count "$DB" "SELECT count(*) FROM hrc_events WHERE event_kind='store.migrated'")"
seq_after="$(count "$DB" "SELECT seq FROM sqlite_sequence WHERE name='hrc_events'")"
inc_after="$(count "$DB" 'SELECT ledger_incarnation_id FROM hrc_event_ledger_metadata')"
boot_migrated="$(log_since "$mark" | jq -c 'select(.event == "store.migrated") | .data' | tail -1)"
listen_after="$(log_since "$mark" | jq -r 'select(.event == "store.migrated" or .event == "server.listening") | .event' | paste -sd, -)"
readback="$(owner schema-state --exe "$OWNER_EXE" 2>/dev/null)"
record pending_backup_then_daemon_migrates_at_boot "$([[ $rc == 0 && "$bk_n" == 1 && "$bk_check" == ok && "$bk_ids" == 109 && "$bk_has_new" == 0 && "$store_has_new" == 1 &&
  "$events_after" == $((events_before + 1)) && "$inc_before" == "$inc_after" && "$seq_after" -gt "$seq_before" && "$(jq -r .path <<<"$boot_migrated")" == "$DB" &&
  "$listen_after" == store.migrated,server.listening* && "$readback" == current && "$(opened_db "$pid_b")" == "$DB" ]] &&
  grep -q 'pruned older backup' "$root/deploy.out" && grep -q '_node-readback scratch scratch' "$JUSTLOG" && echo 1 || echo 0)" \
  "$(jq -cn --argjson rc "$rc" --arg bk "$bk" --arg old "$old_backups" --arg check "$bk_check" --arg bkids "$bk_ids" --arg bknew "$bk_has_new" --arg storenew "$store_has_new" \
    --arg eb "$events_before" --arg ea "$events_after" --arg sb "$seq_before" --arg sa "$seq_after" --arg incsame "$([[ "$inc_before" == "$inc_after" ]] && echo true || echo false)" \
    --argjson booted "${boot_migrated:-null}" --arg order "$listen_after" --arg readback "$readback" --arg opened "$(opened_db "$pid_b")" \
    '{exit: $rc, backup: $bk, olderBackupsBefore: $old, backupQuickCheck: $check, backupIds: $bkids, backupHasNewId: $bknew, storeHasNewId: $storenew,
      storeMigratedRows: [$eb, $ea], hrcEventsSeq: [$sb, $sa], incarnationUnchanged: $incsame, bootLine: $booted, bootOrder: $order,
      readback: $readback, daemonOpened: $opened}')"

# ---- D: ahead: refused before the backup ------------------------------------
say "D: ahead (a build without 0132 on the migrated store)"
install_release base
before_link="$(current_release)"; before_pid="$(daemon_pid)"; bk_before="$(backups)"
: >"$JUSTLOG"
rc=0; deploy wait no-publish || rc=$?
record ahead_refused_before_backup "$([[ $rc != 0 && "$(backups)" == "$bk_before" && "$(current_release)" == "$before_link" && "$(daemon_pid)" == "$before_pid" ]] &&
  grep -q 'installed schema is ahead; refusing the deploy before any backup or stage' "$root/deploy.err" && ! grep -q '_node-readback' "$JUSTLOG" 2>/dev/null && echo 1 || echo 0)" \
  "$(jq -cn --argjson rc "$rc" --arg err "$(grep -E 'ahead' "$root/deploy.err" | head -2)" '{exit: $rc, refusal: $err}')"
# stage itself refuses the same, whoever calls it.
rc=0; owner stage --expect-commit "$sha" >"$root/stage.out" 2>&1 || rc=$?
cat "$root/stage.out" >>"$transcript"
record stage_refuses_ahead_itself "$([[ $rc != 0 && "$(backups)" == "$bk_before" && "$(current_release)" == "$before_link" ]] && grep -q 'store schema is ahead' "$root/stage.out" && echo 1 || echo 0)" \
  "$(jq -cn --argjson rc "$rc" --arg out "$(grep FAIL "$root/stage.out")" '{exit: $rc, refusal: $out}')"

# ---- remaining owner commands still work (nothing the switch path removed) --
say "kept commands: kind, log-path, refresh-plist --dry-run"
k="$(owner kind)"; lp="$(owner log-path)"; rp="$(owner refresh-plist --dry-run 2>&1 | tail -1)"
record kept_commands_work "$([[ "$k" == rusthrc && "$lp" == "$LOG" && "$rp" == REFRESH_NEEDED=0 ]] && echo 1 || echo 0)" \
  "$(jq -cn --arg kind "$k" --arg log "$lp" --arg refresh "$rp" '{kind: $kind, logPath: $log, refreshPlist: $refresh}')"
gone="$(for c in preflight prepare render activate; do owner "$c" >/dev/null 2>&1 && echo "$c"; done || true)"
record switch_commands_removed "$([[ -z "$gone" ]] && echo 1 || echo 0)" "$(jq -cn --arg still "$gone" '{stillAccepted: $still}')"

# ---- bun: the sentinel saw only the release prune (scripts/hrc-owner.sh stage) --
say "bun sentinel"
cat "$BUNLOG" >>"$transcript"
calls="$(grep -c . "$BUNLOG" || true)"
other="$(grep -v $'\targv=run - '"$OWNER_ROOT"'/hrc-runtime-releases/release-[^ ]* '"$OWNER_ROOT"'/hrc-runtime-releases '"$OWNER_ROOT"'/hrc-runtime-current ' "$BUNLOG" || true)"
record no_bun_outside_the_release_prune "$([[ -z "$other" ]] && echo 1 || echo 0)" \
  "$(jq -cn --arg calls "$calls" --arg other "$other" '{bunCalls: $calls, callsOtherThanStageReleasePrune: $other, note: "every call is prune_owner_releases in stage (out of scope); none in schema-state, backup, restart or boot"}')"

cp "$LOG" "$out/rusthrc-owner.log"
cp "$BUNLOG" "$out/bun-calls.log"
jq -s --arg sha "$sha" --arg root "$root" --argjson pass "$pass" --argjson fail "$failn" \
  '{task: "T-13056", sourceCommit: $sha, scratchRoot: $root, pass: $pass, fail: $fail, verdict: (if $fail == 0 then "PASS" else "FAIL" end), cases: .}' \
  "$results" >"$out/result.json"
echo "[e2e] $(jq -r .verdict "$out/result.json"): $pass pass, $failn fail; $out/result.json"
if ((failn == 0)); then
  cleanup
  trap - EXIT
  [[ "$root" == /private/tmp/t13056-e2e.* ]] && rm -rf "$root"
  exit 0
fi
echo "[e2e] scratch kept: $root"
exit 1
