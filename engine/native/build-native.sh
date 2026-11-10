#!/usr/bin/env bash
# Build native (macOS/Linux) GNU Backgammon from the same pinned source as the
# WebAssembly build. Used for two things:
#   1. generating the data files (weights + bearoff databases), and
#   2. as the reference engine the Phase 2 tests compare against.
#
# Usage: engine/native/build-native.sh [strict|release]
#   strict  : -O2 -fno-fast-math -ffp-contract=off  (no float reordering)
#   release : gnubg's own default flags (-O3 -ffast-math, added by configure)
#
# Output: engine/native/build/<variant>/gnubg  (+ makeweights, makebearoff)
# Needs (Homebrew): glib pkgconf python3. GUI, 3D board, SIMD and threads are off.
set -euo pipefail

VARIANT="${1:-strict}"
ENGINE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ENGINE_DIR/build/src/gnubg"
OUT="$ENGINE_DIR/native/build/$VARIANT"

case "$VARIANT" in
    strict)  CFLAGS_VARIANT="-O2 -fno-fast-math -ffp-contract=off" ;;
    # Empty CFLAGS: configure's AM_CFLAGS supplies "-g -O3 -ffast-math".
    release) CFLAGS_VARIANT="" ;;
    *) echo "unknown variant: $VARIANT (use strict or release)" >&2; exit 1 ;;
esac

[ -d "$SRC" ] || "$ENGINE_DIR/scripts/fetch.sh"

mkdir -p "$OUT"
cd "$OUT"

if [ ! -f Makefile ]; then
    # ac_cv_lib_readline_readline=no: macOS ships libedit pretending to be
    # readline, which gnubg.c doesn't compile against. Readline only affects
    # console line editing, which we don't use.
    CFLAGS="$CFLAGS_VARIANT" ac_cv_lib_readline_readline=no \
        "$SRC/configure" \
        --without-gtk --without-board3d \
        --enable-simd=no --disable-threads \
        --with-python=python3 --without-sqlite \
        > configure.log 2>&1 || { tail -30 configure.log; exit 1; }
fi

# lib/ (neural net, RNGs) is a separate libtool library the programs link to.
{ make -j8 -C lib && make -j8 gnubg makeweights makebearoff; } > make.log 2>&1 \
    || { grep -E 'error:|Error [0-9]' make.log | head -30; exit 1; }
echo "Built native gnubg ($VARIANT) in $OUT"
