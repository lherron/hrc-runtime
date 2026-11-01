#!/usr/bin/env bash
# Headless proof of the HRC owner's stable code identity (T-12224), on a
# TEMPORARY keychain: no login keychain, trust setting or dialog is touched.
#
#   scripts/hrc-owner-codesign-e2e.sh [--out <dir>] [--scratch <dir>] <old-release> <release-b> <release-c>
#
# Each release is an atomic release dir (release-*/ with praesidium-release.json
# and bin/rusthrc), for example ~/.bun/install/hrc-runtime-releases/release-*.
# <old-release> may predate the fixed owner exe; <release-b> and <release-c>
# must ship it (their rusthrc resolves its release from <owner>/bin/rusthrc).
# The three must share the store schema of <release-b>, which migrates the
# scratch store.
#
# It runs the real scripts/macos-codesign-identity.sh and scripts/hrc-owner.sh
# against a scratch OWNER_ROOT, a scratch owner plist (never loaded into
# launchd) and a scratch store, and starts the fixed exe as a scratch daemon.
# Failure modes it rules out:
#   - create needs a pre-made or login keychain, or a console (it must make
#     the signing keychain, a 0600 password file and the search-list entry)
#   - stage signs with a same-named certificate from another keychain (a
#     decoy keychain holds one, as mini's login keychain does)
#   - the fixed exe is a symlink, or is signed/written in place
#   - the signature is ad-hoc or carries a per-build cdhash requirement
#   - two builds signed by the identity get different designated requirements,
#     or one build does not satisfy the other's requirement
#   - no identity configured breaks stage instead of keeping ad-hoc
#   - the fixed exe reports itself unmanaged, or names the wrong release,
#     including after a rollback
#   - refresh-plist changes more than the exec path, or moves a plist onto a
#     build that cannot run from the fixed exe
#   - staging a pre-fixed-exe build under a refreshed plist replaces the exe
# Output: <out>/transcript.log and <out>/result.json.
set -euo pipefail

repo="$(cd "$(dirname "$0")/.." && pwd)"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
out="$HOME/praesidium/var/wrkq-artifacts/T-12224/e2e-$stamp"
scratch="$HOME/praesidium/var/scratch/hrc-runtime/T-12224/e2e-$stamp"
releases=()
while (($#)); do
  case "$1" in
    --out) out="$2"; shift ;;
    --scratch) scratch="$2"; shift ;;
    -*) echo "unknown option $1" >&2; exit 2 ;;
    *) releases+=("$(cd "$1" && pwd -P)") ;;
  esac
  shift
done
((${#releases[@]} == 3)) || { sed -n '5,13p' "$0" >&2; exit 2; }
[[ ! -e "$scratch" ]] || { echo "scratch $scratch must not exist" >&2; exit 2; }
mkdir -p "$out" "$scratch"
exec > >(tee "$out/transcript.log") 2>&1

OLD="${releases[0]}" B="${releases[1]}" C="${releases[2]}"
NAME="HRC E2E Code Signing $$"
KC="$scratch/e2e.keychain-db"
KC_PWFILE="$scratch/codesign/e2e.keychain.password"
DECOY="$scratch/decoy.keychain-db"
DECOY_PWFILE="$scratch/codesign/decoy.keychain.password"
OWNER="$scratch/owner"
PLIST="$scratch/LaunchAgents/com.praesidium.hrc-server.plist"
FIXED="$OWNER/bin/rusthrc"
passes=0
results=()
daemon_pid=""
orig_keychains=()

log() { printf '\n== %s\n' "$*"; }
pass() { passes=$((passes + 1)); results+=("PASS $*"); echo "PASS $*"; }
die() {
  results+=("FAIL $*")
  echo "FAIL $*"
  exit 1
}
check() { local what="$1"; shift; if "$@"; then pass "$what"; else die "$what"; fi; }
show() { printf '$ %s\n' "$*"; "$@"; }

cleanup() {
  local rc=$?
  set +e
  [[ -n "$daemon_pid" ]] && kill "$daemon_pid" 2>/dev/null && wait "$daemon_pid" 2>/dev/null
  if ((${#orig_keychains[@]})); then
    security list-keychains -d user -s "${orig_keychains[@]}"
    echo "[cleanup] keychain search list restored: $(security list-keychains -d user | tr -d '"' | paste -sd ' ' -)"
  fi
  [[ -f "$KC" ]] && security delete-keychain "$KC" && echo "[cleanup] deleted temporary keychain $KC"
  [[ -f "$DECOY" ]] && security delete-keychain "$DECOY" && echo "[cleanup] deleted decoy keychain $DECOY"
  local verdict=FAIL
  ((rc == 0)) && verdict=PASS
  {
    printf '{"task":"T-12224","verdict":"%s","passes":%d,"releases":["%s","%s","%s"],"checks":[' "$verdict" "$passes" "$OLD" "$B" "$C"
    local first=1 r
    for r in ${results[@]+"${results[@]}"}; do
      ((first)) || printf ','
      first=0
      jq -Rn --arg r "$r" '$r'
    done
    printf ']}\n'
  } | jq . > "$out/result.json"
  echo "[e2e] $verdict ($passes checks); $out/result.json"
  if ((rc == 0)); then rm -rf "$scratch"; else echo "[e2e] scratch kept: $scratch"; fi
}
trap cleanup EXIT

manifest() { jq -r "$2" "$1/praesidium-release.json"; }
owner() {
  env -i HOME="$HOME" PATH="/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:$HOME/.bun/bin" TMPDIR="$scratch/" \
    OWNER_ROOT="$OWNER" HRC_OWNER_PLIST="$PLIST" INSTALLED_LINK="$scratch/installed" \
    PRAESIDIUM_CODESIGN_KEYCHAIN="$KC" PRAESIDIUM_CODESIGN_KEYCHAIN_PASSWORD_FILE="$KC_PWFILE" "$@"
}
select_release() { ln -sfh "$1" "$scratch/installed"; }
dr_of() { codesign -dr - "$1" 2>/dev/null | sed -n 's/^#* *designated => //p'; }
cdhash_of() { codesign -dvvv "$1" 2>&1 | sed -n 's/^CDHash=//p'; }
plist_exe() { plutil -extract ProgramArguments.0 raw -o - "$PLIST"; }

log "inputs"
for r in "$OLD" "$B" "$C"; do echo "$(basename "$r") sourceCommit $(manifest "$r" .hrcBuild.sourceCommit)"; done

log "temporary keychain $KC"
while IFS= read -r k; do
  k="${k#"${k%%[![:space:]]*}"}"
  k="${k#\"}"
  orig_keychains+=("${k%\"}")
done < <(security list-keychains -d user)

log "decoy keychain $DECOY: a same-named certificate elsewhere in the search list"
show bash "$repo/scripts/macos-codesign-identity.sh" create --keychain "$DECOY" --password-file "$DECOY_PWFILE" --name "$NAME"
DECOY_HASH="$(security find-identity -p codesigning "$DECOY" | awk -v q="\"$NAME\"" 'index($0, q) && $1 ~ /^[0-9]+\)$/ { print $2; exit }')"
echo "decoy identity $DECOY_HASH"

log "identity via macos-codesign-identity.sh create: it makes the keychain, password file and search-list entry"
idscript() { bash "$repo/scripts/macos-codesign-identity.sh" "$@" --keychain "$KC" --password-file "$KC_PWFILE" --name "$NAME"; }
show idscript create
check "create made the signing keychain" test -f "$KC"
check "password file is mode 0600" test "$(stat -f %Lp "$KC_PWFILE")" == 600
check "signing keychain is in the user search list" grep -qxF "$KC" < <(security list-keychains -d user | sed -e 's/^[[:space:]]*"//' -e 's/"[[:space:]]*$//')
check "decoy keychain is still in the search list" grep -qxF "$DECOY" < <(security list-keychains -d user | sed -e 's/^[[:space:]]*"//' -e 's/"[[:space:]]*$//')
status="$(OWNER_ROOT="$OWNER" idscript status --sign-probe)"
echo "$status"
check "identity present in the temporary keychain" grep -q '^IDENTITY=present ' <<<"$status"
check "sign probe uses the identity without a dialog" grep -q '^SIGN_PROBE=ok identifier "com.praesidium.codesign-probe" and certificate leaf = H"' <<<"$status"
second="$(idscript create)"
echo "$second"
check "create is idempotent (second run skips the import)" grep -q '1/4 skip: certificate' <<<"$second"

log "scratch store and owner plist"
mkdir -p "$scratch/state" "$scratch/run" "$scratch/LaunchAgents" "$scratch/tmux"
(cd "$B" && bun -e 'import {openHrcDatabase} from "./packages/hrc-store-sqlite/src/database.ts"; openHrcDatabase(process.argv[1]).close()' "$scratch/state/state.sqlite")
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>EnvironmentVariables</key>
	<dict>
		<key>HRC_LAUNCHD_LABEL</key>
		<string>com.praesidium.hrc-server</string>
		<key>HRC_RUNTIME_DIR</key>
		<string>$scratch/run</string>
		<key>HRC_STATE_DIR</key>
		<string>$scratch/state</string>
	</dict>
	<key>Label</key>
	<string>com.praesidium.hrc-server</string>
	<key>ProgramArguments</key>
	<array>
		<string>$OWNER/hrc-runtime-current/bin/rusthrc</string>
		<string>server</string>
		<string>serve</string>
	</array>
	<key>StandardErrorPath</key>
	<string>$scratch/rusthrc-owner.log</string>
	<key>StandardOutPath</key>
	<string>$scratch/rusthrc-owner.log</string>
</dict>
</plist>
EOF
plutil -lint "$PLIST"

log "ad-hoc fallback: no identity configured"
select_release "$OLD"
adhoc="$(owner OWNER_ROOT="$scratch/owner-adhoc" bash "$repo/scripts/hrc-owner.sh" stage --expect-commit "$(manifest "$OLD" .hrcBuild.sourceCommit)")"
echo "$adhoc"
check "stage without identity says it keeps ad-hoc" grep -q "keeps the linker's ad-hoc signature" <<<"$adhoc"
check "ad-hoc fixed exe is a regular file" test -f "$scratch/owner-adhoc/bin/rusthrc" -a ! -L "$scratch/owner-adhoc/bin/rusthrc"
show codesign -dvv "$scratch/owner-adhoc/bin/rusthrc"
check "ad-hoc fixed exe is ad-hoc signed" grep -q '^Signature=adhoc' < <(codesign -dvv "$scratch/owner-adhoc/bin/rusthrc" 2>&1)
check "ad-hoc designated requirement is a cdhash" grep -q '^cdhash H"' <<<"$(dr_of "$scratch/owner-adhoc/bin/rusthrc")"

log "signed stage of the old release (identity from HRC_CODESIGN_IDENTITY)"
select_release "$OLD"
staged="$(owner HRC_CODESIGN_IDENTITY="$NAME" bash "$repo/scripts/hrc-owner.sh" stage --expect-commit "$(manifest "$OLD" .hrcBuild.sourceCommit)")"
echo "$staged"
check "fixed exe is a regular file, not a symlink" test -f "$FIXED" -a ! -L "$FIXED"
show codesign -dvv "$FIXED"
check "Identifier=com.praesidium.rusthrc" grep -qx 'Identifier=com.praesidium.rusthrc' < <(codesign -dvv "$FIXED" 2>&1)
check "the identity is the signing authority" grep -qx "Authority=$NAME" < <(codesign -dvv "$FIXED" 2>&1)
DR="$(dr_of "$FIXED")"
echo "designated => $DR"
[[ "$DR" =~ ^identifier\ \"com\.praesidium\.rusthrc\"\ and\ certificate\ leaf\ =\ H\"[0-9a-f]{40}\"$ ]] &&
  pass "designated requirement is identifier + certificate leaf, no cdhash" || die "designated requirement is $DR"
KC_HASH="$(security find-identity -p codesigning "$KC" | awk -v q="\"$NAME\"" 'index($0, q) && $1 ~ /^[0-9]+\)$/ { print $2; exit }')"
leaf="$(sed -n 's/.*certificate leaf = H"\([0-9a-f]*\)".*/\1/p' <<<"$DR")"
check "signed by the signing keychain's certificate, not the same-named decoy" \
  test "$leaf" == "$(tr 'A-F' 'a-f' <<<"$KC_HASH")" -a "$leaf" != "$(tr 'A-F' 'a-f' <<<"$DECOY_HASH")"
cp -p "$FIXED" "$scratch/signed-old"
old_cdhash="$(cdhash_of "$FIXED")"
if grep -q 'predates the fixed owner exe' <<<"$staged"; then
  pass "stage warns that the old release predates the fixed exe"
  log "refresh-plist refuses a fixed exe that cannot resolve its release"
  if owner bash "$repo/scripts/hrc-owner.sh" refresh-plist; then die "refresh-plist accepted a pre-fixed-exe build"; fi
  check "plist still execs the release link" test "$(plist_exe)" == "$OWNER/hrc-runtime-current/bin/rusthrc"
fi

log "signed stage of release B (identity from \$OWNER_ROOT/codesign.identity)"
printf '%s\n' "$NAME" > "$OWNER/codesign.identity"
select_release "$B"
show owner bash "$repo/scripts/hrc-owner.sh" stage --expect-commit "$(manifest "$B" .hrcBuild.sourceCommit)"
check "fixed exe is still a regular file" test -f "$FIXED" -a ! -L "$FIXED"
show codesign -dvvv "$FIXED"
b_cdhash="$(cdhash_of "$FIXED")"
check "release B is a different build (cdhash $old_cdhash vs $b_cdhash)" test "$old_cdhash" != "$b_cdhash"
check "release B keeps the SAME designated requirement" test "$(dr_of "$FIXED")" == "$DR"
check "codesign --verify -R <DR> passes for release B" codesign --verify --strict -R "=$DR" "$FIXED"
check "codesign --verify -R <DR> passes for the old build" codesign --verify --strict -R "=$DR" "$scratch/signed-old"
cp -p "$FIXED" "$scratch/signed-b"

log "refresh-plist: the one-time move to the fixed exe"
before="$(plutil -convert json -o - "$PLIST" | jq -S .)"
dry="$(owner bash "$repo/scripts/hrc-owner.sh" refresh-plist --dry-run)"
echo "$dry"
check "dry run reports a refresh is needed" grep -qx 'REFRESH_NEEDED=1' <<<"$dry"
check "dry run leaves the plist alone" test "$(plutil -convert json -o - "$PLIST" | jq -S .)" == "$before"
show owner bash "$repo/scripts/hrc-owner.sh" refresh-plist
check "plist execs the fixed exe" test "$(plist_exe)" == "$FIXED"
check "refresh changed only the exec path" test \
  "$(jq -S --arg new "$FIXED" '.ProgramArguments[0] = $new' <<<"$before")" == "$(plutil -convert json -o - "$PLIST" | jq -S .)"
check "previous plist kept" test -f "$PLIST.pre-fixed-exe"
again="$(owner bash "$repo/scripts/hrc-owner.sh" refresh-plist)"
check "a second refresh is a no-op" grep -qx 'REFRESH_NEEDED=0' <<<"$again"

# Starts the fixed exe as a scratch daemon (the plist's argv and roots) and
# checks the release it reports.
daemon_check() {
  local release="$1" id commit status
  id="$(basename "$release")"
  commit="$(manifest "$release" .hrcBuild.sourceCommit)"
  printf '{"nodeId":"t12224-e2e","peers":{}}\n' > "$scratch/federation.json"
  chmod 600 "$scratch/federation.json"
  env -i HOME="$HOME" PATH="/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin" TMPDIR="$scratch/" TMUX_TMPDIR="$scratch/tmux" \
    HRC_RUNTIME_DIR="$scratch/run" HRC_STATE_DIR="$scratch/state" HRC_PEER_CONFIG_FILE="$scratch/federation.json" \
    HRC_WRKQ_DB="$scratch/wrkq.db" WRKQ_DB="$scratch/wrkq.db" HRC_EVENT_INGEST_SOCKET="$scratch/run/ingest.sock" \
    HRC_ACP_WEBHOOK_URL= HRC_ASPD_SOCKET="$scratch/run/no-aspd.sock" \
    "$(plist_exe)" server serve >> "$scratch/daemon-$id.log" 2>&1 &
  daemon_pid=$!
  status=""
  for _ in $(seq 1 60); do
    kill -0 "$daemon_pid" 2>/dev/null || { tail -20 "$scratch/daemon-$id.log"; die "scratch daemon on $id exited"; }
    status="$(curl -sf --max-time 2 --unix-socket "$scratch/run/hrc.sock" http://localhost/v1/status 2>/dev/null)" && break
    status=""
    sleep 1
  done
  [[ -n "$status" ]] || die "scratch daemon on $id never answered /v1/status"
  jq '{binaryPath, packagePath, release}' <<<"$status" | tee "$out/status-$id.json"
  check "$id: daemon binaryPath is the fixed exe" test "$(jq -r .binaryPath <<<"$status")" == "$FIXED"
  check "$id: release.mode is atomic" test "$(jq -r .release.mode <<<"$status")" == atomic
  check "$id: release.releaseId names the staged release" test "$(jq -r .release.releaseId <<<"$status")" == "$id"
  check "$id: release.sourceCommit is the release's" test "$(jq -r .release.hrcBuild.sourceCommit <<<"$status")" == "$commit"
  check "$id: releasePath is the owner's staged copy" test "$(jq -r .release.releasePath <<<"$status")" == "$OWNER/hrc-runtime-releases/$id"
  check "$id: runningEqualsInstalled" test "$(jq -r .release.runningEqualsInstalled <<<"$status")" == true
  check "$id: fixed exe --version names the release" grep -q "releaseId $id, sourceCommit $commit" < <("$FIXED" --version)
  kill "$daemon_pid"
  wait "$daemon_pid" 2>/dev/null || true
  daemon_pid=""
}

log "scratch daemon from the fixed exe, release B"
daemon_check "$B"

log "stage release C, then roll back to B"
select_release "$C"
show owner bash "$repo/scripts/hrc-owner.sh" stage --expect-commit "$(manifest "$C" .hrcBuild.sourceCommit)"
check "release C: same designated requirement" test "$(dr_of "$FIXED")" == "$DR"
daemon_check "$C"
select_release "$B"
show owner bash "$repo/scripts/hrc-owner.sh" stage --expect-commit "$(manifest "$B" .hrcBuild.sourceCommit)"
check "rollback to B: fixed exe re-copied as a regular file" test -f "$FIXED" -a ! -L "$FIXED"
check "rollback to B: same designated requirement" test "$(dr_of "$FIXED")" == "$DR"
check "rollback to B: verifies against the requirement" codesign --verify --strict -R "=$DR" "$FIXED"
daemon_check "$B"

if grep -q 'predates the fixed owner exe' <<<"$staged"; then
  log "staging the pre-fixed-exe release under the refreshed plist is refused"
  cp -p "$FIXED" "$scratch/before-refusal"
  select_release "$OLD"
  if owner bash "$repo/scripts/hrc-owner.sh" stage --expect-commit "$(manifest "$OLD" .hrcBuild.sourceCommit)"; then
    die "stage accepted a pre-fixed-exe build under a refreshed plist"
  fi
  check "refused stage left the fixed exe alone" cmp -s "$FIXED" "$scratch/before-refusal"
  check "refused stage left the link on B" test "$(cd "$OWNER/hrc-runtime-current" && pwd -P)" == "$OWNER/hrc-runtime-releases/$(basename "$B")"
fi
