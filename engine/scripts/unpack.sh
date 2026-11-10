#!/usr/bin/env bash
# Unpack the verified tarballs (from scripts/fetch.sh) and apply our patches.
#
#   engine/build/src/gnubg/   gnubg source + engine/patches/gnubg/*.patch
#   engine/build/src/glib/    glib source  + engine/patches/glib/*.patch
#                             (+ the meson subproject archives, see versions.env)
#   engine/build/src/cjson/   cJSON source (no patches)
#
# Patches are applied in filename order. Each one starts with a plain-English
# explanation of why it exists.
#
# Each tree gets a stamp file, .gnubg-web-source, listing the SHA-256 of the
# tarball and of every patch (in order). When anything in that list changes
# (version bump, a patch edited, added, renamed or removed) the tree is thrown
# away and recreated from the pristine tarball, with *all* patches applied
# again. The build steps include the stamp in their own signatures (see
# scripts/common.sh), so they then rebuild from scratch too; old objects can
# never survive a source change, whatever the file timestamps say.
#
# A tree is assembled in a temporary directory and only moved into place once
# unpacking and every patch have succeeded, so an interrupted or failed run
# never leaves a half-patched tree that a later run would trust.
set -euo pipefail

ENGINE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ENGINE_DIR/versions.env"
source "$ENGINE_DIR/scripts/common.sh"

DL="$ENGINE_DIR/build/downloads"
SRC="$ENGINE_DIR/build/src"
mkdir -p "$SRC"

TMP=""
trap '[ -z "$TMP" ] || rm -rf "$TMP"' EXIT

# prepare NAME TARBALL [EXTRA_FILE ...]
# EXTRA_FILEs (from downloads/) are copied into the tree's
# subprojects/packagecache/, where meson looks for subproject archives.
prepare() {
    local name="$1" tarball="$2"; shift 2
    local target="$SRC/$name" expected patch f
    [ -f "$DL/$tarball" ] || { echo "missing $DL/$tarball (run scripts/fetch.sh)" >&2; exit 1; }

    # What the tree should be made of. "format" is bumped by hand if the way
    # trees are prepared ever changes, to force everyone's trees to be redone.
    expected="format 1"
    expected="$expected
tarball $tarball $(sha256_of "$DL/$tarball")"
    for patch in "$ENGINE_DIR/patches/$name"/*.patch; do
        [ -e "$patch" ] || continue
        expected="$expected
patch $(basename "$patch") $(sha256_of "$patch")"
    done
    for f in "$@"; do
        expected="$expected
subproject-archive $f $(sha256_of "$DL/$f")"
    done

    if [ "$(source_stamp "$target")" = "$expected" ]; then
        return 0
    fi
    if [ -d "$target" ]; then
        echo "Source $name: tarball or patches changed, unpacking again"
    else
        echo "Unpacking $name"
    fi

    TMP="$(mktemp -d "$SRC/.unpack-$name.XXXXXX")"
    # Every upstream tarball has a single top-level directory; strip it.
    tar -xf "$DL/$tarball" -C "$TMP" --strip-components=1
    for patch in "$ENGINE_DIR/patches/$name"/*.patch; do
        [ -e "$patch" ] || continue
        echo "  applying $name/$(basename "$patch")"
        # -F 0: no "fuzz", i.e. every line of context must match exactly, so a
        # hunk can never land in the wrong place after an upstream update.
        patch -d "$TMP" -p1 --forward -F 0 --no-backup-if-mismatch --quiet < "$patch" \
            || { echo "ERROR: $name/$(basename "$patch") does not apply cleanly" >&2; exit 1; }
    done
    if [ $# -gt 0 ]; then
        mkdir -p "$TMP/subprojects/packagecache"
        for f in "$@"; do
            cp "$DL/$f" "$TMP/subprojects/packagecache/"
        done
    fi
    printf '%s\n' "$expected" > "$TMP/.gnubg-web-source"
    rm -rf "$target"
    mv "$TMP" "$target"
    TMP=""
}

# check_wrap WRAPFILE ARCHIVE SHA256 PATCH_ARCHIVE PATCH_SHA256
# glib's subprojects/*.wrap files name the exact archives meson will use.
# If a glib update changes them, versions.env must be updated to match.
check_wrap() {
    local wrap="$SRC/glib/subprojects/$1"
    grep -qxF "source_filename = $2" "$wrap" && grep -qxF "source_hash = $3" "$wrap" \
        && grep -qxF "patch_filename = $4" "$wrap" && grep -qxF "patch_hash = $5" "$wrap" \
        || { echo "ERROR: $wrap no longer matches versions.env; update the ${1%.wrap} entries there" >&2; exit 1; }
}

prepare gnubg "$(basename "$GNUBG_URL")"
prepare glib  "$(basename "$GLIB_URL")" \
    "$PCRE2_FILE" "$PCRE2_PATCH_FILE" "$LIBFFI_FILE" "$LIBFFI_PATCH_FILE" "$ZLIB_FILE" "$ZLIB_PATCH_FILE"
prepare cjson "$(basename "$CJSON_URL")"

check_wrap pcre2.wrap  "$PCRE2_FILE"  "$PCRE2_SHA256"  "$PCRE2_PATCH_FILE"  "$PCRE2_PATCH_SHA256"
check_wrap libffi.wrap "$LIBFFI_FILE" "$LIBFFI_SHA256" "$LIBFFI_PATCH_FILE" "$LIBFFI_PATCH_SHA256"
check_wrap zlib.wrap   "$ZLIB_FILE"   "$ZLIB_SHA256"   "$ZLIB_PATCH_FILE"   "$ZLIB_PATCH_SHA256"
echo "Sources ready in $SRC"
