#!/usr/bin/env bash
# Install the xterm-ghostty terminfo entry into ~/.terminfo (T-12046 spec §4.7).
# hrc-pty seats run Claude with TERM=xterm-ghostty and refuse `spawn` with
# terminfo_missing without it. The source is scriptable-ghostty's build output
# at the commit crates/hrc-pty/GHOSTTY_COMMIT pins (src/terminfo is unchanged
# there), the same entry Loggia bundles. Idempotent: tic rewrites in place.
set -euo pipefail
src="$(cd "$(dirname "$0")" && pwd)/terminfo/ghostty.terminfo"
dest="${HOME}/.terminfo"
mkdir -p "$dest"
tic -x -o "$dest" "$src"
TERMINFO_DIRS="$dest:" infocmp -x xterm-ghostty >/dev/null
echo "[install] xterm-ghostty terminfo installed in ${dest}"
