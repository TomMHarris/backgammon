#!/usr/bin/env bash
# Build native (macOS/Linux) GNU Backgammon from the same pinned source as the
# WebAssembly build. Used for two things:
#   1. generating the data files (weights + bearoff databases), and
#   2. as the reference engine the Phase 2 tests compare against.
#
# Usage: engine/native/build-native.sh [strict|release]
#   strict  : -O2 -fno-fast-math -ffp-contract=off  (no float reordering;
#             must stay identical to FP_CFLAGS in engine/build.sh)
#   release : gnubg's own default flags (-O3 -ffast-math, added by configure)
#
# Output: engine/native/build/<variant>/gnubg  (+ makeweights, makebearoff)
# Needs: a C compiler, make, pkg-config, glib 2 development files and Python 3
# with headers (see engine/README.md). GUI, 3D board, SIMD and threads are off.
set -euo pipefail

VARIANT="${1:-strict}"
ENGINE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ENGINE_DIR/build/src/gnubg"
OUT="$ENGINE_DIR/native/build/$VARIANT"
source "$ENGINE_DIR/scripts/common.sh"

case "$VARIANT" in
    strict)  CFLAGS_VARIANT="-O2 -fno-fast-math -ffp-contract=off" ;;
    # Empty CFLAGS: configure's AM_CFLAGS supplies "-g -O3 -ffast-math".
    release) CFLAGS_VARIANT="" ;;
    *) echo "unknown variant: $VARIANT (use strict or release)" >&2; exit 1 ;;
esac

# Same pinned, verified, patched source as the wasm build. (Cheap if already
# done; re-unpacks if the pins or patches changed.)
"$ENGINE_DIR/scripts/fetch.sh"
"$ENGINE_DIR/scripts/unpack.sh"

# ac_cv_lib_readline_readline=no: macOS ships libedit pretending to be
# readline, which gnubg.c doesn't compile against. Readline only affects
# console line editing, which we don't use.
CONFIGURE_ENV=(CFLAGS="$CFLAGS_VARIANT" ac_cv_lib_readline_readline=no)
CONFIGURE_CMD=("$SRC/configure"
    --without-gtk --without-board3d
    --enable-simd=no --disable-threads
    --with-python=python3 --without-sqlite)

# Configure again, in a fresh directory, when the flags, the configure command,
# the compiler or the gnubg sources change (see signature_matches in
# scripts/common.sh). This keeps the native reference on exactly the flags
# written above; previously a changed flag was silently ignored.
SIGNATURE="gnubg-native v1
cc $(${CC:-cc} --version 2>/dev/null | head -1)
env $(printf '%q ' "${CONFIGURE_ENV[@]}")
cmd $(printf '%q ' "${CONFIGURE_CMD[@]}")
$(source_stamp "$SRC")"
if ! signature_matches "$OUT" "$SIGNATURE" || [ ! -f "$OUT/Makefile" ]; then
    [ -d "$OUT" ] && echo "Native $VARIANT build settings or sources changed: rebuilding from scratch"
    rm -rf "$OUT"
    mkdir -p "$OUT"
    ( cd "$OUT" && env "${CONFIGURE_ENV[@]}" "${CONFIGURE_CMD[@]}" > configure.log 2>&1 ) \
        || { show_failure "$OUT/configure.log"; exit 1; }
    write_signature "$OUT" "$SIGNATURE"
fi

# lib/ (neural net, RNGs) is a separate libtool library the programs link to.
# Separate logs, so a failure shows the log of the step that failed.
rm -f "$OUT/make-lib.log" "$OUT/make.log"
( cd "$OUT" && make -j8 -C lib > make-lib.log 2>&1 ) || { show_failure "$OUT/make-lib.log"; exit 1; }
( cd "$OUT" && make -j8 gnubg makeweights makebearoff > make.log 2>&1 ) || { show_failure "$OUT/make.log"; exit 1; }
echo "Built native gnubg ($VARIANT) in $OUT"
