#!/usr/bin/env bash
# Check that the committed WebAssembly build is reproducible from source.
#
#   engine/scripts/check-reproducible.sh [WORKDIR]
#
# Takes the repository's current commit (HEAD, recorded once at the start),
# clones it into WORKDIR (default: a new temporary directory) *without*
# engine/dist/, builds everything from scratch there (fresh emsdk install,
# fresh downloads), and compares the resulting gnubg.wasm / gnubg.mjs
# byte-for-byte with the versions committed in that same commit.
# Leaving dist/ out of the clone means a failed build can't pass by accident.
#
# It also checks that the rebuilt gnubg.wasm contains no absolute path of
# this machine (checkout directory, home directory, Homebrew prefix, ...),
# which would make the output depend on who built it and where.
#
# What it can't check: a different machine or OS. Run it on a second machine
# (e.g. Linux) to confirm the build doesn't depend on the host.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$REPO/engine/scripts/common.sh"
WORK="${1:-$(mktemp -d)}"
CLONE="$WORK/repo"

# Record the commit once: commits can land while the (long) build runs, and
# the comparison must be against the commit that was actually built.
COMMIT="$(git -C "$REPO" rev-parse HEAD)"
echo "Checking commit $COMMIT"
echo "Cloning into $CLONE"
git clone -q --no-checkout "$REPO" "$CLONE"
git -C "$CLONE" checkout -q "$COMMIT" -- . ':!engine/dist'
[ ! -e "$CLONE/engine/dist" ] || { echo "engine/dist unexpectedly present" >&2; exit 1; }

echo "Building from scratch (log: $WORK/build.log)"
( cd "$CLONE" && engine/build.sh ) > "$WORK/build.log" 2>&1 \
    || { echo "BUILD FAILED"; tail -30 "$WORK/build.log"; exit 1; }

status=0
for f in gnubg.wasm gnubg.mjs; do
    git -C "$REPO" show "$COMMIT:engine/dist/$f" > "$WORK/committed-$f"
    committed="$(sha256_of "$WORK/committed-$f")"
    rebuilt="$(sha256_of "$CLONE/engine/dist/$f")"
    if [ "$committed" = "$rebuilt" ]; then
        echo "IDENTICAL  $f  $rebuilt"
    else
        echo "DIFFERENT  $f  committed $committed  rebuilt $rebuilt"
        status=1
    fi
done

# Host paths: anything that names where this was built. (glib and gnubg also
# contain fixed install paths such as /usr/local/share/gnubg; those are the
# same everywhere and are fine.)
# The real directories are included too (pwd -P resolves symlinks, e.g.
# macOS's /tmp -> /private/tmp). Empty entries are skipped: an empty
# alternative would match every line.
host_paths="/opt/homebrew|/home/|/Users/|/private/|/nix/store"
for p in "$CLONE" "$REPO" "${HOME:-}" "$(cd "$CLONE" && pwd -P)" "$(cd "$WORK" && pwd -P)"; do
    [ -n "$p" ] && host_paths="$host_paths|$p"
done
if strings -n 4 "$CLONE/engine/dist/gnubg.wasm" | grep -E "$host_paths" > "$WORK/host-paths.txt"; then
    echo "HOST PATHS in gnubg.wasm:"
    sed 's/^/  /' "$WORK/host-paths.txt"
    status=1
else
    echo "NO HOST PATHS in gnubg.wasm (searched for: $host_paths)"
fi
exit $status
