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

# fetch NAME SHA256 URL [FALLBACK_URL ...]
# Tries each URL in turn (with retries) until one downloads; the SHA-256
# check means a mirror can't hand us a different file.
fetch() {
    local name="$1" sha="$2"; shift 2
    local file="$DL/$(basename "$1")"
    if [ ! -f "$file" ]; then
        local url ok=0
        for url in "$@"; do
            echo "Downloading $name from $url"
            if curl -fL --retry 3 --retry-all-errors --connect-timeout 20 -o "$file.part" "$url"; then
                mv "$file.part" "$file"; ok=1; break
            fi
            echo "  failed, trying next source" >&2
        done
        [ "$ok" = 1 ] || { echo "ERROR: could not download $name" >&2; exit 1; }
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

fetch gnubg "$GNUBG_SHA256" "$GNUBG_URL" "$GNUBG_MIRROR_URL"
fetch glib  "$GLIB_SHA256"  "$GLIB_URL"
fetch cjson "$CJSON_SHA256" "$CJSON_URL"
echo "Sources ready in $SRC"
