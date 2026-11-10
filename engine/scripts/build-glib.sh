#!/usr/bin/env bash
# Cross-compile glib's core library (libglib-2.0.a) to WebAssembly.
# Only libglib is built: gnubg doesn't use gio or gobject.
#
# Output: engine/build/glib-wasm/  (static library + generated headers)
set -euo pipefail

ENGINE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ENGINE_DIR/scripts/emsdk-env.sh"

SRC="$ENGINE_DIR/build/src/glib"
OUT="$ENGINE_DIR/build/glib-wasm"

if [ ! -f "$OUT/build.ninja" ]; then
    # PKG_CONFIG_LIBDIR points nowhere so meson can't pick up the *host's*
    # (macOS) libraries by mistake; missing deps (pcre2, libffi) come from
    # glib's own pinned meson "wrap" subprojects instead.
    PKG_CONFIG_LIBDIR=/nonexistent meson setup "$OUT" "$SRC" \
        --cross-file "$ENGINE_DIR/config/emscripten-cross.ini" \
        --default-library=static --buildtype=release \
        -Dtests=false -Dnls=disabled -Dintrospection=disabled \
        -Dlibmount=disabled -Dselinux=disabled -Dxattr=false \
        -Dman-pages=disabled -Ddocumentation=false -Dsysprof=disabled \
        -Dlibelf=disabled -Ddtrace=disabled -Dsystemtap=disabled \
        > "$ENGINE_DIR/build/glib-setup.log" 2>&1 \
        || { tail -30 "$ENGINE_DIR/build/glib-setup.log"; exit 1; }
fi

# libglib itself, its charset helper, and PCRE2 (used by glib's GRegex).
# The two gobject headers are generated files that <glib-object.h> needs;
# gnubg's headers include it for declarations only, so we don't build or
# link the gobject library itself.
ninja -C "$OUT" glib/libglib-2.0.a glib/libcharset/libcharset.a \
    subprojects/pcre2-10.46/libpcre2-8.a \
    gobject/gobject-visibility.h gobject/glib-enumtypes.h
echo "Built glib static libraries in $OUT"
