#!/usr/bin/env bash
# Check that the committed WebAssembly build is reproducible from source.
#
#   engine/scripts/check-reproducible.sh [WORKDIR]
#
# Clones the repository's current commit (HEAD) into WORKDIR (default: a new
# temporary directory) *without* engine/dist/, builds everything from scratch
# there (fresh emsdk install, fresh downloads), and compares the resulting
# gnubg.wasm / gnubg.mjs byte-for-byte with the versions committed at HEAD.
# Leaving dist/ out of the clone means a failed build can't pass by accident.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORK="${1:-$(mktemp -d)}"
CLONE="$WORK/repo"

echo "Cloning $(git -C "$REPO" rev-parse --short HEAD) into $CLONE"
git clone -q --no-checkout "$REPO" "$CLONE"
git -C "$CLONE" checkout -q HEAD -- . ':!engine/dist'
[ ! -e "$CLONE/engine/dist" ] || { echo "engine/dist unexpectedly present" >&2; exit 1; }

echo "Building from scratch (log: $WORK/build.log)"
( cd "$CLONE" && engine/build.sh ) > "$WORK/build.log" 2>&1 \
    || { echo "BUILD FAILED"; tail -30 "$WORK/build.log"; exit 1; }

status=0
for f in gnubg.wasm gnubg.mjs; do
    committed="$(git -C "$REPO" show "HEAD:engine/dist/$f" | shasum -a 256 | awk '{print $1}')"
    rebuilt="$(shasum -a 256 "$CLONE/engine/dist/$f" | awk '{print $1}')"
    if [ "$committed" = "$rebuilt" ]; then
        echo "IDENTICAL  $f  $rebuilt"
    else
        echo "DIFFERENT  $f  committed $committed  rebuilt $rebuilt"
        status=1
    fi
done
exit $status
