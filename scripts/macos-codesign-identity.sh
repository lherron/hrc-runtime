#!/usr/bin/env bash
# The node's self-signed code-signing identity (T-12224). One certificate per
# macOS node, "Praesidium Local Code Signing", in the login keychain, signs the
# node's long-running daemons with a fixed identifier, so macOS TCC privacy
# grants (removable volumes, ...) survive rebuilds. Recipe and background:
# ~/praesidium/var/agents/references/macos-code-signing.md
#
#   macos-codesign-identity.sh create [--keychain <path>] [--name <cn>] [--no-trust]
#   macos-codesign-identity.sh status [--keychain <path>] [--name <cn>] [--sign-probe]
#
# create is meant to run ONCE, by a person at the node's console: trusting the
# certificate asks for the user's password in a macOS dialog. Every step checks
# first and skips what is already done, and prints what it is about to do. --no-trust skips the trust
# step (signing and verifying do not need it; the e2e uses it on a temporary
# keychain, where a trust dialog would be wrong).
#
# status is read-only and safe over ssh. --sign-probe also signs a scratch copy
# of /usr/bin/true with the identity, the exact non-interactive operation
# `hrc-owner.sh stage` performs, so a locked keychain or a key that denies
# codesign shows up here and not in a deploy. At the console, a key that does
# not list codesign may show an "allow access" dialog during the probe.
set -euo pipefail

NAME="Praesidium Local Code Signing"
KEYCHAIN="$HOME/Library/Keychains/login.keychain-db"
OWNER_ROOT="${OWNER_ROOT:-$HOME/praesidium/var/hrc-owner}"
OPENSSL=/usr/bin/openssl # LibreSSL: its PKCS#12 defaults are what `security import` reads
TRUST=1
PROBE=0

say() { printf '[codesign-identity] %s\n' "$*"; }
fail() { printf '[codesign-identity] FAIL: %s\n' "$*" >&2; exit 1; }

cmd="${1:-}"
shift || true
while (($#)); do
  case "$1" in
    --keychain) KEYCHAIN="$2"; shift ;;
    --name) NAME="$2"; shift ;;
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

create() {
  local hashes count work p12pw
  [[ -f "$KEYCHAIN" ]] || fail "no keychain at $KEYCHAIN"
  say "identity \"$NAME\" in $KEYCHAIN"
  hashes="$(cert_hashes)"
  count="$(grep -c . <<<"$hashes" || true)"
  ((count <= 1)) || fail "$count certificates are named \"$NAME\" ($(paste -sd ' ' - <<<"$hashes")); codesign -s cannot choose. Delete the extras in Keychain Access first"
  work="$(mktemp -d "${TMPDIR:-/tmp}/codesign-identity.XXXXXX")"
  trap 'rm -rf "$work"' EXIT
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
    say "2/4 skip: --no-trust"
  elif trusted; then
    say "2/4 skip: already trusted for code signing"
  else
    say "2/4 trusting the certificate for code signing in the user trust settings (macOS shows a password dialog)"
    export_cert "$work/cert.pem"
    security add-trusted-cert -r trustRoot -p codeSign -k "$KEYCHAIN" "$work/cert.pem" ||
      fail "security add-trusted-cert failed"
  fi

  # 3. codesign uses the key without a dialog. The import above put
  # /usr/bin/codesign on the key's access list, which is what lets an ssh
  # session or a deploy sign. `security set-key-partition-list` is not used:
  # it selects keys by label, and `security import` labels every key
  # "Imported Private Key", so it would rewrite every imported key's partition
  # list in this keychain. A key made another way (Keychain Access) may show an
  # "allow access" dialog here once: choose Always Allow.
  say "3/4 signing a scratch copy of /usr/bin/true with \"$NAME\" to prove codesign can use the key"
  cp /usr/bin/true "$work/probe"
  codesign -f -s "$NAME" -i com.praesidium.codesign-probe --timestamp=none "$work/probe" 2>/dev/null ||
    fail "codesign could not use \"$NAME\" (keychain locked, or the key denies codesign)"
  codesign --verify --strict "$work/probe" || fail "the probe signature does not verify"
  say "3/4 $(codesign -dr - "$work/probe" 2>/dev/null | sed -n 's/^designated => /designated requirement: /p')"

  # 4. Read back.
  say "4/4 code-signing identities in $KEYCHAIN:"
  security find-identity -v -p codesigning "$KEYCHAIN" || true
  [[ -n "$(identity_line)" ]] || fail "\"$NAME\" is not a code-signing identity after create"
  say "done. A node daemon opts in by naming the identity in its install config, for HRC: echo '$NAME' > $OWNER_ROOT/codesign.identity"
}

status() {
  local line hash state config probe dr
  say "keychain: $KEYCHAIN"
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
    if trusted; then echo "TRUSTED=yes"; else echo "TRUSTED=no ${state}"; fi
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
    if codesign -f -s "$NAME" -i com.praesidium.codesign-probe --timestamp=none "$probe/probe" 2> "$probe/err" &&
      codesign --verify --strict "$probe/probe" 2>> "$probe/err"; then
      dr="$(codesign -dr - "$probe/probe" 2>/dev/null | sed -n 's/^designated => //p')"
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
  *) echo "usage: $0 create|status [--keychain <path>] [--name <cn>] [--no-trust] [--sign-probe]" >&2; exit 2 ;;
esac
