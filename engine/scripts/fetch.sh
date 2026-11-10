#!/usr/bin/env bash
# Download the pinned upstream sources (engine/versions.env) into
# engine/build/downloads/ and verify their SHA-256.
#
#   engine/scripts/fetch.sh
#
# Files that are already there and have the right checksum are not downloaded
# again. Unpacking and patching is the next step, scripts/unpack.sh.
set -euo pipefail

ENGINE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ENGINE_DIR/versions.env"
source "$ENGINE_DIR/scripts/common.sh"

DL="$ENGINE_DIR/build/downloads"
mkdir -p "$DL"

# --retry-all-errors (curl >= 7.71) also retries after HTTP errors such as a
# 503 from a busy mirror. Older curl (e.g. RHEL 8, Ubuntu 20.04) rejects the
# option, so only use it when available.
CURL_RETRY="--retry 3"
if curl --help all 2>/dev/null | grep -q -- '--retry-all-errors'; then
    CURL_RETRY="$CURL_RETRY --retry-all-errors"
fi

# fetch FILE SHA256 URL [FALLBACK_URL ...]
# Downloads to engine/build/downloads/FILE. Each URL is tried in turn until one
# gives a file with the expected SHA-256; a download with the wrong content
# (truncated file, an HTML error page from a proxy, a tampered mirror) is
# deleted and the next URL is tried. Nothing unverified is ever kept as FILE.
fetch() {
    local file="$DL/$1" sha="$2"; shift 2
    if [ -f "$file" ]; then
        if [ "$(sha256_of "$file")" = "$sha" ]; then
            return 0
        fi
        echo "Existing $file has the wrong SHA-256 (corrupt, or the pin changed); downloading again" >&2
        rm -f "$file"
    fi
    local url actual
    for url in "$@"; do
        echo "Downloading $(basename "$file") from $url"
        rm -f "$file.part"
        # shellcheck disable=SC2086
        if ! curl -fsSL $CURL_RETRY --connect-timeout 20 -o "$file.part" "$url"; then
            echo "  download failed, trying next source" >&2
            continue
        fi
        actual="$(sha256_of "$file.part")"
        if [ "$actual" = "$sha" ]; then
            mv "$file.part" "$file"
            return 0
        fi
        echo "  wrong SHA-256 (expected $sha, got $actual), trying next source" >&2
        rm -f "$file.part"
    done
    echo "ERROR: could not download $(basename "$file") with SHA-256 $sha" >&2
    exit 1
}

fetch "$(basename "$GNUBG_URL")" "$GNUBG_SHA256" "$GNUBG_URL" "$GNUBG_MIRROR_URL"
fetch "$(basename "$GLIB_URL")"  "$GLIB_SHA256"  "$GLIB_URL"
fetch "$(basename "$CJSON_URL")" "$CJSON_SHA256" "$CJSON_URL"
# glib's meson subprojects (see versions.env)
fetch "$PCRE2_FILE"        "$PCRE2_SHA256"        "$PCRE2_URL"        "$PCRE2_MIRROR_URL"
fetch "$PCRE2_PATCH_FILE"  "$PCRE2_PATCH_SHA256"  "$PCRE2_PATCH_URL"  "$PCRE2_PATCH_MIRROR_URL"
fetch "$LIBFFI_FILE"       "$LIBFFI_SHA256"       "$LIBFFI_URL"       "$LIBFFI_MIRROR_URL"
fetch "$LIBFFI_PATCH_FILE" "$LIBFFI_PATCH_SHA256" "$LIBFFI_PATCH_URL" "$LIBFFI_PATCH_MIRROR_URL"
fetch "$ZLIB_FILE"         "$ZLIB_SHA256"         "$ZLIB_URL"         "$ZLIB_MIRROR_URL"
fetch "$ZLIB_PATCH_FILE"   "$ZLIB_PATCH_SHA256"   "$ZLIB_PATCH_URL"   "$ZLIB_PATCH_MIRROR_URL"
echo "Downloads verified in $DL"
