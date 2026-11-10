#!/usr/bin/env bash
# Download the pinned upstream sources, verify their SHA-256, and unpack them.
#
#   engine/build/downloads/   the tarballs (kept, so re-runs don't re-download)
#   engine/build/src/gnubg/   pristine gnubg source (then patched by apply-patches.sh)
#   engine/build/src/glib/    pristine glib source
#   engine/build/src/cjson/   pristine cJSON source
#
# Safe to re-run: an existing unpacked directory is left alone.
set -euo pipefail

ENGINE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ENGINE_DIR/versions.env"

DL="$ENGINE_DIR/build/downloads"
SRC="$ENGINE_DIR/build/src"
mkdir -p "$DL" "$SRC"

# fetch NAME URL SHA256
fetch() {
    local name="$1" url="$2" sha="$3"
    local file="$DL/$(basename "$url")"
    if [ ! -f "$file" ]; then
        echo "Downloading $name from $url"
        curl -fL --retry 3 -o "$file.part" "$url"
        mv "$file.part" "$file"
    fi
    local actual
    actual="$(shasum -a 256 "$file" | awk '{print $1}')"
    if [ "$actual" != "$sha" ]; then
        echo "ERROR: checksum mismatch for $file" >&2
        echo "  expected $sha" >&2
        echo "  actual   $actual" >&2
        exit 1
    fi
    if [ ! -d "$SRC/$name" ]; then
        echo "Unpacking $name"
        mkdir -p "$SRC/$name"
        # Every upstream tarball has a single top-level directory; strip it.
        tar -xf "$file" -C "$SRC/$name" --strip-components=1
    fi
}

fetch gnubg "$GNUBG_URL" "$GNUBG_SHA256"
fetch glib  "$GLIB_URL"  "$GLIB_SHA256"
fetch cjson "$CJSON_URL" "$CJSON_SHA256"
echo "Sources ready in $SRC"
