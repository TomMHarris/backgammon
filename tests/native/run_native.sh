#!/usr/bin/env bash
# Run the native gnubg reference dumps and write
#     tests/reference/native-<variant>-<mode>.json
#
# Usage: tests/native/run_native.sh <strict|release> <fresh|single|single-clear>
#
#   variant  strict  = engine/native/build/strict/gnubg  (-O2, no fast-math)
#            release = engine/native/build/release/gnubg (gnubg's -O3 -ffast-math)
#   mode     fresh   = one new gnubg process per query (per position query,
#                      and per match file). Nothing carries over between
#                      queries, so this is the primary reference.
#            single  = all position queries in one process, in the fixed
#                      order documented in dump_reference.py, then all match
#                      files in one more process. The wasm runner must replay
#                      the same order to compare against this.
#            single-clear = like single, but gnubg's evaluation cache is
#                      flushed ("clear cache") before every position query and
#                      before every match. For positions this gives exactly
#                      the fresh-mode numbers (checked: 344 of 344 queries
#                      bit-identical), in about a second.
#
# Inputs: tests/corpus/positions.json and tests/corpus/matches/*.sgf|*.mat.
# If they don't exist yet, the small sample in tests/native/sample/ is used
# instead (and a warning is printed).
#
# Optional environment variables:
#   ANALYSIS_PRESET=supremo  analyse the matches with gnubg's built-in default
#                     analysis settings instead of "world class"; the output
#                     file name gets "-supremo" appended.
#   MATCHES_ONLY=1    skip the position queries (positionsReference = null).
#
# Every gnubg run uses -r (no rc files) and a new empty HOME, so gnubg starts
# from its built-in defaults.
set -euo pipefail

VARIANT="${1:-}"
MODE="${2:-}"
case "$VARIANT" in strict|release) ;; *) echo "usage: $0 <strict|release> <fresh|single|single-clear>" >&2; exit 1 ;; esac
case "$MODE" in fresh|single|single-clear) ;; *) echo "usage: $0 <strict|release> <fresh|single|single-clear>" >&2; exit 1 ;; esac

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
GNUBG="engine/native/build/$VARIANT/gnubg"
[ -x "$GNUBG" ] || { echo "missing $GNUBG (run engine/native/build-native.sh $VARIANT)" >&2; exit 1; }

CORPUS="tests/corpus/positions.json"
if [ ! -f "$CORPUS" ]; then
    echo "WARNING: $CORPUS not found; using tests/native/sample/positions.json" >&2
    CORPUS="tests/native/sample/positions.json"
fi
MATCHES=$(ls tests/corpus/matches/*.sgf tests/corpus/matches/*.mat 2>/dev/null || true)
if [ -z "$MATCHES" ]; then
    echo "WARNING: no tests/corpus/matches/*.sgf|*.mat; using tests/native/sample/" >&2
    MATCHES=$(ls tests/native/sample/*.sgf tests/native/sample/*.mat)
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/parts" "$WORK/matches" tests/reference

# run_gnubg SCRIPT LOG: run one script inside gnubg with a throwaway HOME.
# The script's settings come from environment variables set by the caller.
run_gnubg() {
    local home
    home="$(mktemp -d "$WORK/home.XXXXXX")"
    HOME="$home" "$GNUBG" -t -r -q -P engine/data -p "$1" > "$2" 2>&1
}

# fail_if_missing FILE LOG: gnubg exits 0 even when the Python script fails,
# so check that the script actually wrote its output.
fail_if_missing() {
    if [ ! -s "$1" ]; then
        echo "gnubg run failed; last lines of $2:" >&2
        tail -25 "$2" >&2
        exit 1
    fi
}

ANALYSIS_PRESET="${ANALYSIS_PRESET:-world class}"
SUFFIX=""
[ "$ANALYSIS_PRESET" = "world class" ] || SUFFIX="-$(echo "$ANALYSIS_PRESET" | tr ' ' '-')"
MATCHES_ONLY="${MATCHES_ONLY:-0}"
export ANALYSIS_PRESET

CLEAR_CACHE=0
[ "$MODE" = single-clear ] && CLEAR_CACHE=1
export CORPUS VARIANT MODE CLEAR_CACHE
START=$SECONDS

# ---- positions ----
POS_OUT="$WORK/positions.json"
if [ "$MATCHES_ONLY" = 1 ]; then
    POS_OUT="-"
elif [ "$MODE" != fresh ]; then
    OUT="$POS_OUT" run_gnubg tests/native/dump_reference.py "$WORK/pos.log"
    fail_if_missing "$POS_OUT" "$WORK/pos.log"
else
    OUT="$WORK/count.json" LIST_ONLY=1 run_gnubg tests/native/dump_reference.py "$WORK/count.log"
    fail_if_missing "$WORK/count.json" "$WORK/count.log"
    N=$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["count"])' "$WORK/count.json")
    k=0
    while [ "$k" -lt "$N" ]; do
        part="$WORK/parts/$(printf 'q%05d' "$k").json"
        OUT="$part" QUERY_INDEX="$k" run_gnubg tests/native/dump_reference.py "$WORK/q.log"
        fail_if_missing "$part" "$WORK/q.log"
        k=$((k + 1))
    done
    python3 -I tests/native/dump_reference.py merge "$WORK/parts" "$POS_OUT"
fi
POS_SECONDS=$((SECONDS - START))

# ---- matches ----
START=$SECONDS
if [ "$MODE" != fresh ]; then
    LIST=$(echo $MATCHES | tr ' ' ':')
    MATCH="$LIST" OUT="$WORK/matches/all.json" run_gnubg tests/native/dump_match_reference.py "$WORK/m.log"
    fail_if_missing "$WORK/matches/all.json" "$WORK/m.log"
else
    i=0
    for m in $MATCHES; do
        out="$WORK/matches/$(printf 'm%03d' "$i").json"
        MATCH="$m" OUT="$out" run_gnubg tests/native/dump_match_reference.py "$WORK/m.log"
        fail_if_missing "$out" "$WORK/m.log"
        i=$((i + 1))
    done
fi
MATCH_SECONDS=$((SECONDS - START))

FINAL="tests/reference/native-$VARIANT-$MODE$SUFFIX.json"
python3 -I tests/native/dump_reference.py combine "$POS_OUT" "$FINAL" "$WORK"/matches/*.json
echo "wrote $FINAL (positions: ${POS_SECONDS}s, matches: ${MATCH_SECONDS}s, corpus: $CORPUS)"
