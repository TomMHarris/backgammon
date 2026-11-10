#!/usr/bin/env bash
# Generate gnubg's data files with the natively built tools, using the exact
# commands from gnubg's Makefile.am (lines 284-292), and copy the match
# equity tables. Output goes to engine/data/, which is committed, so this only
# needs re-running if the gnubg version changes.
#
# Usage: engine/native/make-data.sh [variant]   (default: strict)
set -euo pipefail

VARIANT="${1:-strict}"
ENGINE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ENGINE_DIR/build/src/gnubg"
BIN="$ENGINE_DIR/native/build/$VARIANT"
OUT="$ENGINE_DIR/data"
source "$ENGINE_DIR/scripts/common.sh"

# Always run it: quick when up to date, and it rebuilds if flags or sources changed.
"$ENGINE_DIR/native/build-native.sh" "$VARIANT"
mkdir -p "$OUT/met"

echo "gnubg.wd     (neural net weights, binary form of gnubg.weights)"
"$BIN/makeweights" -f "$OUT/gnubg.wd" "$SRC/gnubg.weights"

echo "gnubg_os0.bd (one-sided bearoff database)"
"$BIN/makebearoff" -o 6 -s 7999999 -f "$OUT/gnubg_os0.bd"

echo "gnubg_ts0.bd (two-sided bearoff database, takes a minute or two)"
"$BIN/makebearoff" -t 6x6 -f "$OUT/gnubg_ts0.bd"

echo "met/         (match equity tables)"
cp "$SRC"/met/*.xml "$SRC"/met/*.dtd "$OUT/met/"

# Same format as "shasum -a 256" / "sha256sum" output (hash, two spaces, name).
for f in gnubg.wd gnubg_os0.bd gnubg_ts0.bd; do
    echo "$(sha256_of "$OUT/$f")  $f"
done > "$OUT/SHA256SUMS"
ls -la "$OUT"
