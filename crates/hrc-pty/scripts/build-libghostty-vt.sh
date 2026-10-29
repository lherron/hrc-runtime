#!/usr/bin/env bash
# Build libghostty-vt (static) from scriptable-ghostty at the pinned commit.
# Only reached when moving the pin (vendor-libghostty-vt.sh) or with
# HRC_PTY_BUILD_VT=1; the default build links vendor/<commit>/.
#
#   build-libghostty-vt.sh <commit> <out-dir>
#
# Clones the fork (GHOSTTY_REPO, default ~/praesidium/scriptable-ghostty) into
# <out-dir>/src without touching the source checkout, builds the libghostty-vt
# static lib with zig 0.17 (ZIG overrides), and writes <out-dir>/COMMIT last so a
# half-built dir is never mistaken for a finished one.
set -euo pipefail

commit="$1"
out="$2"
repo="${GHOSTTY_REPO:-$HOME/praesidium/scriptable-ghostty}"
zig="${ZIG:-zig}"
"$zig" version 2>/dev/null | grep -q '^0\.17\.' || { echo "zig 0.17.x required: put it on PATH or set ZIG" >&2; exit 1; }

mkdir -p "$out"
src="$out/src"
if [ ! -d "$src/.git" ]; then
  git clone --quiet --no-checkout "$repo" "$src"
fi
git -C "$src" cat-file -e "$commit^{commit}" 2>/dev/null || git -C "$src" fetch --quiet origin
git -C "$src" checkout --quiet --detach "$commit"
resolved="$(git -C "$src" rev-parse HEAD)"
[ "$resolved" = "$commit" ] || { echo "checkout resolved $resolved, want $commit" >&2; exit 1; }

rm -rf "$out/zig-out" "$out/COMMIT"
( cd "$src" && "$zig" build -Demit-lib-vt=true -Doptimize=ReleaseFast --prefix "$out/zig-out" )
test -f "$out/zig-out/lib/libghostty-vt.a"
version="$(sed -n 's/^ *\.version = "\(.*\)",/\1/p' "$src/build.zig.zon" | head -1)"
echo "$version" > "$out/VERSION"
echo "$resolved" > "$out/COMMIT"
echo "libghostty-vt $version @ $resolved -> $out/zig-out/lib/libghostty-vt.a"
