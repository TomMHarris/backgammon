#!/usr/bin/env bash
# Cross-compile glib's core library (libglib-2.0.a) to WebAssembly.
# Only libglib is built: gnubg doesn't use gio or gobject.
#
# Output: engine/build/glib-wasm/  (static library + generated headers)
set -euo pipefail

ENGINE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ENGINE_DIR/scripts/common.sh"
source "$ENGINE_DIR/scripts/emsdk-env.sh"

SRC="$ENGINE_DIR/build/src/glib"
OUT="$ENGINE_DIR/build/glib-wasm"

# glib 2.90's meson.build requires meson >= 1.4.0; say so clearly up front.
MESON_VERSION="$(meson --version)"
case "$MESON_VERSION" in
    0.*|1.[0-3].*) echo "ERROR: meson $MESON_VERSION is too old; glib needs >= 1.4.0 (see engine/README.md)" >&2; exit 1 ;;
esac

# Meson's exe_wrapper runs a few small test programs during setup ("C99
# vsnprintf runs", ...). Use the node that the pinned emsdk installed rather
# than whatever node is first on PATH, so the setup doesn't depend on the host.
# (A second cross file overrides that one entry of config/emscripten-cross.ini.)
mkdir -p "$ENGINE_DIR/build"
NODE_CROSS="$ENGINE_DIR/build/emscripten-node.ini"
printf "[binaries]\nexe_wrapper = '%s'\n" "$EMSDK_NODE" > "$NODE_CROSS"

MESON_ARGS=(
    --cross-file "$ENGINE_DIR/config/emscripten-cross.ini"
    --cross-file "$NODE_CROSS"
    --default-library=static --buildtype=release
    # Nothing is ever installed, but glib compiles a few install paths into
    # the library as strings (its locale and charset.alias directories). Left
    # unset, meson uses its own default prefix, which differs between machines
    # (Homebrew on Apple Silicon patches it to /opt/homebrew), so gnubg.wasm
    # would differ per machine. Fix all of them to constants. /usr/local is
    # also what gnubg's own configure uses.
    --prefix=/usr/local --libdir=lib --localedir=share/locale
    --localstatedir=var --sysconfdir=etc --datadir=share
    # Subprojects (PCRE2 etc.) come only from the archives fetch.sh downloaded
    # and verified (unpack.sh puts them in subprojects/packagecache/).
    --wrap-mode=nodownload
    -Dtests=false -Dnls=disabled -Dintrospection=disabled
    -Dlibmount=disabled -Dselinux=disabled -Dxattr=false
    -Dman-pages=disabled -Ddocumentation=false -Dsysprof=disabled
    -Dlibelf=disabled -Ddtrace=disabled -Dsystemtap=disabled
)

# Set up again from scratch whenever anything that went into the setup
# changed: the meson arguments, the cross file, meson or emsdk version, or the
# glib source tree (tarball and patches). See signature_matches in common.sh.
SIGNATURE="glib-setup v1
emsdk $EMSDK_VERSION
meson $MESON_VERSION
args ${MESON_ARGS[*]}
cross-file $(sha256_of "$ENGINE_DIR/config/emscripten-cross.ini")
$(source_stamp "$SRC")"

if ! signature_matches "$OUT" "$SIGNATURE" || [ ! -f "$OUT/build.ninja" ]; then
    [ -d "$OUT" ] && echo "glib build settings or sources changed: setting up glib again from scratch"
    rm -rf "$OUT"
    # PKG_CONFIG_LIBDIR points nowhere so meson can't pick up the *host's*
    # (macOS/Linux) libraries by mistake; missing deps (pcre2, libffi) come
    # from glib's own pinned meson "wrap" subprojects instead.
    PKG_CONFIG_LIBDIR=/nonexistent meson setup "$OUT" "$SRC" "${MESON_ARGS[@]}" \
        > "$ENGINE_DIR/build/glib-setup.log" 2>&1 \
        || { show_failure "$ENGINE_DIR/build/glib-setup.log"; exit 1; }
    write_signature "$OUT" "$SIGNATURE"
fi

# libglib itself, its charset helper, and PCRE2 (used by glib's GRegex).
# The two gobject headers are generated files that <glib-object.h> needs;
# gnubg's headers include it for declarations only, so we don't build or
# link the gobject library itself.
ninja -C "$OUT" glib/libglib-2.0.a glib/libcharset/libcharset.a \
    "subprojects/pcre2-$PCRE2_VERSION/libpcre2-8.a" \
    gobject/gobject-visibility.h gobject/glib-enumtypes.h \
    > "$ENGINE_DIR/build/glib-ninja.log" 2>&1 \
    || { show_failure "$ENGINE_DIR/build/glib-ninja.log"; exit 1; }
echo "Built glib static libraries in $OUT"
