#!/usr/bin/env bash
# Rebuild libghostty-vt at the commit in GHOSTTY_COMMIT and stage it into
# vendor/<commit>/: the debug-stripped static lib, the headers it was built
# with (the two always ship together), COMMIT and VERSION. Run this when you
# move the pin (with Loggia's vendor/GHOSTTY_COMMIT); needs zig 0.17 (ZIG=...).
set -euo pipefail

crate="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
commit="$(tr -d '[:space:]' < "$crate/GHOSTTY_COMMIT")"
build="$crate/../target/libghostty-vt/$commit"
bash "$crate/scripts/build-libghostty-vt.sh" "$commit" "$build"

out="$crate/vendor/$commit"
rm -rf "$crate/vendor"
mkdir -p "$out/lib"
cp "$build/zig-out/lib/libghostty-vt.a" "$out/lib/libghostty-vt.a"
strip -S "$out/lib/libghostty-vt.a"
cp -R "$build/zig-out/include" "$out/include"
cp "$build/COMMIT" "$build/VERSION" "$out/"
echo "vendored libghostty-vt $(cat "$out/VERSION") @ $commit -> $out"
