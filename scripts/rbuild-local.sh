#!/bin/bash
# Stand-in for rbuild (installed by arris `just install`) on a node without it:
# run the command here the way rbuild's own local fallback does. `--pull PATH`
# is a no-op locally; `--mac` targets aarch64-apple-darwin (before any `--`, so
# clippy's lint flags stay after it), so output lands under
# target/aarch64-apple-darwin/ just as a remote run's pull does.
echo "rbuild not installed; running locally" >&2
mac=0
while [ $# -gt 0 ]; do
	case "$1" in
	--mac) mac=1; shift ;;
	--pull) shift 2 ;;
	--) shift; break ;;
	*) break ;;
	esac
done
[ "$mac" = 1 ] || exec "$@"
args=()
while [ $# -gt 0 ] && [ "$1" != -- ]; do args+=("$1"); shift; done
exec "${args[@]}" --target aarch64-apple-darwin "$@"
