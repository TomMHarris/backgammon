#!/usr/bin/env bash
# Build GNU Backgammon's engine + our C API to WebAssembly.
#
#   engine/build.sh            # full build (idempotent; re-runs are incremental)
#
# Steps:
#   1. fetch + verify pinned sources (scripts/fetch.sh), apply our patches
#   2. install/activate the pinned Emscripten (scripts/emsdk-env.sh)
#   3. cross-compile glib's core library (scripts/build-glib.sh)
#   4. configure gnubg with emconfigure (real configure tests, no hand-written config.h)
#   5. compile gnubg with its own Makefile (same flags as the native build)
#   6. compile our API layer + cJSON and link everything into dist/gnubg.{mjs,wasm}
#
# Output: engine/dist/gnubg.mjs (ES module loader) + engine/dist/gnubg.wasm
set -euo pipefail

ENGINE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD="$ENGINE_DIR/build"
GNUBG_SRC="$BUILD/src/gnubg"
GLIB_OUT="$BUILD/glib-wasm"
OBJ="$BUILD/gnubg-wasm"
DIST="$ENGINE_DIR/dist"
# Debug builds go to a separate, git-ignored directory so they can never
# overwrite the committed release artifacts in engine/dist/.
if [ "${GNUBG_DEBUG:-0}" = "1" ]; then
    DIST="$BUILD/dist-debug"
fi

# Floating-point flags. "strict" means no reordering of float arithmetic, so
# results can be compared bit-for-bit with a native build using the same flags
# (engine/native/build-native.sh strict). See PLAN.md section 7.
FP_CFLAGS="-O2 -fno-fast-math -ffp-contract=off"

# Make the output independent of where the repository is checked out: gnubg
# is compiled from absolute paths, and assert() messages embed __FILE__.
# This only rewrites path strings; it doesn't affect generated code.
REPRO_CFLAGS="-ffile-prefix-map=$ENGINE_DIR=engine"

"$ENGINE_DIR/scripts/fetch.sh"
"$ENGINE_DIR/scripts/apply-patches.sh"
source "$ENGINE_DIR/scripts/emsdk-env.sh"
"$ENGINE_DIR/scripts/build-glib.sh"

# --- 4. configure gnubg ----------------------------------------------------
# Re-run configure (from a clean object directory) whenever the configure
# settings below change, so a stale configuration is never reused silently.
CONFIGURE_SIGNATURE="emsdk=$EMSDK_VERSION cflags=$FP_CFLAGS $REPRO_CFLAGS v=2"
mkdir -p "$OBJ"
if [ ! -f "$OBJ/Makefile" ] || [ "$(cat "$OBJ/.configure-signature" 2>/dev/null)" != "$CONFIGURE_SIGNATURE" ]; then
    if [ -f "$OBJ/Makefile" ]; then
        echo "Configure settings changed: cleaning old objects"
        ( cd "$OBJ" && make -s clean > /dev/null 2>&1 && make -s -C lib clean > /dev/null 2>&1 ) || true
    fi
    echo "Configuring gnubg for WebAssembly"
    # Notes (details in NOTES.md, Phase 1):
    #  --host=wasm32-unknown-linux-gnu: gnubg's config.sub predates Emscripten;
    #    without a host, configure assumes macOS and adds Apple-only link flags.
    #  PKG_CONFIG_*: set *inside* emconfigure (via env) so only our wasm glib
    #    is visible, never the Mac's Homebrew libraries.
    #  ac_cv_*=no: match the native build (no readline; no gettext/NLS).
    #  -DGNUBG_WEB: enables gnubg_web_init() from our gnubg patch.
    ( cd "$OBJ" && \
      ac_cv_lib_readline_readline=no ac_cv_header_libintl_h=no \
      emconfigure env PKG_CONFIG_PATH= PKG_CONFIG_LIBDIR="$GLIB_OUT/meson-uninstalled" \
        "$GNUBG_SRC/configure" --host=wasm32-unknown-linux-gnu \
        --without-gtk --without-board3d --enable-simd=no --disable-threads \
        --without-python --without-sqlite --without-libcurl \
        CFLAGS="$FP_CFLAGS $REPRO_CFLAGS" CPPFLAGS="-DGNUBG_WEB" \
        > configure.log 2>&1 ) || { tail -30 "$OBJ/configure.log"; exit 1; }
    echo "$CONFIGURE_SIGNATURE" > "$OBJ/.configure-signature"
fi

# --- 5. compile gnubg ------------------------------------------------------
# Every object gnubg's own Makefile would link, except:
#   glib-ext.o            GObject helpers used only by GTK/main() (needs gobject)
#   external*.o           network play against external bots (sockets)
#   openurl.o             opens a web browser
GNUBG_OBJS_ALL="$(cd "$OBJ" && make -s -f Makefile -f - print-objs <<'EOF'
print-objs: ; @echo $(gnubg_OBJECTS)
EOF
)"
GNUBG_OBJS=""
for o in $GNUBG_OBJS_ALL; do
    case "$o" in
        glib-ext.o|external.o|external_l.o|external_y.o|openurl.o) ;;
        *) GNUBG_OBJS="$GNUBG_OBJS $o" ;;
    esac
done

echo "Compiling gnubg"
( cd "$OBJ" && emmake make -j8 -C lib > make-lib.log 2>&1 && emmake make -j8 $GNUBG_OBJS > make.log 2>&1 ) \
    || { grep -hE 'error:|Error [0-9]' "$OBJ"/make*.log | head -30; exit 1; }

# --- 6. API layer + link ---------------------------------------------------
echo "Compiling API layer"
GLIB_CFLAGS="$(PKG_CONFIG_PATH= PKG_CONFIG_LIBDIR="$GLIB_OUT/meson-uninstalled" pkg-config --cflags glib-2.0)"
API_CFLAGS="$FP_CFLAGS $REPRO_CFLAGS -DHAVE_CONFIG_H -DGNUBG_WEB -I$OBJ -I$GNUBG_SRC -I$GNUBG_SRC/lib -I$BUILD/src/cjson $GLIB_CFLAGS"
# Every .c file in engine/api/ is part of the API.
API_OBJS=""
for src in "$ENGINE_DIR"/api/*.c; do
    o="$OBJ/api_$(basename "$src" .c).o"
    emcc $API_CFLAGS -c "$src" -o "$o"
    API_OBJS="$API_OBJS $o"
done
emcc $FP_CFLAGS $REPRO_CFLAGS -c "$BUILD/src/cjson/cJSON.c" -o "$OBJ/cJSON.o"

# Exported functions: every API function named gnubg_api_* defined (at the
# start of a line, gnubg's style) in engine/api/*.c, plus malloc/free.
EXPORTS="$(grep -ho '^gnubg_api_[a-z_]*' "$ENGINE_DIR"/api/*.c | sort -u | sed 's/^/_/' | tr '\n' ',')_malloc,_free"
echo "Exports: $EXPORTS"

# GNUBG_DEBUG=1 engine/build.sh keeps function names in stack traces, turns
# on Emscripten's runtime assertions (slower; for diagnosing crashes), and
# writes gnubg.mjs.symbols listing every function in the binary. Output goes
# to engine/build/dist-debug/ (see DIST above).
DEBUG_LDFLAGS=""
if [ "${GNUBG_DEBUG:-0}" = "1" ]; then
    DEBUG_LDFLAGS="-O0 --profiling-funcs -sASSERTIONS=2 --emit-symbol-map"
fi

echo "Linking"
mkdir -p "$DIST"
( cd "$OBJ" && emcc $FP_CFLAGS $DEBUG_LDFLAGS \
    $GNUBG_OBJS $API_OBJS cJSON.o \
    lib/.libs/libevent.a \
    "$GLIB_OUT/glib/libglib-2.0.a" "$GLIB_OUT/glib/libcharset/libcharset.a" \
    "$GLIB_OUT/subprojects/pcre2-10.46/libpcre2-8.a" -lm \
    -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createGnubgModule \
    -sENVIRONMENT=web,worker,node \
    -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=64MB \
    -sSTACK_SIZE=8MB \
    -sFORCE_FILESYSTEM=1 \
    -sEXPORTED_FUNCTIONS="$EXPORTS" \
    -sEXPORTED_RUNTIME_METHODS=ccall,cwrap,FS,UTF8ToString \
    -o "$DIST/gnubg.mjs" ) > "$OBJ/link.log" 2>&1 || { cat "$OBJ/link.log"; exit 1; }
if [ -s "$OBJ/link.log" ]; then
    echo "Linker messages:"
    cat "$OBJ/link.log"
fi

ls -la "$DIST"
