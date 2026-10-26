#!/usr/bin/env bash
# Read-only CLI identity, independent of the daemon owner. Safe to embed in an
# ssh probe before the remote checkout has this script.
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
