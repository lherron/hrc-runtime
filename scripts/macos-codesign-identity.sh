#!/usr/bin/env bash
# The node's self-signed code-signing identity (T-12224). One certificate per
# macOS node, "Praesidium Local Code Signing", signs the node's long-running
# daemons with a fixed identifier, so macOS TCC privacy grants (removable
# volumes, Full Disk Access, ...) survive rebuilds. Recipe and background:
# ~/praesidium/var/agents/references/macos-code-signing.md
#
#   macos-codesign-identity.sh create [--keychain <path>] [--password-file <path>] [--name <cn>] [--trust]
#   macos-codesign-identity.sh status [--keychain <path>] [--password-file <path>] [--name <cn>] [--sign-probe]
#
# The identity lives in its own keychain, not the login keychain: deploys sign
# over ssh, and an ssh session cannot use a login keychain that was unlocked at
# the console ("User interaction is not allowed"). The signing keychain,
# ~/Library/Keychains/praesidium-codesign.keychain-db, has a random password in
# a 0600 file, ~/praesidium/var/codesign/praesidium-codesign.keychain.password,
# never auto-locks, and sits in the user keychain search list (codesign only
# finds identities in listed keychains). Every signer unlocks it with that file
# first and signs by certificate SHA-1 with --keychain, so another certificate
# with the same name elsewhere is never picked. Override the two paths with
# PRAESIDIUM_CODESIGN_KEYCHAIN and PRAESIDIUM_CODESIGN_KEYCHAIN_PASSWORD_FILE.
#
# create needs no console: it creates the keychain and its password file,
# lists the keychain, generates and imports the certificate, and proves a
# non-interactive sign. Every step checks first and skips what is already done,
# and prints what it is about to do. Trust is not needed: a self-signed leaf's
# designated requirement is identifier + certificate leaf hash, which macOS TCC
# matches without trust. --trust adds user trust for code signing, which shows
# a password dialog, so it is only for a person at the console.
#
# status is read-only apart from unlocking the signing keychain, and safe over
# ssh. --sign-probe also signs a scratch copy of /usr/bin/true with the
# identity, the exact non-interactive operation `hrc-owner.sh stage` performs.
set -euo pipefail

NAME="Praesidium Local Code Signing"
KEYCHAIN="${PRAESIDIUM_CODESIGN_KEYCHAIN:-$HOME/Library/Keychains/praesidium-codesign.keychain-db}"
PASSWORD_FILE="${PRAESIDIUM_CODESIGN_KEYCHAIN_PASSWORD_FILE:-$HOME/praesidium/var/codesign/praesidium-codesign.keychain.password}"
OWNER_ROOT="${OWNER_ROOT:-$HOME/praesidium/var/hrc-owner}"
OPENSSL=/usr/bin/openssl # LibreSSL: its PKCS#12 defaults are what `security import` reads
TRUST=0
PROBE=0

say() { printf '[codesign-identity] %s\n' "$*"; }
fail() { printf '[codesign-identity] FAIL: %s\n' "$*" >&2; exit 1; }

cmd="${1:-}"
shift || true
while (($#)); do
  case "$1" in
    --keychain) KEYCHAIN="$2"; shift ;;
    --password-file) PASSWORD_FILE="$2"; shift ;;
    --name) NAME="$2"; shift ;;
    --trust) TRUST=1 ;;
    --no-trust) TRUST=0 ;;
    --sign-probe) PROBE=1 ;;
    *) fail "unknown argument $1" ;;
  esac
  shift
done
[[ "$(uname -s)" == Darwin ]] || fail "macOS only"

# SHA-1 hashes of the certificates with this exact common name in the keychain.
cert_hashes() {
  security find-certificate -a -c "$NAME" -Z "$KEYCHAIN" 2>/dev/null | awk -v name="$NAME" '
    /^SHA-1 hash:/ { hash = $3 }
    /"labl"<blob>=/ { label = $0; sub(/^[^=]*="/, "", label); sub(/"$/, "", label); if (label == name) print hash }
  ' | sort -u
}

# "<hash> <state>" for this name as `find-identity` sees it: state is valid
# (has its private key and is trusted for code signing) or the reason it is not.
identity_line() {
  security find-identity -p codesigning "$KEYCHAIN" 2>/dev/null |
    awk -v q="\"$NAME\"" 'index($0, q) && $1 ~ /^[0-9]+\)$/ { state = "valid"; if (match($0, /\(CSSMERR[^)]*\)/)) state = substr($0, RSTART + 1, RLENGTH - 2); print $2, state; exit }'
}

trusted() {
  security find-identity -v -p codesigning "$KEYCHAIN" 2>/dev/null | grep -qF "\"$NAME\""
}

export_cert() { security find-certificate -c "$NAME" -p "$KEYCHAIN" > "$1"; }

# The user keychain search list, one path per line, exactly as listed.
search_list() {
  security list-keychains -d user | sed -e 's/^[[:space:]]*"//' -e 's/"[[:space:]]*$//'
}
listed() { search_list | grep -qxF "$KEYCHAIN"; }

# Unlock the signing keychain with its password file. A signer that skips this
# gets errSecInternalComponent over ssh and an unlock dialog at the console.
unlock() {
  [[ -f "$PASSWORD_FILE" ]] || fail "no password file $PASSWORD_FILE for $KEYCHAIN"
  security unlock-keychain -p "$(<"$PASSWORD_FILE")" "$KEYCHAIN" || fail "could not unlock $KEYCHAIN with $PASSWORD_FILE"
}

# Sign $1 with identifier $2 the way every deploy does: by certificate SHA-1,
# restricted to the signing keychain.
sign_with_identity() {
  local hash
  hash="$(identity_line | awk '{print $1}')"
  [[ -n "$hash" ]] || return 1
  codesign -f -s "$hash" --keychain "$KEYCHAIN" -i "$2" --timestamp=none "$1"
}

create() {
  local hashes count work p12pw
  [[ "$KEYCHAIN" != */login.keychain-db ]] || fail "create writes the key partition list of every key in its keychain; give it the dedicated signing keychain, not the login keychain"
  # 0. The signing keychain, its password file and its search-list entry.
  if [[ -f "$KEYCHAIN" ]]; then
    say "0/4 skip: keychain $KEYCHAIN exists"
  else
    if [[ -f "$PASSWORD_FILE" ]]; then
      say "0/4 creating keychain $KEYCHAIN with the existing password in $PASSWORD_FILE"
    else
      say "0/4 writing a random keychain password to $PASSWORD_FILE (mode 0600)"
      mkdir -p "$(dirname "$PASSWORD_FILE")"
      chmod 700 "$(dirname "$PASSWORD_FILE")"
      (umask 077 && "$OPENSSL" rand -hex 32 > "$PASSWORD_FILE")
      say "0/4 creating keychain $KEYCHAIN"
    fi
    security create-keychain -p "$(<"$PASSWORD_FILE")" "$KEYCHAIN" || fail "security create-keychain failed"
    say "0/4 keychain never auto-locks (no timeout, no lock on sleep)"
    security set-keychain-settings "$KEYCHAIN" || fail "security set-keychain-settings failed"
  fi
  [[ "$(stat -f %Lp "$PASSWORD_FILE" 2>/dev/null)" == 600 ]] || chmod 600 "$PASSWORD_FILE" 2>/dev/null || true
  unlock
  if listed; then
    say "0/4 skip: keychain already in the user search list"
  else
    say "0/4 appending $KEYCHAIN to the user keychain search list (entries before it are kept as they are)"
    local -a keep=()
    while IFS= read -r k; do keep+=("$k"); done < <(search_list)
    security list-keychains -d user -s "${keep[@]}" "$KEYCHAIN" || fail "security list-keychains failed"
    listed || fail "$KEYCHAIN is not in the search list after adding it"
  fi
  say "identity \"$NAME\" in $KEYCHAIN"
  hashes="$(cert_hashes)"
  count="$(grep -c . <<<"$hashes" || true)"
  ((count <= 1)) || fail "$count certificates are named \"$NAME\" ($(paste -sd ' ' - <<<"$hashes")); codesign -s cannot choose. Delete the extras in Keychain Access first"
  work="$(mktemp -d "${TMPDIR:-/tmp}/codesign-identity.XXXXXX")"
  WORK="$work"
  trap 'rm -rf "$WORK"' EXIT
  chmod 700 "$work"

  # 1. Certificate and key.
  if ((count == 1)) && [[ -n "$(identity_line)" ]]; then
    say "1/4 skip: certificate $hashes and its private key are already in the keychain"
  elif ((count == 1)); then
    fail "certificate $hashes is in the keychain without its private key; delete it in Keychain Access, then run create again"
  else
    say "1/4 generating a self-signed RSA-2048 certificate CN=\"$NAME\" (extendedKeyUsage=codeSigning, 3650 days) and importing it with its key, usable by /usr/bin/codesign"
    cat > "$work/req.cnf" <<EOF
[req]
distinguished_name = dn
x509_extensions = ext
prompt = no
[dn]
CN = $NAME
[ext]
basicConstraints = critical, CA:false
keyUsage = critical, digitalSignature
extendedKeyUsage = critical, codeSigning
subjectKeyIdentifier = hash
EOF
    (umask 077 && "$OPENSSL" req -x509 -newkey rsa:2048 -nodes -days 3650 -config "$work/req.cnf" \
      -keyout "$work/key.pem" -out "$work/cert.pem" 2>/dev/null) || fail "openssl req failed"
    p12pw="$("$OPENSSL" rand -hex 16)"
    (umask 077 && "$OPENSSL" pkcs12 -export -name "$NAME" -inkey "$work/key.pem" -in "$work/cert.pem" \
      -out "$work/identity.p12" -passout "pass:$p12pw") || fail "openssl pkcs12 failed"
    security import "$work/identity.p12" -k "$KEYCHAIN" -f pkcs12 -P "$p12pw" -T /usr/bin/codesign ||
      fail "security import into $KEYCHAIN failed (is it unlocked?)"
    hashes="$(cert_hashes)"
    [[ -n "$(identity_line)" ]] || fail "imported, but find-identity does not list \"$NAME\" with its key"
    say "1/4 imported certificate $hashes"
  fi

  # 2. Trust for code signing (user trust settings; macOS asks for the user's password).
  if ((!TRUST)); then
    say "2/4 skip: trust is not needed (pass --trust at the console to add it)"
  elif trusted; then
    say "2/4 skip: already trusted for code signing"
  else
    say "2/4 trusting the certificate for code signing in the user trust settings (macOS shows a password dialog)"
    export_cert "$work/cert.pem"
    security add-trusted-cert -r trustRoot -p codeSign -k "$KEYCHAIN" "$work/cert.pem" ||
      fail "security add-trusted-cert failed"
  fi

  # 3. codesign uses the key without a dialog or a GUI session: the import put
  # /usr/bin/codesign on the key's access list, the keychain is unlocked from
  # its password file, and the key's partition list admits Apple tools. Without
  # the partition list an ssh session gets errSecInternalComponent even with
  # the keychain unlocked. set-key-partition-list selects keys by label, and
  # `security import` labels every key "Imported Private Key", so it would
  # rewrite every imported key in a shared keychain; this keychain holds only
  # this identity, which is why create refuses the login keychain.
  say "3/4 key partition list: apple-tool:, apple:, codesign: (every key in $KEYCHAIN, which holds only this identity)"
  security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$(<"$PASSWORD_FILE")" "$KEYCHAIN" >/dev/null ||
    fail "security set-key-partition-list failed"
  say "3/4 signing a scratch copy of /usr/bin/true with \"$NAME\" (by SHA-1, --keychain $KEYCHAIN) to prove codesign can use the key"
  cp /usr/bin/true "$work/probe"
  sign_with_identity "$work/probe" com.praesidium.codesign-probe 2>/dev/null ||
    fail "codesign could not use \"$NAME\" in $KEYCHAIN"
  codesign --verify --strict "$work/probe" || fail "the probe signature does not verify"
  say "3/4 $(codesign -dr - "$work/probe" 2>/dev/null | sed -n 's/^#* *designated => /designated requirement: /p')"

  # 4. Read back.
  say "4/4 code-signing identities in $KEYCHAIN (\"Valid identities only\" lists the trusted ones):"
  security find-identity -p codesigning "$KEYCHAIN" || true
  [[ -n "$(identity_line)" ]] || fail "\"$NAME\" is not a code-signing identity after create"
  say "done. A node daemon opts in by naming the identity in its install config, for HRC: echo '$NAME' > $OWNER_ROOT/codesign.identity"
}

status() {
  local line hash state config probe dr
  say "keychain: $KEYCHAIN"
  if [[ ! -f "$KEYCHAIN" ]]; then
    echo "KEYCHAIN=absent"
  else
    echo "KEYCHAIN=present"
    if listed; then echo "KEYCHAIN_LISTED=yes"; else echo "KEYCHAIN_LISTED=no (codesign cannot find its identity)"; fi
  fi
  if [[ -f "$PASSWORD_FILE" ]]; then
    echo "PASSWORD_FILE=$PASSWORD_FILE mode $(stat -f %Lp "$PASSWORD_FILE")"
    [[ -f "$KEYCHAIN" ]] && unlock
  else
    echo "PASSWORD_FILE=absent ($PASSWORD_FILE)"
  fi
  line="$(identity_line)"
  if [[ -z "$line" ]]; then
    if [[ -n "$(cert_hashes)" ]]; then
      echo "IDENTITY=certificate-without-key $(cert_hashes | paste -sd ' ' -)"
    else
      echo "IDENTITY=absent"
    fi
  else
    read -r hash state <<<"$line"
    echo "IDENTITY=present $hash"
    echo "CERT_EXPIRES=$(security find-certificate -c "$NAME" -p "$KEYCHAIN" | "$OPENSSL" x509 -noout -enddate | sed 's/^notAfter=//')"
    if trusted; then echo "TRUSTED=yes"; else echo "TRUSTED=no (${state}; not needed for signing or TCC)"; fi
  fi
  if [[ -f "$OWNER_ROOT/codesign.identity" ]]; then
    IFS= read -r config < "$OWNER_ROOT/codesign.identity" || true
    echo "HRC_OWNER_CONFIG=$OWNER_ROOT/codesign.identity: ${config}"
    [[ "$config" == "$NAME" ]] || echo "HRC_OWNER_CONFIG_NOTE=names \"$config\", not \"$NAME\""
  else
    echo "HRC_OWNER_CONFIG=none ($OWNER_ROOT/codesign.identity absent: hrc-owner.sh stage keeps ad-hoc)"
  fi
  if ((PROBE)); then
    [[ -n "$line" ]] || { echo "SIGN_PROBE=skipped (no identity)"; return 1; }
    probe="$(mktemp -d "${TMPDIR:-/tmp}/codesign-probe.XXXXXX")"
    cp /usr/bin/true "$probe/probe"
    if sign_with_identity "$probe/probe" com.praesidium.codesign-probe 2> "$probe/err" &&
      codesign --verify --strict "$probe/probe" 2>> "$probe/err"; then
      dr="$(codesign -dr - "$probe/probe" 2>/dev/null | sed -n 's/^#* *designated => //p')"
      echo "SIGN_PROBE=ok $dr"
      rm -rf "$probe"
    else
      echo "SIGN_PROBE=failed $(tr '\n' ' ' < "$probe/err")"
      rm -rf "$probe"
      return 1
    fi
  fi
}

case "$cmd" in
  create) create ;;
  status) status ;;
  *) echo "usage: $0 create|status [--keychain <path>] [--password-file <path>] [--name <cn>] [--trust] [--sign-probe]" >&2; exit 2 ;;
esac
