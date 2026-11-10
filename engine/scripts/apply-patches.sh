#!/usr/bin/env bash
# Apply our patches to the pristine upstream sources unpacked by fetch.sh.
#
#   engine/patches/<name>/*.patch  are applied, in filename order, to
#   engine/build/src/<name>/
#
# Each patch file starts with a plain-English explanation of why it exists.
# A stamp file records which patches were applied, so re-running is a no-op.
# If you edit a patch, delete engine/build/src/<name> and re-run fetch.sh.
set -euo pipefail

ENGINE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

for pdir in "$ENGINE_DIR"/patches/*/; do
    name="$(basename "$pdir")"
    target="$ENGINE_DIR/build/src/$name"
    stamp="$target/.gnubg-web-patches"
    [ -d "$target" ] || { echo "missing $target (run fetch.sh)" >&2; exit 1; }
    touch "$stamp"
    for patch in "$pdir"*.patch; do
        [ -e "$patch" ] || continue
        pname="$(basename "$patch")"
        if grep -qxF "$pname" "$stamp"; then
            continue
        fi
        echo "Applying $name/$pname"
        patch -d "$target" -p1 --forward --quiet < "$patch"
        echo "$pname" >> "$stamp"
    done
done
