#!/usr/bin/env bash
# Build GNU Backgammon's engine + our C API to WebAssembly.
#
#   engine/build.sh            # full build (idempotent; re-runs are incremental)
#
# Host prerequisites (meson >= 1.4, ninja, ...): see engine/README.md.
#
# Steps:
#   1. download + verify pinned sources (scripts/fetch.sh), unpack them and
#      apply our patches (scripts/unpack.sh)
#   2. install/activate the pinned Emscripten (scripts/emsdk-env.sh)
#   3. cross-compile glib's core library (scripts/build-glib.sh)
#   4. configure gnubg with emconfigure (real configure tests, no hand-written config.h)
#   5. compile gnubg with its own Makefile (same flags as the native build)
#   6. compile our API layer + cJSON and link everything into dist/gnubg.{mjs,wasm}
#
# Every build directory records what it was set up from (a "signature", see
# scripts/common.sh) and is rebuilt from scratch when that changes, so a
# re-run never mixes old and new objects.
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
source "$ENGINE_DIR/versions.env"
source "$ENGINE_DIR/scripts/common.sh"

# --- 0. host checks ----------------------------------------------------------
# Fail early with a clear message rather than deep inside configure.
missing=""
for tool in meson ninja pkg-config python3 git curl make patch tar; do
    command -v "$tool" > /dev/null 2>&1 || missing="$missing $tool"
done
command -v shasum > /dev/null 2>&1 || command -v sha256sum > /dev/null 2>&1 || missing="$missing shasum/sha256sum"
# GNU tar (Linux) needs the separate xz program for glib's .tar.xz.
if tar --version 2>/dev/null | grep -q GNU && ! command -v xz > /dev/null 2>&1; then
    missing="$missing xz"
fi
if [ -n "$missing" ]; then
    echo "ERROR: missing host tools:$missing (see engine/README.md)" >&2
    exit 1
fi
# gnubg's configure (automake) refuses source paths containing these
# characters, with a cryptic "unsafe srcdir value". Check the checkout path.
case "$ENGINE_DIR" in
    *[\ \	\\\"\#\$\&\'\`]*)
        echo "ERROR: the checkout path '$ENGINE_DIR' contains a space or one of \\ \" # \$ & ' \`;" >&2
        echo "gnubg's configure can't handle that. Clone the repository somewhere else." >&2
        exit 1 ;;
esac

# Floating-point flags. "strict" means no reordering of float arithmetic, so
# results can be compared bit-for-bit with a native build using the same flags
# (engine/native/build-native.sh strict). See PLAN.md section 7.
FP_CFLAGS="-O2 -fno-fast-math -ffp-contract=off"

# Make the output independent of where the repository is checked out: gnubg
# is compiled from absolute paths, and assert() messages embed __FILE__.
# This only rewrites path strings; it doesn't affect generated code.
REPRO_CFLAGS="-ffile-prefix-map=$ENGINE_DIR=engine"

# --- 1-3. sources, compiler, glib ------------------------------------------
"$ENGINE_DIR/scripts/fetch.sh"
"$ENGINE_DIR/scripts/unpack.sh"
source "$ENGINE_DIR/scripts/emsdk-env.sh"
"$ENGINE_DIR/scripts/build-glib.sh"

# --- 4. configure gnubg ----------------------------------------------------
# Notes (details in NOTES.md, Phase 1):
#  --host=wasm32-unknown-linux-gnu: gnubg's config.sub predates Emscripten;
#    without a host, configure assumes macOS and adds Apple-only link flags.
#  PKG_CONFIG_*: set *inside* emconfigure (via env) so only our wasm glib
#    is visible, never the host's (Homebrew/system) libraries.
#  ac_cv_*=no: match the native build (no readline; no gettext/NLS).
#  -DGNUBG_WEB: enables gnubg_web_init() from our gnubg patch.
CONFIGURE_ENV=(ac_cv_lib_readline_readline=no ac_cv_header_libintl_h=no)
CONFIGURE_CMD=(emconfigure env PKG_CONFIG_PATH= PKG_CONFIG_LIBDIR="$GLIB_OUT/meson-uninstalled"
    "$GNUBG_SRC/configure" --host=wasm32-unknown-linux-gnu
    --without-gtk --without-board3d --enable-simd=no --disable-threads
    --without-python --without-sqlite --without-libcurl
    CFLAGS="$FP_CFLAGS $REPRO_CFLAGS" CPPFLAGS="-DGNUBG_WEB")

# Configure again, in a fresh directory, whenever anything that configure saw
# changes: the exact command and environment above, the compiler, the gnubg
# sources (tarball + patches) or the glib build it links against.
CONFIGURE_SIGNATURE="gnubg-configure v3
emsdk $EMSDK_VERSION
env $(printf '%q ' "${CONFIGURE_ENV[@]}")
cmd $(printf '%q ' "${CONFIGURE_CMD[@]}")
$(source_stamp "$GNUBG_SRC")
glib: $(cat "$GLIB_OUT/.gnubg-web-signature")"
if ! signature_matches "$OBJ" "$CONFIGURE_SIGNATURE" || [ ! -f "$OBJ/Makefile" ]; then
    if [ -d "$OBJ" ]; then
        echo "gnubg configure settings or sources changed: removing old objects"
    fi
    rm -rf "$OBJ"
    mkdir -p "$OBJ"
    echo "Configuring gnubg for WebAssembly"
    ( cd "$OBJ" && env "${CONFIGURE_ENV[@]}" "${CONFIGURE_CMD[@]}" > configure.log 2>&1 ) \
        || { show_failure "$OBJ/configure.log"; exit 1; }
    write_signature "$OBJ" "$CONFIGURE_SIGNATURE"
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
GNUBG_OBJS=()
for o in $GNUBG_OBJS_ALL; do
    case "$o" in
        glib-ext.o|external.o|external_l.o|external_y.o|openurl.o) ;;
        *) GNUBG_OBJS+=("$o") ;;
    esac
done

echo "Compiling gnubg"
# Two steps with separate logs, so a failure always shows the log of the
# step that actually failed (never an old log from a previous run).
rm -f "$OBJ/make-lib.log" "$OBJ/make.log"
( cd "$OBJ" && emmake make -j8 -C lib > make-lib.log 2>&1 ) \
    || { show_failure "$OBJ/make-lib.log"; exit 1; }
( cd "$OBJ" && emmake make -j8 "${GNUBG_OBJS[@]}" > make.log 2>&1 ) \
    || { show_failure "$OBJ/make.log"; exit 1; }

# --- 6. API layer + link ---------------------------------------------------
echo "Compiling API layer"
GLIB_CFLAGS="$(PKG_CONFIG_PATH= PKG_CONFIG_LIBDIR="$GLIB_OUT/meson-uninstalled" pkg-config --cflags glib-2.0)"
API_CFLAGS="$FP_CFLAGS $REPRO_CFLAGS -DHAVE_CONFIG_H -DGNUBG_WEB -I$OBJ -I$GNUBG_SRC -I$GNUBG_SRC/lib -I$BUILD/src/cjson $GLIB_CFLAGS"
# Every .c file in engine/api/ is part of the API.
API_OBJS=()
for src in "$ENGINE_DIR"/api/*.c; do
    o="api_$(basename "$src" .c).o"
    # shellcheck disable=SC2086
    emcc $API_CFLAGS -c "$src" -o "$OBJ/$o"
    API_OBJS+=("$o")
done
# shellcheck disable=SC2086
emcc $FP_CFLAGS $REPRO_CFLAGS -c "$BUILD/src/cjson/cJSON.c" -o "$OBJ/cJSON.o"

# Guard (see the script for details): no glib threading function that
# misbehaves without real threads may be used by gnubg or the API.
( cd "$OBJ" && "$ENGINE_DIR/scripts/check-glib-threads.sh" "${GNUBG_OBJS[@]}" "${API_OBJS[@]}" lib/.libs/libevent.a )

# Exported functions: every API function named gnubg_api_* defined (at the
# start of a line, gnubg's style) in engine/api/*.c, plus malloc/free.
EXPORTS="$(grep -ho '^gnubg_api_[a-z_]*' "$ENGINE_DIR"/api/*.c | sort -u | sed 's/^/_/' | tr '\n' ',')_malloc,_free"
echo "Exports: $EXPORTS"

# The release link. Paths are relative to $OBJ (the link runs there).
LINK_ARGS=($FP_CFLAGS
    "${GNUBG_OBJS[@]}" "${API_OBJS[@]}" cJSON.o
    lib/.libs/libevent.a
    "$GLIB_OUT/glib/libglib-2.0.a" "$GLIB_OUT/glib/libcharset/libcharset.a"
    "$GLIB_OUT/subprojects/pcre2-$PCRE2_VERSION/libpcre2-8.a" -lm
    -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createGnubgModule
    -sENVIRONMENT=web,worker,node
    -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=64MB
    -sSTACK_SIZE=8MB
    # Put the stack *below* the static data. The stack grows downwards; by
    # default (optimised links) it sits just above gnubg's static data, so an
    # overflow would silently overwrite global variables (weights, settings,
    # caches) and could produce wrong numbers instead of a crash. With the
    # stack first, an overflow runs past address 0 and traps immediately.
    # Costs nothing at run time (it only moves where data lives). The debug
    # build (-O0) already uses this layout by default. Review finding LINK-1.
    -Wl,--stack-first
    -sFORCE_FILESYSTEM=1
    -sEXPORTED_FUNCTIONS="$EXPORTS"
    -sEXPORTED_RUNTIME_METHODS=ccall,cwrap,FS,UTF8ToString)
# Saved for scripts/scan-function-casts.py, which re-links the same inputs.
printf '%s\n' "${LINK_ARGS[@]}" > "$OBJ/link-args.txt"

# GNUBG_DEBUG=1 engine/build.sh keeps function names in stack traces, turns
# on Emscripten's runtime assertions (slower; for diagnosing crashes), and
# writes gnubg.mjs.symbols listing every function in the binary. Output goes
# to engine/build/dist-debug/ (see DIST above).
DEBUG_LDFLAGS=()
if [ "${GNUBG_DEBUG:-0}" = "1" ]; then
    DEBUG_LDFLAGS=(-O0 --profiling-funcs -sASSERTIONS=2 --emit-symbol-map)
fi

echo "Linking"
mkdir -p "$DIST"
# ${DEBUG_LDFLAGS[@]+...}: bash 3.2 treats an empty array as unset under set -u.
( cd "$OBJ" && emcc "${LINK_ARGS[@]}" ${DEBUG_LDFLAGS[@]+"${DEBUG_LDFLAGS[@]}"} -o "$DIST/gnubg.mjs" ) \
    > "$OBJ/link.log" 2>&1 || { cat "$OBJ/link.log"; exit 1; }
if [ -s "$OBJ/link.log" ]; then
    echo "Linker messages:"
    cat "$OBJ/link.log"
fi

ls -la "$DIST"
