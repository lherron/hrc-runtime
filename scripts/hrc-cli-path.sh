#!/usr/bin/env bash
# Read-only CLI identity and deployment status probes. Safe to embed in an
# ssh probe before the remote checkout has this script.
hrc_healthy_status() {
  local attempts="${1:-5}" delay="${2:-3}" attempt snapshot
  for ((attempt = 1; attempt <= attempts; attempt++)); do
    if snapshot="$(hrc server status --json 2>/dev/null)" &&
      jq -e 'type == "object" and .status == "healthy"' >/dev/null 2>&1 <<<"$snapshot"; then
      printf '%s\n' "$snapshot"
      return 0
    fi
    if ((attempt < attempts)); then sleep "$delay"; fi
  done
  printf 'HRC did not report healthy status after %s attempt(s)\n' "$attempts" >&2
  return 1
}

hrc_cli_kind() {
  local cli
  cli="$(command -v hrc)" || { echo missing; return; }
  python3 - "$cli" "$HOME/.bun/install/hrc-runtime-current/bin/rusthrc" <<'PY'
import os, sys
cli, expected = sys.argv[1:]
actual = os.path.realpath(cli)
if not os.access(cli, os.X_OK):
    print('missing')
elif actual == os.path.realpath(expected) and os.path.basename(actual) == 'rusthrc':
    print('rusthrc')
elif actual.endswith(('/cli.ts', '/hrc.js')):
    print('bun')
else:
    print('foreign')
PY
}
