"""
dump_reference.py - native gnubg reference values for the test-position corpus.

This file has two jobs:

1. INSIDE native gnubg (the normal use). gnubg runs it with its embedded
   Python, where `import gnubg` works:

       HOME=$(mktemp -d) engine/native/build/strict/gnubg -t -r -q \
           -P engine/data -p tests/native/dump_reference.py

   gnubg does not pass command-line arguments to the script, so everything is
   controlled by environment variables:

       CORPUS       corpus JSON (default tests/corpus/positions.json)
       OUT          where to write the JSON result (required)
       QUERY_INDEX  run only query number k of the fixed query list (0-based);
                    used by "fresh" mode (one gnubg process per query).
                    Unset = run every query, in order, in this one process.
       LIST_ONLY    if set to 1: only write the number of queries to OUT
       CLEAR_CACHE  if set to 1: run gnubg's "clear cache" (EvalCacheFlush,
                    eval.c) before every query (experiment; see
                    PYTHON_INTERFACE.md "History dependence")
       VARIANT, MODE  labels copied into the output (strict/release, fresh/single)

2. On the HOST with plain python3 (no gnubg module), to glue results together:

       python3 -I tests/native/dump_reference.py merge   PARTS_DIR OUT_JSON
       python3 -I tests/native/dump_reference.py combine POS_JSON OUT_JSON MATCH_JSON...

   "merge" joins the one-query files of a fresh-mode run into the same layout
   a single-process run produces; "combine" puts the position reference and
   the match-analysis references into one file (what run_native.sh writes).

Every float in the output is a float32 value from gnubg promoted to a Python
float (a C double), and json writes it with repr(), which round-trips exactly.
See tests/native/PYTHON_INTERFACE.md for what every number means (units,
perspective, which gnubg C function produced it) with source references.

The fixed query order (the wasm runner must replay it in this order in
single-process mode, because gnubg's evaluation cache makes the last bit of
some results depend on call history - see NOTES.md):

    for each position, in corpus order:
        eval  0-ply cubeless, 0-ply cubeful, 1-ply cubeless, 1-ply cubeful,
              2-ply cubeless, 2-ply cubeful
        move positions: hint "expert", hint "world class"
        cube positions: cube decision 0-ply, cube decision 2-ply
"""

import json
import os
import struct
import sys

try:
    import gnubg            # only exists inside gnubg's embedded Python
except ImportError:
    gnubg = None


# --------------------------------------------------------------------------
# Settings. Each one mirrors a gnubg default or preset; the source line is
# given so the wasm side can check it mirrors the same thing.
# --------------------------------------------------------------------------

# gnubg.c:231  unsigned int nBeavers = 3;   (desktop default; "set beavers")
N_BEAVERS = 3

# eval.c:315-325  aecSettings[]; eval.c:328-338 aiSettingsMoveFilter[]
# Fields: cubeful, plies, deterministic, prune, noise.
PRESETS = {
    "expert": {
        "evalContext": {"cubeful": 1, "plies": 0, "deterministic": 0, "prune": 1, "noise": 0.0},
        "moveFilter": None,          # aiSettingsMoveFilter = -1: not used at 0 ply
    },
    "world class": {
        "evalContext": {"cubeful": 1, "plies": 2, "deterministic": 1, "prune": 1, "noise": 0.0},
        "moveFilter": "normal",      # aiSettingsMoveFilter = 2 -> MOVEFILTER_NORMAL
    },
}

# movefilters.inc: MOVEFILTER_NORMAL, as (ply, level, accept, extra, threshold).
# accept = -1 means "skip this level".
MOVEFILTER_NORMAL = [
    (1, 0, 0, 8, 0.16),
    (2, 0, 0, 8, 0.16), (2, 1, -1, 0, 0.0),
    (3, 0, 0, 8, 0.16), (3, 1, -1, 0, 0.0), (3, 2, 0, 2, 0.04),
    (4, 0, 0, 8, 0.16), (4, 1, -1, 0, 0.0), (4, 2, 0, 2, 0.04), (4, 3, -1, 0, 0.0),
]

EVAL_PLIES = [0, 1, 2]       # evaluate() at 0, 1, 2 ply, cubeless and cubeful
CUBE_PLIES = [0, 2]          # cube decision at 0 and 2 ply (always cubeful)

# Names of gnubg's 5 output probabilities, in gnubg's order (eval.h:46-50).
# Same names as the wasm API (engine/api/api_util.c probs_json).
PROB_NAMES = ["win", "winGammon", "winBackgammon", "loseGammon", "loseBackgammon"]

# cubedecision values for which the cube is NOT available (eval.h:208-210):
# FindBestCubeDecision returns exactly these when GetDPEq() is false
# (eval.c, start of FindBestCubeDecision).
CUBE_NOT_AVAILABLE = {13, 14, 15}   # NODOUBLE_DEADCUBE, NO_REDOUBLE_DEADCUBE, NOT_AVAILABLE


def f32(x):
    """Round a Python float to the nearest float32, like a C float operation.

    For +, -, *, / of two float32 values, doing the operation in double and
    rounding once to float32 gives exactly the float32 result, so f32(a - b)
    reproduces C's `float - float` bit for bit.
    """
    return struct.unpack("<f", struct.pack("<f", x))[0]


def probs_dict(values):
    return {name: values[i] for i, name in enumerate(PROB_NAMES)}


# --------------------------------------------------------------------------
# gnubg-side helpers
# --------------------------------------------------------------------------

def cmd(text):
    """Run a gnubg command, exactly as if typed at the gnubg prompt."""
    gnubg.command(text)


def global_setup():
    """Settings that apply to every query. All are gnubg's defaults already;
    they are set explicitly so an rc file or a changed default cannot leak in."""
    for c in [
        "set display off",            # don't print a board after every command
        "set confirm new off",        # never ask "discard current match?"
        "set player 0 human",         # gnubg must never move by itself
        "set player 1 human",
        "set beavers %d" % N_BEAVERS,  # set.c:2896 CommandSetBeavers -> nBeavers
        "set jacoby on",              # global default (gnubg.c:213); the match ID's
                                      # own Jacoby bit overrides it (play.c SetMatchID)
    ]:
        cmd(c)


def set_position(pos):
    """Load a position + match ID into gnubg's current match state `ms`.

    `set gnubgid` (set.c SetGNUbgID) calls SetMatchID then SetBoard. Both
    start a fresh move record, which also throws away gnubg's cached hint
    list, so each query starts clean.
    """
    cmd("set gnubgid %s:%s" % (pos["positionId"], pos["matchId"]))


def desktop_cubeinfo():
    """The cubeinfo desktop gnubg uses for eval/hint (GetMatchStateCubeInfo,
    gnubg.c:1328-1333): SetCubeInfo(ms..., ms.fJacoby, nBeavers, ms.bgv).

    gnubg.cubeinfo() (gnubgmodule.c:719-747) calls the same SetCubeInfo with
    the same match-state values EXCEPT beavers, where it passes ms.cBeavers
    (beavers already made in this game, normally 0) instead of the global
    nBeavers. SetCubeInfoMoney (eval.c:3248) just copies fBeavers into the
    struct, and SetCubeInfoMatch (eval.c:3272) forces it to FALSE, so fixing
    the one field reproduces GetMatchStateCubeInfo exactly.
    """
    ci = gnubg.cubeinfo()
    if ci["matchto"] == 0:
        ci["beavers"] = N_BEAVERS
    return ci


def state_snapshot(pos):
    ci = desktop_cubeinfo()
    return {
        "gnubgIdIn": "%s:%s" % (pos["positionId"], pos["matchId"]),
        "gnubgIdAfterSet": gnubg.gnubgid(),
        # board[1] = player on roll, board[0] = opponent; each 25 entries,
        # index 0..23 = points 1..24 from that player's side, 24 = bar.
        "board": [list(gnubg.board()[0]), list(gnubg.board()[1])],
        "cubeinfo": ci,
        "posinfo": gnubg.posinfo(),
    }


def apply_hint_preset(name):
    """Set gnubg's `eval`/`hint` chequer settings (esEvalChequer, aamfEval).
    Uses the same commands a desktop user would type."""
    ec = PRESETS[name]["evalContext"]
    onoff = lambda v: "on" if v else "off"
    for c in [
        "set evaluation chequerplay type evaluation",
        "set evaluation chequerplay evaluation cubeful %s" % onoff(ec["cubeful"]),
        "set evaluation chequerplay evaluation plies %d" % ec["plies"],
        "set evaluation chequerplay evaluation prune %s" % onoff(ec["prune"]),
        "set evaluation chequerplay evaluation deterministic %s" % onoff(ec["deterministic"]),
        "set evaluation chequerplay evaluation noise %r" % ec["noise"],
    ]:
        cmd(c)
    # The movefilter is set even for "expert" (0 ply never reads it), so the
    # recorded settings are complete and identical between queries.
    for ply, level, accept, extra, thr in MOVEFILTER_NORMAL:
        if accept < 0:
            cmd("set evaluation movefilter %d %d -1" % (ply, level))
        else:
            cmd("set evaluation movefilter %d %d %d %d %r" % (ply, level, accept, extra, thr))
    # NB: gnubg.setevalhintfilter() cannot be used: it returns NULL without an
    # exception on success (gnubgmodule.c:499), which Python reports as an error.


# --------------------------------------------------------------------------
# The three kinds of query
# --------------------------------------------------------------------------

def query_eval(pos, plies, cubeful):
    """gnubg.evaluate(board, cubeinfo, evalcontext) -> GeneralEvaluationE
    (gnubgmodule.c:1219-1271, eval.c:5922). Returns 5 probabilities and the
    cubeless equity (UtilityME). The cubeful equity GeneralEvaluationE also
    computes is NOT returned by the Python interface (only 6 of the 7 outputs
    are copied, gnubgmodule.c:1264-1268)."""
    set_position(pos)
    board = gnubg.board()
    ci = desktop_cubeinfo()
    ec = gnubg.evalcontext(cubeful, plies, 1, 1, 0.0)
    r = gnubg.evaluate(board, ci, ec)
    return {
        "call": "gnubg.evaluate(board, cubeinfo, evalcontext)",
        "evalContext": ec,
        "cubeinfo": ci,
        "probs": probs_dict(r),
        "cubelessEquity": r[5],
        "cubefulEquity": None,   # not available from gnubg's Python interface
    }


def get_percent(cd, nd, dt, dp):
    """eval.c:4952 getPercent(), in float32 arithmetic. Returns None where
    gnubg returns -1 (no percentage is shown)."""
    if cd in (2, 6, 9, 12):          # NODOUBLE_TAKE, NODOUBLE_BEAVER, NO_REDOUBLE_TAKE, NO_REDOUBLE_BEAVER
        return f32(f32(nd - dt) / f32(dp - dt))
    if cd in (4, 11):                # TOOGOOD_PASS, TOOGOODRE_PASS
        if nd > dt:
            return None
        return f32(f32(nd - dp) / f32(dt - dp))
    return None


def query_cube(pos, plies):
    """gnubg.cfevaluate(board, cubeinfo, evalcontext): GeneralCubeDecisionE
    then FindCubeDecision (gnubgmodule.c:1273-1333). Returns
    (optimal, no double, double/take, double/pass, decision enum, text),
    all equities normalised money equity (match play: MWC converted with
    mwc2eq, i.e. EMG), from the player on roll's side."""
    set_position(pos)
    board = gnubg.board()
    ci = desktop_cubeinfo()
    ec = gnubg.evalcontext(1, plies, 1, 1, 0.0)
    r = gnubg.cfevaluate(board, ci, ec)
    opt, nd, dt, dp, cd, text = r
    out = {
        "call": "gnubg.cfevaluate(board, cubeinfo, evalcontext)",
        "evalContext": ec,
        "cubeinfo": ci,
        "equities": {"optimal": opt, "noDouble": nd, "doubleTake": dt, "doublePass": dp},
        "decision": cd,
        "recommendation": text,
        # derived, see PYTHON_INTERFACE.md "Cube decisions"
        "percent": get_percent(cd, nd, dt, dp),
        "cubeAvailable": cd not in CUBE_NOT_AVAILABLE,
        # GeneralCubeDecisionE's probabilities are not returned by Python.
        "noDouble": None,
    }
    if ci["matchto"]:
        # Same conversion as the wasm API: eq2mwc(arDouble[i], ci) in C.
        out["mwc"] = {k: gnubg.eq2mwc(v, ci) for k, v in out["equities"].items()}
    return out


def query_hint(pos, preset):
    """gnubg.hint() -> hint_move(), the code behind desktop "hint"
    (gnubg.c:2328-2438): FindnSaveBestMoves with threshold
    arSkillLevel[SKILL_DOUBTFUL] and the eval move filter, then
    RefreshMoveList (eval.c:5026), i.e. gnubg's displayed order."""
    apply_hint_preset(preset)
    set_position(pos)            # after the settings: fresh hint record
    ci = desktop_cubeinfo()
    h = gnubg.hint()             # all moves (nMaxMoves defaults to MAX_MOVES)
    moves = []
    for m in h["hint"]:
        if m["type"] != "eval":
            raise RuntimeError("unexpected hint entry type %r" % m["type"])
        moves.append({
            "move": m["move"],
            "equity": m["equity"],          # move.rScore
            "diff": m["eqdiff"],            # rScore - rScore of first move (float32)
            "probs": probs_dict(m["details"]["probs"]),
            "plies": m["context"]["plies"],   # plies this move was actually evaluated at
            "cubeful": m["context"]["cubeful"],
            "evalContext": m["context"],
        })
    return {
        "call": "gnubg.hint()",
        "preset": preset,
        "settingsInEffect": {
            # gnubg.evalcontext() with no arguments returns GetEvalChequer()->ec
            # (gnubgmodule.c:928-947), i.e. what hint just used.
            "evalContext": gnubg.evalcontext(),
            "moveFilter": gnubg.getevalhintfilter(),
            "threshold": "arSkillLevel[SKILL_DOUBTFUL] = 0.03 (gnubg.c:282-287); only used with a key move",
        },
        "cubeinfo": ci,
        "gnubgId": h["gnubgid"],
        "moves": moves,
    }


# --------------------------------------------------------------------------
# Query list and driver
# --------------------------------------------------------------------------

def build_queries(positions):
    """The fixed query order (also documented at the top of this file)."""
    queries = []
    for pi, pos in enumerate(positions):
        for plies in EVAL_PLIES:
            for cubeful in (0, 1):
                queries.append((pi, "eval-%dply-%s" % (plies, "cubeful" if cubeful else "cubeless"),
                                lambda p=pos, n=plies, c=cubeful: query_eval(p, n, c)))
        if pos["kind"] == "move":
            for preset in ("expert", "world class"):
                queries.append((pi, "hint-" + preset.replace(" ", ""),
                                lambda p=pos, s=preset: query_hint(p, s)))
        elif pos["kind"] == "cube":
            for plies in CUBE_PLIES:
                queries.append((pi, "cube-%dply" % plies, lambda p=pos, n=plies: query_cube(p, n)))
        else:
            raise ValueError("unknown kind %r in position %s" % (pos["kind"], pos["id"]))
    return queries


def run_in_gnubg():
    corpus_path = os.environ.get("CORPUS", "tests/corpus/positions.json")
    out_path = os.environ["OUT"]
    with open(corpus_path) as f:
        positions = json.load(f)["positions"]
    queries = build_queries(positions)

    if os.environ.get("LIST_ONLY") == "1":
        with open(out_path, "w") as f:
            json.dump({"count": len(queries)}, f)
        return

    only = os.environ.get("QUERY_INDEX")
    selected = [int(only)] if only not in (None, "") else range(len(queries))

    global_setup()
    clear_cache = os.environ.get("CLEAR_CACHE") == "1"
    results = []
    for qi in selected:
        pi, key, run = queries[qi]
        pos = positions[pi]
        if clear_cache:
            cmd("clear cache")
        res = run()
        res["state"] = state_snapshot(pos)   # after the query: ms is unchanged by it
        results.append({"queryIndex": qi, "positionIndex": pi, "positionKey": pos["id"],
                        "query": key, "result": res})

    out = {
        "generator": "tests/native/dump_reference.py",
        "variant": os.environ.get("VARIANT", "unknown"),
        "mode": os.environ.get("MODE", "single" if only in (None, "") else "fresh"),
        "corpus": corpus_path,
        "clearCacheBeforeEachQuery": clear_cache,
        "settings": settings_description(),
        # The complete fixed order, as [position id, query name] pairs.
        "queryOrder": [[positions[pi]["id"], key] for pi, key, _ in queries],
        "positions": positions,
        "results": results,
    }
    with open(out_path, "w") as f:
        json.dump(out, f, indent=1)


def settings_description():
    return {
        "beavers": N_BEAVERS,
        "cubeinfoRule": "gnubg.cubeinfo() after 'set gnubgid', with beavers=nBeavers(3) in money play "
                        "(= GetMatchStateCubeInfo, gnubg.c:1328)",
        "evaluate": "evalcontext(cubeful, plies, deterministic=1, prune=1, noise=0.0)",
        "cube": "evalcontext(cubeful=1, plies, deterministic=1, prune=1, noise=0.0)",
        "hintPresets": PRESETS,
        "moveFilterNormal": [list(x) for x in MOVEFILTER_NORMAL],
        "evalPlies": EVAL_PLIES,
        "cubePlies": CUBE_PLIES,
    }


# --------------------------------------------------------------------------
# Host-side glue (plain python3, no gnubg)
# --------------------------------------------------------------------------

def merge_parts(parts_dir, out_path):
    """Join fresh-mode one-query files (any names, *.json) into one file."""
    parts = []
    for name in sorted(os.listdir(parts_dir)):
        if name.endswith(".json"):
            with open(os.path.join(parts_dir, name)) as f:
                parts.append(json.load(f))
    if not parts:
        sys.exit("no part files in " + parts_dir)
    merged = dict(parts[0])
    merged["mode"] = "fresh"
    merged["results"] = sorted((r for p in parts for r in p["results"]),
                               key=lambda r: r["queryIndex"])
    idx = [r["queryIndex"] for r in merged["results"]]
    if idx != list(range(len(idx))):
        sys.exit("missing or duplicate query results: %s" % idx)
    with open(out_path, "w") as f:
        json.dump(merged, f, indent=1)


def combine(pos_path, out_path, match_paths):
    with open(pos_path) as f:
        pos = json.load(f)
    matches = []
    for p in match_paths:
        with open(p) as f:
            data = json.load(f)
        matches.extend(data["matches"])
    out = {
        "variant": pos["variant"],
        "mode": pos["mode"],
        "positionsReference": pos,
        "matchesReference": matches,
    }
    with open(out_path, "w") as f:
        json.dump(out, f, indent=1)


if gnubg is not None:
    run_in_gnubg()
elif __name__ == "__main__":
    if len(sys.argv) == 4 and sys.argv[1] == "merge":
        merge_parts(sys.argv[2], sys.argv[3])
    elif len(sys.argv) >= 4 and sys.argv[1] == "combine":
        combine(sys.argv[2], sys.argv[3], sys.argv[4:])
    else:
        sys.exit(__doc__)
